import crypto from 'crypto';
import axios from 'axios';
import { pool } from './db.js';
import { getCreatorById, getCreatorBySlug, listCreatorMedia } from './portalDb.js';

function sanitizePlainText(val, maxLen = 120) {
  return String(val || '')
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, maxLen);
}

function normalizeComparable(val) {
  return String(val || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

async function resolveCreatorBySlugFallback(rawSlug) {
  const cleanSlug = decodeURIComponent(String(rawSlug || '')).trim().toLowerCase();
  if (!cleanSlug) return null;

  const direct = await getCreatorBySlug(cleanSlug).catch(() => null);
  if (direct) return direct;

  try {
    const byExact = await pool.query(
      `SELECT * FROM creator_accounts WHERE LOWER(TRIM(slug)) = $1 LIMIT 1`,
      [cleanSlug]
    );
    if (byExact.rows[0]) return byExact.rows[0];

    const withoutHexSuffix = cleanSlug.replace(/-[a-f0-9]{4}$/i, '');
    const withoutNumericSuffix = withoutHexSuffix.replace(/-\d+$/, '');
    const baseCandidate = withoutNumericSuffix || withoutHexSuffix;

    if (baseCandidate && baseCandidate !== cleanSlug) {
      const byPrefix = await pool.query(
        `SELECT * FROM creator_accounts
         WHERE LOWER(slug) = $1 OR LOWER(slug) LIKE $2
         ORDER BY active DESC, verified DESC, id DESC
         LIMIT 1`,
        [baseCandidate, `${baseCandidate}-%`]
      );
      if (byPrefix.rows[0]) return byPrefix.rows[0];
    }

    const nameGuess = baseCandidate.replace(/-/g, ' ').trim();
    if (nameGuess) {
      const byName = await pool.query(
        `SELECT * FROM creator_accounts
         WHERE LOWER(TRANSLATE(TRIM(stage_name), 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuucAAAAAEEEEIIIIOOOOOUUUC')) = $1
         ORDER BY active DESC, verified DESC, id DESC
         LIMIT 1`,
        [nameGuess]
      );
      if (byName.rows[0]) return byName.rows[0];
    }
  } catch {}

  return null;
}

async function isImpersonatingCreator(nameOrEmail) {
  const clean = normalizeComparable(nameOrEmail);
  if (!clean) return false;

  try {
    const res = await pool.query(
      `SELECT 1
       FROM creator_accounts
       WHERE LOWER(TRANSLATE(TRIM(COALESCE(stage_name, '')), 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuucAAAAAEEEEIIIIOOOOOUUUC')) = $1
          OR LOWER(TRIM(COALESCE(email, ''))) = $1
       LIMIT 1`,
      [clean]
    );
    return res.rows.length > 0;
  } catch {
    return false;
  }
}

function parseVipPlans(raw) {
  const defaults = {
    m1: { de: 48.99, por: 25.99 },
    m2: { de: 89.90, por: 44.99 },
    m3: { de: 129.90, por: 59.99 },
    m12: { de: 399.90, por: 149.99 },
  };
  if (!raw) return defaults;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return defaults; }
  }
  return {
    m1: { de: obj?.m1?.de ?? defaults.m1.de, por: Number(obj?.m1?.por ?? defaults.m1.por) },
    m2: { de: obj?.m2?.de ?? defaults.m2.de, por: Number(obj?.m2?.por ?? defaults.m2.por) },
    m3: { de: obj?.m3?.de ?? defaults.m3.de, por: Number(obj?.m3?.por ?? defaults.m3.por) },
    m12: { de: obj?.m12?.de ?? defaults.m12.de, por: Number(obj?.m12?.por ?? defaults.m12.por) },
  };
}

function planDaysFromKey(planKey) {
  const map = { m1: 30, m2: 60, m3: 90, m12: 365 };
  return map[String(planKey || 'm1').toLowerCase()] || 30;
}

export async function ensureVipTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_posts (
      id SERIAL PRIMARY KEY,
      creator_id INT NOT NULL REFERENCES creator_accounts(id) ON DELETE CASCADE,
      media_type VARCHAR(15) NOT NULL DEFAULT 'photo',
      caption TEXT,
      preview_url TEXT NOT NULL,
      media_url TEXT NOT NULL,
      price NUMERIC(10, 2) NOT NULL DEFAULT 19.90,
      allow_subscription BOOLEAN NOT NULL DEFAULT TRUE,
      likes INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE vip_posts ADD COLUMN IF NOT EXISTS allow_subscription BOOLEAN NOT NULL DEFAULT TRUE;

    CREATE TABLE IF NOT EXISTS vip_subscriptions (
      id SERIAL PRIMARY KEY,
      creator_id INT NOT NULL REFERENCES creator_accounts(id) ON DELETE CASCADE,
      buyer_identifier VARCHAR(120) NOT NULL,
      device_hash VARCHAR(128) NOT NULL,
      price NUMERIC(10, 2) NOT NULL DEFAULT 25.99,
      mp_payment_id VARCHAR(80),
      paid BOOLEAN NOT NULL DEFAULT FALSE,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE vip_subscriptions ADD COLUMN IF NOT EXISTS fan_code VARCHAR(40);
    ALTER TABLE vip_subscriptions ADD COLUMN IF NOT EXISTS fan_nickname VARCHAR(80);
    ALTER TABLE vip_subscriptions ADD COLUMN IF NOT EXISTS item_title VARCHAR(160);

    CREATE TABLE IF NOT EXISTS ppv_unlocks (
      id SERIAL PRIMARY KEY,
      post_id INT NOT NULL REFERENCES vip_posts(id) ON DELETE CASCADE,
      buyer_identifier VARCHAR(120) NOT NULL,
      device_hash VARCHAR(128) NOT NULL,
      price NUMERIC(10, 2) NOT NULL DEFAULT 19.90,
      mp_payment_id VARCHAR(80),
      paid BOOLEAN NOT NULL DEFAULT FALSE,
      views_used INT NOT NULL DEFAULT 0,
      max_views INT NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE ppv_unlocks ADD COLUMN IF NOT EXISTS fan_code VARCHAR(40);
    ALTER TABLE ppv_unlocks ADD COLUMN IF NOT EXISTS fan_nickname VARCHAR(80);
    ALTER TABLE ppv_unlocks ADD COLUMN IF NOT EXISTS item_title VARCHAR(160);

    CREATE TABLE IF NOT EXISTS vip_messages (
      id SERIAL PRIMARY KEY,
      creator_id INT NOT NULL REFERENCES creator_accounts(id) ON DELETE CASCADE,
      subscriber_name VARCHAR(80) NOT NULL,
      device_hash VARCHAR(128),
      message_text TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      creator_reply TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE vip_messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE vip_messages ADD COLUMN IF NOT EXISTS creator_reply TEXT;

    CREATE TABLE IF NOT EXISTS vip_fans (
      id SERIAL PRIMARY KEY,
      fan_code VARCHAR(40) UNIQUE NOT NULL,
      nickname VARCHAR(80),
      full_name VARCHAR(120),
      contact_identifier VARCHAR(140),
      device_hash VARCHAR(128),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE vip_fans ADD COLUMN IF NOT EXISTS nickname VARCHAR(80);
    ALTER TABLE vip_fans ADD COLUMN IF NOT EXISTS full_name VARCHAR(120);
    ALTER TABLE vip_fans ADD COLUMN IF NOT EXISTS contact_identifier VARCHAR(140);
    ALTER TABLE vip_fans ADD COLUMN IF NOT EXISTS device_hash VARCHAR(128);
    ALTER TABLE vip_fans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS vip_plans JSONB;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS cover_video_url TEXT;
  `).catch(() => {});
}

export function registerVipFeedRoutes(app, requireCreatorAuth) {
  if (app.__vipFeedRoutesRegistered) return;
  app.__vipFeedRoutesRegistered = true;

  ensureVipTables();

  app.post('/api/vip/fan-nickname', async (req, reply) => {
    const { fanCode, nickname, contact, deviceHash } = req.body || {};
    const cleanCode = sanitizePlainText(fanCode, 40).toUpperCase();
    const cleanNick = sanitizePlainText(nickname, 60);
    const cleanContact = sanitizePlainText(contact, 120);
    const cleanDev = sanitizePlainText(deviceHash, 128);

    if (!cleanNick || cleanNick.length < 2) {
      return reply.status(400).send({ ok: false, error: 'Informe um apelido com pelo menos 2 caracteres.' });
    }

    if (await isImpersonatingCreator(cleanNick) || await isImpersonatingCreator(cleanContact)) {
      return reply.status(403).send({
        ok: false,
        error: 'Este nome ou contato pertence a uma criadora e não pode ser usado por assinantes.',
      });
    }

    const codeToUse = cleanCode || ('FAN-' + crypto.randomBytes(3).toString('hex').toUpperCase());

    try {
      const existingByCode = await pool.query(
        `SELECT * FROM vip_fans WHERE fan_code = $1 LIMIT 1`,
        [codeToUse]
      );

      if (existingByCode.rows[0]) {
        const current = existingByCode.rows[0];
        const lockedNick = sanitizePlainText(current.nickname || current.full_name, 60);
        if (lockedNick && normalizeComparable(lockedNick) !== normalizeComparable(cleanNick)) {
          return reply.status(409).send({
            ok: false,
            error: 'O apelido já foi definido anteriormente e não pode ser alterado.',
            fan: { ...current, nickname: lockedNick, full_name: lockedNick },
          });
        }

        const updated = await pool.query(
          `UPDATE vip_fans
           SET nickname = COALESCE(NULLIF(TRIM(nickname), ''), $2),
               full_name = COALESCE(NULLIF(TRIM(full_name), ''), $2),
               contact_identifier = COALESCE(NULLIF(TRIM(contact_identifier), ''), $3),
               device_hash = COALESCE(NULLIF(TRIM(device_hash), ''), $4),
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [current.id, cleanNick, cleanContact || null, cleanDev || null]
        );
        const fan = updated.rows[0];
        return reply.send({ ok: true, fan: { ...fan, nickname: fan.nickname || cleanNick, full_name: fan.full_name || cleanNick } });
      }

      const inserted = await pool.query(
        `INSERT INTO vip_fans (fan_code, nickname, full_name, contact_identifier, device_hash)
         VALUES ($1, $2, $2, $3, $4)
         RETURNING *`,
        [codeToUse, cleanNick, cleanContact || null, cleanDev || null]
      );
      return reply.send({ ok: true, fan: inserted.rows[0] });
    } catch (err) {
      app.log.error(err, '[VIP] Erro ao salvar apelido do fã');
      return reply.status(500).send({ ok: false, error: 'Erro ao salvar apelido.' });
    }
  });

  app.get('/api/vip/fan-panel', async (req, reply) => {
    const dev = sanitizePlainText(req.query?.deviceHash, 128);
    if (!dev) return reply.status(400).send({ error: 'deviceHash obrigatório.' });

    const fanRes = await pool.query(
      `SELECT * FROM vip_fans WHERE device_hash = $1 ORDER BY id DESC LIMIT 1`,
      [dev]
    ).catch(() => ({ rows: [] }));

    let fan = fanRes.rows[0] || null;
    if (!fan) {
      const generatedCode = 'FAN-' + dev.slice(0, 6).toUpperCase();
      const created = await pool.query(
        `INSERT INTO vip_fans (fan_code, device_hash)
         VALUES ($1, $2)
         ON CONFLICT (fan_code) DO UPDATE SET device_hash = COALESCE(vip_fans.device_hash, EXCLUDED.device_hash)
         RETURNING *`,
        [generatedCode, dev]
      ).catch(() => ({ rows: [] }));
      fan = created.rows[0] || { fan_code: generatedCode, nickname: '', full_name: '' };
    }

    const subsRes = await pool.query(
      `SELECT s.id, s.creator_id, s.price, s.expires_at, s.created_at,
              c.stage_name AS creator_name, c.slug AS creator_slug, c.city AS creator_city, c.avatar_url AS creator_avatar
       FROM vip_subscriptions s
       LEFT JOIN creator_accounts c ON c.id = s.creator_id
       WHERE s.device_hash = $1 AND s.paid = TRUE
       ORDER BY s.created_at DESC`,
      [dev]
    ).catch(() => ({ rows: [] }));

    const unlocksRes = await pool.query(
      `SELECT u.id, u.post_id, u.price, u.views_used, u.max_views, u.created_at,
              COALESCE(NULLIF(TRIM(u.item_title), ''), p.caption, 'Conteúdo Avulso VIP') AS caption,
              c.stage_name AS creator_name, c.slug AS creator_slug
       FROM ppv_unlocks u
       LEFT JOIN vip_posts p ON p.id = u.post_id
       LEFT JOIN creator_accounts c ON c.id = p.creator_id
       WHERE u.device_hash = $1 AND u.paid = TRUE
       ORDER BY u.created_at DESC`,
      [dev]
    ).catch(() => ({ rows: [] }));

    const nick = sanitizePlainText(fan?.nickname || fan?.full_name, 60);

    return reply.send({
      ok: true,
      fanCode: fan?.fan_code || '',
      nickname: nick,
      fanNickname: nick,
      fan: fan ? { ...fan, nickname: nick, full_name: nick } : null,
      subscriptions: subsRes.rows,
      unlocks: unlocksRes.rows,
    });
  });

  app.get('/api/vip/profile/:slug', async (req, reply) => {
    const creator = await resolveCreatorBySlugFallback(req.params.slug);
    if (!creator) return reply.status(404).send({ error: 'Perfil VIP não encontrado.' });

    const [postsRes, mediaList] = await Promise.all([
      pool.query(
        `SELECT id, creator_id, media_type, caption, preview_url, price, allow_subscription, likes, created_at
         FROM vip_posts
         WHERE creator_id = $1
         ORDER BY id DESC`,
        [creator.id]
      ),
      listCreatorMedia(creator.id, true),
    ]);

    const plans = parseVipPlans(creator.vip_plans);
    const previewPosts = postsRes.rows.length > 0
      ? postsRes.rows
      : mediaList.map((m, idx) => ({
          id: 900000 + m.id,
          creator_id: creator.id,
          media_type: m.media_type === 'video' ? 'video' : 'photo',
          caption: m.caption || 'Conteúdo exclusivo da galeria VIP.',
          preview_url: m.thumbnail_url || m.public_url || creator.avatar_url,
          price: Number(creator.subscription_price || 19.90) + idx * 5,
          allow_subscription: true,
          likes: 180 + idx * 35,
          created_at: m.created_at,
        }));

    return reply.send({
      ok: true,
      creator: {
        ...creator,
        vip_plans: plans,
        vip_monthly_price: plans.m1.por,
        vip_anchor_price: plans.m1.de,
      },
      posts: previewPosts,
    });
  });

  app.get('/api/portal/vip/my-posts', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT id, creator_id, media_type, caption, preview_url, media_url, price, allow_subscription, likes, created_at
       FROM vip_posts
       WHERE creator_id = $1
       ORDER BY id DESC`,
      [req.creator.id]
    );
    return reply.send({ ok: true, posts: rows });
  });

  app.post('/api/portal/vip/posts', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const { mediaType, caption, previewUrl, mediaUrl, price, allowSubscription } = req.body || {};
    const cleanMediaUrl = sanitizePlainText(mediaUrl, 1000);
    if (!cleanMediaUrl) return reply.status(400).send({ error: 'Informe a mídia (mediaUrl).' });

    const cleanPreview = sanitizePlainText(previewUrl, 1000) || req.creator.avatar_url || cleanMediaUrl;
    const cleanPrice = Math.max(1, Number(price || 19.90));
    const type = mediaType === 'video' ? 'video' : 'photo';
    const allowSub = allowSubscription === false || allowSubscription === 'false' ? false : true;

    const res = await pool.query(
      `INSERT INTO vip_posts (creator_id, media_type, caption, preview_url, media_url, price, allow_subscription)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.creator.id, type, sanitizePlainText(caption, 400) || null, cleanPreview, cleanMediaUrl, cleanPrice, allowSub]
    );

    return reply.send({ ok: true, post: res.rows[0] });
  });

  app.delete('/api/portal/vip/posts/:id', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const postId = Number(req.params.id);
    await pool.query(`DELETE FROM vip_posts WHERE id = $1 AND creator_id = $2`, [postId, req.creator.id]);
    return reply.send({ ok: true });
  });

  const handleGetCreatorVipMessages = async (req, reply) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, subscriber_name, message_text,
                COALESCE(is_read, FALSE) AS is_read,
                creator_reply, created_at
         FROM vip_messages
         WHERE creator_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [req.creator.id]
      );
      return reply.send({ ok: true, messages: rows });
    } catch (err) {
      app.log.error(err, '[VIP] Erro ao listar mensagens da criadora');
      return reply.status(500).send({ ok: false, error: 'Erro ao carregar mensagens.' });
    }
  };

  app.get('/api/portal/vip/messages', { preHandler: requireCreatorAuth }, handleGetCreatorVipMessages);
  app.get('/api/portal/creator/vip-messages', { preHandler: requireCreatorAuth }, handleGetCreatorVipMessages);

  app.post('/api/portal/creator/vip-messages/:id/reply', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const msgId = Number(req.params.id);
    const replyText = sanitizePlainText(req.body?.replyText, 600);
    if (!Number.isInteger(msgId) || msgId <= 0) {
      return reply.status(400).send({ ok: false, error: 'Mensagem inválida.' });
    }

    try {
      const res = await pool.query(
        `UPDATE vip_messages
         SET creator_reply = $1, is_read = TRUE
         WHERE id = $2 AND creator_id = $3
         RETURNING id, subscriber_name, message_text, is_read, creator_reply, created_at`,
        [replyText || null, msgId, req.creator.id]
      );
      if (!res.rows[0]) {
        return reply.status(404).send({ ok: false, error: 'Mensagem não encontrada.' });
      }
      return reply.send({ ok: true, message: res.rows[0] });
    } catch (err) {
      app.log.error(err, '[VIP] Erro ao responder mensagem');
      return reply.status(500).send({ ok: false, error: 'Erro ao salvar resposta.' });
    }
  });

  app.post('/api/portal/vip/:slug/messages', async (req, reply) => {
    const creator = await resolveCreatorBySlugFallback(req.params.slug);
    if (!creator) return reply.status(404).send({ error: 'Clube VIP não encontrado.' });

    const { subscriberName, messageText, deviceHash } = req.body || {};
    const cleanText = sanitizePlainText(messageText, 600);
    if (!cleanText) return reply.status(400).send({ error: 'Escreva uma mensagem.' });

    const cleanDev = sanitizePlainText(deviceHash, 128);
    if (!cleanDev) return reply.status(403).send({ error: 'Apenas assinantes VIP podem enviar mensagem.' });

    const subRes = await pool.query(
      `SELECT 1 FROM vip_subscriptions
       WHERE creator_id = $1 AND device_hash = $2 AND paid = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [creator.id, cleanDev]
    );
    if (subRes.rows.length === 0) {
      return reply.status(403).send({ error: 'Apenas assinantes VIP podem enviar mensagem.' });
    }

    const fanRow = (
      await pool.query(
        `SELECT nickname, full_name FROM vip_fans WHERE device_hash = $1 LIMIT 1`,
        [cleanDev]
      ).catch(() => ({ rows: [] }))
    ).rows[0];

    const rawSender = sanitizePlainText(subscriberName, 60);
    if (await isImpersonatingCreator(rawSender)) {
      return reply.status(403).send({
        error: 'Você não pode enviar mensagens usando o nome de uma criadora.',
      });
    }

    const safeName =
      sanitizePlainText(fanRow?.nickname || fanRow?.full_name, 60) ||
      rawSender ||
      'Assinante VIP';

    const ins = await pool.query(
      `INSERT INTO vip_messages (creator_id, subscriber_name, device_hash, message_text, is_read)
       VALUES ($1, $2, $3, $4, FALSE)
       RETURNING id, subscriber_name, message_text, is_read, creator_reply, created_at`,
      [creator.id, safeName, cleanDev, cleanText]
    );

    return reply.send({ ok: true, message: ins.rows[0] });
  });

  app.post('/api/vip/check-access', async (req, reply) => {
    const { creatorId, deviceHash } = req.body || {};
    const cleanDev = sanitizePlainText(deviceHash, 128);
    if (!creatorId || !cleanDev) return reply.send({ subscribed: false, posts: [] });

    const subRes = await pool.query(
      `SELECT id, buyer_identifier, fan_nickname, fan_code, expires_at
       FROM vip_subscriptions
       WHERE creator_id = $1 AND device_hash = $2 AND paid = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY id DESC LIMIT 1`,
      [Number(creatorId), cleanDev]
    );

    if (subRes.rows.length === 0) {
      return reply.send({ subscribed: false, posts: [] });
    }

    const sub = subRes.rows[0];
    const [postsRes, mediaRes] = await Promise.all([
      pool.query(
        `SELECT id, media_type, media_url, preview_url, caption
         FROM vip_posts
         WHERE creator_id = $1 AND allow_subscription = TRUE
         ORDER BY id DESC`,
        [Number(creatorId)]
      ),
      listCreatorMedia(Number(creatorId), true),
    ]);

    const unlockedPosts = postsRes.rows.length > 0
      ? postsRes.rows
      : mediaRes.map((m) => ({
          id: 900000 + m.id,
          media_type: m.media_type === 'video' ? 'video' : 'photo',
          media_url: m.public_url,
          preview_url: m.thumbnail_url || m.public_url,
          caption: m.caption || '',
        }));

    return reply.send({
      subscribed: true,
      buyerLabel: sanitizePlainText(sub.fan_nickname || sub.buyer_identifier, 60) || 'VIP',
      posts: unlockedPosts,
    });
  });

  async function generateVipPix({ amount, description, externalRef, payerEmail }) {
    const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (!token) return null;
    const webhookBase = (process.env.PUBLIC_URL || 'https://zapjob-production.up.railway.app').replace(/\/$/, '');

    const res = await axios.post(
      'https://api.mercadopago.com/v1/payments',
      {
        transaction_amount: Number(amount),
        description,
        payment_method_id: 'pix',
        external_reference: externalRef,
        notification_url: `${webhookBase}/webhook/mercadopago`,
        payer: { email: payerEmail || 'cliente@portalvip.com' },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': `${externalRef}_${Date.now()}`,
        },
      }
    );

    const tx = res.data?.point_of_interaction?.transaction_data;
    if (!tx?.qr_code) return null;
    return { paymentId: res.data.id, qrCode: tx.qr_code, qrCodeBase64: tx.qr_code_base64 || null };
  }

  app.post('/api/vip/subscribe-intent', async (req, reply) => {
    const { creatorId, buyerIdentifier, fanCode, fanNickname, deviceHash, planKey = 'm1', amount } = req.body || {};
    const cleanDev = sanitizePlainText(deviceHash, 128);
    if (!creatorId || !cleanDev) return reply.status(400).send({ error: 'Dados incompletos.' });

    const creator = await getCreatorById(Number(creatorId));
    if (!creator) return reply.status(404).send({ error: 'Criadora não encontrada.' });

    const plans = parseVipPlans(creator.vip_plans);
    const chosen = plans[planKey] || plans.m1;
    const finalPrice = Number(amount || chosen.por || creator.vip_monthly_price || 25.99);
    const days = planDaysFromKey(planKey);
    const itemTitle = `Assinatura VIP (${planKey}) - ${creator.stage_name}`;

    const ins = await pool.query(
      `INSERT INTO vip_subscriptions (creator_id, buyer_identifier, fan_code, fan_nickname, item_title, device_hash, price, paid, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NOW() + ($8 || ' days')::INTERVAL)
       RETURNING id`,
      [
        creator.id,
        sanitizePlainText(buyerIdentifier, 120) || 'Cliente VIP',
        sanitizePlainText(fanCode, 40) || null,
        sanitizePlainText(fanNickname, 60) || 'Cliente VIP',
        itemTitle,
        cleanDev,
        finalPrice,
        String(days),
      ]
    );
    const subId = ins.rows[0].id;

    const pix = await generateVipPix({
      amount: finalPrice,
      description: `Clube VIP - ${creator.stage_name} (${planKey})`,
      externalRef: `vip_sub:${subId}`,
      payerEmail: creator.email,
    });
    if (!pix) return reply.status(500).send({ error: 'Falha ao gerar Pix.' });

    await pool.query(`UPDATE vip_subscriptions SET mp_payment_id = $1 WHERE id = $2`, [String(pix.paymentId), subId]);

    return reply.send({
      ok: true,
      subId,
      boundDevice: cleanDev.slice(0, 8).toUpperCase(),
      qrCode: pix.qrCode,
      qrCodeBase64: pix.qrCodeBase64,
    });
  });

  app.get('/api/vip/sub-status/:subId', async (req, reply) => {
    const res = await pool.query(`SELECT paid FROM vip_subscriptions WHERE id = $1`, [Number(req.params.subId)]);
    return reply.send({ paid: Boolean(res.rows[0]?.paid) });
  });

  app.post('/api/vip/unlock-intent', async (req, reply) => {
    const { postId, price, buyerIdentifier, fanCode, fanNickname, deviceHash } = req.body || {};
    const cleanDev = sanitizePlainText(deviceHash, 128);
    if (!postId || !cleanDev) return reply.status(400).send({ error: 'Dados incompletos.' });

    const pRes = await pool.query(
      `SELECT p.*, c.stage_name, c.email AS creator_email
       FROM vip_posts p
       JOIN creator_accounts c ON c.id = p.creator_id
       WHERE p.id = $1`,
      [Number(postId)]
    );
    const post = pRes.rows[0];
    const finalPrice = Number(price || post?.price || 19.90);
    const itemTitle = sanitizePlainText(post?.caption, 140) || `Conteúdo Avulso VIP #${Number(postId)}`;

    const ins = await pool.query(
      `INSERT INTO ppv_unlocks (post_id, buyer_identifier, fan_code, fan_nickname, item_title, device_hash, price, paid, views_used, max_views)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, 0, 1)
       RETURNING id`,
      [
        Number(postId),
        sanitizePlainText(buyerIdentifier, 120) || 'Cliente VIP',
        sanitizePlainText(fanCode, 40) || null,
        sanitizePlainText(fanNickname, 60) || 'Cliente VIP',
        itemTitle,
        cleanDev,
        finalPrice,
      ]
    );
    const unlockId = ins.rows[0].id;

    const pix = await generateVipPix({
      amount: finalPrice,
      description: `Conteúdo Avulso 1x - ${post?.stage_name || 'VIP'}`,
      externalRef: `vip_ppv:${unlockId}`,
      payerEmail: post?.creator_email,
    });
    if (!pix) return reply.status(500).send({ error: 'Falha ao gerar Pix.' });

    await pool.query(`UPDATE ppv_unlocks SET mp_payment_id = $1 WHERE id = $2`, [String(pix.paymentId), unlockId]);

    return reply.send({
      ok: true,
      unlockId,
      boundDevice: cleanDev.slice(0, 8).toUpperCase(),
      qrCode: pix.qrCode,
      qrCodeBase64: pix.qrCodeBase64,
    });
  });

  app.get('/api/vip/unlock-status/:unlockId', async (req, reply) => {
    const res = await pool.query(`SELECT paid FROM ppv_unlocks WHERE id = $1`, [Number(req.params.unlockId)]);
    return reply.send({ paid: Boolean(res.rows[0]?.paid) });
  });

  app.post('/api/vip/paxum-checkout', async (req, reply) => {
    const businessEmail = String(process.env.PAXUM_BUSINESS_EMAIL || '').trim();
    const sharedSecret = String(process.env.PAXUM_SHARED_SECRET || '').trim();
    if (!businessEmail || !sharedSecret) {
      return reply.status(503).send({
        error: 'Pagamento internacional via Paxum ainda não ativado.',
      });
    }

    try {
      const { mode = 'sub', creatorId, postId = 0, price, buyerIdentifier, fanCode, fanNickname, deviceHash, currency = 'USD' } = req.body || {};
      const cleanDev = sanitizePlainText(deviceHash, 128);
      if (!creatorId || !cleanDev) return reply.status(400).send({ error: 'Dados incompletos.' });

      const creator = await getCreatorById(Number(creatorId));
      if (!creator) return reply.status(404).send({ error: 'Criadora não encontrada.' });

      const baseUrl = (process.env.PUBLIC_URL || 'https://zapjob-production.up.railway.app').replace(/\/$/, '');
      const cleanCurrency = ['USD', 'EUR', 'GBP'].includes(String(currency).toUpperCase())
        ? String(currency).toUpperCase()
        : 'USD';

      const amountNum = Math.max(2, Number(price || creator.vip_monthly_price || 14.99));
      const safeBuyer = sanitizePlainText(buyerIdentifier, 120) || 'VIP Fan';
      const safeCode = sanitizePlainText(fanCode, 40) || null;
      const safeNick = sanitizePlainText(fanNickname, 60) || 'VIP Fan';

      let reference = '';
      let subId = 0;
      let unlockId = 0;

      if (mode === 'ppv' && Number(postId) > 0) {
        const pRes = await pool.query(`SELECT caption FROM vip_posts WHERE id = $1`, [Number(postId)]);
        const itemTitle = sanitizePlainText(pRes.rows[0]?.caption, 140) || `VIP Single Unlock #${Number(postId)}`;
        const ins = await pool.query(
          `INSERT INTO ppv_unlocks (post_id, buyer_identifier, fan_code, fan_nickname, item_title, device_hash, price, paid, views_used, max_views)
           VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, 0, 1)
           RETURNING id`,
          [Number(postId), safeBuyer, safeCode, safeNick, itemTitle, cleanDev, amountNum]
        );
        unlockId = ins.rows[0].id;
        reference = `vip_ppv:${unlockId}`;
      } else {
        const itemTitle = `VIP Pass - ${creator.stage_name}`;
        const ins = await pool.query(
          `INSERT INTO vip_subscriptions (creator_id, buyer_identifier, fan_code, fan_nickname, item_title, device_hash, price, paid, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NOW() + INTERVAL '30 days')
           RETURNING id`,
          [creator.id, safeBuyer, safeCode, safeNick, itemTitle, cleanDev, amountNum]
        );
        subId = ins.rows[0].id;
        reference = `vip_sub:${subId}`;
      }

      const cleanAmount = amountNum.toFixed(2);
      const rawSig = `${businessEmail}${cleanAmount}${cleanCurrency}${reference}${sharedSecret}`;
      const signature = crypto.createHash('sha256').update(rawSig).digest('hex');

      const isSandbox = String(process.env.PAXUM_SANDBOX || '').toLowerCase() === 'true';
      const paxumUrl = isSandbox
        ? 'https://sandbox.paxum.com/payment/phrame.php'
        : 'https://www.paxum.com/payment/phrame.php';

      const params = new URLSearchParams({
        view: 'payment',
        business_email: businessEmail,
        amount: cleanAmount,
        currency: cleanCurrency,
        item_name: mode === 'ppv' ? `VIP Single Unlock - ${creator.stage_name}` : `VIP Club Access - ${creator.stage_name}`,
        button_type_id: '1',
        variables: `custom=${reference}`,
        return: `${baseUrl}/vip/${encodeURIComponent(creator.slug)}?paxum_paid=1&subId=${subId}&unlockId=${unlockId}`,
        cancel_return: `${baseUrl}/vip/${encodeURIComponent(creator.slug)}?paxum_canceled=1`,
        notify_url: `${baseUrl}/webhook/paxum`,
        key: signature,
      });

      return reply.send({
        ok: true,
        subId,
        unlockId,
        checkoutUrl: `${paxumUrl}?${params.toString()}`,
      });
    } catch (err) {
      app.log.error(err, '[Paxum VIP] Erro ao criar checkout');
      return reply.status(500).send({ error: err?.message || 'Erro ao criar checkout Paxum.' });
    }
  });

  app.get('/clube-vip/:slug', async (req, reply) => {
    return reply.redirect('/vip/' + encodeURIComponent(req.params.slug));
  });
}
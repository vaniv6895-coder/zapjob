import { pool } from './db.js';
import { getCreatorBySlug } from './portalDb.js';
import { createVipPpvPix, getMercadoPagoPayment } from './mercadopago.js';

export async function ensureVipTables() {
  await pool.query(`
    ALTER TABLE creator_accounts
      ADD COLUMN IF NOT EXISTS vip_monthly_price NUMERIC(10,2) DEFAULT 49.90;

    CREATE TABLE IF NOT EXISTS vip_posts (
      id SERIAL PRIMARY KEY,
      creator_id INTEGER NOT NULL,
      caption TEXT,
      media_type VARCHAR(20) NOT NULL DEFAULT 'image',
      media_url TEXT NOT NULL,
      preview_url TEXT,
      price NUMERIC(10,2) NOT NULL DEFAULT 19.90,
      single_view BOOLEAN DEFAULT TRUE,
      allow_subscription BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ppv_unlocks (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL,
      buyer_identifier VARCHAR(120) NOT NULL,
      device_hash VARCHAR(128) NOT NULL,
      pix_txid VARCHAR(120) UNIQUE,
      price NUMERIC(10,2) DEFAULT 19.90,
      paid BOOLEAN DEFAULT FALSE,
      viewed BOOLEAN DEFAULT FALSE,
      viewed_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vip_subscriptions (
      id SERIAL PRIMARY KEY,
      creator_id INTEGER NOT NULL,
      buyer_identifier VARCHAR(120) NOT NULL,
      device_hash VARCHAR(128) NOT NULL,
      pix_txid VARCHAR(120) UNIQUE,
      price NUMERIC(10,2) NOT NULL DEFAULT 49.90,
      paid BOOLEAN DEFAULT FALSE,
      expires_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

export function registerVipFeedRoutes(app, requireCreatorAuth) {
  // =========================================================================
  // 1. CRIADORA: Métricas, Ganhos e Publicação no Feed VIP
  // =========================================================================
  if (requireCreatorAuth) {
    app.get('/api/vip/earnings', { preHandler: requireCreatorAuth }, async (req, reply) => {
      const creatorId = req.creator.id;

      const subsRes = await pool.query(
        `SELECT 
           COALESCE(SUM(price), 0)::numeric AS total_subs,
           COUNT(*)::int AS count_subs
         FROM vip_subscriptions
         WHERE creator_id = $1 AND paid = TRUE`,
        [creatorId]
      );

      const ppvRes = await pool.query(
        `SELECT 
           COALESCE(SUM(u.price), 0)::numeric AS total_ppv,
           COUNT(*)::int AS count_ppv
         FROM ppv_unlocks u
         JOIN vip_posts p ON p.id = u.post_id
         WHERE p.creator_id = $1 AND u.paid = TRUE`,
        [creatorId]
      );

      const dailyRes = await pool.query(
        `WITH days AS (
           SELECT generate_series(
             CURRENT_DATE - INTERVAL '6 days',
             CURRENT_DATE,
             '1 day'::interval
           )::date AS day
         ),
         sub_daily AS (
           SELECT DATE(created_at) AS day, SUM(price) AS amount
           FROM vip_subscriptions
           WHERE creator_id = $1 AND paid = TRUE AND created_at >= CURRENT_DATE - INTERVAL '6 days'
           GROUP BY DATE(created_at)
         ),
         ppv_daily AS (
           SELECT DATE(u.created_at) AS day, SUM(u.price) AS amount
           FROM ppv_unlocks u
           JOIN vip_posts p ON p.id = u.post_id
           WHERE p.creator_id = $1 AND u.paid = TRUE AND u.created_at >= CURRENT_DATE - INTERVAL '6 days'
           GROUP BY DATE(u.created_at)
         )
         SELECT 
           TO_CHAR(d.day, 'DD/MM') AS label,
           (COALESCE(s.amount, 0) + COALESCE(v.amount, 0))::numeric AS total
         FROM days d
         LEFT JOIN sub_daily s ON s.day = d.day
         LEFT JOIN ppv_daily v ON v.day = d.day
         ORDER BY d.day ASC`,
        [creatorId]
      );

      const totalSubs = Number(subsRes.rows[0]?.total_subs || 0);
      const totalPpv = Number(ppvRes.rows[0]?.total_ppv || 0);

      return reply.send({
        ok: true,
        totalAll: totalSubs + totalPpv,
        totalSubs,
        countSubs: subsRes.rows[0]?.count_subs || 0,
        totalPpv,
        countPpv: ppvRes.rows[0]?.count_ppv || 0,
        daily: dailyRes.rows.map((r) => ({
          label: r.label,
          total: Number(r.total || 0),
        })),
      });
    });

    app.post('/api/vip/posts', { preHandler: requireCreatorAuth }, async (req, reply) => {
      const { caption, mediaType, mediaUrl, previewUrl, price, singleView, allowSubscription } = req.body || {};
      if (!mediaUrl) {
        return reply.status(400).send({ error: 'Arquivo de mídia obrigatório.' });
      }

      const finalPrice = Number(price) > 0 ? Number(price) : 29.90;
      const isSingle = singleView !== false;
      const allowSub = allowSubscription !== false;

      const { rows } = await pool.query(
        `INSERT INTO vip_posts (creator_id, caption, media_type, media_url, preview_url, price, single_view, allow_subscription)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          req.creator.id,
          (caption || '').trim(),
          mediaType || 'image',
          mediaUrl,
          previewUrl || mediaUrl,
          finalPrice,
          isSingle,
          allowSub,
        ]
      );

      return reply.send({ ok: true, post: rows[0] });
    });

    app.get('/api/vip/my-posts', { preHandler: requireCreatorAuth }, async (req, reply) => {
      const { rows } = await pool.query(
        `SELECT * FROM vip_posts WHERE creator_id = $1 ORDER BY id DESC LIMIT 50`,
        [req.creator.id]
      );
      return reply.send({ ok: true, posts: rows });
    });

    app.delete('/api/vip/posts/:id', { preHandler: requireCreatorAuth }, async (req, reply) => {
      await pool.query(`DELETE FROM vip_posts WHERE id = $1 AND creator_id = $2`, [
        Number(req.params.id),
        req.creator.id,
      ]);
      return reply.send({ ok: true });
    });
  }

  // =========================================================================
  // 2. ASSINATURA MENSAL (30 DIAS VINCULADA AO APARELHO)
  // =========================================================================
  app.post('/api/vip/subscribe-intent', async (req, reply) => {
    const { creatorId, buyerIdentifier, deviceHash } = req.body || {};
    if (!creatorId || !deviceHash) {
      return reply.status(400).send({ error: 'Dados do aparelho ausentes.' });
    }

    const { rows: cRows } = await pool.query(
      `SELECT stage_name, vip_monthly_price FROM creator_accounts WHERE id = $1`,
      [creatorId]
    );
    if (!cRows[0]) return reply.status(404).send({ error: 'Criadora não encontrada.' });

    const monthlyPrice = Number(cRows[0].vip_monthly_price) || 49.90;
    const buyer = (buyerIdentifier || 'Assinante VIP').trim();

    const { rows } = await pool.query(
      `INSERT INTO vip_subscriptions (creator_id, buyer_identifier, device_hash, price, paid)
       VALUES ($1, $2, $3, $4, FALSE)
       RETURNING id`,
      [creatorId, buyer, deviceHash, monthlyPrice]
    );

    const subId = rows[0].id;
    const pix = await createVipPpvPix({
      unlockId: subId,
      priceBr: monthlyPrice,
      description: `Assinatura 30d - ${cRows[0].stage_name}`,
      customExternalRef: `vip_sub:${subId}`,
    });

    if (!pix) {
      return reply.status(500).send({ error: 'Erro ao gerar Pix da assinatura.' });
    }

    await pool.query(`UPDATE vip_subscriptions SET pix_txid = $1 WHERE id = $2`, [String(pix.paymentId), subId]);

    return reply.send({
      ok: true,
      subId,
      qrCode: pix.qrCode,
      qrCodeBase64: pix.qrCodeBase64,
      amount: pix.amount,
      boundDevice: deviceHash.slice(0, 8).toUpperCase(),
    });
  });

  app.get('/api/vip/sub-status/:subId', async (req, reply) => {
    const subId = Number(req.params.subId);
    if (!subId) return reply.status(400).send({ paid: false });

    const { rows } = await pool.query(`SELECT id, paid, pix_txid FROM vip_subscriptions WHERE id = $1`, [subId]);
    const row = rows[0];
    if (!row) return reply.status(404).send({ paid: false });

    if (row.paid) return reply.send({ paid: true });

    if (row.pix_txid) {
      const mp = await getMercadoPagoPayment(row.pix_txid);
      if (mp && mp.status === 'approved') {
        await pool.query(
          `UPDATE vip_subscriptions SET paid = TRUE, expires_at = NOW() + INTERVAL '30 days' WHERE id = $1`,
          [subId]
        );
        return reply.send({ paid: true });
      }
    }

    return reply.send({ paid: false });
  });

  app.post('/api/vip/check-access', async (req, reply) => {
    const { creatorId, deviceHash } = req.body || {};
    if (!creatorId || !deviceHash) return reply.send({ subscribed: false, posts: [] });

    const { rows: subRows } = await pool.query(
      `SELECT id, buyer_identifier, expires_at
       FROM vip_subscriptions
       WHERE creator_id = $1 AND device_hash = $2 AND paid = TRUE AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`,
      [creatorId, deviceHash]
    );

    if (subRows.length === 0) {
      return reply.send({ subscribed: false, posts: [] });
    }

    const { rows: posts } = await pool.query(
      `SELECT id, caption, media_type, media_url, created_at
       FROM vip_posts
       WHERE creator_id = $1 AND allow_subscription = TRUE
       ORDER BY id DESC`,
      [creatorId]
    );

    return reply.send({
      subscribed: true,
      buyerLabel: subRows[0].buyer_identifier,
      expiresAt: subRows[0].expires_at,
      posts,
    });
  });

  // =========================================================================
  // 3. PAY-PER-VIEW (VISUALIZAÇÃO ÚNICA AVULSA)
  // =========================================================================
  app.post('/api/vip/unlock-intent', async (req, reply) => {
    const { postId, price, buyerIdentifier, deviceHash } = req.body || {};
    if (!postId || !deviceHash) {
      return reply.status(400).send({ error: 'Dados do dispositivo ausentes.' });
    }

    const { rows: postRows } = await pool.query(`SELECT price FROM vip_posts WHERE id = $1`, [postId]);
    const finalPrice = postRows[0]?.price || Number(price) || 29.90;
    const buyer = (buyerIdentifier || 'Cliente VIP').trim();

    const { rows } = await pool.query(
      `INSERT INTO ppv_unlocks (post_id, buyer_identifier, device_hash, price, paid, viewed)
       VALUES ($1, $2, $3, $4, FALSE, FALSE)
       RETURNING id`,
      [postId, buyer, deviceHash, finalPrice]
    );

    const unlockId = rows[0].id;
    const pix = await createVipPpvPix({
      unlockId,
      priceBr: finalPrice,
      description: `Conteudo VIP #${postId} (1x)`,
      customExternalRef: `vip_ppv:${unlockId}`,
    });

    if (!pix) {
      return reply.status(500).send({ error: 'Falha ao gerar cobrança Pix no Mercado Pago.' });
    }

    await pool.query(`UPDATE ppv_unlocks SET pix_txid = $1 WHERE id = $2`, [String(pix.paymentId), unlockId]);

    return reply.send({
      ok: true,
      unlockId,
      paymentId: pix.paymentId,
      qrCode: pix.qrCode,
      qrCodeBase64: pix.qrCodeBase64,
      amount: pix.amount,
      boundDevice: deviceHash.slice(0, 8).toUpperCase(),
    });
  });

  app.get('/api/vip/unlock-status/:unlockId', async (req, reply) => {
    const unlockId = Number(req.params.unlockId);
    if (!unlockId) return reply.status(400).send({ paid: false });

    const { rows } = await pool.query(`SELECT id, paid, viewed, pix_txid FROM ppv_unlocks WHERE id = $1`, [unlockId]);
    const row = rows[0];
    if (!row) return reply.status(404).send({ paid: false });

    if (row.paid) return reply.send({ paid: true, viewed: row.viewed });

    if (row.pix_txid) {
      const mp = await getMercadoPagoPayment(row.pix_txid);
      if (mp && mp.status === 'approved') {
        await pool.query(`UPDATE ppv_unlocks SET paid = TRUE WHERE id = $1`, [unlockId]);
        return reply.send({ paid: true, viewed: row.viewed });
      }
    }

    return reply.send({ paid: false, viewed: row.viewed });
  });

  app.post('/api/vip/consume-once', async (req, reply) => {
    const { postId, unlockId, deviceHash } = req.body || {};
    if (!postId || !unlockId || !deviceHash) {
      return reply.status(400).send({ error: 'Requisição inválida.' });
    }

    const { rows } = await pool.query(
      `SELECT u.*, p.media_url, p.media_type, p.single_view
       FROM ppv_unlocks u
       LEFT JOIN vip_posts p ON p.id = u.post_id
       WHERE u.id = $1 AND u.post_id = $2`,
      [unlockId, postId]
    );

    const unlock = rows[0];
    if (!unlock) return reply.status(404).send({ error: 'Compra não encontrada.' });
    if (!unlock.paid) return reply.status(402).send({ error: 'Pagamento Pix ainda não confirmado.' });
    if (unlock.device_hash !== deviceHash) {
      return reply.status(403).send({
        error: 'Acesso bloqueado: este conteúdo está vinculado exclusivamente ao celular que realizou a compra.',
      });
    }
    if (unlock.single_view !== false && unlock.viewed) {
      return reply.status(410).send({
        error: 'Este conteúdo de visualização única já foi aberto e expirou.',
      });
    }

    await pool.query(`UPDATE ppv_unlocks SET viewed = TRUE, viewed_at = NOW() WHERE id = $1`, [unlock.id]);

    const fallbackUrl =
      Number(postId) === 102
        ? 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4'
        : 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=900&q=85';

    return reply.send({
      ok: true,
      mediaUrl: unlock.media_url || fallbackUrl,
      mediaType: unlock.media_type || (Number(postId) === 102 ? 'video' : 'image'),
      buyerLabel: unlock.buyer_identifier,
    });
  });

  // =========================================================================
  // 4. API DE DADOS E ENTREGA DO HTML EXTERNO (public/clube-vip.html)
  // =========================================================================
  app.get('/api/vip/profile/:slug', async (req, reply) => {
    const slug = String(req.params.slug || '').trim().toLowerCase();

    const creator =
      slug === 'demo'
        ? {
            id: 0,
            slug: 'demo',
            stage_name: 'Valentina Luxo',
            city: 'Cuiabá',
            state: 'MT',
            avatar_url: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=400&q=85',
            cover_url: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=1000&q=85',
            bio: 'Conteúdo exclusivo sem censura, ensaios íntimos e vídeos gravados diariamente só para assinantes VIP 🔥😈',
            vip_monthly_price: 49.90,
          }
        : await getCreatorBySlug(slug);

    if (!creator) return reply.status(404).send({ error: 'Criadora não encontrada' });

    const { rows: dbPosts } =
      creator.id > 0
        ? await pool.query(`SELECT * FROM vip_posts WHERE creator_id = $1 ORDER BY id DESC`, [creator.id])
        : { rows: [] };

    const posts =
      dbPosts.length > 0
        ? dbPosts
        : [
            {
              id: 101,
              caption: 'Ensaio completo no quarto sem censura 🔥✨ (Incluso na assinatura ou desbloqueio avulso 1x)',
              media_type: 'image',
              preview_url: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=700&q=70',
              price: 29.90,
              allow_subscription: true,
              likes: 342,
            },
            {
              id: 102,
              caption: 'Vídeo íntimo exclusivo gravado hoje à noite 😈 Só abre 1 vez no avulso ou ilimitado para assinantes!',
              media_type: 'video',
              preview_url: 'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=700&q=70',
              price: 49.90,
              allow_subscription: true,
              likes: 518,
            },
          ];

    return reply.send({ ok: true, creator, posts });
  });

  app.get('/vip/:slug', async (req, reply) => {
    return reply.sendFile('clube-vip.html');
  });
}
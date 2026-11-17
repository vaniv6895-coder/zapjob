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
  // 1. CRIADORA: Publicar novo post no Feed VIP (/api/vip/posts)
  // =========================================================================
  if (requireCreatorAuth) {

    // Métricas Financeiras e Gráfico de Ganhos do Clube VIP
    app.get('/api/vip/earnings', { preHandler: requireCreatorAuth }, async (req, reply) => {
      const creatorId = req.creator.id;

      // 1. Soma ganhos de Assinaturas Mensais pagas
      const subsRes = await pool.query(
        `SELECT 
           COALESCE(SUM(price), 0)::numeric AS total_subs,
           COUNT(*)::int AS count_subs
         FROM vip_subscriptions
         WHERE creator_id = $1 AND paid = TRUE`,
        [creatorId]
      );

      // 2. Soma ganhos de Posts Avulsos (PPV Visualização Única) pagos
      const ppvRes = await pool.query(
        `SELECT 
           COALESCE(SUM(u.price), 0)::numeric AS total_ppv,
           COUNT(*)::int AS count_ppv
         FROM ppv_unlocks u
         JOIN vip_posts p ON p.id = u.post_id
         WHERE p.creator_id = $1 AND u.paid = TRUE`,
        [creatorId]
      );

      // 3. Faturamento diário dos últimos 7 dias (Assinaturas + PPV)
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
          total: Number(r.total || 0)
        }))
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
          allowSub
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
        req.creator.id
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
      customExternalRef: `vip_sub:${subId}`
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
      boundDevice: deviceHash.slice(0, 8).toUpperCase()
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

  // Verifica se o aparelho atual possui assinatura ativa para a criadora e devolve posts liberados
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
      posts
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
      customExternalRef: `vip_ppv:${unlockId}`
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
      boundDevice: deviceHash.slice(0, 8).toUpperCase()
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
        error: 'Acesso bloqueado: este conteúdo está vinculado exclusivamente ao celular que realizou a compra.'
      });
    }
    if (unlock.single_view !== false && unlock.viewed) {
      return reply.status(410).send({
        error: 'Este conteúdo de visualização única já foi aberto e expirou.'
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
      buyerLabel: unlock.buyer_identifier
    });
  });

  // =========================================================================
  // 4. PÁGINA EXCLUSIVA ESTILO ONLYFANS (/vip/:slug)
  // =========================================================================
  app.get('/vip/:slug', async (req, reply) => {
    const creator = await getCreatorBySlug(req.params.slug);
    if (!creator) {
      return reply.status(404).send('Criadora não encontrada.');
    }

    const monthlyPrice = Number(creator.vip_monthly_price) || 49.90;

    const { rows: dbPosts } = await pool.query(
      `SELECT * FROM vip_posts WHERE creator_id = $1 ORDER BY id DESC`,
      [creator.id]
    );

    const posts =
      dbPosts.length > 0
        ? dbPosts
        : [
            {
              id: 101,
              caption: 'Ensaio exclusivo sem censura no quarto 🔥 (Incluso na assinatura ou visualização única)',
              media_type: 'image',
              preview_url: creator.avatar_url || 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=600&q=60',
              price: 29.90,
              allow_subscription: true
            },
            {
              id: 102,
              caption: 'Vídeo íntimo gravado hoje à noite 😈 Só abre 1 vez no avulso ou ilimitado para assinantes!',
              media_type: 'video',
              preview_url: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=600&q=60',
              price: 49.90,
              allow_subscription: true
            }
          ];

    const postsHtml = posts
      .map(
        (p) => `
      <article id="vip-post-card-${p.id}" style="background:#fff;border:1px solid #e2e9ed;border-radius:14px;overflow:hidden;margin-bottom:18px;">
        <div style="padding:14px 16px;display:flex;align-items:center;gap:10px;">
          <img src="${creator.avatar_url || 'https://placehold.co/80x80'}" style="width:42px;height:42px;border-radius:50%;object-fit:cover;" />
          <div>
            <strong style="display:block;font-size:14px;color:#263238;">${creator.stage_name}</strong>
            <span style="font-size:11px;color:#e25352;font-weight:700;">
              ${p.allow_subscription !== false ? '👑 Assinantes ou 🔥 Visualização Única' : '🔥 Exclusivo PPV (Visualização Única)'}
            </span>
          </div>
        </div>
        <p style="padding:0 16px 12px;font-size:13px;color:#455a64;">${p.caption || ''}</p>
        <div id="vip-media-slot-${p.id}" style="position:relative;aspect-ratio:4/5;background:#111;overflow:hidden;display:flex;align-items:center;justify-content:center;">
          <img src="${p.preview_url || creator.avatar_url}" style="width:100%;height:100%;object-fit:cover;filter:blur(26px) brightness(0.65);transform:scale(1.1);" />
          <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;text-align:center;color:#fff;">
            <div style="font-size:38px;margin-bottom:8px;">🔒</div>
            <strong style="font-size:16px;margin-bottom:4px;">Conteúdo Exclusivo VIP</strong>
            <span style="font-size:12px;color:#cbd5e1;max-width:260px;margin-bottom:16px;">
              Desbloqueie avulso (1x) ou assine o perfil mensal para liberar todo o feed.
            </span>
            <button id="ppv-btn-${p.id}" onclick="comprarPostUnico(${p.id}, ${Number(p.price).toFixed(2)})" style="background:#e25352;color:#fff;border:none;padding:12px 20px;border-radius:99px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(226,83,82,0.4);">
              🔥 Desbloquear 1x (R$ ${Number(p.price).toFixed(2).replace('.', ',')})
            </button>
          </div>
        </div>
      </article>`
      )
      .join('');

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Clube VIP - ${creator.stage_name}</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    .pix-modal { position:fixed; inset:0; background:rgba(15,23,42,0.85); z-index:9999; display:none; align-items:center; justify-content:center; padding:16px; }
    .pix-modal.open { display:flex; }
    .pix-box { background:#fff; border-radius:16px; padding:24px; max-width:380px; width:100%; text-align:center; box-shadow:0 12px 32px rgba(0,0,0,0.35); }
    .pix-code-input { width:100%; padding:10px; border:1px solid #cbd5e1; border-radius:8px; font-size:11px; margin:12px 0; background:#f8fafc; }
  </style>
</head>
<body style="margin:0;background:#eceff1;font-family:'Montserrat',sans-serif;color:#263238;">
  <header style="background:#fff;padding:14px 16px;border-bottom:1px solid #e2e9ed;position:sticky;top:0;z-index:40;display:flex;justify-content:space-between;align-items:center;">
    <a href="/acompanhante/${creator.slug}" style="text-decoration:none;color:#263238;font-weight:700;font-size:13px;">← Perfil</a>
    <strong style="font-size:15px;">CLUBE <span style="color:#e25352;">VIP</span></strong>
    <span id="dev-badge" style="font-size:10px;background:#f1f5f9;padding:4px 8px;border-radius:6px;color:#64748b;">Aparelho Protegido</span>
  </header>

  <main style="max-width:540px;margin:16px auto;padding:0 14px 40px;">
    <!-- Banner de Assinatura Mensal Estilo OnlyFans -->
    <section id="sub-banner" style="background:linear-gradient(135deg,#1e293b,#0f172a);color:#fff;border-radius:16px;padding:18px;margin-bottom:18px;box-shadow:0 8px 24px rgba(15,23,42,0.2);">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <img src="${creator.avatar_url || 'https://placehold.co/100x100'}" style="width:54px;height:54px;border-radius:50%;object-fit:cover;border:2px solid #e25352;" />
        <div>
          <strong style="font-size:16px;display:block;">${creator.stage_name}</strong>
          <span style="font-size:12px;color:#94a3b8;">Acesso ilimitado por 30 dias neste aparelho</span>
        </div>
      </div>
      <button id="btn-subscribe-month" onclick="assinarMensal()" style="width:100%;padding:13px;border:none;border-radius:99px;background:linear-gradient(90deg,#e25352,#ec4899);color:#fff;font-family:inherit;font-size:14px;font-weight:800;cursor:pointer;">
        👑 Assinar VIP (30 Dias) — R$ ${monthlyPrice.toFixed(2).replace('.', ',')}
      </button>
    </section>

    ${postsHtml}
  </main>

  <!-- Modal Checkout Pix -->
  <div id="pix-modal" class="pix-modal">
    <div class="pix-box">
      <div style="font-size:28px;margin-bottom:6px;">💠</div>
      <h3 id="pix-modal-title" style="margin:0 0 6px;font-size:17px;">Pagamento Pix Instantâneo</h3>
      <p id="pix-device-note" style="font-size:11px;color:#64748b;margin-bottom:12px;"></p>
      <img id="pix-qr-img" src="" style="width:200px;height:200px;border:1px solid #e2e8f0;border-radius:10px;display:none;margin:0 auto;" />
      <input id="pix-copy-text" class="pix-code-input" readonly />
      <button onclick="copiarPix()" style="width:100%;padding:12px;border:none;border-radius:10px;background:#389e47;color:#fff;font-weight:700;font-size:14px;cursor:pointer;">
        📋 Copiar Código Pix
      </button>
      <div style="margin-top:12px;font-size:12px;font-weight:700;color:#e25352;">
        ⏳ Aguardando confirmação automática...
      </div>
      <button onclick="fecharPixModal()" style="margin-top:12px;background:transparent;border:none;color:#64748b;font-size:12px;cursor:pointer;">
        Cancelar
      </button>
    </div>
  </div>

  <script src="/vip-shield.js"></script>
  <script src="/device-id.js"></script>
  <script>
    const CREATOR_ID = ${creator.id};
    let statusPoll = null;

    window.addEventListener('DOMContentLoaded', async () => {
      const hash = await window.getDeviceHash();
      document.getElementById('dev-badge').innerText = 'ID: ' + hash.slice(0, 6).toUpperCase();
      await verificarAssinaturaAtiva(hash);
    });

    async function verificarAssinaturaAtiva(deviceHash) {
      const res = await fetch('/api/vip/check-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorId: CREATOR_ID, deviceHash })
      });
      const data = await res.json();
      if (!data.subscribed) return;

      const subBtn = document.getElementById('btn-subscribe-month');
      subBtn.style.background = '#389e47';
      subBtn.innerText = '✅ Assinatura VIP Ativa neste Aparelho';
      subBtn.disabled = true;

      // Desbloqueia automaticamente todos os posts incluídos na assinatura com VIP Shield
      (data.posts || []).forEach(p => {
        const slot = document.getElementById('vip-media-slot-' + p.id);
        if (!slot) return;
        slot.className = 'vip-protected-wrap';
        slot.innerHTML = p.media_type === 'video'
          ? \`<video src="\${p.media_url}" controls playsinline style="width:100%;height:100%;object-fit:cover;"></video>\`
          : \`<img src="\${p.media_url}" data-vip-canvas="1" style="width:100%;height:100%;object-fit:cover;" />\`;
      });

      if (typeof window.applyVipShield === 'function') {
        window.applyVipShield(data.buyerLabel + ' • DEV:' + deviceHash.slice(0, 8).toUpperCase());
      }
    }

    function fecharPixModal() {
      clearInterval(statusPoll);
      document.getElementById('pix-modal').classList.remove('open');
    }

    function copiarPix() {
      const inp = document.getElementById('pix-copy-text');
      inp.select();
      navigator.clipboard.writeText(inp.value);
      alert('Código Pix Copia e Cola copiado!');
    }

    function abrirModalPix(data, title) {
      document.getElementById('pix-modal-title').innerText = title;
      document.getElementById('pix-device-note').innerText =
        'Vinculado exclusivamente a este celular (ID: ' + data.boundDevice + ')';
      document.getElementById('pix-copy-text').value = data.qrCode;

      const qrImg = document.getElementById('pix-qr-img');
      if (data.qrCodeBase64) {
        qrImg.src = 'data:image/png;base64,' + data.qrCodeBase64;
        qrImg.style.display = 'block';
      } else {
        qrImg.style.display = 'none';
      }
      document.getElementById('pix-modal').classList.add('open');
    }

    async function assinarMensal() {
      const buyer = prompt('Digite seu e-mail ou WhatsApp para ativar sua assinatura de 30 dias:');
      if (!buyer) return;

      const deviceHash = await window.getDeviceHash();
      const res = await fetch('/api/vip/subscribe-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorId: CREATOR_ID, buyerIdentifier: buyer, deviceHash })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) return alert(data.error || 'Erro ao gerar Pix.');

      abrirModalPix(data, 'Assinatura Mensal VIP (30 dias)');

      clearInterval(statusPoll);
      statusPoll = setInterval(async () => {
        const st = await fetch('/api/vip/sub-status/' + data.subId).then(r => r.json());
        if (st.paid) {
          clearInterval(statusPoll);
          document.getElementById('pix-modal').classList.remove('open');
          await verificarAssinaturaAtiva(deviceHash);
        }
      }, 3000);
    }

    async function comprarPostUnico(postId, price) {
      const buyer = prompt('Digite seu e-mail ou WhatsApp para carimbar sua compra:');
      if (!buyer) return;

      const btn = document.getElementById('ppv-btn-' + postId);
      const oldText = btn.innerText;
      btn.innerText = 'Gerando Pix...';
      btn.disabled = true;

      try {
        const deviceHash = await window.getDeviceHash();
        const res = await fetch('/api/vip/unlock-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postId, price, buyerIdentifier: buyer, deviceHash })
        });
        const data = await res.json();

        btn.innerText = oldText;
        btn.disabled = false;

        if (!res.ok || !data.ok) return alert(data.error || 'Erro ao gerar Pix.');

        abrirModalPix(data, 'Desbloquear Visualização Única (1x)');

        clearInterval(statusPoll);
        statusPoll = setInterval(async () => {
          const st = await fetch('/api/vip/unlock-status/' + data.unlockId).then(r => r.json());
          if (st.paid) {
            clearInterval(statusPoll);
            document.getElementById('pix-modal').classList.remove('open');
            btn.style.background = '#389e47';
            btn.innerText = '🔥 Abrir Visualização Única Agora';
            btn.onclick = () => window.openSingleViewPost(postId, data.unlockId);
          }
        }, 3000);
      } catch (e) {
        btn.innerText = oldText;
        btn.disabled = false;
        alert('Erro de conexão ao gerar Pix.');
      }
    }
  </script>
</body>
</html>`;

    return reply.type('text/html; charset=utf-8').send(html);
  });
}
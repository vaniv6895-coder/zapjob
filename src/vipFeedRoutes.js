import { pool } from './db.js'; // Ajuste para o import da sua conexão PostgreSQL (ou portalDb.js)
import { getCreatorBySlug } from './portalDb.js';

// Garante as tabelas de Posts VIP e Desbloqueios de Visualização Única
export async function ensureVipTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_posts (
      id SERIAL PRIMARY KEY,
      creator_id INTEGER NOT NULL,
      caption TEXT,
      media_type VARCHAR(20) NOT NULL DEFAULT 'image', -- 'image' ou 'video'
      media_url TEXT NOT NULL,
      preview_url TEXT,
      price NUMERIC(10,2) NOT NULL DEFAULT 19.90,
      single_view BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ppv_unlocks (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL,
      buyer_identifier VARCHAR(120) NOT NULL,
      device_hash VARCHAR(128) NOT NULL,
      pix_txid VARCHAR(120) UNIQUE,
      paid BOOLEAN DEFAULT FALSE,
      viewed BOOLEAN DEFAULT FALSE,
      viewed_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

export function registerVipFeedRoutes(app) {
  // 1. Rota que registra a intenção de compra e amarra ao celular (deviceHash)
  app.post('/api/vip/unlock-intent', async (req, reply) => {
    const { postId, buyerIdentifier, deviceHash } = req.body || {};
    if (!postId || !deviceHash) {
      return reply.status(400).send({ error: 'Dados do dispositivo ausentes.' });
    }

    const txid = `PPV_${postId}_${Date.now()}`;
    const buyer = (buyerIdentifier || 'Cliente VIP').trim();

    // Em produção, aqui você gera a cobrança Pix e marca paid = true no webhook.
    // Por enquanto, criamos o registro pronto para ativação pelo webhook Pix:
    const { rows } = await pool.query(
      `INSERT INTO ppv_unlocks (post_id, buyer_identifier, device_hash, pix_txid, paid, viewed)
       VALUES ($1, $2, $3, $4, FALSE, FALSE)
       RETURNING id, pix_txid`,
      [postId, buyer, deviceHash, txid]
    );

    return reply.send({
      ok: true,
      unlockId: rows[0].id,
      txid: rows[0].pix_txid,
      boundDevice: deviceHash.slice(0, 8).toUpperCase()
    });
  });

  // 2. Rota de Consumo Único: valida o celular e queima a visualização no banco
  app.post('/api/vip/consume-once', async (req, reply) => {
    const { postId, unlockId, deviceHash } = req.body || {};
    if (!postId || !unlockId || !deviceHash) {
      return reply.status(400).send({ error: 'Requisição inválida.' });
    }

    const { rows } = await pool.query(
      `SELECT u.*, p.media_url, p.media_type, p.single_view
       FROM ppv_unlocks u
       JOIN vip_posts p ON p.id = u.post_id
       WHERE u.id = $1 AND u.post_id = $2`,
      [unlockId, postId]
    );

    const unlock = rows[0];
    if (!unlock) {
      return reply.status(404).send({ error: 'Compra não encontrada.' });
    }

    if (!unlock.paid) {
      return reply.status(402).send({ error: 'Pagamento Pix ainda não confirmado.' });
    }

    // TRAVA 1: Verifica se é exatamente o mesmo celular que comprou
    if (unlock.device_hash !== deviceHash) {
      return reply.status(403).send({
        error: 'Acesso bloqueado: este conteúdo está vinculado exclusivamente ao celular que realizou a compra.'
      });
    }

    // TRAVA 2: Verifica se já foi visualizado (Visualização Única)
    if (unlock.single_view && unlock.viewed) {
      return reply.status(410).send({
        error: 'Este conteúdo de visualização única já foi aberto e expirou.'
      });
    }

    // Queima a visualização no banco antes de enviar a URL
    await pool.query(
      `UPDATE ppv_unlocks SET viewed = TRUE, viewed_at = NOW() WHERE id = $1`,
      [unlock.id]
    );

    return reply.send({
      ok: true,
      mediaUrl: unlock.media_url,
      mediaType: unlock.media_type,
      buyerLabel: unlock.buyer_identifier
    });
  });

  // 3. Página Exclusiva Estilo OnlyFans (/vip/:slug)
  app.get('/vip/:slug', async (req, reply) => {
    const creator = await getCreatorBySlug(req.params.slug);
    if (!creator) {
      return reply.status(404).send('Criadora não encontrada.');
    }

    const { rows: dbPosts } = await pool.query(
      `SELECT * FROM vip_posts WHERE creator_id = $1 ORDER BY id DESC`,
      [creator.id]
    );

    // Posts de demonstração caso a modelo ainda não tenha postado no VIP
    const posts =
      dbPosts.length > 0
        ? dbPosts
        : [
            {
              id: 101,
              caption: 'Ensaio exclusivo sem censura no quarto 🔥 (Visualização única vinculada ao seu aparelho)',
              media_type: 'image',
              preview_url: creator.avatar_url || 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=600&q=60',
              price: 29.90
            },
            {
              id: 102,
              caption: 'Vídeo íntimo gravado hoje à noite 😈 Só abre 1 vez!',
              media_type: 'video',
              preview_url: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=600&q=60',
              price: 49.90
            }
          ];

    const postsHtml = posts
      .map(
        (p) => `
      <article style="background:#fff;border:1px solid #e2e9ed;border-radius:14px;overflow:hidden;margin-bottom:18px;">
        <div style="padding:14px 16px;display:flex;align-items:center;gap:10px;">
          <img src="${creator.avatar_url || 'https://placehold.co/80x80'}" style="width:42px;height:42px;border-radius:50%;object-fit:cover;" />
          <div>
            <strong style="display:block;font-size:14px;color:#263238;">${creator.stage_name}</strong>
            <span style="font-size:11px;color:#e25352;font-weight:700;">🔥 Conteúdo Exclusivo • Visualização Única</span>
          </div>
        </div>
        <p style="padding:0 16px 12px;font-size:13px;color:#455a64;">${p.caption}</p>
        <div style="position:relative;aspect-ratio:4/5;background:#111;overflow:hidden;display:flex;align-items:center;justify-content:center;">
          <img src="${p.preview_url}" style="width:100%;height:100%;object-fit:cover;filter:blur(26px) brightness(0.65);transform:scale(1.1);" />
          <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;text-align:center;color:#fff;">
            <div style="font-size:38px;margin-bottom:8px;">🔒</div>
            <strong style="font-size:16px;margin-bottom:4px;">Mídia Protegida (1x)</strong>
            <span style="font-size:12px;color:#cbd5e1;max-width:260px;margin-bottom:16px;">
              Após o Pix, libera visualização única exclusivamente neste celular.
            </span>
            <button id="ppv-btn-${p.id}" onclick="comprarPostUnico(${p.id}, ${Number(p.price).toFixed(2)})" style="background:#e25352;color:#fff;border:none;padding:13px 22px;border-radius:99px;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(226,83,82,0.4);">
              Desbloquear por R$ ${Number(p.price).toFixed(2).replace('.', ',')}
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
  <title>Conteúdo Exclusivo VIP - ${creator.stage_name}</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet">
</head>
<body style="margin:0;background:#eceff1;font-family:'Montserrat',sans-serif;color:#263238;">
  <header style="background:#fff;padding:14px 16px;border-bottom:1px solid #e2e9ed;position:sticky;top:0;z-index:40;display:flex;justify-content:space-between;align-items:center;">
    <a href="/acompanhante/${creator.slug}" style="text-decoration:none;color:#263238;font-weight:700;font-size:13px;">← Voltar ao Perfil</a>
    <strong style="font-size:15px;">CONTEÚDO <span style="color:#e25352;">VIP</span></strong>
    <span id="dev-badge" style="font-size:10px;background:#f1f5f9;padding:4px 8px;border-radius:6px;color:#64748b;">Aparelho Protegido</span>
  </header>

  <main style="max-width:540px;margin:18px auto;padding:0 14px;">
    ${postsHtml}
  </main>

  <script src="/vip-shield.js"></script>
  <script src="/device-id.js"></script>
  <script>
    window.addEventListener('DOMContentLoaded', async () => {
      const hash = await window.getDeviceHash();
      document.getElementById('dev-badge').innerText = 'ID: ' + hash.slice(0, 6).toUpperCase();
    });

    async function comprarPostUnico(postId, price) {
      const buyer = prompt('Digite seu e-mail ou WhatsApp para vincular a compra ao seu celular:');
      if (!buyer) return;

      const deviceHash = await window.getDeviceHash();
      const res = await fetch('/api/vip/unlock-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId, buyerIdentifier: buyer, deviceHash })
      });
      const data = await res.json();
      if (data.ok) {
        alert('Pedido #' + data.unlockId + ' vinculado ao seu celular (' + data.boundDevice + ')! Assim que o Pix compensar, clique para abrir sua visualização única.');
      }
    }
  </script>
</body>
</html>`;

    return reply.type('text/html; charset=utf-8').send(html);
  });
}
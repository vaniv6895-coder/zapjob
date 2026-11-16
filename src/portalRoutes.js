import crypto from 'crypto';
import axios from 'axios';
import {
  registerCreator,
  authenticateCreator,
  getCreatorById,
  getCreatorBySlug,
  updateCreatorProfile,
  listCreatorMedia,
  getHomeRanking,
  createHighlightOrder,
  setCreatorApproval,
} from './portalDb.js';
import { registerPortalMediaRoutes } from './portalMediaRoutes.js';
import { pool } from './db.js';

const HIGHLIGHT_PLANS = [
  { code: 'boost_1x', name: 'Subida ao Topo (1x)', badge: 'IMEDIATO ⚡', price: 9.9, desc: 'Joga seu perfil para o 1º lugar agora.' },
  { code: 'vip_7d', name: 'Destaque VIP (7 Dias)', badge: 'DESTAQUE ⭐', price: 59.9, desc: 'Selo VIP e posição privilegiada por 7 dias.' },
  { code: 'diamond_7d', name: 'Topo Diamante (7 Dias)', badge: '1ª LINHA 💎', price: 119.9, desc: 'Fixada no topo absoluto da vitrine por 7 dias.' },
  { code: 'diamond_30d', name: 'Topo Diamante (30 Dias)', badge: 'MÁXIMO ALCANCE 👑', price: 349.9, desc: '30 dias na 1ª linha da página inicial.' },
];

function signSessionToken(creatorId) {
  const secret = process.env.PANEL_PASSWORD || 'portal_secret_2026';
  const payload = `${creatorId}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [creatorId, ts, sig] = parts;
  const secret = process.env.PANEL_PASSWORD || 'portal_secret_2026';
  const expected = crypto.createHmac('sha256', secret).update(`${creatorId}.${ts}`).digest('hex');
  if (sig !== expected) return null;
  return Number(creatorId);
}

async function requireCreatorAuth(req, reply) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
  const creatorId = verifySessionToken(token);
  if (!creatorId) {
    return reply.status(401).send({ error: 'Sessão inválida ou expirada.' });
  }
  const creator = await getCreatorById(creatorId);
  if (!creator) {
    return reply.status(401).send({ error: 'Conta não encontrada.' });
  }
  req.creator = creator;
}

async function createPortalHighlightPix({ orderId, planName, amount, creatorEmail }) {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) return null;

  const webhookBase = (process.env.PUBLIC_URL || 'https://zapjob-production.up.railway.app').replace(/\/$/, '');

  const res = await axios.post(
    'https://api.mercadopago.com/v1/payments',
    {
      transaction_amount: Number(amount),
      description: `Portal VIP - ${planName}`,
      payment_method_id: 'pix',
      external_reference: `portal:${orderId}`,
      notification_url: `${webhookBase}/webhook/mercadopago`,
      payer: { email: creatorEmail || 'modelo@portalvip.com' },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `portal_order_${orderId}`,
      },
    }
  );

  const tx = res.data?.point_of_interaction?.transaction_data;
  if (!tx?.qr_code) return null;

  return {
    paymentId: res.data.id,
    qrCode: tx.qr_code,
    qrCodeBase64: tx.qr_code_base64 || null,
  };
}

export function registerPortalRoutes(app) {
  registerPortalMediaRoutes(app, requireCreatorAuth);

  // =======================================================================
  // API DE CADASTRO, LOGIN, PERFIL E COMPRA DE DESTAQUE PIX
  // =======================================================================
  app.post('/api/portal/register', async (req, reply) => {
    try {
      const { email, password, stageName, city, state, whatsapp, bio } = req.body || {};
      if (!email || !password || !stageName || !city || !state) {
        return reply.status(400).send({ error: 'Preencha todos os campos obrigatórios.' });
      }
      const creator = await registerCreator({ email, password, stageName, city, state, whatsapp, bio });
      const token = signSessionToken(creator.id);
      return reply.send({ ok: true, token, creator });
    } catch (err) {
      if (String(err.message).includes('unique')) {
        return reply.status(409).send({ error: 'Este e-mail já está cadastrado.' });
      }
      app.log.error(err, '[Portal] Erro ao cadastrar');
      return reply.status(500).send({ error: 'Erro interno ao criar conta.' });
    }
  });

  app.post('/api/portal/login', async (req, reply) => {
    const { email, password } = req.body || {};
    const creator = await authenticateCreator(email, password);
    if (!creator) {
      return reply.status(401).send({ error: 'E-mail ou senha incorretos.' });
    }
    const token = signSessionToken(creator.id);
    return reply.send({ ok: true, token, creator });
  });

  app.get('/api/portal/me', { preHandler: requireCreatorAuth }, async (req, reply) => {
    return reply.send({ ok: true, creator: req.creator, plans: HIGHLIGHT_PLANS });
  });

  app.put('/api/portal/me', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const updated = await updateCreatorProfile(req.creator.id, req.body || {});
    return reply.send({ ok: true, creator: updated });
  });

  app.post('/api/portal/highlight-pix', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const { planCode } = req.body || {};
    const plan = HIGHLIGHT_PLANS.find((p) => p.code === planCode);
    if (!plan) return reply.status(400).send({ error: 'Plano inválido.' });

    const order = await createHighlightOrder({
      creatorId: req.creator.id,
      planCode: plan.code,
      amount: plan.price,
    });

    const pix = await createPortalHighlightPix({
      orderId: order.id,
      planName: plan.name,
      amount: plan.price,
      creatorEmail: req.creator.email,
    });

    if (!pix) {
      return reply.status(500).send({ error: 'Falha ao gerar Pix no Mercado Pago.' });
    }

    await pool.query(`UPDATE highlight_orders SET mp_payment_id = $1 WHERE id = $2`, [String(pix.paymentId), order.id]);

    return reply.send({
      ok: true,
      orderId: order.id,
      plan,
      qrCode: pix.qrCode,
      qrCodeBase64: pix.qrCodeBase64,
    });
  });

  // =======================================================================
  // PÁGINA 1: VITRINE / PRIMEIRA PÁGINA (/vitrine) — VISUAL PORTAL PROFISSIONAL
  // =======================================================================
  app.get('/vitrine', async (req, reply) => {
    const city = req.query.city ? String(req.query.city).trim() : null;
    const filter = String(req.query.filter || 'all');

    let profiles = await getHomeRanking({ city, limit: 80 });

    // Busca contagem de mídias/vídeos por perfil para exibir selos e filtros
    const mediaCountsRes = await pool.query(`
      SELECT creator_id,
             COUNT(*)::int AS total_media,
             COUNT(*) FILTER (WHERE media_type = 'video')::int AS total_videos
      FROM creator_media
      WHERE visibility IN ('public', 'preview')
      GROUP BY creator_id
    `);
    const mediaMap = new Map();
    for (const row of mediaCountsRes.rows) {
      mediaMap.set(row.creator_id, row);
    }

    profiles = profiles.map((p) => ({
      ...p,
      total_media: mediaMap.get(p.id)?.total_media || 0,
      total_videos: mediaMap.get(p.id)?.total_videos || 0,
    }));

    // Barra de Stories no topo (prioriza Diamantes e VIPs ativos)
    const storyProfiles = profiles.slice(0, 15);
    const storiesHtml =
      storyProfiles.length > 0
        ? storyProfiles
            .map((s) => {
              const thumb = s.avatar_url || s.cover_url || 'https://placehold.co/120x120/1e293b/e25352?text=VIP';
              const ringColor = s.is_featured && s.tier === 'diamond' ? 'linear-gradient(135deg,#e25352,#b9a36a)' : '#e25352';
              return `
              <a href="/modelo/${s.slug}" class="story-item">
                <div class="story-ring" style="background:${ringColor}">
                  <img src="${thumb}" alt="${s.stage_name}" loading="lazy" />
                </div>
                <span>${s.stage_name.split(' ')[0]}</span>
              </a>`;
            })
            .join('')
        : '';

    // Aplica filtros rápidos
    let filteredProfiles = profiles;
    if (filter === 'diamond') {
      filteredProfiles = profiles.filter((p) => p.is_featured && p.tier === 'diamond');
    } else if (filter === 'vip') {
      filteredProfiles = profiles.filter((p) => p.is_featured && (p.tier === 'vip' || p.tier === 'diamond'));
    } else if (filter === 'video') {
      filteredProfiles = profiles.filter((p) => p.total_videos > 0);
    }

    const baseQuery = city ? `&city=${encodeURIComponent(city)}` : '';

    const cardsHtml =
      filteredProfiles.length === 0
        ? `<div class="empty-box">
            <p style="font-size:16px;margin-bottom:12px">Nenhum perfil encontrado para este filtro${city ? ` em <strong>${city}</strong>` : ''}.</p>
            <a href="/vitrine" style="display:inline-block;background:#263238;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;margin-right:8px">Ver Todos</a>
            <a href="/minha-conta" style="display:inline-block;background:#e25352;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">Cadastrar Meu Perfil</a>
           </div>`
        : filteredProfiles
            .map((p) => {
              const isDiamond = p.is_featured && p.tier === 'diamond';
              const isVip = p.is_featured && p.tier === 'vip';
              const cardClass = isDiamond ? 'card card--diamond' : isVip ? 'card card--vip' : 'card';
              const badgeHtml = isDiamond
                ? `<span class="badge badge--diamond">💎 LUXO DIAMANTE</span>`
                : isVip
                ? `<span class="badge badge--vip">⭐ DESTAQUE VIP</span>`
                : '';

              const cover = p.cover_url || p.avatar_url || 'https://placehold.co/400x520/1e293b/e25352?text=VIP';
              const waLink = p.whatsapp
                ? `https://wa.me/55${p.whatsapp.replace(/^55/, '')}?text=${encodeURIComponent(`Oi ${p.stage_name}, vi seu perfil no Portal VIP!`)}`
                : `/modelo/${p.slug}`;

              return `
              <article class="${cardClass}">
                <a href="/modelo/${p.slug}" class="card-media">
                  ${badgeHtml}
                  ${p.total_videos > 0 ? `<span class="media-pill">🎬 ${p.total_videos}</span>` : ''}
                  <img src="${cover}" alt="${p.stage_name}" loading="lazy" />
                  <div class="card-gradient">
                    <div class="card-name">
                      <span>${p.stage_name}</span>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="#1284ED"><path d="M12 2L14.8 4.6L18.6 4.1L19.4 7.8L22.7 9.7L21 13.1L22.7 16.5L19.4 18.4L18.6 22.1L14.8 21.6L12 24.2L9.2 21.6L5.4 22.1L4.6 18.4L1.3 16.5L3 13.1L1.3 9.7L4.6 7.8L5.4 4.1L9.2 4.6L12 2Z"/><path d="M9.5 12.5L11.2 14.2L15 10.2" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
                    </div>
                    <div class="card-loc">📍 ${p.city} - ${p.state}</div>
                  </div>
                </a>
                <div class="card-body">
                  <p class="card-bio">${p.bio ? p.bio.slice(0, 72) + (p.bio.length > 72 ? '...' : '') : 'Atendimento exclusivo e fotos verificadas.'}</p>
                  <div class="card-actions">
                    <a href="/modelo/${p.slug}" class="btn-outline">Perfil</a>
                    <a href="${waLink}" target="_blank" class="btn-wa">WhatsApp</a>
                  </div>
                </div>
              </article>`;
            })
            .join('');

    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Portal VIP — Modelos em Destaque${city ? ` em ${city}` : ''}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'Montserrat',sans-serif; background:#f4f6f8; color:#263238; overflow-x:hidden; }

    /* Modal +18 */
    .age-modal { position:fixed; inset:0; background:rgba(1,7,31,0.78); backdrop-filter:blur(10px); z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px; }
    .age-card { background:#fff; border-radius:14px; max-width:380px; width:100%; padding:24px; text-align:center; box-shadow:0 20px 50px rgba(0,0,0,0.4); }
    .age-card h2 { font-size:18px; font-weight:700; margin-bottom:10px; color:#263238; }
    .age-card p { font-size:13px; color:#5d7a89; line-height:1.5; margin-bottom:18px; }
    .age-btn { width:100%; padding:13px; border:none; border-radius:8px; background:#e25352; color:#fff; font-weight:700; font-size:15px; cursor:pointer; }

    /* Topbar & Header */
    .topbar { background:#e25352; color:#fff; text-align:center; font-size:12px; font-weight:600; padding:8px 12px; }
    .header { background:#fff; border-bottom:1px solid #e2e9ed; position:sticky; top:0; z-index:50; }
    .header-inner { max-width:1100px; margin:0 auto; padding:12px 16px; display:flex; justify-content:space-between; align-items:center; gap:12px; }
    .brand { font-size:20px; font-weight:800; color:#263238; text-decoration:none; letter-spacing:-0.5px; }
    .brand span { color:#e25352; }
    .cta-announce { background:#e25352; color:#fff; padding:9px 16px; border-radius:99px; font-size:13px; font-weight:700; text-decoration:none; white-space:nowrap; transition:0.2s; }
    .cta-announce:hover { background:#d04c4c; }

    .container { max-width:1100px; margin:0 auto; padding:16px 16px 48px; }

    /* Stories Bar */
    .stories-wrap { display:flex; gap:14px; overflow-x:auto; padding:6px 2px 14px; scrollbar-width:none; }
    .stories-wrap::-webkit-scrollbar { display:none; }
    .story-item { display:flex; flex-direction:column; align-items:center; text-decoration:none; color:#263238; flex-shrink:0; width:74px; }
    .story-ring { width:68px; height:68px; border-radius:50%; padding:3px; margin-bottom:6px; }
    .story-ring img { width:100%; height:100%; border-radius:50%; object-fit:cover; border:2px solid #fff; display:block; }
    .story-item span { font-size:11px; font-weight:600; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:72px; }

    /* Banner Luxo (Inspirado no FATAL) */
    .lux-banner { background:linear-gradient(90deg,#191919 0%,#3d3226 60%,#191919 100%); border:1px solid #b9a36a; border-radius:14px; padding:18px 20px; margin:8px 0 18px; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:14px; color:#fff; }
    .lux-title { display:flex; align-items:center; gap:8px; font-size:18px; font-weight:700; color:#e5d39b; }
    .lux-desc { font-size:13px; color:#e2e8f0; max-width:440px; }
    .lux-btn { border:2px solid #b9a36a; color:#fff; padding:9px 18px; border-radius:99px; font-size:13px; font-weight:700; text-decoration:none; background:rgba(185,163,106,0.15); }

    /* Busca e Filtros Rápidos */
    .search-row { display:flex; gap:8px; margin-bottom:14px; }
    .search-row input { flex:1; padding:12px 16px; border-radius:99px; border:1px solid #cad4d8; background:#fff; font-family:inherit; font-size:14px; outline:none; }
    .search-row input:focus { border-color:#263238; }
    .search-row button { padding:0 22px; border-radius:99px; border:none; background:#263238; color:#fff; font-family:inherit; font-weight:700; font-size:13px; cursor:pointer; }

    .pills { display:flex; gap:8px; overflow-x:auto; padding-bottom:14px; scrollbar-width:none; }
    .pills::-webkit-scrollbar { display:none; }
    .pill { padding:8px 16px; border-radius:99px; border:1px solid #263238; color:#263238; text-decoration:none; font-size:12px; font-weight:600; white-space:nowrap; background:#fff; }
    .pill.active { background:#e25352; border-color:#e25352; color:#fff; }

    .section-h1 { font-size:18px; font-weight:700; margin-bottom:14px; color:#263238; }
    .section-h1 span { color:#e25352; }

    /* Grid de Perfis */
    .grid { display:grid; grid-template-columns:repeat(2,1fr); gap:12px; }
    @media(min-width:640px){ .grid { grid-template-columns:repeat(3,1fr); gap:16px; } }
    @media(min-width:960px){ .grid { grid-template-columns:repeat(4,1fr); gap:18px; } }

    .card { background:#fff; border-radius:12px; overflow:hidden; border:1px solid #e2e9ed; display:flex; flex-direction:column; box-shadow:0 2px 8px rgba(0,0,0,0.04); transition:transform 0.2s; }
    .card:hover { transform:translateY(-2px); }
    .card--diamond { border:3px solid #ed3a3b; box-shadow:0 8px 20px rgba(237,58,59,0.18); }
    .card--vip { border:2px solid #b9a36a; }

    .card-media { position:relative; display:block; aspect-ratio:3/4; background:#1e293b; overflow:hidden; text-decoration:none; }
    .card-media img { width:100%; height:100%; object-fit:cover; display:block; }
    .badge { position:absolute; top:8px; left:8px; font-size:10px; font-weight:800; padding:4px 9px; border-radius:99px; z-index:2; }
    .badge--diamond { background:#ed3a3b; color:#fff; }
    .badge--vip { background:linear-gradient(90deg,#534930,#b9a36a); color:#fff; }
    .media-pill { position:absolute; top:8px; right:8px; background:rgba(1,7,31,0.65); color:#fff; font-size:10px; font-weight:600; padding:3px 8px; border-radius:99px; }

    .card-gradient { position:absolute; bottom:0; left:0; right:0; background:linear-gradient(transparent,rgba(16,22,24,0.92)); padding:32px 10px 10px; color:#fff; }
    .card-name { display:flex; align-items:center; gap:5px; font-size:15px; font-weight:700; }
    .card-loc { font-size:11px; color:#e2e8f0; margin-top:2px; }

    .card-body { padding:10px; display:flex; flex-direction:column; flex:1; }
    .card-bio { font-size:12px; color:#5d7a89; line-height:1.4; margin-bottom:10px; }
    .card-actions { display:flex; gap:6px; margin-top:auto; }
    .btn-outline { flex:1; text-align:center; padding:8px 6px; border-radius:6px; border:1px solid #cad4d8; color:#263238; font-size:12px; font-weight:700; text-decoration:none; }
    .btn-wa { flex:1.3; text-align:center; padding:8px 6px; border-radius:6px; background:#43a047; color:#fff; font-size:12px; font-weight:700; text-decoration:none; }

    .empty-box { grid-column:1/-1; background:#fff; border:1px solid #e2e9ed; border-radius:12px; padding:40px 20px; text-align:center; color:#5d7a89; }
  </style>
</head>
<body>
  <!-- Verificação de Idade +18 -->
  <div id="age-gate" class="age-modal" style="display:none">
    <div class="age-card">
      <h2>🔞 Conteúdo Exclusivo para Maiores de 18 Anos</h2>
      <p>Este portal exibe perfis e conteúdos destinados exclusivamente ao público adulto (+18). Ao continuar, você confirma ter 18 anos ou mais.</p>
      <button class="age-btn" onclick="acceptAge()">Tenho 18 anos ou mais — Entrar</button>
    </div>
  </div>

  <div class="topbar">✨ Perfis verificados com contato direto e liberação automática</div>

  <header class="header">
    <div class="header-inner">
      <a href="/vitrine" class="brand">PORTAL<span>VIP</span></a>
      <a href="/minha-conta" class="cta-announce">+ Anunciar Perfil</a>
    </div>
  </header>

  <main class="container">
    ${storiesHtml ? `<div class="stories-wrap">${storiesHtml}</div>` : ''}

    <div class="lux-banner">
      <div>
        <div class="lux-title">👑 Destaque Luxo & Diamante</div>
        <p class="lux-desc">Os perfis de maior destaque e exclusividade no topo da primeira página.</p>
      </div>
      <a href="/vitrine?filter=diamond${baseQuery}" class="lux-btn">Ver Perfis Diamante</a>
    </div>

    <form class="search-row" method="GET" action="/vitrine">
      <input type="text" name="city" placeholder="Buscar por cidade (ex: Cuiabá, Várzea Grande, São Paulo...)" value="${city || ''}" />
      <button type="submit">Buscar</button>
    </form>

    <div class="pills">
      <a href="/vitrine?filter=all${baseQuery}" class="pill ${filter === 'all' ? 'active' : ''}">Todos (${profiles.length})</a>
      <a href="/vitrine?filter=diamond${baseQuery}" class="pill ${filter === 'diamond' ? 'active' : ''}">💎 Topo Diamante</a>
      <a href="/vitrine?filter=vip${baseQuery}" class="pill ${filter === 'vip' ? 'active' : ''}">⭐ Destaques VIP</a>
      <a href="/vitrine?filter=video${baseQuery}" class="pill ${filter === 'video' ? 'active' : ''}">🎬 Com Vídeos</a>
    </div>

    <h1 class="section-h1">Acompanhantes e Modelos em <span>${city || 'Todo o Brasil'}</span></h1>

    <div class="grid">${cardsHtml}</div>
  </main>

  <script>
    if (!document.cookie.includes('age_verified=1')) {
      document.getElementById('age-gate').style.display = 'flex';
    }
    function acceptAge() {
      document.cookie = 'age_verified=1; max-age=2592000; path=/';
      document.getElementById('age-gate').style.display = 'none';
    }
  </script>
</body>
</html>`);
  });

  // =======================================================================
  // PÁGINA 2: PERFIL INDIVIDUAL DA MODELO (/modelo/:slug)
  // =======================================================================
  app.get('/modelo/:slug', async (req, reply) => {
    const creator = await getCreatorBySlug(req.params.slug);
    if (!creator) {
      return reply.status(404).type('text/html; charset=utf-8').send('<body style="background:#f4f6f8;color:#263238;font-family:sans-serif;text-align:center;padding:50px"><h2>Perfil não encontrado ou aguardando verificação.</h2><a href="/vitrine" style="color:#e25352;font-weight:bold">Voltar para a Vitrine</a></body>');
    }

    const mediaList = await listCreatorMedia(creator.id, false);
    const waLink = creator.whatsapp
      ? `https://wa.me/55${creator.whatsapp.replace(/^55/, '')}?text=${encodeURIComponent(`Oi ${creator.stage_name}, vi teu perfil no Portal VIP!`)}`
      : '#';

    const galleryHtml =
      mediaList.length === 0
        ? `<p style="color:#5d7a89;text-align:center;padding:24px;grid-column:1/-1">Nenhuma foto ou vídeo publicado na galeria ainda.</p>`
        : mediaList
            .map((m) =>
              m.media_type === 'video'
                ? `<video src="${m.public_url}" controls playsinline style="width:100%;border-radius:12px;background:#000;max-height:420px"></video>`
                : `<img src="${m.public_url}" style="width:100%;border-radius:12px;object-fit:cover;aspect-ratio:3/4" loading="lazy" />`
            )
            .join('');

    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${creator.stage_name} — Portal VIP</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    body { background:#f4f6f8; color:#263238; font-family:'Montserrat',sans-serif; margin:0; padding:16px; }
    .wrap { max-width:560px; margin:0 auto; }
    .top-card { background:#fff; border-radius:16px; padding:22px; border:1px solid #e2e9ed; margin-bottom:18px; box-shadow:0 4px 12px rgba(0,0,0,0.04); }
    .wa-btn { display:block; text-align:center; background:#43a047; color:#fff; padding:14px; border-radius:10px; font-weight:700; text-decoration:none; font-size:15px; margin-top:16px; }
    .gallery { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  </style>
</head>
<body>
  <div class="wrap">
    <a href="/vitrine" style="color:#5d7a89;text-decoration:none;font-size:13px;font-weight:600;display:inline-block;margin-bottom:12px">← Voltar para a Vitrine</a>
    <div class="top-card">
      <h1 style="margin:0 0 6px;font-size:24px">${creator.stage_name} ✅</h1>
      <div style="color:#e25352;font-size:14px;font-weight:600;margin-bottom:10px">📍 ${creator.city} - ${creator.state}</div>
      <p style="color:#5d7a89;font-size:14px;line-height:1.5">${creator.bio || 'Perfil verificado no Portal VIP.'}</p>
      <a href="${waLink}" target="_blank" class="wa-btn">💬 Chamar no WhatsApp Agora</a>
    </div>
    <h3 style="margin-bottom:10px;font-size:16px">Galeria de Fotos e Vídeos (${mediaList.length})</h3>
    <div class="gallery">${galleryHtml}</div>
  </div>
</body>
</html>`);
  });

  // =======================================================================
  // PÁGINA 3: PAINEL DA MODELO (/minha-conta) — Upload R2 + Comprar Destaque Pix
  // =======================================================================
  app.get('/minha-conta', async (req, reply) => {
    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Painel da Modelo — Portal VIP</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { background:#f4f6f8; color:#263238; font-family:'Montserrat',sans-serif; padding:16px; }
    .wrap { max-width:520px; margin:0 auto; }
    .card { background:#fff; border:1px solid #e2e9ed; border-radius:16px; padding:18px; margin-bottom:16px; box-shadow:0 2px 8px rgba(0,0,0,0.04); }
    h2, h3 { margin-bottom:10px; }
    input, textarea, select { width:100%; padding:11px; border-radius:10px; border:1px solid #cad4d8; background:#fff; color:#263238; margin-bottom:10px; font-family:inherit; font-size:14px; }
    .btn { width:100%; padding:13px; border-radius:10px; border:none; background:#e25352; color:#fff; font-family:inherit; font-weight:700; font-size:15px; cursor:pointer; }
    .btn-green { background:#43a047; color:#fff; }
    .tabs { display:flex; gap:8px; margin-bottom:14px; }
    .tab { flex:1; padding:10px; border-radius:10px; border:1px solid #cad4d8; background:#f4f6f8; color:#5d7a89; font-family:inherit; font-weight:700; cursor:pointer; }
    .tab.active { background:#e25352; border-color:#e25352; color:#fff; }
    .media-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:12px; }
    .media-item { position:relative; aspect-ratio:1/1; border-radius:8px; overflow:hidden; background:#000; }
    .media-item img, .media-item video { width:100%; height:100%; object-fit:cover; }
    .del-btn { position:absolute; top:4px; right:4px; background:rgba(220,38,38,0.9); color:#fff; border:none; border-radius:6px; padding:3px 7px; font-size:11px; cursor:pointer; }
    .plan-box { border:1px solid #e2e9ed; border-radius:12px; padding:12px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; gap:10px; background:#f8fafc; }
  </style>
</head>
<body>
  <div class="wrap">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <a href="/vitrine" style="color:#e25352;text-decoration:none;font-weight:800;font-size:18px">PORTAL VIP</a>
      <button id="logout-btn" onclick="logout()" style="display:none;background:#fff;border:1px solid #cad4d8;color:#5d7a89;padding:6px 12px;border-radius:8px;font-weight:600">Sair</button>
    </div>

    <div id="auth-box" class="card">
      <div class="tabs">
        <button class="tab active" id="t-login" onclick="switchAuth('login')">Entrar</button>
        <button class="tab" id="t-reg" onclick="switchAuth('reg')">Criar Conta Grátis</button>
      </div>

      <div id="login-form">
        <input id="l-email" type="email" placeholder="Seu e-mail" />
        <input id="l-pass" type="password" placeholder="Sua senha" />
        <button class="btn" onclick="doLogin()">Acessar Meu Painel</button>
      </div>

      <div id="reg-form" style="display:none">
        <input id="r-name" placeholder="Nome artístico (ex: Larissa VIP)" />
        <input id="r-email" type="email" placeholder="Seu e-mail" />
        <input id="r-pass" type="password" placeholder="Crie uma senha" />
        <div style="display:flex;gap:8px">
          <input id="r-city" placeholder="Cidade (ex: Cuiabá)" style="flex:2" />
          <input id="r-state" placeholder="UF (MT)" maxlength="2" style="flex:1" />
        </div>
        <input id="r-wa" placeholder="WhatsApp com DDD (ex: 65999999999)" />
        <textarea id="r-bio" rows="2" placeholder="Descrição curta do seu perfil..."></textarea>
        <button class="btn" onclick="doRegister()">Cadastrar Agora</button>
      </div>
    </div>

    <div id="dash-box" style="display:none">
      <div class="card">
        <h2 id="welcome-title">Olá!</h2>
        <p id="status-badge" style="font-size:13px;color:#d97706;font-weight:600;margin-bottom:8px"></p>
        <a id="profile-link" href="#" target="_blank" style="color:#e25352;font-size:13px;font-weight:700">Ver meu perfil público ↗</a>
      </div>

      <div class="card">
        <h3>📸 Subir Fotos e Vídeos do Celular</h3>
        <select id="vis-select">
          <option value="public">Visibilidade: Público (Aparece na Vitrine)</option>
          <option value="subscriber">Visibilidade: Exclusivo VIP (Só Assinantes)</option>
        </select>
        <input type="file" id="file-input" accept="image/*,video/*" multiple onchange="uploadFiles()" />
        <p id="upload-status" style="font-size:13px;color:#16a34a;font-weight:600"></p>
        <div id="media-grid" class="media-grid"></div>
      </div>

      <div class="card">
        <h3>🚀 Aparecer no Topo da 1ª Página</h3>
        <p style="font-size:13px;color:#5d7a89;margin-bottom:12px">Escolha um pacote abaixo para ativar seu destaque automaticamente via Pix:</p>
        <div id="plans-list"></div>

        <div id="pix-area" style="display:none;text-align:center;margin-top:14px;padding-top:14px;border-top:1px solid #e2e9ed">
          <p id="pix-plan-title" style="font-weight:700;margin-bottom:8px"></p>
          <img id="pix-qr" style="width:190px;height:190px;background:#fff;padding:8px;border:1px solid #cad4d8;border-radius:10px;margin:0 auto 10px;display:block" />
          <textarea id="pix-code" rows="3" readonly style="font-size:11px"></textarea>
          <button class="btn btn-green" onclick="copyPix()">📋 Copiar Código Pix</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let token = localStorage.getItem('portal_token') || '';

    function switchAuth(mode) {
      document.getElementById('t-login').classList.toggle('active', mode === 'login');
      document.getElementById('t-reg').classList.toggle('active', mode === 'reg');
      document.getElementById('login-form').style.display = mode === 'login' ? 'block' : 'none';
      document.getElementById('reg-form').style.display = mode === 'reg' ? 'block' : 'none';
    }

    async function doLogin() {
      const res = await fetch('/api/portal/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('l-email').value,
          password: document.getElementById('l-pass').value,
        }),
      });
      const data = await res.json();
      if (!data.ok) return alert(data.error);
      token = data.token;
      localStorage.setItem('portal_token', token);
      loadDashboard();
    }

    async function doRegister() {
      const res = await fetch('/api/portal/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stageName: document.getElementById('r-name').value,
          email: document.getElementById('r-email').value,
          password: document.getElementById('r-pass').value,
          city: document.getElementById('r-city').value,
          state: document.getElementById('r-state').value,
          whatsapp: document.getElementById('r-wa').value,
          bio: document.getElementById('r-bio').value,
        }),
      });
      const data = await res.json();
      if (!data.ok) return alert(data.error);
      token = data.token;
      localStorage.setItem('portal_token', token);
      loadDashboard();
    }

    function logout() {
      localStorage.removeItem('portal_token');
      location.reload();
    }

    async function loadDashboard() {
      if (!token) return;
      const res = await fetch('/api/portal/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) return logout();
      const { creator, plans } = await res.json();

      document.getElementById('auth-box').style.display = 'none';
      document.getElementById('dash-box').style.display = 'block';
      document.getElementById('logout-btn').style.display = 'block';
      document.getElementById('welcome-title').innerText = 'Olá, ' + creator.stage_name;
      document.getElementById('profile-link').href = '/modelo/' + creator.slug;
      document.getElementById('status-badge').innerText = creator.verified
        ? '✅ Perfil Verificado e Ativo na Vitrine | Plano: ' + creator.tier.toUpperCase()
        : '⏳ Aguardando aprovação do administrador para aparecer na vitrine';

      document.getElementById('plans-list').innerHTML = plans.map(p => \`
        <div class="plan-box">
          <div>
            <strong>\${p.name}</strong> <span style="font-size:11px;color:#e25352;font-weight:700">\${p.badge}</span>
            <div style="font-size:12px;color:#5d7a89">\${p.desc}</div>
          </div>
          <button onclick="buyPlan('\${p.code}')" style="background:#43a047;color:#fff;border:none;padding:10px 12px;border-radius:8px;font-weight:700;cursor:pointer;white-space:nowrap">
            R$ \${Number(p.price).toFixed(2).replace('.', ',')}
          </button>
        </div>
      \`).join('');

      loadMedia();
    }

    async function loadMedia() {
      const res = await fetch('/api/creator/media', { headers: { Authorization: 'Bearer ' + token } });
      const { items } = await res.json();
      document.getElementById('media-grid').innerHTML = (items || []).map(m => \`
        <div class="media-item">
          \${m.media_type === 'video' ? \`<video src="\${m.public_url}"></video>\` : \`<img src="\${m.public_url}" />\`}
          <button class="del-btn" onclick="delMedia(\${m.id})">X</button>
        </div>
      \`).join('');
    }

    async function uploadFiles() {
      const files = document.getElementById('file-input').files;
      const visibility = document.getElementById('vis-select').value;
      const status = document.getElementById('upload-status');
      if (!files.length) return;

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        status.innerText = \`Enviando \${i + 1} de \${files.length} (\${f.name})...\`;

        const presign = await fetch('/api/creator/upload-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ fileName: f.name, contentType: f.type, visibility }),
        }).then(r => r.json());

        if (!presign.ok) { alert(presign.error); continue; }

        await fetch(presign.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': f.type },
          body: f,
        });

        await fetch('/api/creator/media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({
            mediaType: presign.mediaType,
            visibility: presign.visibility,
            r2Key: presign.r2Key,
            publicUrl: presign.publicUrl,
          }),
        });

        if (presign.mediaType === 'image' && visibility === 'public') {
          await fetch('/api/portal/me', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ cover_url: presign.publicUrl, avatar_url: presign.publicUrl }),
          });
        }
      }

      status.innerText = '✅ Envio concluído!';
      loadMedia();
    }

    async function delMedia(id) {
      if (!confirm('Apagar esta mídia?')) return;
      await fetch('/api/creator/media/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
      loadMedia();
    }

    async function buyPlan(planCode) {
      const res = await fetch('/api/portal/highlight-pix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ planCode }),
      });
      const data = await res.json();
      if (!data.ok) return alert(data.error);

      document.getElementById('pix-area').style.display = 'block';
      document.getElementById('pix-plan-title').innerText = data.plan.name + ' — R$ ' + Number(data.plan.price).toFixed(2).replace('.', ',');
      document.getElementById('pix-qr').src = 'data:image/png;base64,' + data.qrCodeBase64;
      document.getElementById('pix-code').value = data.qrCode;
    }

    function copyPix() {
      const el = document.getElementById('pix-code');
      el.select();
      navigator.clipboard.writeText(el.value);
      alert('Código Pix copiado! Assim que pagar, seu destaque ativa automaticamente.');
    }

    loadDashboard();
  </script>
</body>
</html>`);
  });

  // =======================================================================
  // PÁGINA 4: ADMIN PARA VOCÊ APROVAR AS MODELOS (/portal-admin)
  // =======================================================================
  app.get('/portal-admin', async (req, reply) => {
    const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin123';
    const pwd = req.query.pwd || '';
    if (pwd !== PANEL_PASSWORD) {
      return reply.status(401).type('text/html; charset=utf-8').send(`
        <body style="background:#f4f6f8;color:#263238;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
          <form method="GET" style="background:#fff;padding:24px;border-radius:12px;border:1px solid #e2e9ed">
            <h3>Admin do Portal</h3>
            <input type="password" name="pwd" placeholder="Senha do painel" style="padding:10px;border-radius:8px;border:1px solid #cad4d8" />
            <button style="padding:10px 16px;border-radius:8px;background:#e25352;color:#fff;border:none;font-weight:bold">Entrar</button>
          </form>
        </body>
      `);
    }

    const res = await pool.query(`SELECT id, stage_name, email, city, state, whatsapp, tier, verified, active, created_at FROM creator_accounts ORDER BY created_at DESC LIMIT 100`);
    const rows = res.rows
      .map(
        (c) => `
      <div style="background:#fff;padding:14px;border-radius:12px;margin-bottom:10px;border:1px solid #e2e9ed;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div>
          <strong>#${c.id} ${c.stage_name}</strong> (${c.city}-${c.state})<br/>
          <small style="color:#5d7a89">${c.email} | WA: ${c.whatsapp || '-'} | Plano: ${c.tier}</small>
        </div>
        <button onclick="toggle(${c.id}, ${!c.verified})" style="padding:8px 12px;border-radius:8px;border:none;font-weight:bold;cursor:pointer;background:${c.verified ? '#43a047' : '#f59e0b'};color:#fff">
          ${c.verified ? '✅ Aprovada' : '⏳ Aprovar'}
        </button>
      </div>`
      )
      .join('');

    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Admin Portal</title></head>
<body style="background:#f4f6f8;color:#263238;font-family:-apple-system,sans-serif;padding:16px;max-width:600px;margin:0 auto">
  <h2>🛡️ Aprovação de Perfis do Portal</h2>
  <p style="color:#5d7a89;font-size:13px;margin-bottom:14px">Clique para ativar ou pausar cada modelo na primeira página.</p>
  ${rows}
  <script>
    async function toggle(id, status) {
      await fetch('/api/portal/admin/approve?pwd=${encodeURIComponent(pwd)}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorId: id, verified: status, active: status }),
      });
      location.reload();
    }
  </script>
</body>
</html>`);
  });

  app.post('/api/portal/admin/approve', async (req, reply) => {
    const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin123';
    if (req.query.pwd !== PANEL_PASSWORD) return reply.status(401).send({ error: 'Não autorizado' });
    const { creatorId, verified, active } = req.body || {};
    await setCreatorApproval(creatorId, { verified, active });
    return reply.send({ ok: true });
  });
}
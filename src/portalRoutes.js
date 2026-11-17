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
  trackProfileEvent,
  getCreatorStats30d,
  findOrCreateGoogleCreator,
} from './portalDb.js';
import { registerPortalProfileRoute } from './portalProfilePage.js';
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
  if (!creatorId) return reply.status(401).send({ error: 'Sessão inválida ou expirada.' });
  const creator = await getCreatorById(creatorId);
  if (!creator) return reply.status(401).send({ error: 'Conta não encontrada.' });
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
  return { paymentId: res.data.id, qrCode: tx.qr_code, qrCodeBase64: tx.qr_code_base64 || null };
}



  export function registerPortalRoutes(app) {
  registerPortalMediaRoutes(app, requireCreatorAuth);

  // <--- ESSA LINHA É OBRIGATÓRIA AQUI PARA REGISTRAR A ROTA DO ACOMPHANHANTE --->
  registerPortalProfileRoute(app);

  registerPortalMediaRoutes(app, requireCreatorAuth);

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
      return reply.status(500).send({ error: 'Erro interno ao criar conta.' });
    }
  });

  app.post('/api/portal/login', async (req, reply) => {
    const { email, password } = req.body || {};
    const creator = await authenticateCreator(email, password);
    if (!creator) return reply.status(401).send({ error: 'E-mail ou senha incorretos.' });
    return reply.send({ ok: true, token: signSessionToken(creator.id), creator });
  });

  app.post('/api/portal/google-auth', async (req, reply) => {
    try {
      const { credential } = req.body || {};
      if (!credential) return reply.status(400).send({ error: 'Token Google ausente.' });

      const googleRes = await axios.get(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
      );
      const payload = googleRes.data;

      if (process.env.GOOGLE_CLIENT_ID && payload.aud !== process.env.GOOGLE_CLIENT_ID) {
        return reply.status(401).send({ error: 'Client ID do Google inválido.' });
      }

      const creator = await findOrCreateGoogleCreator({
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
      });

      const token = signSessionToken(creator.id);
      return reply.send({ ok: true, token, creator });
    } catch (err) {
      app.log.error(err, '[Portal] Erro no login com Google');
      return reply.status(401).send({ error: 'Falha ao autenticar com a conta Google.' });
    }
  });

  app.get('/api/portal/me', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const stats = await getCreatorStats30d(req.creator.id);
    return reply.send({ ok: true, creator: req.creator, stats, plans: HIGHLIGHT_PLANS });
  });

  app.put('/api/portal/me', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const updated = await updateCreatorProfile(req.creator.id, req.body || {});
    return reply.send({ ok: true, creator: updated });
  });

  app.post('/api/portal/highlight-pix', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const { planCode } = req.body || {};
    const plan = HIGHLIGHT_PLANS.find((p) => p.code === planCode);
    if (!plan) return reply.status(400).send({ error: 'Plano inválido.' });

    const order = await createHighlightOrder({ creatorId: req.creator.id, planCode: plan.code, amount: plan.price });
    const pix = await createPortalHighlightPix({
      orderId: order.id,
      planName: plan.name,
      amount: plan.price,
      creatorEmail: req.creator.email,
    });
    if (!pix) return reply.status(500).send({ error: 'Falha ao gerar Pix no Mercado Pago.' });

    await pool.query(`UPDATE highlight_orders SET mp_payment_id = $1 WHERE id = $2`, [String(pix.paymentId), order.id]);
    return reply.send({ ok: true, orderId: order.id, plan, qrCode: pix.qrCode, qrCodeBase64: pix.qrCodeBase64 });
  });

  app.get('/r/wa/:slug', async (req, reply) => {
    const creator = await getCreatorBySlug(req.params.slug);
    if (!creator || !creator.whatsapp) {
      return reply.redirect('/vitrine');
    }
    await trackProfileEvent(creator.id, 'whatsapp_click');
    const cleanPhone = String(creator.whatsapp).replace(/\D/g, '').replace(/^55/, '');
    const msg = encodeURIComponent(`Oi ${creator.stage_name}, vi teu perfil no Portal VIP!`);
    return reply.redirect(`https://wa.me/55${cleanPhone}?text=${msg}`);
  });

  // =======================================================================
  // PÁGINA 1: VITRINE COMPLETA (/vitrine)
  // =======================================================================
  app.get('/vitrine', async (req, reply) => {
    const city = req.query.city ? String(req.query.city).trim() : null;
    const filter = String(req.query.filter || 'all');

    let profiles = await getHomeRanking({ city, limit: 80 });

    const [mediaCountsRes, recentVideosRes] = await Promise.all([
      pool.query(`
        SELECT creator_id,
               COUNT(*)::int AS total_media,
               COUNT(*) FILTER (WHERE media_type = 'video')::int AS total_videos
        FROM creator_media
        WHERE visibility IN ('public', 'preview')
        GROUP BY creator_id
      `),
      pool.query(`
        SELECT m.id, m.public_url, m.caption, c.stage_name, c.slug, c.city, c.state, c.avatar_url, c.cover_url
        FROM creator_media m
        JOIN creator_accounts c ON c.id = m.creator_id
        WHERE m.media_type = 'video'
          AND m.visibility IN ('public', 'preview')
          AND c.active = TRUE AND c.verified = TRUE
        ORDER BY m.created_at DESC
        LIMIT 12
      `),
    ]);

    const mediaMap = new Map();
    for (const row of mediaCountsRes.rows) mediaMap.set(row.creator_id, row);

    profiles = profiles.map((p) => ({
      ...p,
      total_media: mediaMap.get(p.id)?.total_media || 0,
      total_videos: mediaMap.get(p.id)?.total_videos || 0,
    }));

    const storiesData = profiles.slice(0, 15).map((s) => ({
      name: s.stage_name,
      city: `${s.city}-${s.state}`,
      slug: s.slug,
      img: s.avatar_url || s.cover_url || 'https://placehold.co/400x600/111827/ec4899?text=VIP',
      isDiamond: s.is_featured && s.tier === 'diamond',
    }));

    const storiesHtml = `
      <div class="stories-wrap">
        <a href="/reels" class="story-item">
          <div class="story-ring" style="background:linear-gradient(135deg,#ec4899,#8b5cf6)">
            <div style="width:60px;height:60px;border-radius:50%;background:#111827;color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;border:2px solid #fff">🎬</div>
          </div>
          <span style="color:#ec4899;font-weight:800">VIP Reels</span>
        </a>
        ${storiesData
          .map(
            (s, idx) => `
          <div class="story-item" onclick="openStory(${idx})" style="cursor:pointer">
            <div class="story-ring" style="background:${s.isDiamond ? 'linear-gradient(135deg,#ec4899,#b9a36a)' : '#ec4899'}">
              <img src="${s.img}" alt="${s.name}" loading="lazy" />
            </div>
            <span>${s.name.split(' ')[0]}</span>
          </div>`
          )
          .join('')}
      </div>`;

    const reelsStripHtml =
      recentVideosRes.rows.length > 0
        ? `
      <div class="reels-section">
        <div class="reels-header">
          <h3>🔥 Reels & Vídeos Recentes</h3>
          <a href="/reels">Ver todos em tela cheia →</a>
        </div>
        <div class="reels-row">
          ${recentVideosRes.rows
            .map(
              (v) => `
            <a href="/reels?v=${v.id}" class="reel-card">
              <video src="${v.public_url}#t=0.5" muted playsinline preload="metadata"></video>
              <div class="reel-play">▶</div>
              <div class="reel-info">
                <strong>${v.stage_name}</strong>
                <span>${v.city}-${v.state}</span>
              </div>
            </a>`
            )
            .join('')}
        </div>
      </div>`
        : '';

    let filteredProfiles = profiles;
    if (filter === 'diamond') filteredProfiles = profiles.filter((p) => p.is_featured && p.tier === 'diamond');
    else if (filter === 'vip') filteredProfiles = profiles.filter((p) => p.is_featured && (p.tier === 'vip' || p.tier === 'diamond'));
    else if (filter === 'video') filteredProfiles = profiles.filter((p) => p.total_videos > 0);

    const baseQuery = city ? `&city=${encodeURIComponent(city)}` : '';

    const cardsHtml =
      filteredProfiles.length === 0
        ? `<div class="empty-box">
            <p style="font-size:16px;margin-bottom:14px">Nenhum perfil ativo encontrado${city ? ` em <strong>${city}</strong>` : ''} ainda.</p>
            <a href="/minha-conta" style="display:inline-block;background:#ec4899;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">Cadastrar Meu Perfil Grátis</a>
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
                : `<span class="badge badge--online">🟢 ONLINE</span>`;

              const cover = p.cover_url || p.avatar_url || 'https://placehold.co/400x520/111827/ec4899?text=VIP';
              const rateTag = p.hourly_rate ? `<span style="font-weight:800;color:#38bdf8">R$ ${Number(p.hourly_rate).toFixed(0)}/h</span>` : '';

              return `
              <article class="${cardClass}">
                <a href="/modelo/${p.slug}" class="card-media">
                  ${badgeHtml}
                  <div class="media-counters">
                    ${p.total_media > 0 ? `<span>📷 ${p.total_media}</span>` : ''}
                    ${p.total_videos > 0 ? `<span>🎬 ${p.total_videos}</span>` : ''}
                  </div>
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
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:12px">
                    <span style="color:#4ade80;font-weight:700">● Disponível</span>
                    ${rateTag}
                  </div>
                  <p class="card-bio">${p.bio ? p.bio.slice(0, 70) + (p.bio.length > 70 ? '...' : '') : 'Atendimento exclusivo, fotos e vídeos verificados.'}</p>
                  <div class="card-actions">
                    <a href="/modelo/${p.slug}" class="btn-outline">Ver Perfil</a>
                    <a href="/r/wa/${p.slug}" target="_blank" class="btn-wa">💬 WhatsApp</a>
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
  <title>Portal VIP — Modelos e Acompanhantes${city ? ` em ${city}` : ''}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'Montserrat',sans-serif; background:#090d16; color:#f8fafc; overflow-x:hidden; }

    .age-modal { position:fixed; inset:0; background:rgba(1,7,31,0.88); backdrop-filter:blur(12px); z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px; }
    .age-card { background:#111827; border:1px solid #1f2937; border-radius:18px; max-width:380px; width:100%; padding:24px; text-align:center; box-shadow:0 20px 50px rgba(0,0,0,0.6); }
    .age-card h2 { font-size:18px; font-weight:700; margin-bottom:10px; color:#fff; }
    .age-card p { font-size:13px; color:#94a3b8; line-height:1.5; margin-bottom:18px; }
    .age-btn { width:100%; padding:13px; border:none; border-radius:12px; background:linear-gradient(90deg,#ec4899,#db2777); color:#fff; font-weight:800; font-size:15px; cursor:pointer; }

    .story-modal { position:fixed; inset:0; background:rgba(0,0,0,0.92); z-index:9998; display:none; align-items:center; justify-content:center; padding:16px; }
    .story-box { position:relative; width:100%; max-width:390px; aspect-ratio:9/16; border-radius:18px; overflow:hidden; background:#111; border:1px solid #334155; }
    .story-box img { width:100%; height:100%; object-fit:cover; }
    .story-top { position:absolute; top:0; left:0; right:0; padding:14px; background:linear-gradient(rgba(0,0,0,0.8),transparent); display:flex; justify-content:space-between; align-items:center; color:#fff; }
    .story-bottom { position:absolute; bottom:0; left:0; right:0; padding:20px 14px; background:linear-gradient(transparent,rgba(0,0,0,0.95)); text-align:center; }

    .topbar { background:linear-gradient(90deg,#ec4899,#8b5cf6); color:#fff; text-align:center; font-size:11px; font-weight:700; padding:8px 12px; letter-spacing:0.5px; }
    .header { background:#111827; border-bottom:1px solid #1f2937; position:sticky; top:0; z-index:50; }
    .header-inner { max-width:1100px; margin:0 auto; padding:12px 16px; display:flex; justify-content:space-between; align-items:center; gap:10px; }
    .brand { font-size:20px; font-weight:900; background:linear-gradient(90deg,#ec4899,#8b5cf6); -webkit-background-clip:text; -webkit-text-fill-color:transparent; text-decoration:none; }
    .nav-actions { display:flex; gap:8px; align-items:center; }
    .nav-reels { background:#1f2937; color:#fff; padding:8px 14px; border-radius:99px; font-size:12px; font-weight:700; text-decoration:none; }
    .cta-announce { background:linear-gradient(90deg,#ec4899,#db2777); color:#fff; padding:8px 16px; border-radius:99px; font-size:12px; font-weight:700; text-decoration:none; }

    .container { max-width:1100px; margin:0 auto; padding:16px 16px 48px; }

    .stories-wrap { display:flex; gap:14px; overflow-x:auto; padding:4px 2px 16px; scrollbar-width:none; }
    .stories-wrap::-webkit-scrollbar { display:none; }
    .story-item { display:flex; flex-direction:column; align-items:center; text-decoration:none; color:#f8fafc; flex-shrink:0; width:72px; }
    .story-ring { width:66px; height:66px; min-width:66px; min-height:66px; border-radius:50%; padding:3px; margin-bottom:6px; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
    .story-ring img { width:60px; height:60px; border-radius:50%; object-fit:cover; border:2px solid #111827; display:block; }
    .story-item span { font-size:11px; font-weight:600; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:70px; }

    .reels-section { margin:6px 0 20px; }
    .reels-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
    .reels-header h3 { font-size:15px; font-weight:700; color:#fff; }
    .reels-header a { font-size:12px; font-weight:700; color:#ec4899; text-decoration:none; }
    .reels-row { display:flex; gap:10px; overflow-x:auto; padding-bottom:4px; scrollbar-width:none; }
    .reels-row::-webkit-scrollbar { display:none; }
    .reel-card { position:relative; width:126px; height:210px; border-radius:14px; overflow:hidden; background:#000; flex-shrink:0; text-decoration:none; border:2px solid #ec4899; }
    .reel-card video { width:100%; height:100%; object-fit:cover; opacity:0.9; }
    .reel-play { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:34px; height:34px; border-radius:50%; background:rgba(236,72,153,0.9); color:#fff; display:flex; align-items:center; justify-content:center; font-size:13px; }
    .reel-info { position:absolute; bottom:0; left:0; right:0; padding:18px 8px 8px; background:linear-gradient(transparent,rgba(0,0,0,0.9)); color:#fff; }
    .reel-info strong { display:block; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .reel-info span { font-size:10px; color:#cbd5e1; }

    .lux-banner { background:linear-gradient(90deg,#191919 0%,#3d3226 60%,#191919 100%); border:1px solid #b9a36a; border-radius:16px; padding:16px 18px; margin:8px 0 18px; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; color:#fff; }
    .lux-title { font-size:17px; font-weight:700; color:#e5d39b; }
    .lux-desc { font-size:12px; color:#e2e8f0; max-width:440px; }
    .lux-btn { border:2px solid #b9a36a; color:#fff; padding:8px 16px; border-radius:99px; font-size:12px; font-weight:700; text-decoration:none; background:rgba(185,163,106,0.15); }

    .search-row { display:flex; gap:8px; margin-bottom:14px; }
    .search-row input { flex:1; padding:12px 18px; border-radius:99px; border:1px solid #334155; background:#111827; color:#fff; font-family:inherit; font-size:14px; outline:none; }
    .search-row input:focus { border-color:#ec4899; }
    .search-row button { padding:0 22px; border-radius:99px; border:none; background:linear-gradient(90deg,#ec4899,#db2777); color:#fff; font-family:inherit; font-weight:700; font-size:13px; cursor:pointer; }

    .pills { display:flex; gap:8px; overflow-x:auto; padding-bottom:14px; scrollbar-width:none; }
    .pills::-webkit-scrollbar { display:none; }
    .pill { padding:8px 16px; border-radius:99px; border:1px solid #334155; color:#94a3b8; text-decoration:none; font-size:12px; font-weight:600; white-space:nowrap; background:#111827; }
    .pill.active { background:#ec4899; border-color:#ec4899; color:#fff; }

    .section-h1 { font-size:17px; font-weight:700; margin-bottom:14px; color:#fff; }
    .section-h1 span { color:#ec4899; }

    .grid { display:grid; grid-template-columns:repeat(2,1fr); gap:12px; }
    @media(min-width:640px){ .grid { grid-template-columns:repeat(3,1fr); gap:16px; } }
    @media(min-width:960px){ .grid { grid-template-columns:repeat(4,1fr); gap:18px; } }

    .card { background:#111827; border-radius:14px; overflow:hidden; border:1px solid #1f2937; display:flex; flex-direction:column; box-shadow:0 4px 12px rgba(0,0,0,0.2); transition:0.2s; }
    .card:hover { transform:translateY(-2px); border-color:#374151; }
    .card--diamond { border:3px solid #ec4899; box-shadow:0 8px 24px rgba(236,72,153,0.25); }
    .card--vip { border:2px solid #eab308; }

    .card-media { position:relative; display:block; aspect-ratio:3/4; background:#0b101d; overflow:hidden; text-decoration:none; }
    .card-media img { width:100%; height:100%; object-fit:cover; display:block; }
    .badge { position:absolute; top:8px; left:8px; font-size:10px; font-weight:800; padding:4px 9px; border-radius:99px; z-index:2; }
    .badge--diamond { background:linear-gradient(90deg,#ec4899,#8b5cf6); color:#fff; }
    .badge--vip { background:#eab308; color:#000; }
    .badge--online { background:rgba(17,24,39,0.8); color:#4ade80; }
    .media-counters { position:absolute; top:8px; right:8px; display:flex; gap:4px; }
    .media-counters span { background:rgba(11,16,29,0.75); color:#fff; font-size:10px; font-weight:600; padding:3px 8px; border-radius:99px; }

    .card-gradient { position:absolute; bottom:0; left:0; right:0; background:linear-gradient(transparent,rgba(11,16,29,0.95)); padding:34px 10px 10px; color:#fff; }
    .card-name { display:flex; align-items:center; gap:5px; font-size:15px; font-weight:700; }
    .card-loc { font-size:11px; color:#94a3b8; margin-top:2px; }

    .card-body { padding:12px; display:flex; flex-direction:column; flex:1; }
    .card-bio { font-size:12px; color:#94a3b8; line-height:1.4; margin-bottom:12px; }
    .card-actions { display:flex; gap:6px; margin-top:auto; }
    .btn-outline { flex:1; text-align:center; padding:9px 6px; border-radius:8px; border:1px solid #334155; background:#0b101d; color:#f8fafc; font-size:12px; font-weight:700; text-decoration:none; }
    .btn-outline:hover { background:#1f2937; }
    .btn-wa { flex:1.3; text-align:center; padding:9px 6px; border-radius:8px; background:#22c55e; color:#052e16; font-size:12px; font-weight:800; text-decoration:none; }
    .btn-wa:hover { background:#16a34a; color:#fff; }
    .empty-box { grid-column:1/-1; background:#111827; border:1px solid #1f2937; border-radius:14px; padding:40px 20px; text-align:center; color:#94a3b8; }
  </style>
</head>
<body>
  <div id="age-gate" class="age-modal" style="display:none">
    <div class="age-card">
      <h2>🔞 Conteúdo Exclusivo para Maiores de 18 Anos</h2>
      <p>Este portal exibe perfis e conteúdos destinados exclusivamente ao público adulto (+18).</p>
      <button class="age-btn" onclick="acceptAge()">Tenho 18 anos ou mais — Entrar</button>
    </div>
  </div>

  <div id="story-modal" class="story-modal" onclick="if(event.target===this) closeStory()">
    <div class="story-box">
      <div class="story-top">
        <strong id="st-name"></strong>
        <button onclick="closeStory()" style="background:none;border:none;color:#fff;font-size:22px;cursor:pointer">✕</button>
      </div>
      <img id="st-img" src="" />
      <div class="story-bottom">
        <p id="st-city" style="color:#cbd5e1;font-size:12px;margin-bottom:10px"></p>
        <a id="st-link" href="#" style="display:inline-block;background:linear-gradient(90deg,#ec4899,#db2777);color:#fff;padding:10px 22px;border-radius:99px;font-weight:700;font-size:13px;text-decoration:none">Ver Perfil Completo</a>
      </div>
    </div>
  </div>

  <div class="topbar">✨ Perfis verificados com contato direto e liberação automática</div>

  <header class="header">
    <div class="header-inner">
      <a href="/vitrine" class="brand">PORTAL VIP</a>
      <div class="nav-actions">
        <a href="/reels" class="nav-reels">🎬 Reels</a>
        <a href="/minha-conta" class="cta-announce">+ Anunciar</a>
      </div>
    </div>
  </header>

  <main class="container">
    ${storiesHtml}
    ${reelsStripHtml}

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
    const stories = ${JSON.stringify(storiesData)};
    if (!document.cookie.includes('age_verified=1')) {
      document.getElementById('age-gate').style.display = 'flex';
    }
    function acceptAge() {
      document.cookie = 'age_verified=1; max-age=2592000; path=/';
      document.getElementById('age-gate').style.display = 'none';
    }
    function openStory(idx) {
      const s = stories[idx];
      if (!s) return;
      document.getElementById('st-name').innerText = s.name;
      document.getElementById('st-city').innerText = '📍 ' + s.city;
      document.getElementById('st-img').src = s.img;
      document.getElementById('st-link').href = '/modelo/' + s.slug;
      document.getElementById('story-modal').style.display = 'flex';
    }
    function closeStory() {
      document.getElementById('story-modal').style.display = 'none';
    }
  </script>
</body>
</html>`);
  });

  // =======================================================================
  // PÁGINA 1.5: VIP REELS (/reels)
  // =======================================================================
  app.get('/reels', async (req, reply) => {
    const videosRes = await pool.query(`
      SELECT m.id, m.public_url, m.caption, c.stage_name, c.slug, c.city, c.state, c.whatsapp
      FROM creator_media m
      JOIN creator_accounts c ON c.id = m.creator_id
      WHERE m.media_type = 'video'
        AND m.visibility IN ('public', 'preview')
        AND c.active = TRUE AND c.verified = TRUE
      ORDER BY m.created_at DESC
      LIMIT 40
    `);

    const slidesHtml =
      videosRes.rows.length === 0
        ? `<div style="height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px">
            <p style="font-size:18px;margin-bottom:14px">Nenhum vídeo publicado nos Reels ainda 🎬</p>
            <a href="/vitrine" style="background:#ec4899;color:#fff;padding:12px 20px;border-radius:99px;text-decoration:none;font-weight:700">Voltar para a Vitrine</a>
           </div>`
        : videosRes.rows
            .map(
              (v) => `
              <section class="reel-slide">
                <video src="${v.public_url}" loop playsinline onclick="this.paused ? this.play() : this.pause()"></video>
                <div class="reel-overlay">
                  <div>
                    <a href="/modelo/${v.slug}" style="color:#fff;font-size:18px;font-weight:800;text-decoration:none">${v.stage_name} ✅</a>
                    <p style="font-size:13px;color:#e2e8f0;margin:4px 0 12px">📍 ${v.city} - ${v.state}</p>
                    <div style="display:flex;gap:8px">
                      <a href="/modelo/${v.slug}" style="background:rgba(255,255,255,0.2);backdrop-filter:blur(6px);color:#fff;padding:10px 16px;border-radius:99px;font-size:13px;font-weight:700;text-decoration:none">Ver Perfil</a>
                      <a href="/r/wa/${v.slug}" target="_blank" style="background:#22c55e;color:#052e16;padding:10px 18px;border-radius:99px;font-size:13px;font-weight:800;text-decoration:none">💬 WhatsApp</a>
                    </div>
                  </div>
                </div>
              </section>`
            )
            .join('');

    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>VIP Reels — Vídeos Curtos</title>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { background:#000; color:#fff; font-family:-apple-system,sans-serif; overflow:hidden; }
    .top-bar { position:fixed; top:14px; left:14px; right:14px; z-index:20; display:flex; justify-content:space-between; align-items:center; }
    .back-pill { background:rgba(0,0,0,0.6);backdrop-filter:blur(8px); color:#fff; padding:8px 14px; border-radius:99px; text-decoration:none; font-size:13px; font-weight:700; }
    .feed { height:100dvh; overflow-y:scroll; scroll-snap-type:y mandatory; scrollbar-width:none; }
    .feed::-webkit-scrollbar { display:none; }
    .reel-slide { position:relative; height:100dvh; width:100%; scroll-snap-align:start; display:flex; justify-content:center; background:#000; }
    .reel-slide video { height:100%; width:100%; max-width:480px; object-fit:cover; }
    .reel-overlay { position:absolute; bottom:0; left:50%; transform:translateX(-50%); width:100%; max-width:480px; padding:40px 18px 28px; background:linear-gradient(transparent,rgba(0,0,0,0.9)); }
  </style>
</head>
<body>
  <div class="top-bar">
    <a href="/vitrine" class="back-pill">← Vitrine</a>
    <span style="font-weight:800;font-size:14px;background:linear-gradient(90deg,#ec4899,#db2777);padding:5px 12px;border-radius:99px">🎬 VIP REELS</span>
  </div>
  <div class="feed" id="feed">${slidesHtml}</div>
  <script>
    const videos = document.querySelectorAll('video');
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) e.target.play().catch(() => {});
        else e.target.pause();
      });
    }, { threshold: 0.65 });
    videos.forEach(v => obs.observe(v));
  </script>
</body>
</html>`);
  });

  // =======================================================================
  // PÁGINA 2: PERFIL INDIVIDUAL DA MODELO (/modelo/:slug) — LAYOUT PREMIUM
  // =======================================================================
  app.get('/modelo/:slug', async (req, reply) => {
    const creator = await getCreatorBySlug(req.params.slug);
    if (!creator) {
      return reply
        .status(404)
        .type('text/html; charset=utf-8')
        .send('<body style="background:#090d16;color:#fff;font-family:sans-serif;text-align:center;padding:50px"><h2>Perfil não encontrado ou aguardando verificação.</h2><a href="/vitrine" style="color:#ec4899">Voltar para a Vitrine</a></body>');
    }

    await trackProfileEvent(creator.id, 'view');

    const mediaList = await listCreatorMedia(creator.id, false);
    const photosCount = mediaList.filter((m) => m.media_type === 'image').length;
    const videosCount = mediaList.filter((m) => m.media_type === 'video').length;

    const coverUrl = creator.cover_url || creator.avatar_url || 'https://placehold.co/900x360/111827/ec4899?text=PORTAL+VIP';
    const avatarUrl = creator.avatar_url || creator.cover_url || 'https://placehold.co/300x300/1f2937/ec4899?text=VIP';

    const isDiamond = creator.tier === 'diamond' && creator.featured_until && new Date(creator.featured_until) > new Date();
    const isVip = creator.tier === 'vip' && creator.featured_until && new Date(creator.featured_until) > new Date();

    const tierBadge = isDiamond
      ? `<span class="tier-pill tier-diamond">💎 LUXO DIAMANTE</span>`
      : isVip
      ? `<span class="tier-pill tier-vip">⭐ DESTAQUE VIP</span>`
      : `<span class="tier-pill tier-online">🟢 ONLINE AGORA</span>`;

    const rateCardHtml = creator.hourly_rate
      ? `<div class="rate-box">
          <span class="rate-label">Valor do Atendimento (1h)</span>
          <strong class="rate-value">R$ ${Number(creator.hourly_rate).toFixed(2).replace('.', ',')}</strong>
         </div>`
      : `<div class="rate-box">
          <span class="rate-label">Valor do Atendimento</span>
          <strong class="rate-value" style="font-size:15px;color:#cbd5e1">A combinar no WhatsApp</strong>
         </div>`;

    const galleryHtml =
      mediaList.length === 0
        ? `<div class="empty-gallery">Nenhuma foto ou vídeo publicado na galeria ainda.</div>`
        : mediaList
            .map((m, idx) =>
              m.media_type === 'video'
                ? `<div class="media-card" data-type="video" onclick="openLightbox(${idx})">
                    <video src="${m.public_url}#t=0.5" muted playsinline preload="metadata"></video>
                    <span class="play-badge">▶ Vídeo</span>
                   </div>`
                : `<div class="media-card" data-type="image" onclick="openLightbox(${idx})">
                    <img src="${m.public_url}" alt="${creator.stage_name}" loading="lazy" />
                   </div>`
            )
            .join('');

    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Conheça ${creator.stage_name} em ${creator.city} - ${creator.state} | Portal VIP</title>
  <meta property="og:title" content="Conheça ${creator.stage_name} em ${creator.city} - ${creator.state}" />
  <meta property="og:description" content="${(creator.bio || 'Perfil verificado no Portal VIP.').slice(0, 140)}" />
  <meta property="og:image" content="${avatarUrl}" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { background:#090d16; color:#f8fafc; font-family:'Montserrat',sans-serif; padding-bottom:84px; }

    .topbar { background:#111827; border-bottom:1px solid #1f2937; padding:12px 16px; position:sticky; top:0; z-index:40; }
    .topbar-inner { max-width:720px; margin:0 auto; display:flex; justify-content:space-between; align-items:center; }
    .back-link { color:#cbd5e1; text-decoration:none; font-size:13px; font-weight:700; display:flex; align-items:center; gap:6px; }
    .brand { font-size:16px; font-weight:900; background:linear-gradient(90deg,#ec4899,#8b5cf6); -webkit-background-clip:text; -webkit-text-fill-color:transparent; text-decoration:none; }

    .container { max-width:720px; margin:0 auto; }

    .cover-wrap { position:relative; height:190px; background:#1e293b; overflow:hidden; }
    @media(min-width:640px){ .cover-wrap { height:250px; border-radius:0 0 20px 20px; } }
    .cover-img { width:100%; height:100%; object-fit:cover; filter:brightness(0.78); }
    .cover-grad { position:absolute; inset:0; background:linear-gradient(180deg,transparent 35%,#090d16 100%); }

    .profile-head { padding:0 16px; margin-top:-54px; position:relative; z-index:10; display:flex; flex-direction:column; align-items:center; text-align:center; }
    .avatar-ring { width:112px; height:112px; border-radius:50%; padding:3px; background:linear-gradient(135deg,#ec4899,#8b5cf6); box-shadow:0 10px 25px rgba(0,0,0,0.5); position:relative; }
    .avatar-ring img { width:100%; height:100%; border-radius:50%; object-fit:cover; border:3px solid #090d16; display:block; }
    .online-dot { position:absolute; bottom:6px; right:6px; width:16px; height:16px; border-radius:50%; background:#22c55e; border:3px solid #090d16; }

    .tier-pill { display:inline-block; font-size:10px; font-weight:800; padding:4px 12px; border-radius:99px; margin-top:10px; letter-spacing:0.4px; }
    .tier-diamond { background:linear-gradient(90deg,#ec4899,#8b5cf6); color:#fff; }
    .tier-vip { background:#eab308; color:#000; }
    .tier-online { background:rgba(34,197,94,0.15); color:#4ade80; border:1px solid rgba(34,197,94,0.3); }

    .stage-title { font-size:24px; font-weight:800; color:#fff; margin-top:8px; display:flex; align-items:center; justify-content:center; gap:6px; }
    .loc-text { font-size:13px; color:#94a3b8; font-weight:600; margin-top:4px; }

    .stats-bar { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin:18px 16px 0; background:#111827; border:1px solid #1f2937; border-radius:16px; padding:12px 8px; text-align:center; }
    .stat-item strong { display:block; font-size:17px; font-weight:800; color:#fff; }
    .stat-item span { font-size:11px; color:#94a3b8; font-weight:600; }

    .rate-box { margin:12px 16px 0; background:linear-gradient(90deg,rgba(236,72,153,0.12),rgba(139,92,246,0.12)); border:1px solid rgba(236,72,153,0.35); border-radius:14px; padding:14px 18px; display:flex; justify-content:space-between; align-items:center; }
    .rate-label { font-size:12px; font-weight:700; color:#cbd5e1; }
    .rate-value { font-size:20px; font-weight:900; color:#ec4899; }

    .bio-card { margin:12px 16px 0; background:#111827; border:1px solid #1f2937; border-radius:16px; padding:16px; }
    .bio-card h3 { font-size:13px; font-weight:800; color:#94a3b8; text-transform:uppercase; margin-bottom:8px; letter-spacing:0.5px; }
    .bio-card p { font-size:14px; color:#e2e8f0; line-height:1.55; white-space:pre-line; }

    .gallery-head { margin:22px 16px 12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; }
    .gallery-head h2 { font-size:16px; font-weight:800; color:#fff; }
    .filter-tabs { display:flex; gap:6px; }
    .ftab { background:#111827; border:1px solid #334155; color:#94a3b8; padding:6px 12px; border-radius:99px; font-size:11px; font-weight:700; cursor:pointer; }
    .ftab.active { background:#ec4899; border-color:#ec4899; color:#fff; }

    .gallery-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:4px; padding:0 16px; }
    @media(min-width:640px){ .gallery-grid { gap:10px; } }
    .media-card { position:relative; aspect-ratio:3/4; background:#111827; border-radius:8px; overflow:hidden; cursor:pointer; }
    .media-card img, .media-card video { width:100%; height:100%; object-fit:cover; display:block; transition:transform 0.25s; }
    .media-card:hover img, .media-card:hover video { transform:scale(1.04); }
    .play-badge { position:absolute; bottom:8px; left:8px; background:rgba(0,0,0,0.75); color:#fff; font-size:10px; font-weight:700; padding:3px 8px; border-radius:99px; }
    .empty-gallery { grid-column:1/-1; background:#111827; border:1px solid #1f2937; border-radius:14px; padding:32px; text-align:center; color:#94a3b8; font-size:13px; }

    .sticky-cta { position:fixed; bottom:0; left:0; right:0; background:rgba(9,13,22,0.92); backdrop-filter:blur(10px); border-top:1px solid #1f2937; padding:12px 16px; z-index:45; }
    .sticky-inner { max-width:720px; margin:0 auto; display:flex; gap:10px; }
    .wa-cta { flex:1; display:flex; align-items:center; justify-content:center; gap:8px; background:linear-gradient(90deg,#22c55e,#16a34a); color:#fff; padding:14px; border-radius:12px; font-weight:800; font-size:15px; text-decoration:none; box-shadow:0 4px 16px rgba(34,197,94,0.3); }
    .share-btn { background:#1f2937; border:1px solid #374151; color:#fff; padding:0 16px; border-radius:12px; font-weight:700; font-size:13px; cursor:pointer; }

    .lightbox { position:fixed; inset:0; background:rgba(0,0,0,0.95); z-index:9999; display:none; flex-direction:column; align-items:center; justify-content:center; padding:16px; }
    .lightbox-close { position:absolute; top:16px; right:16px; background:#1f2937; color:#fff; border:none; width:38px; height:38px; border-radius:50%; font-size:18px; cursor:pointer; }
    .lightbox-content img, .lightbox-content video { max-width:100%; max-height:82dvh; border-radius:12px; }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <a href="/vitrine" class="back-link">← Voltar para a Vitrine</a>
      <a href="/vitrine" class="brand">💎 PORTAL VIP</a>
    </div>
  </header>

  <main class="container">
    <div class="cover-wrap">
      <img src="${coverUrl}" alt="Capa de ${creator.stage_name}" class="cover-img" />
      <div class="cover-grad"></div>
    </div>

    <div class="profile-head">
      <div class="avatar-ring">
        <img src="${avatarUrl}" alt="${creator.stage_name}" />
        <span class="online-dot" title="Online agora"></span>
      </div>
      ${tierBadge}
      <h1 class="stage-title">
        ${creator.stage_name}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="#1284ED"><path d="M12 2L14.8 4.6L18.6 4.1L19.4 7.8L22.7 9.7L21 13.1L22.7 16.5L19.4 18.4L18.6 22.1L14.8 21.6L12 24.2L9.2 21.6L5.4 22.1L4.6 18.4L1.3 16.5L3 13.1L1.3 9.7L4.6 7.8L5.4 4.1L9.2 4.6L12 2Z"/><path d="M9.5 12.5L11.2 14.2L15 10.2" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
      </h1>
      <div class="loc-text">📍 ${creator.city} - ${creator.state}</div>
    </div>

    <div class="stats-bar">
      <div class="stat-item">
        <strong>${photosCount}</strong>
        <span>📷 Fotos</span>
      </div>
      <div class="stat-item">
        <strong>${videosCount}</strong>
        <span>🎬 Vídeos</span>
      </div>
      <div class="stat-item">
        <strong style="color:#4ade80">100%</strong>
        <span>✅ Verificada</span>
      </div>
    </div>

    ${rateCardHtml}

    <div class="bio-card">
      <h3>Sobre mim</h3>
      <p>${creator.bio || 'Atendimento exclusivo com discrição e total segurança. Entre em contato pelo WhatsApp para mais informações e horários.'}</p>
    </div>

    <div class="gallery-head">
      <h2>Galeria de Mídias (${mediaList.length})</h2>
      <div class="filter-tabs">
        <button class="ftab active" onclick="filterMedia('all', this)">Tudo</button>
        <button class="ftab" onclick="filterMedia('image', this)">Fotos (${photosCount})</button>
        <button class="ftab" onclick="filterMedia('video', this)">Vídeos (${videosCount})</button>
      </div>
    </div>

    <div class="gallery-grid" id="gallery-grid">
      ${galleryHtml}
    </div>
  </main>

  <div class="sticky-cta">
    <div class="sticky-inner">
      <a href="/r/wa/${creator.slug}" target="_blank" class="wa-cta">💬 Chamar no WhatsApp</a>
      <button class="share-btn" onclick="shareProfile()">🔗</button>
    </div>
  </div>

  <div id="lightbox" class="lightbox" onclick="if(event.target===this) closeLightbox()">
    <button class="lightbox-close" onclick="closeLightbox()">✕</button>
    <div id="lightbox-content" class="lightbox-content"></div>
  </div>

  <script>
    const mediaItems = ${JSON.stringify(mediaList.map((m) => ({ type: m.media_type, url: m.public_url })))};

    function filterMedia(type, btn) {
      document.querySelectorAll('.ftab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.media-card').forEach(card => {
        card.style.display = (type === 'all' || card.dataset.type === type) ? 'block' : 'none';
      });
    }

    function openLightbox(idx) {
      const item = mediaItems[idx];
      if (!item) return;
      const box = document.getElementById('lightbox-content');
      box.innerHTML = item.type === 'video'
        ? \`<video src="\${item.url}" controls autoplay playsinline></video>\`
        : \`<img src="\${item.url}" />\`;
      document.getElementById('lightbox').style.display = 'flex';
    }

    function closeLightbox() {
      document.getElementById('lightbox-content').innerHTML = '';
      document.getElementById('lightbox').style.display = 'none';
    }

    function shareProfile() {
      navigator.clipboard.writeText(location.href);
      alert('Link do perfil copiado!');
    }
  </script>
</body>
</html>`);
  });

  // =======================================================================
  // PÁGINA 3: PAINEL DA CRIADORA (/minha-conta) — TEMA ESCURO MODERNO COMPLETO
  // =======================================================================
  app.get('/minha-conta', async (req, reply) => {
    const googleClientId = process.env.GOOGLE_CLIENT_ID || '';

    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Painel da Criadora — Portal VIP</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  ${googleClientId ? '<script src="https://accounts.google.com/gsi/client" async defer></script>' : ''}
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { background:#090d16; color:#f8fafc; font-family:'Montserrat',sans-serif; padding:16px; min-height:100vh; }
    .wrap { max-width:540px; margin:0 auto; padding-bottom:40px; }

    .top-nav { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; padding:0 4px; }
    .brand { font-size:20px; font-weight:900; background:linear-gradient(90deg,#ec4899,#8b5cf6); -webkit-background-clip:text; -webkit-text-fill-color:transparent; text-decoration:none; }
    .logout-btn { background:#1f2937; border:1px solid #374151; color:#94a3b8; padding:7px 14px; border-radius:99px; font-size:12px; font-weight:600; cursor:pointer; }
    .logout-btn:hover { background:#374151; color:#fff; }

    .card { background:#111827; border:1px solid #1f2937; border-radius:18px; padding:20px; margin-bottom:16px; box-shadow:0 10px 25px -5px rgba(0,0,0,0.3); }
    h2, h3 { font-size:16px; font-weight:700; color:#fff; margin-bottom:14px; display:flex; align-items:center; gap:8px; }
    
    label { display:block; font-size:11px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; }
    input, textarea, select { width:100%; padding:12px 14px; border-radius:12px; border:1px solid #334155; background:#0b101d; color:#fff; margin-bottom:14px; font-family:inherit; font-size:14px; outline:none; transition:0.2s; }
    input:focus, textarea:focus, select:focus { border-color:#ec4899; box-shadow:0 0 0 3px rgba(236,72,153,0.15); }
    
    .btn { width:100%; padding:14px; border-radius:12px; border:none; background:linear-gradient(90deg,#ec4899,#db2777); color:#fff; font-family:inherit; font-weight:800; font-size:14px; cursor:pointer; transition:0.2s; box-shadow:0 4px 12px rgba(236,72,153,0.25); }
    .btn:hover { opacity:0.9; transform:translateY(-1px); }
    .btn-dark { background:#1f2937; border:1px solid #374151; box-shadow:none; }
    .btn-dark:hover { background:#374151; }
    .btn-green { background:linear-gradient(90deg,#22c55e,#16a34a); box-shadow:0 4px 12px rgba(34,197,94,0.25); }

    .tabs { display:flex; gap:8px; margin-bottom:16px; background:#0b101d; padding:4px; border-radius:14px; border:1px solid #1f2937; }
    .tab { flex:1; padding:10px; border-radius:10px; border:none; background:transparent; color:#94a3b8; font-family:inherit; font-weight:700; font-size:13px; cursor:pointer; transition:0.2s; }
    .tab.active { background:#1f2937; color:#fff; box-shadow:0 2px 8px rgba(0,0,0,0.2); }

    .kpi-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:12px; }
    .kpi-box { background:#0b101d; border:1px solid #1f2937; border-radius:14px; padding:14px 8px; text-align:center; }
    .kpi-num { font-size:22px; font-weight:900; color:#fff; }
    .kpi-label { font-size:10px; color:#94a3b8; font-weight:700; text-transform:uppercase; margin-top:4px; }

    .media-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:12px; }
    .media-item { position:relative; aspect-ratio:1/1; border-radius:10px; overflow:hidden; background:#000; border:1px solid #1f2937; }
    .media-item img, .media-item video { width:100%; height:100%; object-fit:cover; }
    .del-btn { position:absolute; top:6px; right:6px; background:rgba(220,38,38,0.9); color:#fff; border:none; border-radius:6px; padding:4px 8px; font-size:11px; cursor:pointer; font-weight:bold; }

    .plan-box { border:1px solid #1f2937; border-radius:14px; padding:14px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; gap:12px; background:#0b101d; transition:0.2s; }
    .plan-box:hover { border-color:#374151; }
    .plan-btn { background:#22c55e; color:#052e16; border:none; padding:10px 16px; border-radius:10px; font-weight:800; font-size:13px; cursor:pointer; white-space:nowrap; transition:0.2s; }
    .plan-btn:hover { background:#16a34a; color:#fff; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top-nav">
      <a href="/vitrine" class="brand">💎 PORTAL VIP</a>
      <button id="logout-btn" class="logout-btn" onclick="logout()" style="display:none">Sair da Conta</button>
    </div>

    <div id="auth-box" class="card">
      ${
        googleClientId
          ? `
        <div style="display:flex;justify-content:center;margin-bottom:8px">
          <div id="g_id_onload"
               data-client_id="${googleClientId}"
               data-callback="handleGoogleCredential"
               data-auto_prompt="false">
          </div>
          <div class="g_id_signin"
               data-type="standard"
               data-size="large"
               data-theme="filled_black"
               data-text="continue_with"
               data-shape="pill"
               data-width="320">
          </div>
        </div>
        <div style="text-align:center;font-size:11px;color:#64748b;margin:16px 0;font-weight:600">— OU ENTRE COM E-MAIL —</div>
      `
          : ''
      }

      <div class="tabs">
        <button class="tab active" id="t-login" onclick="switchAuth('login')">Entrar</button>
        <button class="tab" id="t-reg" onclick="switchAuth('reg')">Criar Conta Grátis</button>
      </div>

      <div id="login-form">
        <label>E-mail</label>
        <input id="l-email" type="email" placeholder="seu@email.com" />
        <label>Senha</label>
        <input id="l-pass" type="password" placeholder="Sua senha" />
        <button class="btn" onclick="doLogin()">Acessar Painel</button>
      </div>

      <div id="reg-form" style="display:none">
        <label>Nome Artístico</label>
        <input id="r-name" placeholder="Ex: Larissa VIP" />
        <label>E-mail</label>
        <input id="r-email" type="email" placeholder="seu@email.com" />
        <label>Senha</label>
        <input id="r-pass" type="password" placeholder="Crie uma senha forte" />
        <div style="display:flex;gap:10px">
          <div style="flex:2"><label>Cidade</label><input id="r-city" placeholder="Ex: Cuiabá" /></div>
          <div style="flex:1"><label>UF</label><input id="r-state" placeholder="MT" maxlength="2" /></div>
        </div>
        <label>WhatsApp</label>
        <input id="r-wa" placeholder="65999999999" />
        <label>Biografia / Descrição</label>
        <textarea id="r-bio" rows="2" placeholder="Fale um pouco sobre você..."></textarea>
        <button class="btn" onclick="doRegister()">Criar Conta e Começar</button>
      </div>
    </div>

    <div id="dash-box" style="display:none">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:10px">
          <div>
            <h2 id="welcome-title" style="margin-bottom:6px;font-size:18px;">Olá!</h2>
            <p id="status-badge" style="font-size:12px;color:#fbbf24;font-weight:700"></p>
          </div>
          <a id="profile-link" href="#" target="_blank" style="background:rgba(236,72,153,0.15);color:#ec4899;border:1px solid rgba(236,72,153,0.3);padding:8px 12px;border-radius:10px;font-size:12px;font-weight:700;text-decoration:none;white-space:nowrap;">Ver Meu Perfil ↗</a>
        </div>

        <div style="margin-top:16px;padding-top:14px;border-top:1px solid #1f2937;">
          <span style="font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:0.5px">📊 PERFORMANCE (ÚLTIMOS 30 DIAS)</span>
          <div class="kpi-grid">
            <div class="kpi-box">
              <div class="kpi-num" id="kpi-views">0</div>
              <div class="kpi-label">👁️ Visitas</div>
            </div>
            <div class="kpi-box">
              <div class="kpi-num" style="color:#4ade80" id="kpi-contacts">0</div>
              <div class="kpi-label">💬 WhatsApp</div>
            </div>
            <div class="kpi-box">
              <div class="kpi-num" style="color:#ec4899" id="kpi-rate">0%</div>
              <div class="kpi-label">🔥 Conv.</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>💰 Valor do Serviço & Perfil</h3>
        <div style="display:flex;gap:10px">
          <div style="flex:1">
            <label>Valor da Hora (R$)</label>
            <input id="p-rate" type="number" step="10" placeholder="Ex: 250" />
          </div>
          <div style="flex:1.4">
            <label>WhatsApp (com DDD)</label>
            <input id="p-wa" placeholder="65999999999" />
          </div>
        </div>
        <div style="display:flex;gap:10px">
          <div style="flex:2">
            <label>Nome Artístico</label>
            <input id="p-name" />
          </div>
          <div style="flex:1.2">
            <label>Cidade</label>
            <input id="p-city" />
          </div>
        </div>
        <label>Descrição do Atendimento</label>
        <textarea id="p-bio" rows="2" placeholder="Descreva seu atendimento, horários e diferenciais..."></textarea>
        <button class="btn btn-dark" onclick="saveProfile()">💾 Salvar Alterações</button>
      </div>

      <div class="card">
        <h3>🚀 Impulsionar Perfil (Topo da Vitrine)</h3>
        <p style="font-size:12px;color:#94a3b8;margin-bottom:14px">Ative seu destaque de forma instantânea via Pix e receba muito mais acessos:</p>
        <div id="plans-list"></div>

        <div id="pix-area" style="display:none;text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid #1f2937">
          <p id="pix-plan-title" style="font-weight:700;margin-bottom:10px;color:#fff"></p>
          <img id="pix-qr" style="width:190px;height:190px;background:#fff;padding:8px;border-radius:12px;margin:0 auto 12px;display:block" />
          <textarea id="pix-code" rows="3" readonly style="font-size:11px;background:#05070d;color:#cbd5e1"></textarea>
          <button class="btn btn-green" onclick="copyPix()" style="margin-top:8px">📋 Copiar Código Pix</button>
        </div>
      </div>

      <div class="card">
        <h3>📸 Galeria de Fotos e Vídeos</h3>
        <label>Visibilidade dos arquivos</label>
        <select id="vis-select">
          <option value="public">Público (Aparece na Vitrine e Reels)</option>
          <option value="subscriber">Exclusivo VIP (Só Assinantes)</option>
        </select>
        <input type="file" id="file-input" accept="image/*,video/*" multiple onchange="uploadFiles()" />
        <p id="upload-status" style="font-size:12px;color:#4ade80;font-weight:700;margin-top:6px"></p>
        <div id="media-grid" class="media-grid"></div>
      </div>
    </div>
  </div>

  <script>
    let token = localStorage.getItem('portal_token') || '';

    async function handleGoogleCredential(response) {
      const res = await fetch('/api/portal/google-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential }),
      });
      const data = await res.json();
      if (!data.ok) return alert(data.error);
      token = data.token;
      localStorage.setItem('portal_token', token);
      loadDashboard();
    }

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
        body: JSON.stringify({ email: document.getElementById('l-email').value, password: document.getElementById('l-pass').value }),
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
      const { creator, stats, plans } = await res.json();

      document.getElementById('auth-box').style.display = 'none';
      document.getElementById('dash-box').style.display = 'block';
      document.getElementById('logout-btn').style.display = 'block';
      document.getElementById('welcome-title').innerText = creator.stage_name;
      document.getElementById('profile-link').href = '/modelo/' + creator.slug;
      document.getElementById('status-badge').innerText = creator.verified
        ? '✅ Perfil Ativo na Vitrine | ' + creator.tier.toUpperCase()
        : '⏳ Aguardando aprovação do administrador';

      const views = Number(stats?.views_30d || 0);
      const contacts = Number(stats?.contacts_30d || 0);
      const conv = views > 0 ? Math.min(100, Math.round((contacts / views) * 100)) : 0;
      document.getElementById('kpi-views').innerText = views;
      document.getElementById('kpi-contacts').innerText = contacts;
      document.getElementById('kpi-rate').innerText = conv + '%';

      document.getElementById('p-rate').value = creator.hourly_rate || '';
      document.getElementById('p-wa').value = creator.whatsapp || '';
      document.getElementById('p-name').value = creator.stage_name || '';
      document.getElementById('p-city').value = creator.city || '';
      document.getElementById('p-bio').value = creator.bio || '';

      document.getElementById('plans-list').innerHTML = plans.map(p => \`
        <div class="plan-box">
          <div>
            <strong style="color:#fff;font-size:13px">\${p.name}</strong> <span style="font-size:10px;color:#ec4899;font-weight:800">\${p.badge}</span>
            <div style="font-size:11px;color:#94a3b8;margin-top:2px">\${p.desc}</div>
          </div>
          <button class="plan-btn" onclick="buyPlan('\${p.code}')">
            R$ \${Number(p.price).toFixed(2).replace('.', ',')}
          </button>
        </div>
      \`).join('');

      loadMedia();
    }

    async function saveProfile() {
      const rateVal = document.getElementById('p-rate').value;
      const res = await fetch('/api/portal/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          hourly_rate: rateVal ? Number(rateVal) : null,
          whatsapp: document.getElementById('p-wa').value.replace(/\\D/g, ''),
          stage_name: document.getElementById('p-name').value.trim(),
          city: document.getElementById('p-city').value.trim(),
          bio: document.getElementById('p-bio').value.trim(),
        }),
      });
      const data = await res.json();
      if (data.ok) alert('✅ Perfil e valores atualizados com sucesso!');
    }

    async function loadMedia() {
      const res = await fetch('/api/creator/media', { headers: { Authorization: 'Bearer ' + token } });
      const { items } = await res.json();
      document.getElementById('media-grid').innerHTML = (items || []).map(m => \`
        <div class="media-item">
          \${m.media_type === 'video' ? \`<video src="\${m.public_url}"></video>\` : \`<img src="\${m.public_url}" />\`}
          <button class="del-btn" onclick="delMedia(\${m.id})">✕</button>
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

        await fetch(presign.uploadUrl, { method: 'PUT', headers: { 'Content-Type': f.type }, body: f });

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

      status.innerText = '✅ Upload concluído com sucesso!';
      loadMedia();
    }

    async function delMedia(id) {
      if (!confirm('Deseja realmente apagar esta mídia?')) return;
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
      alert('Código Pix copiado! Cole no seu aplicativo de pagamento.');
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
        <body style="background:#090d16;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
          <form method="GET" style="background:#111827;padding:24px;border-radius:14px;border:1px solid #1f2937">
            <h3 style="color:#fff;margin-bottom:10px">Admin do Portal</h3>
            <input type="password" name="pwd" placeholder="Senha do painel" style="padding:10px;border-radius:8px;border:1px solid #334155;background:#0b101d;color:#fff;width:100%;margin-bottom:10px" />
            <button style="padding:10px 16px;border-radius:8px;background:linear-gradient(90deg,#ec4899,#db2777);color:#fff;border:none;font-weight:bold;width:100%;cursor:pointer">Entrar</button>
          </form>
        </body>
      `);
    }

    const res = await pool.query(`SELECT id, stage_name, email, city, state, whatsapp, tier, verified, active, created_at FROM creator_accounts ORDER BY created_at DESC LIMIT 100`);
    const rows = res.rows
      .map(
        (c) => `
      <div style="background:#111827;padding:14px;border-radius:12px;margin-bottom:10px;border:1px solid #1f2937;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div>
          <strong style="color:#fff">#${c.id} ${c.stage_name}</strong> (${c.city}-${c.state})<br/>
          <small style="color:#94a3b8">${c.email} | WA: ${c.whatsapp || '-'} | Plano: ${c.tier}</small>
        </div>
        <button onclick="toggle(${c.id}, ${!c.verified})" style="padding:8px 12px;border-radius:8px;border:none;font-weight:bold;cursor:pointer;background:${c.verified ? '#22c55e' : '#f59e0b'};color:#000">
          ${c.verified ? '✅ Aprovada' : '⏳ Aprovar'}
        </button>
      </div>`
      )
      .join('');

    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Admin Portal</title></head>
<body style="background:#090d16;color:#f8fafc;font-family:-apple-system,sans-serif;padding:16px;max-width:600px;margin:0 auto">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px">
    <h2 style="color:#fff">🛡️ Admin do Portal</h2>
    <div style="display:flex;gap:6px">
      <button onclick="seedDemo()" style="background:#1f2937;color:#fff;border:1px solid #374151;padding:9px 12px;border-radius:8px;font-weight:bold;cursor:pointer">+ Demos</button>
      <button onclick="clearDemo()" style="background:#dc2626;color:#fff;border:none;padding:9px 12px;border-radius:8px;font-weight:bold;cursor:pointer">Limpar Demos</button>
    </div>
  </div>
  <p style="color:#94a3b8;font-size:13px;margin-bottom:14px">Clique para ativar ou pausar cada modelo na primeira página.</p>
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
    async function seedDemo() {
      await fetch('/api/portal/admin/seed?pwd=${encodeURIComponent(pwd)}', { method: 'POST' });
      location.reload();
    }
    async function clearDemo() {
      await fetch('/api/portal/admin/clear-demo?pwd=${encodeURIComponent(pwd)}', { method: 'POST' });
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

  app.post('/api/portal/admin/seed', async (req, reply) => {
    const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin123';
    if (req.query.pwd !== PANEL_PASSWORD) return reply.status(401).send({ error: 'Não autorizado' });

    const demos = [
      { name: 'Valentina Luxo', city: 'Cuiabá', state: 'MT', tier: 'diamond', rate: 300, img: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=600&q=80' },
      { name: 'Isabela Ferraz', city: 'Várzea Grande', state: 'MT', tier: 'diamond', rate: 250, img: 'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=600&q=80' },
      { name: 'Camila Moraes', city: 'Cuiabá', state: 'MT', tier: 'vip', rate: 200, img: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=600&q=80' },
      { name: 'Larissa Ribeiro', city: 'São Paulo', state: 'SP', tier: 'free', rate: 180, img: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=600&q=80' },
    ];

    for (const d of demos) {
      const slug = d.name.toLowerCase().replace(/\s+/g, '-') + '-' + Math.floor(Math.random() * 999);
      await pool.query(
        `INSERT INTO creator_accounts (email, password_hash, slug, stage_name, city, state, whatsapp, hourly_rate, bio, avatar_url, cover_url, verified, active, tier, featured_until)
         VALUES ($1, 'demo:hash', $2, $3, $4, $5, '65999999999', $6, 'Atendimento VIP exclusivo e fotos verificadas.', $7, $7, TRUE, TRUE, $8, NOW() + INTERVAL '30 days')`,
        [`${slug}@demo.com`, slug, d.name, d.city, d.state, d.rate, d.img, d.tier]
      );
    }
    return reply.send({ ok: true });
  });

  app.post('/api/portal/admin/clear-demo', async (req, reply) => {
    const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin123';
    if (req.query.pwd !== PANEL_PASSWORD) return reply.status(401).send({ error: 'Não autorizado' });
    await pool.query(`DELETE FROM creator_accounts WHERE email LIKE '%@demo.com'`);
    return reply.send({ ok: true });
  });
}
import crypto from 'crypto';
import { pool } from './db.js';
import fs from 'fs';
import path from 'path';
import { registerVipFeedRoutes } from './vipFeedRoutes.js';

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
      description: `Garota VIP - ${planName}`,
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
  // Rota para a página separada de edição de perfil
  app.get('/minha-conta/editar', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'editar-perfil.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  registerVipFeedRoutes(app, requireCreatorAuth);
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
    const msg = encodeURIComponent(`Oi ${creator.stage_name}, vi teu perfil no Garota VIP!`);
    return reply.redirect(`https://wa.me/55${cleanPhone}?text=${msg}`);
  });

  // =======================================================================
  // PÁGINA 1: VITRINE SEPARADA (/vitrine) + API DE DADOS E STORIES
  // =======================================================================
  app.get('/api/portal/vitrine-data', async (req, reply) => {
    const city = req.query.city ? String(req.query.city).trim() : null;
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
        SELECT m.id, m.creator_id, m.public_url, m.caption, c.stage_name, c.slug, c.city, c.state, c.avatar_url, c.cover_url
        FROM creator_media m
        JOIN creator_accounts c ON c.id = m.creator_id
        WHERE m.media_type = 'video'
          AND m.visibility IN ('public', 'preview')
          AND c.active = TRUE AND c.verified = TRUE
        ORDER BY m.created_at DESC
        LIMIT 20
      `),
    ]);

    const mediaMap = new Map();
    for (const row of mediaCountsRes.rows) mediaMap.set(row.creator_id, row);

    const videoByCreator = new Map();
    for (const v of recentVideosRes.rows) {
      if (!videoByCreator.has(v.creator_id)) videoByCreator.set(v.creator_id, v);
    }

    profiles = profiles.map((p) => ({
      ...p,
      total_media: mediaMap.get(p.id)?.total_media || 0,
      total_videos: mediaMap.get(p.id)?.total_videos || 0,
    }));

    const stories = profiles.slice(0, 15).map((s) => {
      const vid = videoByCreator.get(s.id);
      return {
        name: s.stage_name,
        city: `${s.city}-${s.state}`,
        slug: s.slug,
        avatar: s.avatar_url || s.cover_url || 'https://placehold.co/400x400/111827/ec4899?text=VIP',
        mediaUrl: s.cover_url || s.avatar_url || 'https://placehold.co/400x600/111827/ec4899?text=VIP',
        videoUrl: vid ? vid.public_url : null,
        caption: vid?.caption || s.specialty_tag || s.bio || '',
      };
    });

    const demoReels = [
      {
        id: 1,
        public_url: 'https://assets.mixkit.co/videos/preview/mixkit-girl-in-neon-light-1282-large.mp4',
        caption: 'Bastidores do ensaio de hoje à noite 🔥 vem conferir...',
        stage_name: 'Isabela Ferraz',
        slug: 'isabela-ferraz',
        city: 'Várzea Grande',
        state: 'MT',
      },
      {
        id: 2,
        public_url: 'https://assets.mixkit.co/videos/preview/mixkit-woman-posing-for-camera-in-studio-34420-large.mp4',
        caption: 'Look novo esperando por você no meu VIP 💎',
        stage_name: 'Valentina Luxo',
        slug: 'valentina-luxo',
        city: 'Cuiabá',
        state: 'MT',
      },
    ];

    const reels = recentVideosRes.rows.length > 0 ? recentVideosRes.rows : demoReels;
    return reply.send({ ok: true, profiles, stories, reels });
  });

  app.get('/vitrine', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'vitrine.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // =======================================================================
  // PÁGINA 3: PAINEL DA CRIADORA (/minha-conta) — STUDIO PRO + CLUBE VIP
  // =======================================================================
  app.get('/minha-conta', async (req, reply) => {
    const googleClientId = process.env.GOOGLE_CLIENT_ID || '';

    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Creator Studio — Garota VIP</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  ${googleClientId ? '<script src="https://accounts.google.com/gsi/client" async defer></script>' : ''}
  <style>
    :root {
      --bg-main: #070a12;
      --bg-card: #0f1523;
      --bg-input: #090d16;
      --border: #1e293b;
      --accent: #ec4899;
      --accent-2: #8b5cf6;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --green: #10b981;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at top center, #131b31 0%, var(--bg-main) 55%);
      color: var(--text-main);
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      padding: 16px;
      min-height: 100vh;
    }
    .wrap { max-width: 620px; margin: 0 auto; padding-bottom: 64px; }

    /* Top Bar */
    .top-nav {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 20px; padding: 8px 4px;
    }
    .brand {
      font-size: 20px; font-weight: 800; letter-spacing: -0.5px;
      background: linear-gradient(135deg, #f472b6, #a78bfa);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      text-decoration: none; display: flex; align-items: center; gap: 6px;
    }
    .brand-tag {
      font-size: 10px; font-weight: 800; text-transform: uppercase;
      background: rgba(236, 72, 153, 0.15); color: #f472b6;
      border: 1px solid rgba(236, 72, 153, 0.3);
      padding: 3px 8px; border-radius: 99px; -webkit-text-fill-color: #f472b6;
    }
    .logout-btn {
      background: rgba(30, 41, 59, 0.7); border: 1px solid var(--border);
      color: var(--text-muted); padding: 8px 14px; border-radius: 99px;
      font-size: 12px; font-weight: 600; cursor: pointer; transition: 0.2s;
    }
    .logout-btn:hover { background: #1e293b; color: #fff; }

    /* Cards & Inputs */
    .card {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 20px; padding: 22px; margin-bottom: 18px;
      box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.45);
    }
    .card-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 16px; gap: 10px;
    }
    h2, h3 { font-size: 16px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px; }
    .subtitle { font-size: 12px; color: var(--text-muted); line-height: 1.5; margin-bottom: 16px; }

    label {
      display: block; font-size: 11px; font-weight: 700; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 6px;
    }
    input, textarea, select {
      width: 100%; padding: 12px 14px; border-radius: 12px;
      border: 1px solid var(--border); background: var(--bg-input);
      color: #fff; margin-bottom: 14px; font-family: inherit; font-size: 14px;
      outline: none; transition: border-color 0.2s, box-shadow 0.2s;
    }
    input:focus, textarea:focus, select:focus {
      border-color: var(--accent); box-shadow: 0 0 0 3px rgba(236, 72, 153, 0.15);
    }

    .btn {
      width: 100%; padding: 14px; border-radius: 12px; border: none;
      background: linear-gradient(135deg, #ec4899, #8b5cf6);
      color: #fff; font-family: inherit; font-weight: 700; font-size: 14px;
      cursor: pointer; transition: 0.2s; box-shadow: 0 6px 18px rgba(236, 72, 153, 0.28);
    }
    .btn:hover { opacity: 0.94; transform: translateY(-1px); }
    .btn-green {
      background: linear-gradient(135deg, #10b981, #059669);
      box-shadow: 0 6px 18px rgba(16, 185, 129, 0.25);
    }

    /* Auth Tabs */
    .tabs {
      display: flex; gap: 6px; margin-bottom: 18px; background: var(--bg-input);
      padding: 5px; border-radius: 14px; border: 1px solid var(--border);
    }
    .tab {
      flex: 1; padding: 10px; border-radius: 10px; border: none;
      background: transparent; color: var(--text-muted); font-family: inherit;
      font-weight: 700; font-size: 13px; cursor: pointer; transition: 0.2s;
    }
    .tab.active { background: #1e293b; color: #fff; }

    /* Studio Navigation Pills */
    .studio-nav {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
      background: var(--bg-card); border: 1px solid var(--border);
      padding: 6px; border-radius: 16px; margin-bottom: 18px;
      position: sticky; top: 10px; z-index: 30;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    }
    .s-nav-btn {
      border: none; background: transparent; color: var(--text-muted);
      font-family: inherit; font-size: 11px; font-weight: 700;
      padding: 10px 4px; border-radius: 11px; cursor: pointer; transition: 0.2s;
      display: flex; flex-direction: column; align-items: center; gap: 4px;
    }
    .s-nav-btn span.ico { font-size: 16px; }
    .s-nav-btn.active {
      background: linear-gradient(135deg, rgba(236, 72, 153, 0.2), rgba(139, 92, 246, 0.2));
      color: #fff; border: 1px solid rgba(236, 72, 153, 0.35);
    }

    /* Mode Switcher & Quick Links */
    .mode-switcher {
      display: flex; justify-content: space-between; align-items: center;
      gap: 8px; margin-bottom: 14px; flex-wrap: wrap;
    }
    .mode-pills {
      display: flex; background: var(--bg-input); border: 1px solid var(--border);
      border-radius: 99px; padding: 3px;
    }
    .mode-pill {
      border: none; background: transparent; color: var(--text-muted);
      font-family: inherit; font-size: 11px; font-weight: 700;
      padding: 7px 13px; border-radius: 99px; cursor: pointer; transition: 0.2s;
    }
    .mode-pill.active { background: var(--accent); color: #fff; }
    .quick-ext-link {
      background: rgba(255, 255, 255, 0.05); color: #e2e8f0;
      border: 1px solid var(--border); padding: 7px 12px;
      border-radius: 99px; font-size: 11px; font-weight: 700; text-decoration: none;
      transition: 0.2s;
    }
    .quick-ext-link:hover { border-color: var(--accent); color: #fff; }

    /* Live Preview Card */
    .live-preview-card {
      background: #ffffff; color: #1e293b; border-radius: 20px; overflow: hidden;
      border: 2px solid rgba(236, 72, 153, 0.65);
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5); margin-bottom: 18px;
    }
    .lp-cover { position: relative; height: 165px; background: #1e293b; }
    .lp-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .lp-cover-grad { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0.1), rgba(0,0,0,0.5)); }
    .edit-cover-btn {
      position: absolute; top: 12px; right: 12px; z-index: 5;
      background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(8px);
      color: #fff; border: 1px solid rgba(255, 255, 255, 0.25);
      padding: 7px 13px; border-radius: 99px; font-size: 11px; font-weight: 700;
      cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    }
    .edit-cover-btn:hover { background: var(--accent); border-color: var(--accent); }

    .lp-body { padding: 0 18px 20px; position: relative; }
    .lp-top-row { display: flex; justify-content: space-between; align-items: flex-end; margin-top: -46px; margin-bottom: 12px; }
    .lp-avatar-wrap { position: relative; width: 92px; height: 92px; }
    .lp-avatar-wrap img {
      width: 100%; height: 100%; border-radius: 50%; object-fit: cover;
      border: 4px solid #fff; box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22); background: #fff;
    }
    .edit-avatar-btn {
      position: absolute; bottom: 0; right: -2px; background: var(--accent); color: #fff;
      border: 2px solid #fff; width: 32px; height: 32px; border-radius: 50%;
      font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
    }
    .lp-price-box {
      background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;
      padding: 8px 14px; text-align: right;
    }
    .lp-price-box span { display: block; font-size: 10px; color: #64748b; font-weight: 700; text-transform: uppercase; }
    .lp-price-box strong { font-size: 18px; color: #0f172a; font-weight: 800; }

    .lp-name { font-size: 20px; font-weight: 800; color: #0f172a; display: flex; align-items: center; gap: 6px; }
    .lp-city { font-size: 12px; color: #64748b; font-weight: 600; margin-top: 2px; }
    .lp-bio {
      font-size: 12.5px; color: #334155; line-height: 1.55; margin-top: 12px;
      background: #f1f5f9; padding: 11px 14px; border-radius: 12px;
    }
    .lp-fake-cta { margin-top: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .lp-btn-wa { background: #16a34a; color: #fff; text-align: center; padding: 11px; border-radius: 10px; font-size: 12px; font-weight: 700; }
    .lp-btn-vip { background: linear-gradient(135deg, #e11d48, #db2777); color: #fff; text-align: center; padding: 11px; border-radius: 10px; font-size: 12px; font-weight: 700; }

    .client-view-mode .edit-cover-btn,
    .client-view-mode .edit-avatar-btn { display: none !important; }

    /* KPIs & Earnings Chart */
    .kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .kpi-box {
      background: var(--bg-input); border: 1px solid var(--border);
      border-radius: 14px; padding: 14px 8px; text-align: center;
    }
    .kpi-num { font-size: 22px; font-weight: 800; color: #fff; }
    .kpi-label { font-size: 10px; color: var(--text-muted); font-weight: 700; text-transform: uppercase; margin-top: 4px; }

    .earn-split { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
    .earn-pill {
      background: var(--bg-input); border: 1px solid var(--border);
      border-radius: 14px; padding: 12px 14px;
    }
    .earn-pill span { font-size: 10px; color: var(--text-muted); font-weight: 700; display: block; margin-bottom: 4px; }
    .earn-pill strong { font-size: 16px; font-weight: 800; }

    .chart-box {
      display: flex; align-items: flex-end; justify-content: space-between; gap: 8px;
      height: 145px; padding: 16px 10px 8px; background: var(--bg-input);
      border: 1px solid var(--border); border-radius: 16px;
    }

    /* Media & VIP Posts */
    .media-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 14px; }
    .media-item {
      position: relative; aspect-ratio: 1/1; border-radius: 12px;
      overflow: hidden; background: #000; border: 1px solid var(--border);
    }
    .media-item img, .media-item video { width: 100%; height: 100%; object-fit: cover; }
    .del-btn {
      position: absolute; top: 6px; right: 6px; background: rgba(220, 38, 38, 0.9);
      color: #fff; border: none; border-radius: 6px; padding: 4px 8px;
      font-size: 11px; cursor: pointer; font-weight: 700;
    }
    .media-set-bar {
      position: absolute; bottom: 0; left: 0; right: 0;
      background: rgba(7, 10, 18, 0.82); backdrop-filter: blur(4px);
      display: flex; gap: 4px; padding: 5px;
    }
    .media-set-btn {
      flex: 1; background: rgba(255, 255, 255, 0.14); color: #fff; border: none;
      border-radius: 5px; font-size: 10px; font-weight: 700; padding: 5px 2px; cursor: pointer;
    }
    .media-set-btn:hover { background: var(--accent); }

    .vip-post-row {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      background: var(--bg-input); border: 1px solid var(--border);
      border-radius: 12px; padding: 10px; margin-top: 10px;
    }
    .vip-post-thumb { width: 48px; height: 48px; border-radius: 10px; object-fit: cover; background: #000; flex-shrink: 0; }

    /* Highlight Plans */
    .plan-box {
      border: 1px solid var(--border); border-radius: 14px; padding: 14px;
      margin-bottom: 10px; display: flex; justify-content: space-between;
      align-items: center; gap: 12px; background: var(--bg-input); transition: 0.2s;
    }
    .plan-box:hover { border-color: #334155; }
    .plan-btn {
      background: var(--green); color: #022c22; border: none; padding: 10px 16px;
      border-radius: 10px; font-weight: 800; font-size: 13px; cursor: pointer;
      white-space: nowrap; transition: 0.2s;
    }
    .plan-btn:hover { background: #059669; color: #fff; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top-nav">
      <a href="/vitrine" class="brand">💎 GAROTA VIP <span class="brand-tag">Studio</span></a>
      <button id="logout-btn" class="logout-btn" onclick="logout()" style="display:none">Sair</button>
    </div>

    <!-- Tela de Login / Cadastro -->
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
        <div style="text-align:center;font-size:11px;color:#64748b;margin:16px 0;font-weight:700">— OU ENTRE COM E-MAIL —</div>
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
        <button class="btn" onclick="doLogin()">Acessar Creator Studio</button>
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

    <!-- Painel Logado -->
    <div id="dash-box" style="display:none">
      <!-- Menu de Navegação Rápida por Abas -->
      <nav class="studio-nav">
        <button class="s-nav-btn active" id="nav-perfil" onclick="openStudioTab('perfil')">
          <span class="ico">👤</span><span>Perfil</span>
        </button>
        <button class="s-nav-btn" id="nav-vip" onclick="openStudioTab('vip')">
          <span class="ico">🔥</span><span>Clube VIP</span>
        </button>
        <button class="s-nav-btn" id="nav-galeria" onclick="openStudioTab('galeria')">
          <span class="ico">📸</span><span>Galeria</span>
        </button>
        <button class="s-nav-btn" id="nav-impulsionar" onclick="openStudioTab('impulsionar')">
          <span class="ico">🚀</span><span>Destaque</span>
        </button>
      </nav>

      <!-- ABA 1: PERFIL & PRÉVIA AO VIVO -->
      <div id="tab-perfil" class="studio-section">
        <div class="mode-switcher">
          <div class="mode-pills">
            <button id="btn-mode-edit" class="mode-pill active" onclick="setPreviewMode('edit')">✏️ Editar</button>
            <button id="btn-mode-client" class="mode-pill" onclick="setPreviewMode('client')">👁️ Visão Cliente</button>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <a href="/minha-conta/editar" class="quick-ext-link" style="border-color:#ec4899;color:#f472b6;">⚙️ Edição Completa</a>
            <a id="vip-club-link" href="#" target="_blank" class="quick-ext-link">🔥 Clube VIP ↗</a>
            <a id="profile-link" href="#" target="_blank" class="quick-ext-link">Perfil ↗</a>
          </div>
        </div>

        <div id="live-preview-card" class="live-preview-card">
          <div class="lp-cover">
            <img id="lp-cover-img" src="https://placehold.co/900x360/1e293b/ec4899?text=CAPA" alt="Capa" />
            <div class="lp-cover-grad"></div>
            <button type="button" class="edit-cover-btn" onclick="document.getElementById('cover-file-input').click()">
              📷 Alterar Capa
            </button>
            <input type="file" id="cover-file-input" accept="image/*" style="display:none" onchange="uploadSingleProfilePhoto('cover', this.files[0])" />
          </div>

          <div class="lp-body">
            <div class="lp-top-row">
              <div class="lp-avatar-wrap">
                <img id="lp-avatar-img" src="https://placehold.co/300x300/1e293b/ec4899?text=VIP" alt="Avatar" />
                <button type="button" class="edit-avatar-btn" title="Trocar foto de perfil" onclick="document.getElementById('avatar-file-input').click()">
                  📷
                </button>
                <input type="file" id="avatar-file-input" accept="image/*" style="display:none" onchange="uploadSingleProfilePhoto('avatar', this.files[0])" />
              </div>

              <div class="lp-price-box">
                <span>Cachê (1 hora)</span>
                <strong id="lp-price-display">Consultar</strong>
              </div>
            </div>

            <div class="lp-name">
              <span id="lp-name-display">Seu Nome</span>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="#1284ED"><path d="M12 2L14.8 4.6L18.6 4.1L19.4 7.8L22.7 9.7L21 13.1L22.7 16.5L19.4 18.4L18.6 22.1L14.8 21.6L12 24.2L9.2 21.6L5.4 22.1L4.6 18.4L1.3 16.5L3 13.1L1.3 9.7L4.6 7.8L5.4 4.1L9.2 4.6L12 2Z"/><path d="M9.5 12.5L11.2 14.2L15 10.2" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
            </div>
            <div class="lp-city" id="lp-city-display">📍 Cidade - UF</div>
            <div class="lp-bio" id="lp-bio-display">Sua descrição aparecerá aqui para os clientes...</div>

            <div class="lp-fake-cta">
              <div class="lp-btn-wa">💬 Chamar no WhatsApp</div>
              <div class="lp-btn-vip" id="lp-vip-btn-label">🔥 Clube VIP (R$ 49,90/mês)</div>
            </div>
          </div>
        </div>

        <div id="edit-form-card" class="card">
          <div class="card-header">
            <h3>✏️ Valores e Informações</h3>
          </div>
          <div style="display:flex;gap:10px">
            <div style="flex:1">
              <label>Cachê 1 Hora (R$)</label>
              <input id="p-rate" type="number" step="10" placeholder="Ex: 300" oninput="syncLivePreview()" />
            </div>
            <div style="flex:1">
              <label>Assinatura VIP (R$/mês)</label>
              <input id="p-vip-price" type="number" step="5" placeholder="Ex: 49.90" oninput="syncLivePreview()" />
            </div>
          </div>
          <div style="display:flex;gap:10px">
            <div style="flex:1.4">
              <label>Nome Artístico</label>
              <input id="p-name" oninput="syncLivePreview()" />
            </div>
            <div style="flex:1">
              <label>WhatsApp (DDD)</label>
              <input id="p-wa" placeholder="65999999999" />
            </div>
          </div>
          <label>Cidade</label>
          <input id="p-city" oninput="syncLivePreview()" />
          <label>Descrição do Atendimento</label>
          <textarea id="p-bio" rows="3" placeholder="Descreva seu atendimento, horários e diferenciais..." oninput="syncLivePreview()"></textarea>
          <button class="btn" onclick="saveProfile()">💾 Salvar Alterações do Perfil</button>
        </div>

        <div class="card">
          <div class="card-header">
            <h3>📊 Alcance do Perfil (30 Dias)</h3>
            <span id="status-badge" style="font-size:11px;color:#fbbf24;font-weight:700"></span>
          </div>
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
              <div class="kpi-label">🔥 Conversão</div>
            </div>
          </div>
        </div>
      </div>

      <!-- ABA 2: CLUBE VIP (GANHOS + PUBLICAR CONTEÚDO EXCLUSIVO) -->
      <div id="tab-vip" class="studio-section" style="display:none;">
        <!-- Gráfico de Ganhos -->
        <div class="card">
          <div class="card-header">
            <h3>💸 Ganhos no Clube VIP</h3>
            <span id="vip-total-earned" style="font-size:18px;font-weight:800;color:#10b981;">R$ 0,00</span>
          </div>

          <div class="earn-split">
            <div class="earn-pill">
              <span>👑 ASSINATURAS (<b id="vip-subs-count">0</b>)</span>
              <strong id="vip-subs-earned" style="color:#ec4899;">R$ 0,00</strong>
            </div>
            <div class="earn-pill">
              <span>🔥 AVULSOS 1X (<b id="vip-ppv-count">0</b>)</span>
              <strong id="vip-ppv-earned" style="color:#38bdf8;">R$ 0,00</strong>
            </div>
          </div>

          <label style="margin-bottom:8px;">Faturamento dos últimos 7 dias</label>
          <div id="vip-earnings-chart" class="chart-box"></div>
        </div>

        <!-- Publicar Post Exclusivo -->
        <div class="card">
          <div class="card-header">
            <h3>🔥 Publicar Conteúdo Exclusivo</h3>
          </div>
          <p class="subtitle">
            Publique fotos ou vídeos protegidos contra print. Você pode liberar para assinantes mensais ou vender avulso com visualização única (1x).
          </p>
          <label>Legenda do Post</label>
          <textarea id="vip-post-caption" rows="2" placeholder="Ex: Ensaio exclusivo gravado hoje à noite 🔥"></textarea>
          <div style="display:flex;gap:10px">
            <div style="flex:1">
              <label>Preço Avulso 1x (R$)</label>
              <input id="vip-post-price" type="number" step="5" value="29.90" />
            </div>
            <div style="flex:1.4">
              <label>Modo de Venda</label>
              <select id="vip-post-mode">
                <option value="both">Assinantes + Compra Avulsa (1x)</option>
                <option value="ppv_only">Somente Compra Avulsa (1x)</option>
              </select>
            </div>
          </div>
          <label>Arquivo (Foto ou Vídeo)</label>
          <input type="file" id="vip-post-file" accept="image/*,video/*" />
          <button class="btn" onclick="publishVipPost()">🚀 Publicar no Clube VIP</button>
          <p id="vip-post-status" style="font-size:12px;color:#10b981;font-weight:700;margin-top:8px;"></p>

          <div id="vip-posts-list" style="margin-top:14px;"></div>
        </div>
      </div>

      <!-- ABA 3: GALERIA PÚBLICA & REELS -->
      <div id="tab-galeria" class="studio-section" style="display:none;">
        <div class="card">
          <div class="card-header">
            <h3>📸 Galeria Pública & Reels</h3>
          </div>
          <p class="subtitle">
            As fotos e vídeos públicos aparecem na sua página, na vitrine e no feed de Reels para atrair novos clientes.
          </p>
          <label>Visibilidade</label>
          <select id="vis-select">
            <option value="public">Público (Vitrine, Perfil e Reels)</option>
            <option value="preview">Prévia Borrada</option>
          </select>
          <input type="file" id="file-input" accept="image/*,video/*" multiple onchange="uploadFiles()" />
          <p id="upload-status" style="font-size:12px;color:#10b981;font-weight:700;margin-top:6px"></p>
          <div id="media-grid" class="media-grid"></div>
        </div>
      </div>

      <!-- ABA 4: IMPULSIONAR PERFIL -->
      <div id="tab-impulsionar" class="studio-section" style="display:none;">
        <div class="card">
          <div class="card-header">
            <h3>🚀 Impulsionar Perfil na Vitrine</h3>
          </div>
          <p class="subtitle">
            Destaque seu anúncio no topo da primeira página com liberação automática via Pix:
          </p>
          <div id="plans-list"></div>

          <div id="pix-area" style="display:none;text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
            <p id="pix-plan-title" style="font-weight:700;margin-bottom:10px;color:#fff"></p>
            <img id="pix-qr" style="width:190px;height:190px;background:#fff;padding:8px;border-radius:12px;margin:0 auto 12px;display:block" />
            <textarea id="pix-code" rows="3" readonly style="font-size:11px;background:#05070d;color:#cbd5e1"></textarea>
            <button class="btn btn-green" onclick="copyPix()" style="margin-top:8px">📋 Copiar Código Pix</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let token = localStorage.getItem('portal_token') || '';
    let currentStateUF = 'MT';

    function openStudioTab(tabName) {
      document.querySelectorAll('.studio-section').forEach(el => el.style.display = 'none');
      document.querySelectorAll('.s-nav-btn').forEach(btn => btn.classList.remove('active'));
      document.getElementById('tab-' + tabName).style.display = 'block';
      document.getElementById('nav-' + tabName).classList.add('active');
    }

    function setPreviewMode(mode) {
      const card = document.getElementById('live-preview-card');
      const editForm = document.getElementById('edit-form-card');
      const btnEdit = document.getElementById('btn-mode-edit');
      const btnClient = document.getElementById('btn-mode-client');

      if (mode === 'client') {
        card.classList.add('client-view-mode');
        editForm.style.display = 'none';
        btnClient.classList.add('active');
        btnEdit.classList.remove('active');
      } else {
        card.classList.remove('client-view-mode');
        editForm.style.display = 'block';
        btnEdit.classList.add('active');
        btnClient.classList.remove('active');
      }
    }

    function syncLivePreview() {
      const name = document.getElementById('p-name').value.trim() || 'Seu Nome Artístico';
      const city = document.getElementById('p-city').value.trim() || 'Sua Cidade';
      const rate = document.getElementById('p-rate').value;
      const vipPrice = document.getElementById('p-vip-price').value;
      const bio = document.getElementById('p-bio').value.trim() || 'Atendimento exclusivo com total discrição e segurança.';

      document.getElementById('lp-name-display').innerText = name;
      document.getElementById('lp-city-display').innerText = '📍 ' + city + ' - ' + currentStateUF;
      document.getElementById('lp-bio-display').innerText = bio;
      document.getElementById('lp-price-display').innerText = rate ? 'R$ ' + Number(rate).toFixed(0) : 'Consultar';
      document.getElementById('lp-vip-btn-label').innerText = vipPrice
        ? '🔥 Clube VIP (R$ ' + Number(vipPrice).toFixed(2).replace('.', ',') + '/mês)'
        : '🔥 Clube VIP';
    }

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

      currentStateUF = creator.state || 'MT';

      document.getElementById('auth-box').style.display = 'none';
      document.getElementById('dash-box').style.display = 'block';
      document.getElementById('logout-btn').style.display = 'block';
      document.getElementById('profile-link').href = '/acompanhante/' + creator.slug;
      document.getElementById('vip-club-link').href = '/vip/' + creator.slug;
      document.getElementById('status-badge').innerText = creator.verified
        ? '✅ Ativo | ' + creator.tier.toUpperCase()
        : '⏳ Aguardando aprovação';

      if (creator.cover_url || creator.avatar_url) {
        document.getElementById('lp-cover-img').src = creator.cover_url || creator.avatar_url;
      }
      if (creator.avatar_url || creator.cover_url) {
        document.getElementById('lp-avatar-img').src = creator.avatar_url || creator.cover_url;
      }

      const views = Number(stats?.views_30d || 0);
      const contacts = Number(stats?.contacts_30d || 0);
      const conv = views > 0 ? Math.min(100, Math.round((contacts / views) * 100)) : 0;
      document.getElementById('kpi-views').innerText = views;
      document.getElementById('kpi-contacts').innerText = contacts;
      document.getElementById('kpi-rate').innerText = conv + '%';

      document.getElementById('p-rate').value = creator.hourly_rate || '';
      document.getElementById('p-vip-price').value = creator.vip_monthly_price || '49.90';
      document.getElementById('p-wa').value = creator.whatsapp || '';
      document.getElementById('p-name').value = creator.stage_name || '';
      document.getElementById('p-city').value = creator.city || '';
      document.getElementById('p-bio').value = creator.bio || '';
      syncLivePreview();

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
      loadVipPosts();
      loadVipEarnings();
    }

    async function loadVipEarnings() {
      const res = await fetch('/api/vip/earnings', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok) return;

      const fmt = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
      document.getElementById('vip-total-earned').innerText = fmt(data.totalAll);
      document.getElementById('vip-subs-earned').innerText = fmt(data.totalSubs);
      document.getElementById('vip-subs-count').innerText = data.countSubs;
      document.getElementById('vip-ppv-earned').innerText = fmt(data.totalPpv);
      document.getElementById('vip-ppv-count').innerText = data.countPpv;

      const daily = data.daily || [];
      const maxVal = Math.max(...daily.map(d => d.total), 10);

      document.getElementById('vip-earnings-chart').innerHTML = daily.map(d => {
        const pct = Math.max(8, Math.round((d.total / maxVal) * 100));
        return \`
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;height:100%;justify-content:flex-end;gap:5px;" title="\${d.label}: \${fmt(d.total)}">
            <span style="font-size:9px;color:#e2e8f0;font-weight:700;">\${d.total > 0 ? 'R$' + Math.round(d.total) : ''}</span>
            <div style="width:100%;max-width:28px;height:\${pct}%;background:\${d.total > 0 ? 'linear-gradient(180deg,#ec4899,#8b5cf6)' : '#1e293b'};box-shadow:\${d.total > 0 ? '0 0 12px rgba(236,72,153,0.4)' : 'none'};border-radius:7px 7px 3px 3px;transition:height 0.4s;"></div>
            <span style="font-size:9px;color:#64748b;font-weight:700;">\${d.label}</span>
          </div>
        \`;
      }).join('');
    }

    async function uploadSingleProfilePhoto(target, file) {
      if (!file) return;
      const presign = await fetch('/api/creator/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, visibility: 'public' }),
      }).then(r => r.json());

      if (!presign.ok) return alert(presign.error || 'Erro ao preparar upload');

      await fetch(presign.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });

      const payload = target === 'cover' ? { cover_url: presign.publicUrl } : { avatar_url: presign.publicUrl };
      await fetch('/api/portal/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(payload),
      });

      if (target === 'cover') {
        document.getElementById('lp-cover-img').src = presign.publicUrl;
        alert('✅ Foto de capa atualizada!');
      } else {
        document.getElementById('lp-avatar-img').src = presign.publicUrl;
        alert('✅ Foto principal do perfil atualizada!');
      }
    }

    async function setExistingAs(target, url) {
      const payload = target === 'cover' ? { cover_url: url } : { avatar_url: url };
      await fetch('/api/portal/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(payload),
      });
      if (target === 'cover') {
        document.getElementById('lp-cover-img').src = url;
        alert('✅ Definida como foto de capa!');
      } else {
        document.getElementById('lp-avatar-img').src = url;
        alert('✅ Definida como foto principal!');
      }
    }

    async function saveProfile() {
      const rateVal = document.getElementById('p-rate').value;
      const vipPriceVal = document.getElementById('p-vip-price').value;
      const res = await fetch('/api/portal/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          hourly_rate: rateVal ? Number(rateVal) : null,
          vip_monthly_price: vipPriceVal ? Number(vipPriceVal) : 49.90,
          whatsapp: document.getElementById('p-wa').value.replace(/\\D/g, ''),
          stage_name: document.getElementById('p-name').value.trim(),
          city: document.getElementById('p-city').value.trim(),
          bio: document.getElementById('p-bio').value.trim(),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        syncLivePreview();
        alert('✅ Alterações salvas com sucesso!');
      }
    }

    async function publishVipPost() {
      const file = document.getElementById('vip-post-file').files[0];
      const caption = document.getElementById('vip-post-caption').value.trim();
      const price = Number(document.getElementById('vip-post-price').value) || 29.90;
      const mode = document.getElementById('vip-post-mode').value;
      const status = document.getElementById('vip-post-status');

      if (!file) return alert('Selecione uma foto ou vídeo exclusivo para publicar.');

      status.innerText = 'Enviando mídia exclusiva...';
      const presign = await fetch('/api/creator/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, visibility: 'subscriber' }),
      }).then(r => r.json());

      if (!presign.ok) return alert(presign.error || 'Erro ao preparar upload');

      await fetch(presign.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });

      const res = await fetch('/api/vip/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          caption,
          mediaType: presign.mediaType,
          mediaUrl: presign.publicUrl,
          previewUrl: presign.publicUrl,
          price,
          singleView: true,
          allowSubscription: mode === 'both'
        }),
      }).then(r => r.json());

      if (res.ok) {
        status.innerText = '✅ Post publicado no seu Clube VIP!';
        document.getElementById('vip-post-caption').value = '';
        document.getElementById('vip-post-file').value = '';
        loadVipPosts();
      } else {
        alert(res.error || 'Erro ao publicar post VIP.');
      }
    }

    async function loadVipPosts() {
      const res = await fetch('/api/vip/my-posts', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) return;
      const { posts } = await res.json();
      document.getElementById('vip-posts-list').innerHTML = (posts || []).map(p => \`
        <div class="vip-post-row">
          <div style="display:flex;align-items:center;gap:10px;overflow:hidden;">
            \${p.media_type === 'video' ? \`<video src="\${p.media_url}" class="vip-post-thumb"></video>\` : \`<img src="\${p.media_url}" class="vip-post-thumb" />\`}
            <div style="overflow:hidden;">
              <strong style="display:block;font-size:12px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">\${p.caption || 'Conteúdo Exclusivo'}</strong>
              <span style="font-size:11px;color:#ec4899;font-weight:700;">R$ \${Number(p.price).toFixed(2).replace('.', ',')} (1x) \${p.allow_subscription ? '• + Assinantes' : ''}</span>
            </div>
          </div>
          <button onclick="delVipPost(\${p.id})" style="background:#dc2626;color:#fff;border:none;border-radius:8px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;">Excluir</button>
        </div>
      \`).join('');
    }

    async function delVipPost(id) {
      if (!confirm('Remover este post do Clube VIP?')) return;
      await fetch('/api/vip/posts/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
      loadVipPosts();
    }

    async function loadMedia() {
      const res = await fetch('/api/creator/media', { headers: { Authorization: 'Bearer ' + token } });
      const { items } = await res.json();
      document.getElementById('media-grid').innerHTML = (items || []).map(m => \`
        <div class="media-item">
          \${m.media_type === 'video' ? \`<video src="\${m.public_url}"></video>\` : \`<img src="\${m.public_url}" />\`}
          <button class="del-btn" onclick="delMedia(\${m.id})">✕</button>
          \${m.media_type === 'image' ? \`
            <div class="media-set-bar">
              <button class="media-set-btn" onclick="setExistingAs('cover', '\${m.public_url}')">Capa</button>
              <button class="media-set-btn" onclick="setExistingAs('avatar', '\${m.public_url}')">Perfil</button>
            </div>\` : ''}
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

    const res = await pool.query(`SELECT id, stage_name, email, city, state, whatsapp, tier, verified, active, verification_video_url, created_at FROM creator_accounts ORDER BY created_at DESC LIMIT 100`);
    const rows = res.rows
      .map(
        (c) => `
      <div style="background:#111827;padding:14px;border-radius:12px;margin-bottom:10px;border:1px solid #1f2937;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div>
          <strong style="color:#fff">#${c.id} ${c.stage_name}</strong> (${c.city}-${c.state})<br/>
          <small style="color:#94a3b8">${c.email} | WA: ${c.whatsapp || '-'} | Plano: ${c.tier}</small><br/>
          ${c.verification_video_url ? `<a href="${c.verification_video_url}" target="_blank" style="display:inline-block;margin-top:4px;font-size:11px;color:#38bdf8;font-weight:bold;text-decoration:none;">🎥 Assistir Vídeo de Verificação ↗</a>` : '<span style="font-size:11px;color:#ef4444;">Sem vídeo de verificação</span>'}
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
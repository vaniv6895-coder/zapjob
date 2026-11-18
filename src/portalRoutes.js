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
import { registerPortalSecurityRoutes } from './portalSecurityRoutes.js';

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
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // Expira após 7 dias
  if (Date.now() - Number(ts) > maxAgeMs) return null;
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

  app.get('/biometria-facial', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'biometria-facial.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });
  
  registerVipFeedRoutes(app, requireCreatorAuth);
  registerPortalProfileRoute(app);
  registerPortalMediaRoutes(app, requireCreatorAuth);
  registerPortalSecurityRoutes(app, requireCreatorAuth, signSessionToken);

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

  // Entrega o Client ID do Google para o frontend separado
  app.get('/api/portal/auth-config', async (req, reply) => {
    return reply.send({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
  });

  // Página separada de Login/Cadastro (Google) e Creator Studio
  app.get('/minha-conta', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'minha-conta.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
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
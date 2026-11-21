import crypto from 'crypto';
import { pool, getBotSettings, saveBotSettings } from './db.js';
import fs from 'fs';
import path from 'path';
import { registerTelemetryRoutes } from './visitaid.js';
import { registerVipFeedRoutes } from './vipFeedRoutes.js';
import nodemailer from 'nodemailer';

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

function getAdminSecret() {
  return String(process.env.PANEL_PASSWORD || '').trim();
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function signAdminToken() {
  const secret = getAdminSecret();
  if (!secret) return null;
  const payload = `admin.${Date.now()}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyAdminToken(token) {
  const secret = getAdminSecret();
  if (!secret || !token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'admin') return false;
  const ts = Number(parts[1]);
  const maxAgeMs = 12 * 60 * 60 * 1000; // Expira após 12 horas
  if (!Number.isFinite(ts) || Date.now() - ts > maxAgeMs) return false;
  const expected = crypto.createHmac('sha256', secret).update(`admin.${parts[1]}`).digest('hex');
  return safeEqual(parts[2], expected);
}

function isAdminAuthorized(req) {
  const secret = getAdminSecret();
  if (!secret) return false;

  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (verifyAdminToken(token)) return true;
  }

  // Fallback opcional para compatibilidade interna
  if (req.query?.pwd && safeEqual(req.query.pwd, secret)) {
    return true;
  }

  return false;
}

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
  // Garante colunas opcionais de link nos Stories
  pool.query(`
    ALTER TABLE creator_media
      ADD COLUMN IF NOT EXISTS link_url TEXT,
      ADD COLUMN IF NOT EXISTS link_label VARCHAR(80);
  `).catch(() => {});

  // Tabela de log de disparos de e-mail por IA
  pool.query(`
    CREATE TABLE IF NOT EXISTS ai_email_campaigns (
      id SERIAL PRIMARY KEY,
      creator_id INTEGER,
      recipient_email TEXT NOT NULL,
      stage_name TEXT,
      campaign_type VARCHAR(50),
      subject TEXT,
      body TEXT,
      status VARCHAR(20) DEFAULT 'sent',
      error_msg TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `).catch(() => {});

  // Proteção centralizada para TODAS as rotas /api/portal/admin/* (exceto /login)
  app.addHook('onRequest', async (req, reply) => {
    const urlPath = req.url.split('?')[0];
    if (urlPath.startsWith('/api/portal/admin/') && urlPath !== '/api/portal/admin/login') {
      if (!getAdminSecret()) {
        return reply.status(503).send({ error: 'PANEL_PASSWORD não configurada no servidor.' });
      }
      if (!isAdminAuthorized(req)) {
        return reply.status(401).send({ error: 'Não autorizado.' });
      }
      // Injeta pwd internamente para compatibilidade com rotas de visitaid.js
      if (!req.query) req.query = {};
      req.query.pwd = getAdminSecret();
    }
  });

  // Login seguro do Command Center Admin (via POST no corpo JSON, sem expor senha na URL)
  app.post('/api/portal/admin/login', async (req, reply) => {
    const secret = getAdminSecret();
    if (!secret) {
      return reply.status(503).send({ error: 'Configure a variável PANEL_PASSWORD no Railway.' });
    }
    const { password } = req.body || {};
    if (!safeEqual(password, secret)) {
      return reply.status(401).send({ error: 'Senha incorreta.' });
    }
    const token = signAdminToken();
    return reply.send({ ok: true, token });
  });

  // Ativa telemetria, analytics, trends e o painel admin
  registerTelemetryRoutes(app, pool);

  // Rota para o Command Center Admin (/admin-dashboard)
  app.get('/admin-dashboard', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'admin-dashboard.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // Página dedicada do Agente de IA — Disparos Gmail (/admin-ai-gmail)
  app.get('/admin-ai-gmail', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'admin-ai-gmail.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // Lista destinatárias elegíveis + histórico recente de disparos
  app.get('/api/portal/admin/ai-gmail/data', async (req, reply) => {
    const [creatorsRes, logsRes] = await Promise.all([
      pool.query(`
        SELECT id, stage_name, email, city, state, tier, verified, featured_until,
               COALESCE(views_count, 0)::int AS views_count
        FROM creator_accounts
        WHERE COALESCE(email, '') <> ''
          AND email NOT LIKE '%@demo.com'
        ORDER BY id DESC
      `),
      pool.query(`
        SELECT id, recipient_email, stage_name, campaign_type, subject, status, error_msg, created_at
        FROM ai_email_campaigns
        ORDER BY created_at DESC
        LIMIT 50
      `).catch(() => ({ rows: [] })),
    ]);

    return reply.send({
      ok: true,
      gmailConfigured: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
      senderEmail: process.env.GMAIL_USER || '',
      creators: creatorsRes.rows,
      logs: logsRes.rows,
    });
  });

  // Gera texto personalizado com Gemini (ou template inteligente) e envia via Gmail
  app.post('/api/portal/admin/ai-gmail/send', async (req, reply) => {
    const { creatorIds = [], campaignType = 'boost', customPrompt = '', dryRun = false } = req.body || {};

    if (!Array.isArray(creatorIds) || creatorIds.length === 0) {
      return reply.status(400).send({ error: 'Selecione ao menos uma modelo.' });
    }

    const gmailUser = String(process.env.GMAIL_USER || '').trim();
    const gmailPass = String(process.env.GMAIL_APP_PASSWORD || '').trim();

    if (!dryRun && (!gmailUser || !gmailPass)) {
      return reply.status(503).send({
        error: 'Configure GMAIL_USER e GMAIL_APP_PASSWORD nas variáveis do Railway antes de disparar.',
      });
    }

    const creatorsRes = await pool.query(
      `SELECT id, stage_name, email, city, state, tier, COALESCE(views_count, 0)::int AS views_count
       FROM creator_accounts
       WHERE id = ANY($1::int[])`,
      [creatorIds.map(Number)]
    );

    const studioUrl = `${(process.env.PUBLIC_URL || 'https://zapjob-production.up.railway.app').replace(/\/$/, '')}/minha-conta`;

    async function gerarCopyIA(creator) {
      const geminiKey = process.env.GEMINI_API_KEY;
      const goalMap = {
        boost: 'convidar a modelo a ativar o Destaque VIP/Diamante para voltar ao topo da vitrine e receber mais contatos no WhatsApp',
        onboarding: 'dar boas-vindas e incentivar a completar fotos/vídeos e verificação facial para liberar o perfil na vitrine',
        reactivation: 'reativar uma modelo inativa mostrando que há buscas na cidade dela',
      };
      const objetivo = goalMap[campaignType] || goalMap.boost;

      if (geminiKey) {
        try {
          const prompt = `Você é o gerente de sucesso de criadoras da plataforma Garota VIP.
Escreva um e-mail curto, elegante, direto e persuasivo em português para ${creator.stage_name} (${creator.city}-${creator.state}), que teve ${creator.views_count} visualizações no perfil.
Objetivo: ${objetivo}.
${customPrompt ? `Instrução extra do admin: ${customPrompt}` : ''}
Inclua este link de acesso: ${studioUrl}
Responda APENAS em JSON válido no formato: {"subject": "...", "body": "..."} (use quebras de linha \\n no body, sem markdown).`;

          const aiRes = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
            { contents: [{ parts: [{ text: prompt }] }] },
            { timeout: 12000 }
          );
          const raw = aiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const cleaned = raw.replace(/```json|```/gi, '').trim();
          const parsed = JSON.parse(cleaned);
          if (parsed.subject && parsed.body) return parsed;
        } catch {}
      }

      return {
        subject: `${creator.stage_name}, seu perfil em ${creator.city} está recebendo buscas 🔥`,
        body: `Oi ${creator.stage_name}, tudo bem?\n\nNotamos que visitantes em ${creator.city}-${creator.state} estão procurando perfis como o seu na vitrine do Garota VIP.\n\nAtive agora o Destaque VIP no seu painel para ficar na 1ª linha e multiplicar seus cliques no WhatsApp:\n${studioUrl}\n\nQualquer dúvida, responda este e-mail!\nEquipe Garota VIP`,
      };
    }

    if (dryRun) {
      const sample = creatorsRes.rows[0];
      const preview = await gerarCopyIA(sample);
      return reply.send({ ok: true, preview, recipient: sample });
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass },
    });

    const results = [];
    for (const c of creatorsRes.rows) {
      const copy = await gerarCopyIA(c);
      try {
        await transporter.sendMail({
          from: `"Garota VIP" <${gmailUser}>`,
          to: c.email,
          subject: copy.subject,
          text: copy.body,
        });

        await pool.query(
          `INSERT INTO ai_email_campaigns (creator_id, recipient_email, stage_name, campaign_type, subject, body, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'sent')`,
          [c.id, c.email, c.stage_name, campaignType, copy.subject, copy.body]
        );
        results.push({ id: c.id, email: c.email, status: 'sent' });
      } catch (err) {
        await pool.query(
          `INSERT INTO ai_email_campaigns (creator_id, recipient_email, stage_name, campaign_type, subject, body, status, error_msg)
           VALUES ($1, $2, $3, $4, $5, $6, 'error', $7)`,
          [c.id, c.email, c.stage_name, campaignType, copy.subject, copy.body, String(err.message || err)]
        );
        results.push({ id: c.id, email: c.email, status: 'error', error: err.message });
      }
    }

    return reply.send({ ok: true, results });
  });

  // Rota explícita para a página de fluxo (/index.html), com fallback seguro se não existir
  app.get('/index.html', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'index.html');
    if (!fs.existsSync(filePath)) {
      return reply.status(404).send({
        error: 'Arquivo public/index.html não encontrado no servidor. Adicione public/index.html ao repositório e faça deploy.',
      });
    }
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // Resumo de cadastros: Assinantes vs Modelos vs Acompanhantes
  app.get('/api/portal/admin/registrations-summary', async (req, reply) => {
    let subscribersCount = 0;
    let modelsCount = 0;
    let escortsCount = 0;

    try {
      const creatorsRes = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE COALESCE(email, '') NOT LIKE '%@demo.com')::int AS total_creators,
          COUNT(*) FILTER (
            WHERE COALESCE(email, '') NOT LIKE '%@demo.com'
              AND (
                COALESCE(hourly_rate, 0) > 0
                OR LOWER(COALESCE(specialty_tag, '') || ' ' || COALESCE(bio, '')) ~ '(acompanhante|encontro|cache|cachê|local proprio|local próprio)'
              )
          )::int AS escorts_count
        FROM creator_accounts
      `);
      const totalCreators = creatorsRes.rows[0]?.total_creators || 0;
      escortsCount = creatorsRes.rows[0]?.escorts_count || 0;
      modelsCount = Math.max(0, totalCreators - escortsCount);
    } catch {}

    const fanTables = ['fan_accounts', 'vip_fans', 'vip_users', 'client_accounts'];
    for (const tbl of fanTables) {
      try {
        const r = await pool.query(`SELECT COUNT(*)::int AS c FROM ${tbl}`);
        if (r.rows[0]?.c > 0) {
          subscribersCount = r.rows[0].c;
          break;
        }
      } catch {}
    }

    if (subscribersCount === 0) {
      try {
        const subRes = await pool.query(`SELECT COUNT(DISTINCT fan_email)::int AS c FROM vip_subscriptions`);
        subscribersCount = subRes.rows[0]?.c || 0;
      } catch {}
    }

    return reply.send({
      ok: true,
      subscribers: subscribersCount,
      models: modelsCount,
      escorts: escortsCount,
      totalCreators: modelsCount + escortsCount,
    });
  });

  // Rota para publicar Story com sticker de link
  app.get('/publicar-story', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'publicar-story.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

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
  // PÁGINA 1: VITRINE SEPARADA (/vitrine) + FILTROS (/filtros) + API
  // =======================================================================
  app.get('/api/portal/vitrine-data', async (req, reply) => {
    const city = req.query.city ? String(req.query.city).trim() : null;
    let profiles = await getHomeRanking({ city, limit: 80 });

    const [mediaCountsRes, recentVideosRes, recentStoriesRes, extraAttrsRes] = await Promise.all([
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
      pool.query(`
        SELECT DISTINCT ON (m.creator_id)
          m.id, m.creator_id, m.media_type, m.public_url, m.caption, m.link_url, m.link_label
        FROM creator_media m
        WHERE m.visibility = 'public'
        ORDER BY m.creator_id, m.created_at DESC
      `).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT id, age, height, has_location, physical_tags, services_tags
        FROM creator_accounts
      `),
    ]);

    const mediaMap = new Map();
    for (const row of mediaCountsRes.rows) mediaMap.set(row.creator_id, row);

    const attrsMap = new Map();
    for (const row of extraAttrsRes.rows) attrsMap.set(row.id, row);

    const storyMediaByCreator = new Map();
    for (const st of recentStoriesRes.rows) {
      storyMediaByCreator.set(st.creator_id, st);
    }

    profiles = profiles.map((p) => {
      const extra = attrsMap.get(p.id) || {};
      return {
        ...p,
        age: p.age ?? extra.age ?? null,
        height: p.height || extra.height || '',
        has_location: p.has_location || extra.has_location || '',
        physical_tags: Array.isArray(p.physical_tags) ? p.physical_tags : (extra.physical_tags || []),
        services_tags: Array.isArray(p.services_tags) ? p.services_tags : (extra.services_tags || []),
        total_media: mediaMap.get(p.id)?.total_media || 0,
        total_videos: mediaMap.get(p.id)?.total_videos || 0,
      };
    });

    const stories = profiles.slice(0, 15).map((s) => {
      const stMedia = storyMediaByCreator.get(s.id);
      const isVid = stMedia?.media_type === 'video';
      return {
        name: s.stage_name,
        city: `${s.city}-${s.state}`,
        slug: s.slug,
        avatar: s.avatar_url || s.cover_url || 'https://placehold.co/400x400/111827/ec4899?text=VIP',
        mediaUrl: (!isVid && stMedia?.public_url) || s.cover_url || s.avatar_url || 'https://placehold.co/400x600/111827/ec4899?text=VIP',
        videoUrl: isVid ? stMedia.public_url : null,
        videoId: isVid ? stMedia.id : null,
        caption: stMedia?.caption || s.specialty_tag || s.bio || '',
        linkUrl: stMedia?.link_url || '',
        linkLabel: stMedia?.link_label || '',
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

  app.get('/filtros', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'filtro.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/vip-studio', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'vip-studio.html');
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

  // Carregar e salvar parâmetros do fluxo e paywall no Command Center Admin
  app.get('/api/portal/admin/bot-settings', async (req, reply) => {
    try {
      const settings = await getBotSettings();
      return reply.send({ ok: true, settings });
    } catch (err) {
      app.log.error(err, '[Portal Admin] Erro ao carregar bot_settings');
      return reply.status(500).send({ error: 'Erro ao carregar configurações do fluxo.' });
    }
  });

  app.post('/api/portal/admin/bot-settings', async (req, reply) => {
    const { visual_flow, paywall_config } = req.body || {};
    const toSave = {};
    if (visual_flow !== undefined && visual_flow !== null) toSave.visual_flow = visual_flow;
    if (paywall_config !== undefined && paywall_config !== null) toSave.paywall_config = paywall_config;

    try {
      await saveBotSettings(toSave);
      return reply.send({ ok: true });
    } catch (err) {
      app.log.error(err, '[Portal Admin] Erro ao salvar bot_settings');
      return reply.status(500).send({ error: 'Erro ao salvar configurações do fluxo.' });
    }
  });

  app.post('/api/portal/admin/approve', async (req, reply) => {
    const { creatorId, verified, active } = req.body || {};
    await setCreatorApproval(creatorId, { verified, active });
    return reply.send({ ok: true });
  });

  app.post('/api/portal/admin/seed', async (req, reply) => {
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
    await pool.query(`DELETE FROM creator_accounts WHERE email LIKE '%@demo.com'`);
    return reply.send({ ok: true });
  });
}
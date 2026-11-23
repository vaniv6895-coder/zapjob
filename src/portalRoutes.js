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
  approveHighlightOrder,
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

const BRAND_NAME = process.env.SITE_BRAND_NAME || 'Garota VIP';

const COUNTRY_CONFIG = {
  br: { name: 'Brasil', lang: 'pt-BR', localeGroup: 'pt' },
  pt: { name: 'Portugal', lang: 'pt-PT', localeGroup: 'pt' },
  us: { name: 'United States', lang: 'en-US', localeGroup: 'en' },
  uk: { name: 'United Kingdom', lang: 'en-GB', localeGroup: 'en' },
  gb: { name: 'United Kingdom', lang: 'en-GB', localeGroup: 'en' },
  ca: { name: 'Canada', lang: 'en-CA', localeGroup: 'en' },
  ch: { name: 'Switzerland', lang: 'en-CH', localeGroup: 'en' },
  de: { name: 'Germany', lang: 'en-DE', localeGroup: 'en' },
  fr: { name: 'France', lang: 'en-FR', localeGroup: 'en' },
  es: { name: 'España', lang: 'es-ES', localeGroup: 'es' },
  mx: { name: 'México', lang: 'es-MX', localeGroup: 'es' },
  ar: { name: 'Argentina', lang: 'es-AR', localeGroup: 'es' },
  co: { name: 'Colombia', lang: 'es-CO', localeGroup: 'es' },
  cl: { name: 'Chile', lang: 'es-CL', localeGroup: 'es' },
};

const COUNTRY_NAME_TO_CODE = {
  brasil: 'br',
  brazil: 'br',
  portugal: 'pt',
  'united states': 'us',
  usa: 'us',
  'united kingdom': 'uk',
  uk: 'uk',
  switzerland: 'ch',
  germany: 'de',
  france: 'fr',
  canada: 'ca',
  espana: 'es',
  spain: 'es',
  mexico: 'mx',
  argentina: 'ar',
  colombia: 'co',
  chile: 'cl',
};

function resolveSeoLocale(countryParam) {
  const code = String(countryParam || 'br').trim().toLowerCase();
  return COUNTRY_CONFIG[code] || { name: countryParam || 'Global', lang: 'en', localeGroup: 'en' };
}

function slugifySeo(val) {
  return String(val || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function unslugifyLabel(slugVal) {
  return String(slugVal || '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (l) => l.toUpperCase())
    .trim();
}

function escapeXml(str) {
  return String(str || '').replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[c]));
}

function sanitizeText(val, maxLen = 500) {
  if (val === undefined || val === null) return undefined;
  return String(val)
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, maxLen);
}

function buildMultilingualSeo({ countryCode, cityLabel, hoodLabel, count }) {
  const cfg = resolveSeoLocale(countryCode);
  const local = hoodLabel && cityLabel
    ? `${hoodLabel}, ${cityLabel}`
    : (cityLabel || cfg.name);

  if (cfg.localeGroup === 'es') {
    return {
      ...cfg,
      local,
      headingPrefix: 'Escorts y Modelos VIP en',
      title: `Escorts VIP en ${local} — Fotos y Videos Verificados | ${BRAND_NAME}`,
      description: `Encuentra ${count || 'las mejores'} escorts y modelos VIP verificadas en ${local}. Contacto directo por WhatsApp, fotos reales y Club VIP exclusivo.`,
    };
  }

  if (cfg.localeGroup === 'en') {
    return {
      ...cfg,
      local,
      headingPrefix: 'VIP Escorts & Models in',
      title: `VIP Escorts in ${local} — Verified Photos & Exclusive Club | ${BRAND_NAME}`,
      description: `Discover ${count || 'top'} verified VIP escorts and independent models in ${local}. Direct contact, real photos, and exclusive VIP content.`,
    };
  }

  return {
    ...cfg,
    local,
    headingPrefix: 'Acompanhantes e Modelos em',
    title: `Acompanhantes em ${local} — Fotos e Vídeos Verificados | ${BRAND_NAME}`,
    description: `Encontre ${count || 'diversas'} modelos e acompanhantes verificadas em ${local}. Contato direto no WhatsApp, fotos reais e Clube VIP.`,
  };
}

function getPaxumBaseUrl() {
  const isSandbox = String(process.env.PAXUM_SANDBOX || '').toLowerCase() === 'true';
  return isSandbox
    ? 'https://sandbox.paxum.com/payment/phrame.php'
    : 'https://www.paxum.com/payment/phrame.php';
}

function buildPaxumCheckoutUrl({ amount, currency = 'USD', itemName, reference, returnUrl, cancelUrl, notifyUrl }) {
  const businessEmail = String(process.env.PAXUM_BUSINESS_EMAIL || '').trim();
  const sharedSecret = String(process.env.PAXUM_SHARED_SECRET || '').trim();
  if (!businessEmail || !sharedSecret) return null;

  const cleanAmount = Number(amount).toFixed(2);
  const cleanCurrency = ['USD', 'EUR', 'GBP'].includes(String(currency).toUpperCase())
    ? String(currency).toUpperCase()
    : 'USD';

  const rawSig = `${businessEmail}${cleanAmount}${cleanCurrency}${reference}${sharedSecret}`;
  const signature = crypto.createHash('sha256').update(rawSig).digest('hex');

  const params = new URLSearchParams({
    view: 'payment',
    business_email: businessEmail,
    amount: cleanAmount,
    currency: cleanCurrency,
    item_name: String(itemName || 'VIP Access').slice(0, 120),
    button_type_id: '1',
    variables: `custom=${reference}`,
    return: returnUrl,
    cancel_return: cancelUrl,
    notify_url: notifyUrl,
    key: signature,
  });

  return `${getPaxumBaseUrl()}?${params.toString()}`;
}

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
  const maxAgeMs = 12 * 60 * 60 * 1000;
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

  if (req.query?.pwd && safeEqual(req.query.pwd, secret)) {
    return true;
  }

  return false;
}

function signSessionToken(creatorId) {
  const secret = process.env.PANEL_PASSWORD || 'portal_secret_2026';
  const payload = `creator.${creatorId}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 4 || parts[0] !== 'creator') return null;

  const [, creatorId, ts, sig] = parts;
  const idNum = Number(creatorId);
  const tsNum = Number(ts);
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;

  if (!Number.isInteger(idNum) || idNum <= 0) return null;
  if (!Number.isFinite(tsNum) || Date.now() - tsNum > maxAgeMs) return null;

  const secret = process.env.PANEL_PASSWORD || 'portal_secret_2026';
  const expected = crypto.createHmac('sha256', secret).update(`creator.${creatorId}.${ts}`).digest('hex');
  if (!safeEqual(sig, expected)) return null;
  return idNum;
}

async function requireCreatorAuth(req, reply) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const creatorId = verifySessionToken(token);
  if (!creatorId) return reply.status(401).send({ error: 'Acesso restrito a contas de modelo autenticadas.' });

  const creator = await getCreatorById(creatorId);
  if (!creator) return reply.status(401).send({ error: 'Conta de modelo não encontrada.' });
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
      description: `${BRAND_NAME} - ${planName}`,
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

async function ensureCreatorWithdrawalsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS creator_withdrawals (
      id SERIAL PRIMARY KEY,
      creator_id INT NOT NULL REFERENCES creator_accounts(id) ON DELETE CASCADE,
      amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
      pix_key VARCHAR(160) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      paid_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_creator_withdrawals_creator
      ON creator_withdrawals (creator_id, created_at DESC);
  `).catch(() => {});
}

async function getCreatorVipBalanceAndSales(creatorId) {
  await ensureCreatorWithdrawalsTable();

  const [subsRes, ppvRes, wdSumRes, wdListRes, salesRes] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(price), 0)::numeric AS total_subs, COUNT(*)::int AS count_subs
       FROM vip_subscriptions
       WHERE creator_id = $1 AND paid = TRUE`,
      [creatorId]
    ).catch(() => ({ rows: [{ total_subs: 0, count_subs: 0 }] })),
    pool.query(
      `SELECT COALESCE(SUM(u.price), 0)::numeric AS total_ppv, COUNT(*)::int AS count_ppv
       FROM ppv_unlocks u
       JOIN vip_posts p ON p.id = u.post_id
       WHERE p.creator_id = $1 AND u.paid = TRUE`,
      [creatorId]
    ).catch(() => ({ rows: [{ total_ppv: 0, count_ppv: 0 }] })),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS total_withdrawn
       FROM creator_withdrawals
       WHERE creator_id = $1 AND status IN ('pending', 'paid')`,
      [creatorId]
    ).catch(() => ({ rows: [{ total_withdrawn: 0 }] })),
    pool.query(
      `SELECT id, amount, pix_key, status, created_at, paid_at
       FROM creator_withdrawals
       WHERE creator_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [creatorId]
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT
         s.id,
         s.buyer_identifier,
         COALESCE(NULLIF(TRIM(s.fan_nickname), ''), NULLIF(TRIM(f.nickname), ''), NULLIF(TRIM(f.full_name), ''), s.buyer_identifier, 'Assinante VIP') AS fan_nickname,
         COALESCE(NULLIF(TRIM(s.fan_code), ''), f.fan_code) AS fan_code,
         COALESCE(NULLIF(TRIM(s.item_title), ''), 'Assinatura Mensal VIP (30 dias)') AS item_title,
         'Assinatura' AS sale_type,
         s.price,
         s.created_at
       FROM vip_subscriptions s
       LEFT JOIN vip_fans f ON f.device_hash = s.device_hash
       WHERE s.creator_id = $1 AND s.paid = TRUE
       UNION ALL
       SELECT
         u.id,
         u.buyer_identifier,
         COALESCE(NULLIF(TRIM(u.fan_nickname), ''), NULLIF(TRIM(f.nickname), ''), NULLIF(TRIM(f.full_name), ''), u.buyer_identifier, 'Cliente VIP') AS fan_nickname,
         COALESCE(NULLIF(TRIM(u.fan_code), ''), f.fan_code) AS fan_code,
         COALESCE(NULLIF(TRIM(u.item_title), ''), NULLIF(TRIM(p.caption), ''), 'Conteúdo Avulso VIP #' || u.post_id) AS item_title,
         'Avulso (PPV)' AS sale_type,
         u.price,
         u.created_at
       FROM ppv_unlocks u
       JOIN vip_posts p ON p.id = u.post_id
       LEFT JOIN vip_fans f ON f.device_hash = u.device_hash
       WHERE p.creator_id = $1 AND u.paid = TRUE
       ORDER BY created_at DESC
       LIMIT 50`,
      [creatorId]
    ).catch(() => ({ rows: [] })),
  ]);

  const totalSubs = Number(subsRes.rows[0]?.total_subs || 0);
  const totalPpv = Number(ppvRes.rows[0]?.total_ppv || 0);
  const grossEarned = Number((totalSubs + totalPpv).toFixed(2));
  const withdrawnOrReserved = Number(wdSumRes.rows[0]?.total_withdrawn || 0);
  const balance = Math.max(0, Number((grossEarned - withdrawnOrReserved).toFixed(2)));

  const sales = salesRes.rows.map((r) => {
    const nick = String(r.fan_nickname || 'Cliente VIP').trim();
    const code = r.fan_code ? String(r.fan_code).trim() : '';
    return {
      id: r.id,
      buyer_identifier: code ? `${nick} • ${code}` : (r.buyer_identifier || nick),
      fan_nickname: nick,
      fan_code: code || null,
      item_title: String(r.item_title || r.sale_type).trim(),
      sale_type: r.sale_type,
      price: Number(r.price || 0),
      created_at: r.created_at,
    };
  });

  return {
    balance,
    grossEarned,
    withdrawnOrReserved,
    totalSubs,
    countSubs: Number(subsRes.rows[0]?.count_subs || 0),
    totalPpv,
    countPpv: Number(ppvRes.rows[0]?.count_ppv || 0),
    withdrawals: wdListRes.rows,
    sales,
  };
}

export function registerPortalRoutes(app) {
  if (app.__portalRoutesRegistered) return;
  app.__portalRoutesRegistered = true;

  ensureCreatorWithdrawalsTable();

  pool.query(`
    ALTER TABLE creator_media
      ADD COLUMN IF NOT EXISTS link_url TEXT,
      ADD COLUMN IF NOT EXISTS link_label VARCHAR(80);
  `).catch(() => {});

  pool.query(`
    ALTER TABLE creator_accounts
      ADD COLUMN IF NOT EXISTS profile_type VARCHAR(30) DEFAULT 'conteudo';
  `).catch(() => {});

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

  app.addHook('onRequest', async (req, reply) => {
    const urlPath = req.url.split('?')[0];
    if (urlPath.startsWith('/api/portal/admin/') && urlPath !== '/api/portal/admin/login') {
      if (!getAdminSecret()) {
        return reply.status(503).send({ error: 'PANEL_PASSWORD não configurada no servidor.' });
      }
      if (!isAdminAuthorized(req)) {
        return reply.status(401).send({ error: 'Não autorizado.' });
      }
      if (!req.query) req.query = {};
      req.query.pwd = getAdminSecret();
    }
  });

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

  registerTelemetryRoutes(app, pool);

  // Rotas SEO multilíngues, robots.txt e sitemap.xml
  app.get('/vitrine/:country/:citySlug/:hoodSlug?', async (req, reply) => {
    const countryCode = String(req.params.country || 'br').trim().toLowerCase();
    const citySlug = slugifySeo(req.params.citySlug);
    const hoodSlug = req.params.hoodSlug ? slugifySeo(req.params.hoodSlug) : '';

    const cityLabel = unslugifyLabel(citySlug);
    const hoodLabel = hoodSlug ? unslugifyLabel(hoodSlug) : '';
    const countryCfg = resolveSeoLocale(countryCode);

    const profiles = await getHomeRanking({
      neighborhood: hoodLabel || null,
      city: cityLabel || null,
      country: countryCfg.name,
      limit: 80,
    });

    const seo = buildMultilingualSeo({
      countryCode,
      cityLabel,
      hoodLabel,
      count: profiles.length,
    });

    const canonicalPath = hoodSlug
      ? `/vitrine/${countryCode}/${citySlug}/${hoodSlug}`
      : `/vitrine/${countryCode}/${citySlug}`;
    const baseUrl = (process.env.PUBLIC_URL || 'https://zapjob-production.up.railway.app').replace(/\/$/, '');

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: seo.title,
      description: seo.description,
      inLanguage: seo.lang,
      url: `${baseUrl}${canonicalPath}`,
      numberOfItems: profiles.length,
      itemListElement: profiles.slice(0, 20).map((p, idx) => ({
        '@type': 'ListItem',
        position: idx + 1,
        url: `${baseUrl}/acompanhante/${p.slug}`,
        name: p.stage_name,
      })),
    };

    const initialGeoPayload = {
      country: countryCode,
      countryName: countryCfg.name,
      lang: seo.lang,
      localeGroup: seo.localeGroup,
      citySlug,
      cityLabel,
      neighborhoodSlug: hoodSlug,
      hoodLabel,
    };

    let html = fs.readFileSync(path.join(process.cwd(), 'public', 'vitrine.html'), 'utf-8');
    html = html.replace(/<html lang="[^"]*">/i, `<html lang="${seo.lang}">`);
    html = html.replace(/<title>.*?<\/title>/i, `<title>${seo.title}</title>`);
    html = html.replace(
      /<h1 class="section-h1">.*?<\/h1>/i,
      `<h1 class="section-h1">${seo.headingPrefix} <span id="city-title">${seo.local}</span></h1>`
    );
    html = html.replace(
      '</head>',
      `  <meta name="description" content="${seo.description}" />
  <link rel="canonical" href="${baseUrl}${canonicalPath}" />
  <meta property="og:title" content="${seo.title}" />
  <meta property="og:description" content="${seo.description}" />
  <meta property="og:locale" content="${seo.lang.replace('-', '_')}" />
  <script>window.__INITIAL_GEO_SEO__ = ${JSON.stringify(initialGeoPayload)};</script>
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>`
    );

    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/robots.txt', async (req, reply) => {
    const baseUrl = (process.env.PUBLIC_URL || 'https://zapjob-production.up.railway.app').replace(/\/$/, '');
    const txt = [
      'User-agent: *',
      'Allow: /',
      'Allow: /vitrine',
      'Allow: /acompanhante/',
      'Allow: /vip/',
      'Disallow: /admin-dashboard',
      'Disallow: /admin-ai-gmail',
      'Disallow: /minha-conta',
      'Disallow: /financeiro',
      'Disallow: /painel-fa',
      'Disallow: /api/',
      '',
      `Sitemap: ${baseUrl}/sitemap.xml`,
    ].join('\n');

    return reply.type('text/plain; charset=utf-8').send(txt);
  });

  app.get('/sitemap.xml', async (req, reply) => {
    const baseUrl = (process.env.PUBLIC_URL || 'https://zapjob-production.up.railway.app').replace(/\/$/, '');
    const today = new Date().toISOString().slice(0, 10);

    const { rows } = await pool.query(`
      SELECT slug, city, neighborhood, COALESCE(country, 'Brasil') AS country, COALESCE(last_boost_at, created_at, NOW()) AS updated_at
      FROM creator_accounts
      WHERE active = TRUE
        AND verified = TRUE
        AND COALESCE(TRIM(verification_video_url), '') <> ''
      ORDER BY updated_at DESC
    `);

    const urls = [
      { loc: `${baseUrl}/vitrine`, lastmod: today, changefreq: 'hourly', priority: '1.0' },
      { loc: `${baseUrl}/reels`, lastmod: today, changefreq: 'daily', priority: '0.8' },
    ];

    const seenCities = new Set();
    const seenHoods = new Set();

    for (const r of rows) {
      const cSlug = slugifySeo(r.city);
      const hSlug = slugifySeo(r.neighborhood);
      const rawCountry = slugifySeo(r.country).replace(/-/g, ' ');
      const cCode = COUNTRY_NAME_TO_CODE[rawCountry] || (String(r.country || '').length === 2 ? String(r.country).toLowerCase() : 'br');
      const lastmod = r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 10) : today;

      if (cSlug && !seenCities.has(`${cCode}/${cSlug}`)) {
        seenCities.add(`${cCode}/${cSlug}`);
        urls.push({
          loc: `${baseUrl}/vitrine/${cCode}/${cSlug}`,
          lastmod,
          changefreq: 'daily',
          priority: '0.9',
        });
      }

      if (cSlug && hSlug && !seenHoods.has(`${cCode}/${cSlug}/${hSlug}`)) {
        seenHoods.add(`${cCode}/${cSlug}/${hSlug}`);
        urls.push({
          loc: `${baseUrl}/vitrine/${cCode}/${cSlug}/${hSlug}`,
          lastmod,
          changefreq: 'daily',
          priority: '0.85',
        });
      }

      if (r.slug) {
        urls.push({
          loc: `${baseUrl}/acompanhante/${encodeURIComponent(r.slug)}`,
          lastmod,
          changefreq: 'weekly',
          priority: '0.75',
        });
      }
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${escapeXml(u.loc)}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`
  )
  .join('\n')}
</urlset>`;

    return reply.type('application/xml; charset=utf-8').send(xml);
  });

  app.get('/admin-dashboard', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'admin-dashboard.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/admin-ai-gmail', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'admin-ai-gmail.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/api/portal/admin/ai-gmail/data', async (req, reply) => {
    let creators = [];
    let logs = [];

    try {
      const creatorsRes = await pool.query(`
        SELECT *
        FROM creator_accounts
        WHERE COALESCE(email, '') <> ''
          AND email NOT LIKE '%@demo.com'
        ORDER BY id DESC
      `);
      creators = creatorsRes.rows.map((c) => ({
        id: c.id,
        stage_name: c.stage_name || c.name || 'Sem nome',
        email: c.email,
        city: c.city || '-',
        state: c.state || '-',
        tier: c.tier || 'free',
        verified: Boolean(c.verified),
        featured_until: c.featured_until || null,
        views_count: Number(c.views_count || 0),
      }));
    } catch (err) {
      app.log.error(err, '[AI Gmail] Erro ao listar creator_accounts');
    }

    try {
      const logsRes = await pool.query(`
        SELECT id, recipient_email, stage_name, campaign_type, subject, status, error_msg, created_at
        FROM ai_email_campaigns
        ORDER BY created_at DESC
        LIMIT 50
      `);
      logs = logsRes.rows;
    } catch {}

    return reply.send({
      ok: true,
      gmailConfigured: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
      senderEmail: process.env.GMAIL_USER || '',
      creators,
      logs,
    });
  });

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
          const prompt = `Você é o gerente de sucesso de criadoras da plataforma ${BRAND_NAME}.
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
        body: `Oi ${creator.stage_name}, tudo bem?\n\nNotamos que visitantes em ${creator.city}-${creator.state} estão procurando perfis como o seu na vitrine do ${BRAND_NAME}.\n\nAtive agora o Destaque VIP no seu painel para ficar na 1ª linha e multiplicar seus cliques no WhatsApp:\n${studioUrl}\n\nQualquer dúvida, responda este e-mail!\nEquipe ${BRAND_NAME}`,
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
          from: `"${BRAND_NAME}" <${gmailUser}>`,
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

  app.get('/publicar-story', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'publicar-story.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

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

  app.get('/financeiro', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'financeiro-modelo.html');
    if (!fs.existsSync(filePath)) {
      return reply.status(404).send({ error: 'Arquivo public/financeiro-modelo.html não encontrado.' });
    }
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  const serveGaleriaAssinantes = async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'galeria-assinantes.html');
    if (!fs.existsSync(filePath)) {
      return reply.status(404).send({ error: 'Arquivo public/galeria-assinantes.html não encontrado.' });
    }
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  };
  app.get('/galeria-assinantes', serveGaleriaAssinantes);
  app.get('/galeria-assinantes/*', serveGaleriaAssinantes);

  app.get('/vip/:slug', async (req, reply) => {
    const candidates = ['clube-vip.html', 'meu-vip.html', 'galeria-assinantes.html'];
    for (const fname of candidates) {
      const filePath = path.join(process.cwd(), 'public', fname);
      if (fs.existsSync(filePath)) {
        const html = fs.readFileSync(filePath, 'utf-8');
        return reply.type('text/html; charset=utf-8').send(html);
      }
    }
    return reply.status(404).send({ error: 'Página VIP não encontrada.' });
  });

  registerVipFeedRoutes(app, requireCreatorAuth);

  app.get('/api/vip/earnings', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const vipSummary = await getCreatorVipBalanceAndSales(req.creator.id);
    return reply.send({
      ok: true,
      totalAll: vipSummary.balance,
      grossEarned: vipSummary.grossEarned,
      withdrawnOrReserved: vipSummary.withdrawnOrReserved,
      totalSubs: vipSummary.totalSubs,
      countSubs: vipSummary.countSubs,
      totalPpv: vipSummary.totalPpv,
      countPpv: vipSummary.countPpv,
      withdrawals: vipSummary.withdrawals,
      sales: vipSummary.sales,
      recentBuyers: vipSummary.sales,
      totals: {
        totalAll: vipSummary.balance,
        totalSubs: vipSummary.totalSubs,
        countSubs: vipSummary.countSubs,
        totalPpv: vipSummary.totalPpv,
        countPpv: vipSummary.countPpv,
      },
    });
  });

  app.get('/api/portal/me/finance', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const summary = await getCreatorVipBalanceAndSales(req.creator.id);
    return reply.send({
      ok: true,
      creatorName: req.creator.stage_name,
      ...summary,
    });
  });

  app.post('/api/portal/me/withdraw', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const { amount, pixKey } = req.body || {};
    const cleanPix = sanitizeText(pixKey, 160);
    const reqAmount = Number(amount);

    if (!cleanPix || cleanPix.length < 4) {
      return reply.status(400).send({ error: 'Informe uma chave Pix válida.' });
    }
    if (!Number.isFinite(reqAmount) || reqAmount <= 0) {
      return reply.status(400).send({ error: 'Informe um valor de saque maior que zero.' });
    }

    const summary = await getCreatorVipBalanceAndSales(req.creator.id);
    if (reqAmount > summary.balance) {
      return reply.status(400).send({
        error: `Saldo insuficiente. Disponível: R$ ${summary.balance.toFixed(2).replace('.', ',')}.`,
      });
    }

    const ins = await pool.query(
      `INSERT INTO creator_withdrawals (creator_id, amount, pix_key, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, amount, pix_key, status, created_at, paid_at`,
      [req.creator.id, Number(reqAmount.toFixed(2)), cleanPix]
    );

    const updated = await getCreatorVipBalanceAndSales(req.creator.id);
    return reply.send({
      ok: true,
      withdrawal: ins.rows[0],
      ...updated,
    });
  });

  app.get('/api/portal/admin/withdrawals', async (req, reply) => {
    await ensureCreatorWithdrawalsTable();
    const { rows } = await pool.query(`
      SELECT w.id, w.creator_id, c.stage_name, c.email, w.amount, w.pix_key, w.status, w.created_at, w.paid_at
      FROM creator_withdrawals w
      JOIN creator_accounts c ON c.id = w.creator_id
      ORDER BY CASE WHEN w.status = 'pending' THEN 0 ELSE 1 END, w.created_at DESC
      LIMIT 100
    `);
    return reply.send({ ok: true, withdrawals: rows });
  });

  app.post('/api/portal/admin/withdrawals/:id/pay', async (req, reply) => {
    await ensureCreatorWithdrawalsTable();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Saque inválido.' });
    }
    const res = await pool.query(
      `UPDATE creator_withdrawals
       SET status = 'paid', paid_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    if (!res.rows[0]) {
      return reply.status(404).send({ error: 'Solicitação de saque não encontrada.' });
    }
    return reply.send({ ok: true, withdrawal: res.rows[0] });
  });

  registerPortalProfileRoute(app);
  registerPortalMediaRoutes(app, requireCreatorAuth);
  registerPortalSecurityRoutes(app, requireCreatorAuth, signSessionToken);

  app.post('/api/portal/register', async (req, reply) => {
    try {
      const { email, password, stageName, city, state, country, whatsapp, bio, profileType, isEscort } = req.body || {};
      if (!email || !password || !stageName || !city || !state) {
        return reply.status(400).send({ error: 'Preencha todos os campos obrigatórios.' });
      }
      const resolvedType = profileType === 'acompanhante' || isEscort === true ? 'acompanhante' : 'conteudo';
      const creator = await registerCreator({
        email,
        password,
        stageName: sanitizeText(stageName, 60),
        city: sanitizeText(city, 80),
        state: sanitizeText(state, 10)?.toUpperCase(),
        country: sanitizeText(country || 'Brasil', 60),
        whatsapp,
        bio: sanitizeText(bio, 1500),
      });
      await pool.query(
        `UPDATE creator_accounts SET profile_type = $1 WHERE id = $2`,
        [resolvedType, creator.id]
      ).catch(() => {});
      const token = signSessionToken(creator.id);
      return reply.send({ ok: true, token, creator: { ...creator, profile_type: resolvedType } });
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
    const [stats, vipSummary] = await Promise.all([
      getCreatorStats30d(req.creator.id),
      getCreatorVipBalanceAndSales(req.creator.id),
    ]);
    return reply.send({
      ok: true,
      creator: {
        ...req.creator,
        profile_type: req.creator.profile_type || 'conteudo',
        vip_balance: vipSummary.balance,
      },
      vipBalance: vipSummary.balance,
      vipGrossEarned: vipSummary.grossEarned,
      vipWithdrawn: vipSummary.withdrawnOrReserved,
      vipWithdrawals: vipSummary.withdrawals,
      vipSales: vipSummary.sales,
      vipTotals: {
        totalAll: vipSummary.balance,
        totalSubs: vipSummary.totalSubs,
        countSubs: vipSummary.countSubs,
        totalPpv: vipSummary.totalPpv,
        countPpv: vipSummary.countPpv,
      },
      stats,
      plans: HIGHLIGHT_PLANS,
      paxumEnabled: Boolean(process.env.PAXUM_BUSINESS_EMAIL && process.env.PAXUM_SHARED_SECRET),
    });
  });

  app.get('/api/portal/me/sales', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const vipSummary = await getCreatorVipBalanceAndSales(req.creator.id);
    return reply.send({
      ok: true,
      balance: vipSummary.balance,
      vipBalance: vipSummary.balance,
      grossEarned: vipSummary.grossEarned,
      withdrawnOrReserved: vipSummary.withdrawnOrReserved,
      withdrawals: vipSummary.withdrawals,
      sales: vipSummary.sales,
      recentBuyers: vipSummary.sales,
      totals: {
        totalAll: vipSummary.balance,
        totalSubs: vipSummary.totalSubs,
        countSubs: vipSummary.countSubs,
        totalPpv: vipSummary.totalPpv,
        countPpv: vipSummary.countPpv,
      },
    });
  });

  app.put('/api/portal/me', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const body = { ...(req.body || {}) };

    // Bloqueia qualquer tentativa de alterar dono da conta, credenciais ou status administrativo
    delete body.id;
    delete body.creatorId;
    delete body.creator_id;
    delete body.verified;
    delete body.active;
    delete body.tier;
    delete body.featured_until;
    delete body.email;
    delete body.password_hash;

    if (body.stage_name !== undefined) {
      const cleanName = sanitizeText(body.stage_name, 60);
      if (!cleanName || cleanName.length < 2) {
        return reply.status(400).send({ error: 'Nome artístico inválido.' });
      }
      body.stage_name = cleanName;
    }

    if (body.profile_type !== undefined) {
      body.profile_type = body.profile_type === 'acompanhante' ? 'acompanhante' : 'conteudo';
      await pool.query(
        `UPDATE creator_accounts SET profile_type = $1 WHERE id = $2`,
        [body.profile_type, req.creator.id]
      ).catch(() => {});
      delete body.profile_type;
    }

    if (body.bio !== undefined) body.bio = sanitizeText(body.bio, 1500);
    if (body.specialty_tag !== undefined) body.specialty_tag = sanitizeText(body.specialty_tag, 80);
    if (body.neighborhood !== undefined) body.neighborhood = sanitizeText(body.neighborhood, 80);
    if (body.city !== undefined) body.city = sanitizeText(body.city, 80);
    if (body.state !== undefined) body.state = sanitizeText(body.state, 10)?.toUpperCase();
    if (body.country !== undefined) body.country = sanitizeText(body.country, 60);

    const updated = await updateCreatorProfile(req.creator.id, body);
    return reply.send({ ok: true, creator: updated });
  });

  // 1. Impulso via Pix (Mercado Pago)
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
    return reply.send({
      ok: true,
      orderId: order.id,
      plan,
      qrCode: pix.qrCode,
      qrCodeBase64: pix.qrCodeBase64,
    });
  });

  // 2. Impulso Internacional via Paxum
  app.post('/api/portal/highlight-paxum', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const { planCode, currency = 'USD' } = req.body || {};
    const plan = HIGHLIGHT_PLANS.find((p) => p.code === planCode);
    if (!plan) return reply.status(400).send({ error: 'Plano inválido.' });

    const businessEmail = String(process.env.PAXUM_BUSINESS_EMAIL || '').trim();
    const sharedSecret = String(process.env.PAXUM_SHARED_SECRET || '').trim();
    if (!businessEmail || !sharedSecret) {
      return reply.status(503).send({
        error: 'Pagamento via Paxum ainda não ativado. Configure PAXUM_BUSINESS_EMAIL e PAXUM_SHARED_SECRET no Railway.',
      });
    }

    const order = await createHighlightOrder({
      creatorId: req.creator.id,
      planCode: plan.code,
      amount: plan.price,
    });

    const baseUrl = (process.env.PUBLIC_URL || 'https://zapjob-production.up.railway.app').replace(/\/$/, '');
    const cleanCurrency = ['USD', 'EUR'].includes(String(currency).toUpperCase())
      ? String(currency).toUpperCase()
      : 'USD';

    const usdRate = Number(process.env.USD_BRL_RATE || 5.5) || 5.5;
    const eurRate = Number(process.env.EUR_BRL_RATE || 6.0) || 6.0;
    const convertedAmount = cleanCurrency === 'EUR'
      ? Math.max(2, plan.price / eurRate)
      : Math.max(2, plan.price / usdRate);

    const checkoutUrl = buildPaxumCheckoutUrl({
      amount: convertedAmount,
      currency: cleanCurrency,
      itemName: `${BRAND_NAME} - ${plan.name}`,
      reference: `portal:${order.id}`,
      returnUrl: `${baseUrl}/impulsionar?paid=1&orderId=${order.id}&gateway=paxum`,
      cancelUrl: `${baseUrl}/impulsionar?canceled=1`,
      notifyUrl: `${baseUrl}/webhook/paxum`,
    });

    return reply.send({
      ok: true,
      orderId: order.id,
      checkoutUrl,
      currency: cleanCurrency,
      amountCharged: convertedAmount.toFixed(2),
    });
  });

  // 3. Webhook IPN Paxum (Confirmação automática de Destaques + Assinaturas/Avulsos VIP)
  app.post('/webhook/paxum', async (req, reply) => {
    const sharedSecret = String(process.env.PAXUM_SHARED_SECRET || '').trim();
    const payload = req.body || {};

    const incomingSig = String(
      req.headers['x-signature'] || payload.signature || payload.key || ''
    ).trim();

    if (sharedSecret && incomingSig && req.rawBody) {
      const expectedHmac = crypto
        .createHmac('sha256', sharedSecret)
        .update(req.rawBody)
        .digest('hex');

      if (!safeEqual(incomingSig.toLowerCase(), expectedHmac.toLowerCase())) {
        app.log.warn('[Paxum Webhook] Assinatura IPN inválida.');
        return reply.status(400).send({ error: 'Assinatura Paxum inválida.' });
      }
    }

    try {
      const status = String(payload.transaction_status || payload.status || '').toLowerCase();
      const txId = String(payload.transaction_id || payload.id || `paxum_${Date.now()}`);

      let customRef = String(payload.custom || '').trim();
      if (!customRef && payload.variables) {
        const match = String(payload.variables).match(/custom=([^&]+)/);
        if (match) customRef = decodeURIComponent(match[1]);
      }

      if (!['done', 'completed', 'approved', 'paid'].includes(status)) {
        return reply.status(200).send({ received: true, ignored: true });
      }

      if (customRef.startsWith('portal:')) {
        const orderId = Number(customRef.split(':')[1]);
        if (orderId > 0) {
          await approveHighlightOrder(orderId, txId);
          app.log.info(`[Paxum Webhook] Destaque #${orderId} aprovado (${txId})`);
        }
      }

      if (customRef.startsWith('vip_sub:')) {
        const subId = Number(customRef.split(':')[1]);
        if (subId > 0) {
          await pool.query(
            `UPDATE vip_subscriptions SET paid = TRUE, mp_payment_id = $2 WHERE id = $1`,
            [subId, txId]
          );
          app.log.info(`[Paxum Webhook] Assinatura VIP #${subId} ativada (${txId})`);
        }
      }

      if (customRef.startsWith('vip_ppv:')) {
        const unlockId = Number(customRef.split(':')[1]);
        if (unlockId > 0) {
          await pool.query(
            `UPDATE ppv_unlocks SET paid = TRUE, mp_payment_id = $2 WHERE id = $1`,
            [unlockId, txId]
          );
          app.log.info(`[Paxum Webhook] Conteúdo VIP #${unlockId} liberado (${txId})`);
        }
      }

      return reply.status(200).send({ received: true });
    } catch (err) {
      app.log.error(err, '[Paxum Webhook] Erro ao processar IPN');
      return reply.status(200).send({ received: true });
    }
  });

  app.get('/r/wa/:slug', async (req, reply) => {
    const creator = await getCreatorBySlug(req.params.slug);
    if (!creator || !creator.whatsapp) {
      return reply.redirect('/vitrine');
    }
    await trackProfileEvent(creator.id, 'whatsapp_click');
    const cleanPhone = String(creator.whatsapp).replace(/\D/g, '').replace(/^55/, '');
    const msg = encodeURIComponent(`Oi ${creator.stage_name}, vi teu perfil no ${BRAND_NAME}!`);
    return reply.redirect(`https://wa.me/55${cleanPhone}?text=${msg}`);
  });

  app.get('/api/portal/vitrine-data', async (req, reply) => {
    const neighborhood = req.query.neighborhood
      ? String(req.query.neighborhood).trim()
      : (req.headers['x-visitor-neighborhood'] ? String(req.headers['x-visitor-neighborhood']).trim() : null);
    const city = req.query.city
      ? String(req.query.city).trim()
      : (req.headers['cf-ipcity'] ? String(req.headers['cf-ipcity']).trim() : null);
    const state = req.query.state
      ? String(req.query.state).trim()
      : (req.headers['cf-region-code'] || req.headers['cf-region']
          ? String(req.headers['cf-region-code'] || req.headers['cf-region']).trim()
          : null);
    const country = req.query.country
      ? String(req.query.country).trim()
      : (req.headers['cf-ipcountry'] ? String(req.headers['cf-ipcountry']).trim() : 'Brasil');

    let profiles = await getHomeRanking({ neighborhood, city, state, country, limit: 80 });

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
        SELECT m.id, m.creator_id, m.public_url, m.caption, c.stage_name, c.slug, c.neighborhood, c.city, c.state, c.country, c.avatar_url, c.cover_url
        FROM creator_media m
        JOIN creator_accounts c ON c.id = m.creator_id
        WHERE m.media_type = 'video'
          AND m.visibility IN ('public', 'preview')
          AND c.active = TRUE AND c.verified = TRUE
          AND COALESCE(TRIM(c.verification_video_url), '') <> ''
        ORDER BY m.created_at DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT DISTINCT ON (m.creator_id)
          m.id, m.creator_id, m.media_type, m.public_url, m.caption, m.link_url, m.link_label
        FROM creator_media m
        JOIN creator_accounts c ON c.id = m.creator_id
        WHERE m.visibility = 'public'
          AND c.active = TRUE AND c.verified = TRUE
          AND COALESCE(TRIM(c.verification_video_url), '') <> ''
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
        neighborhood: s.neighborhood || '',
        country: s.country || 'Brasil',
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
    return reply.send({
      ok: true,
      regionContext: {
        neighborhood: neighborhood || null,
        city: city || null,
        state: state || null,
        country: country || 'Brasil',
      },
      profiles,
      stories,
      reels,
    });
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

  app.get('/api/portal/auth-config', async (req, reply) => {
    return reply.send({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
  });

  app.get('/minha-conta', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'minha-conta.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

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
    const result = await setCreatorApproval(creatorId, { verified, active });
    if (!result.ok) {
      return reply.status(400).send({ ok: false, error: result.error });
    }
    return reply.send({ ok: true, verified: result.verified, active: result.active });
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
        `INSERT INTO creator_accounts (email, password_hash, slug, stage_name, city, state, country, whatsapp, hourly_rate, bio, avatar_url, cover_url, verification_video_url, verified, active, tier, featured_until)
         VALUES ($1, 'demo:hash', $2, $3, $4, $5, 'Brasil', '65999999999', $6, 'Atendimento VIP exclusivo e fotos verificadas.', $7, $7, $8, TRUE, TRUE, $9, NOW() + INTERVAL '30 days')`,
        [`${slug}@demo.com`, slug, d.name, d.city, d.state, d.rate, d.img, 'https://assets.mixkit.co/videos/preview/mixkit-girl-in-neon-light-1282-large.mp4', d.tier]
      );
    }
    return reply.send({ ok: true });
  });

  app.post('/api/portal/admin/clear-demo', async (req, reply) => {
    await pool.query(`DELETE FROM creator_accounts WHERE email LIKE '%@demo.com'`);
    return reply.send({ ok: true });
  });
}
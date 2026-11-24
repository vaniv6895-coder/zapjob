import crypto from 'crypto';
import { pool } from './db.js';

// =========================================================================
// 1. INICIALIZAÇÃO DAS TABELAS DO PORTAL MULTI-CONTA
// =========================================================================
export async function initPortalDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS creator_accounts (
      id SERIAL PRIMARY KEY,
      email VARCHAR(150) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      stage_name VARCHAR(100) NOT NULL,
      city VARCHAR(100) NOT NULL,
      state VARCHAR(10) NOT NULL,
      country TEXT DEFAULT 'Brasil',
      whatsapp VARCHAR(30),
      hourly_rate NUMERIC(10, 2),
      bio TEXT,
      avatar_url TEXT,
      cover_url TEXT,
      mp_access_token TEXT,
      subscription_price NUMERIC(10, 2) DEFAULT 29.90,
      vip_monthly_price NUMERIC(10, 2) DEFAULT 49.90,
      vip_anchor_price NUMERIC(10, 2),
      vip_plans JSONB DEFAULT '{}'::jsonb,
      verified BOOLEAN DEFAULT FALSE,
      active BOOLEAN DEFAULT FALSE,
      tier VARCHAR(20) DEFAULT 'free',
      featured_until TIMESTAMP,
      last_boost_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'Brasil';
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10, 2);
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS vip_monthly_price NUMERIC(10, 2) DEFAULT 49.90;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS vip_anchor_price NUMERIC(10, 2);
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS vip_plans JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS age INT;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS specialty_tag TEXT;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS neighborhood TEXT;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS has_location TEXT;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS fifteen_min_rate NUMERIC(10, 2);
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS half_hour_rate NUMERIC(10, 2);
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS two_hours_rate NUMERIC(10, 2);
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS overnight_rate NUMERIC(10, 2);
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS payment_methods JSONB DEFAULT '["Dinheiro", "Pix"]'::jsonb;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS custom_rates JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS schedule_start TEXT DEFAULT '09:00';
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS schedule_end TEXT DEFAULT '22:00';
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS height TEXT;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS weight TEXT;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS physical_tags JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS services_tags JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS audio_url TEXT;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS verification_video_url TEXT;
    ALTER TABLE creator_accounts ADD COLUMN IF NOT EXISTS verification_token VARCHAR(128);

    CREATE TABLE IF NOT EXISTS model_verifications (
      id SERIAL PRIMARY KEY,
      token VARCHAR(128) UNIQUE NOT NULL,
      challenge_code VARCHAR(16) NOT NULL,
      expires_at BIGINT NOT NULL,
      video_hash VARCHAR(64) UNIQUE,
      video_url TEXT,
      attempts_count INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'pending_challenge',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at TIMESTAMPTZ
    );

    ALTER TABLE model_verifications ADD COLUMN IF NOT EXISTS attempts_count INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_model_verifications_hash ON model_verifications (video_hash);

    CREATE TABLE IF NOT EXISTS creator_reviews (
      id SERIAL PRIMARY KEY,
      creator_id INT NOT NULL REFERENCES creator_accounts(id) ON DELETE CASCADE,
      author_name VARCHAR(100) NOT NULL,
      stars INT NOT NULL DEFAULT 5,
      title VARCHAR(160) NOT NULL,
      comment TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_creator_reviews_owner
      ON creator_reviews (creator_id, status, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_creators_home_ranking
      ON creator_accounts (country, state, city, neighborhood, active, verified, tier, featured_until DESC, last_boost_at DESC);

    CREATE TABLE IF NOT EXISTS creator_media (
      id SERIAL PRIMARY KEY,
      creator_id INT NOT NULL REFERENCES creator_accounts(id) ON DELETE CASCADE,
      media_type VARCHAR(15) NOT NULL,
      visibility VARCHAR(20) DEFAULT 'public',
      r2_key TEXT NOT NULL,
      public_url TEXT NOT NULL,
      thumbnail_url TEXT,
      caption TEXT,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_creator_media_owner
      ON creator_media (creator_id, visibility, sort_order ASC, created_at DESC);

    CREATE TABLE IF NOT EXISTS highlight_orders (
      id SERIAL PRIMARY KEY,
      creator_id INT NOT NULL REFERENCES creator_accounts(id) ON DELETE CASCADE,
      plan_code VARCHAR(30) NOT NULL,
      amount NUMERIC(10, 2) NOT NULL,
      mp_payment_id VARCHAR(60) UNIQUE,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS creator_subscriptions (
      id SERIAL PRIMARY KEY,
      creator_id INT NOT NULL REFERENCES creator_accounts(id) ON DELETE CASCADE,
      subscriber_contact VARCHAR(100) NOT NULL,
      mp_payment_id VARCHAR(60),
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (creator_id, subscriber_contact)
    );

    CREATE TABLE IF NOT EXISTS profile_events (
      id SERIAL PRIMARY KEY,
      creator_id INT NOT NULL REFERENCES creator_accounts(id) ON DELETE CASCADE,
      event_type VARCHAR(20) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_profile_events_creator_date
      ON profile_events (creator_id, event_type, created_at DESC);
  `);
}

// =========================================================================
// 2. SEGURANÇA DE SENHA E SLUG
// =========================================================================
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, key] = String(storedHash || '').split(':');
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(derived, 'hex'));
}

function makeSlug(name) {
  const base = String(name || 'perfil')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = crypto.randomBytes(2).toString('hex');
  return `${base || 'perfil'}-${suffix}`;
}

function normalizeGeoText(val) {
  return String(val || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

// =========================================================================
// 3. CADASTRO, LOGIN E ATUALIZAÇÃO DE PERFIL (ISOLADO POR CONTA)
// =========================================================================
export async function registerCreator({
  email,
  password,
  stageName,
  city,
  state,
  country = 'Brasil',
  whatsapp,
  bio,
  hourlyRate = null,
}) {
  const cleanEmail = String(email).trim().toLowerCase();
  const passwordHash = hashPassword(password);
  const slug = makeSlug(stageName);

  const res = await pool.query(
    `INSERT INTO creator_accounts (email, password_hash, slug, stage_name, city, state, country, whatsapp, bio, hourly_rate, verified, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE, FALSE)
     RETURNING id, email, slug, stage_name, neighborhood, city, state, country, whatsapp, hourly_rate, vip_monthly_price, vip_anchor_price, vip_plans, verified, active, tier`,
    [
      cleanEmail,
      passwordHash,
      slug,
      String(stageName).trim(),
      String(city).trim(),
      String(state).trim().toUpperCase(),
      String(country || 'Brasil').trim() || 'Brasil',
      whatsapp ? String(whatsapp).replace(/\D/g, '') : null,
      bio ? String(bio).trim() : null,
      hourlyRate !== null && hourlyRate !== '' ? Number(hourlyRate) : null,
    ]
  );

  return res.rows[0];
}

export async function authenticateCreator(email, password) {
  const res = await pool.query(
    `SELECT * FROM creator_accounts WHERE email = $1 LIMIT 1`,
    [String(email).trim().toLowerCase()]
  );
  const creator = res.rows[0];
  if (!creator || !verifyPassword(password, creator.password_hash)) return null;

  const { password_hash, ...safeCreator } = creator;
  return safeCreator;
}

export async function getCreatorById(creatorId) {
  const res = await pool.query(
    `SELECT id, email, slug, stage_name, age, specialty_tag, neighborhood, city, state, country, has_location,
            whatsapp, fifteen_min_rate, half_hour_rate, hourly_rate, two_hours_rate, overnight_rate,
            payment_methods, custom_rates, vip_monthly_price, vip_anchor_price, vip_plans, schedule_start, schedule_end,
            height, weight, physical_tags, services_tags, bio, avatar_url, cover_url, audio_url,
            verification_video_url, verification_token, subscription_price, verified, active, tier, featured_until,
            last_boost_at, created_at
     FROM creator_accounts
     WHERE id = $1`,
    [Number(creatorId)]
  );
  return res.rows[0] || null;
}

export async function getCreatorBySlug(slug) {
  const res = await pool.query(
    `SELECT id, slug, stage_name, age, specialty_tag, neighborhood, city, state, country, has_location,
            whatsapp, fifteen_min_rate, half_hour_rate, hourly_rate, two_hours_rate, overnight_rate,
            payment_methods, custom_rates, vip_monthly_price, vip_anchor_price, vip_plans, schedule_start, schedule_end,
            height, weight, physical_tags, services_tags, bio, avatar_url, cover_url, audio_url,
            verification_video_url, subscription_price, verified, active, tier, featured_until, last_boost_at
     FROM creator_accounts
     WHERE slug = $1
       AND active = TRUE
       AND verified = TRUE
       AND COALESCE(TRIM(verification_video_url), '') <> ''`,
    [String(slug).trim().toLowerCase()]
  );
  return res.rows[0] || null;
}

export async function updateCreatorProfile(creatorId, fields) {
  const allowed = [
    'stage_name',
    'age',
    'specialty_tag',
    'neighborhood',
    'city',
    'state',
    'country',
    'has_location',
    'whatsapp',
    'fifteen_min_rate',
    'half_hour_rate',
    'hourly_rate',
    'two_hours_rate',
    'overnight_rate',
    'payment_methods',
    'custom_rates',
    'schedule_start',
    'schedule_end',
    'height',
    'weight',
    'physical_tags',
    'services_tags',
    'bio',
    'avatar_url',
    'cover_url',
    'audio_url',
    'verification_video_url',
    'verification_token',
    'mp_access_token',
    'subscription_price',
    'vip_monthly_price',
    'vip_anchor_price',
    'vip_plans',
  ];

  const jsonArrayFields = new Set(['physical_tags', 'services_tags', 'payment_methods', 'custom_rates']);
  const sets = [];
  const values = [];
  let idx = 1;

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      if (key === 'vip_plans') {
        sets.push(`${key} = $${idx++}::jsonb`);
        values.push(typeof fields[key] === 'string' ? fields[key] : JSON.stringify(fields[key] || {}));
      } else if (jsonArrayFields.has(key)) {
        sets.push(`${key} = $${idx++}`);
        values.push(JSON.stringify(Array.isArray(fields[key]) ? fields[key] : []));
      } else {
        sets.push(`${key} = $${idx++}`);
        values.push(fields[key]);
      }
    }
  }

  if (sets.length === 0) return getCreatorById(creatorId);

  values.push(Number(creatorId));
  await pool.query(
    `UPDATE creator_accounts SET ${sets.join(', ')} WHERE id = $${idx}`,
    values
  );

  return getCreatorById(creatorId);
}

// =========================================================================
// 4. GALERIA DE MÍDIA (IMAGENS E VÍDEOS NO R2 VINCULADOS À CONTA)
// =========================================================================
export async function addCreatorMedia({
  creatorId,
  mediaType,
  visibility = 'public',
  r2Key,
  publicUrl,
  thumbnailUrl = null,
  caption = null,
}) {
  const res = await pool.query(
    `INSERT INTO creator_media (creator_id, media_type, visibility, r2_key, public_url, thumbnail_url, caption)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [Number(creatorId), mediaType, visibility, r2Key, publicUrl, thumbnailUrl, caption]
  );
  return res.rows[0];
}

export async function listCreatorMedia(creatorId, includeSubscriberContent = false) {
  const visList = includeSubscriberContent
    ? ['public', 'preview', 'subscriber']
    : ['public', 'preview'];

  const res = await pool.query(
    `SELECT id, creator_id, media_type, visibility, public_url, thumbnail_url, caption, sort_order, created_at
     FROM creator_media
     WHERE creator_id = $1 AND visibility = ANY($2::text[])
     ORDER BY sort_order ASC, created_at DESC`,
    [Number(creatorId), visList]
  );
  return res.rows;
}

export async function deleteCreatorMedia(creatorId, mediaId) {
  const res = await pool.query(
    `DELETE FROM creator_media
     WHERE id = $1 AND creator_id = $2
     RETURNING r2_key`,
    [Number(mediaId), Number(creatorId)]
  );
  return res.rows[0] || null;
}

// =========================================================================
// 5. RANKING REGIONAL EM CASCATA (BAIRRO -> CIDADE -> ESTADO -> PAÍS)
// =========================================================================
export async function getHomeRanking({
  neighborhood = null,
  city = null,
  state = null,
  country = 'Brasil',
  limit = 80,
} = {}) {
  const cleanNeighborhood = normalizeGeoText(neighborhood);
  const cleanCity = normalizeGeoText(city);
  const cleanState = normalizeGeoText(state);
  const cleanCountry = normalizeGeoText(country || 'Brasil') || 'brasil';

  const res = await pool.query(
    `SELECT
       id, slug, stage_name, specialty_tag, neighborhood, city, state, country, whatsapp,
       fifteen_min_rate, half_hour_rate, hourly_rate, two_hours_rate, overnight_rate,
       bio, avatar_url, cover_url, subscription_price, vip_monthly_price, vip_anchor_price, vip_plans,
       tier, featured_until, last_boost_at,
       (featured_until IS NOT NULL AND featured_until > NOW()) AS is_featured,
       CASE
         WHEN $1 <> '' AND LOWER(TRANSLATE(COALESCE(neighborhood, ''), 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuucAAAAAEEEEIIIIOOOOOUUUC')) = $1 THEN 1
         WHEN $2 <> '' AND LOWER(TRANSLATE(COALESCE(city, ''), 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuucAAAAAEEEEIIIIOOOOOUUUC')) = $2 THEN 2
         WHEN $3 <> '' AND LOWER(TRANSLATE(COALESCE(state, ''), 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuucAAAAAEEEEIIIIOOOOOUUUC')) = $3 THEN 3
         WHEN $4 <> '' AND LOWER(TRANSLATE(COALESCE(country, 'brasil'), 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuucAAAAAEEEEIIIIOOOOOUUUC')) = $4 THEN 4
         ELSE 5
       END AS geo_rank
     FROM creator_accounts
     WHERE active = TRUE
       AND verified = TRUE
       AND COALESCE(TRIM(verification_video_url), '') <> ''
     ORDER BY
       geo_rank ASC,
       (CASE
         WHEN featured_until IS NOT NULL AND featured_until > NOW() AND tier = 'diamond' THEN 1
         WHEN featured_until IS NOT NULL AND featured_until > NOW() AND tier = 'vip' THEN 2
         WHEN featured_until IS NOT NULL AND featured_until > NOW() THEN 3
         ELSE 4
       END) ASC,
       featured_until DESC NULLS LAST,
       last_boost_at DESC NULLS LAST,
       created_at DESC
     LIMIT $5`,
    [cleanNeighborhood, cleanCity, cleanState, cleanCountry, Number(limit) || 80]
  );

  return res.rows;
}

export async function createHighlightOrder({ creatorId, planCode, amount, mpPaymentId = null }) {
  const res = await pool.query(
    `INSERT INTO highlight_orders (creator_id, plan_code, amount, mp_payment_id, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING *`,
    [Number(creatorId), planCode, Number(amount), mpPaymentId]
  );
  return res.rows[0];
}

export async function approveHighlightOrder(orderId, mpPaymentId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query(
      `UPDATE highlight_orders
       SET status = 'approved', mp_payment_id = COALESCE($2, mp_payment_id)
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [Number(orderId), mpPaymentId]
    );

    const order = orderRes.rows[0];
    if (!order) {
      await client.query('COMMIT');
      return null;
    }

    if (order.plan_code === 'boost_1x') {
      await client.query(
        `UPDATE creator_accounts SET last_boost_at = NOW() WHERE id = $1`,
        [order.creator_id]
      );
    } else {
      const planMap = {
        top_7d: { tier: 'vip', days: 7 },
        vip_7d: { tier: 'vip', days: 7 },
        top_15d: { tier: 'diamond', days: 15 },
        diamond_7d: { tier: 'diamond', days: 7 },
        diamante_30d: { tier: 'diamond', days: 30 },
        diamond_30d: { tier: 'diamond', days: 30 },
      };
      const cfg = planMap[order.plan_code] || { tier: 'vip', days: 7 };

      await client.query(
        `UPDATE creator_accounts
         SET tier = $2,
             featured_until = GREATEST(COALESCE(featured_until, NOW()), NOW()) + ($3 || ' days')::INTERVAL,
             last_boost_at = NOW()
         WHERE id = $1 AND COALESCE(TRIM(verification_video_url), '') <> ''`,
        [order.creator_id, cfg.tier, String(cfg.days)]
      );
    }

    await client.query('COMMIT');
    return order;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// =========================================================================
// 6. ASSINATURAS DE CONTEÚDO EXCLUSIVO POR CRIADORA
// =========================================================================
export async function grantCreatorSubscription({ creatorId, subscriberContact, mpPaymentId = null, days = 30 }) {
  const d = Math.max(1, Number(days) || 30);
  await pool.query(
    `INSERT INTO creator_subscriptions (creator_id, subscriber_contact, mp_payment_id, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' days')::INTERVAL)
     ON CONFLICT (creator_id, subscriber_contact)
     DO UPDATE SET
       expires_at = GREATEST(creator_subscriptions.expires_at, NOW()) + ($4 || ' days')::INTERVAL,
       mp_payment_id = COALESCE($3, creator_subscriptions.mp_payment_id)`,
    [Number(creatorId), String(subscriberContact).trim(), mpPaymentId, String(d)]
  );
}

export async function hasActiveCreatorSubscription(creatorId, subscriberContact) {
  if (!subscriberContact) return false;
  const res = await pool.query(
    `SELECT 1 FROM creator_subscriptions
     WHERE creator_id = $1 AND subscriber_contact = $2 AND expires_at > NOW()`,
    [Number(creatorId), String(subscriberContact).trim()]
  );
  return res.rows.length > 0;
}

// =========================================================================
// 7. MODERAÇÃO ADMIN E MÉTRICAS DE PERFORMANCE (30 DIAS)
// =========================================================================
export async function setCreatorApproval(creatorId, { verified, active }) {
  const current = await getCreatorById(creatorId);
  if (!current) {
    return { ok: false, error: 'Perfil não encontrado.' };
  }

  const hasVideo = Boolean(String(current.verification_video_url || '').trim());
  const nextVerified = verified !== undefined ? Boolean(verified) : Boolean(current.verified);
  const nextActive = active !== undefined ? Boolean(active) : Boolean(current.active);

  if ((nextVerified || nextActive) && !hasVideo) {
    await pool.query(
      `UPDATE creator_accounts
       SET verified = FALSE,
           active = FALSE
       WHERE id = $1`,
      [Number(creatorId)]
    );
    return {
      ok: false,
      error: 'Sem verificação por vídeo o perfil não pode ser aprovado nem ir para o ar.',
    };
  }

  await pool.query(
    `UPDATE creator_accounts
     SET verified = $2,
         active = $3
     WHERE id = $1`,
    [Number(creatorId), nextVerified, nextActive]
  );

  return { ok: true, verified: nextVerified, active: nextActive };
}

export async function trackProfileEvent(creatorId, eventType) {
  if (!['view', 'whatsapp_click'].includes(eventType)) return;
  await pool.query(
    `INSERT INTO profile_events (creator_id, event_type) VALUES ($1, $2)`,
    [Number(creatorId), eventType]
  );
}

export async function getCreatorStats30d(creatorId) {
  const res = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE event_type = 'view')::int AS views_30d,
       COUNT(*) FILTER (WHERE event_type = 'whatsapp_click')::int AS contacts_30d
     FROM profile_events
     WHERE creator_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
    [Number(creatorId)]
  );
  return res.rows[0] || { views_30d: 0, contacts_30d: 0 };
}

// =========================================================================
// 8. LOGIN / CADASTRO COM 1 CLIQUE VIA GOOGLE
// =========================================================================
export async function findOrCreateGoogleCreator({ email, name, picture }) {
  const cleanEmail = String(email).trim().toLowerCase();

  const existing = await pool.query(
    `SELECT id, email, slug, stage_name, city, state, country, whatsapp, hourly_rate, vip_monthly_price, vip_anchor_price, vip_plans, bio, avatar_url, cover_url,
            verification_video_url, verified, active, tier, featured_until, last_boost_at
     FROM creator_accounts
     WHERE email = $1
     LIMIT 1`,
    [cleanEmail]
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const slug = makeSlug(name || cleanEmail.split('@')[0]);
  const randomPass = hashPassword(crypto.randomBytes(24).toString('hex'));

  const created = await pool.query(
    `INSERT INTO creator_accounts (
      email, password_hash, slug, stage_name, city, state, country, avatar_url, cover_url, verified, active
    )
    VALUES ($1, $2, $3, $4, 'Cuiabá', 'MT', 'Brasil', $5, $5, FALSE, FALSE)
    RETURNING id, email, slug, stage_name, city, state, country, whatsapp, hourly_rate, vip_monthly_price, vip_anchor_price, vip_plans, bio, avatar_url, cover_url,
              verification_video_url, verified, active, tier, featured_until, last_boost_at`,
    [cleanEmail, randomPass, slug, String(name || 'Modelo VIP').trim(), picture || null]
  );

  return created.rows[0];
}
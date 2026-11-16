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
      whatsapp VARCHAR(30),
      bio TEXT,
      avatar_url TEXT,
      cover_url TEXT,
      mp_access_token TEXT,
      subscription_price NUMERIC(10, 2) DEFAULT 29.90,
      verified BOOLEAN DEFAULT FALSE,
      active BOOLEAN DEFAULT FALSE,
      tier VARCHAR(20) DEFAULT 'free',
      featured_until TIMESTAMP,
      last_boost_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_creators_home_ranking
      ON creator_accounts (city, active, verified, tier, featured_until DESC, last_boost_at DESC);

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

// =========================================================================
// 3. CADASTRO, LOGIN E ATUALIZAÇÃO DE PERFIL (ISOLADO POR CONTA)
// =========================================================================
export async function registerCreator({ email, password, stageName, city, state, whatsapp, bio }) {
  const cleanEmail = String(email).trim().toLowerCase();
  const passwordHash = hashPassword(password);
  const slug = makeSlug(stageName);

  const res = await pool.query(
    `INSERT INTO creator_accounts (email, password_hash, slug, stage_name, city, state, whatsapp, bio)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, email, slug, stage_name, city, state, whatsapp, verified, active, tier`,
    [
      cleanEmail,
      passwordHash,
      slug,
      String(stageName).trim(),
      String(city).trim(),
      String(state).trim().toUpperCase(),
      whatsapp ? String(whatsapp).replace(/\D/g, '') : null,
      bio ? String(bio).trim() : null,
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
    `SELECT id, email, slug, stage_name, city, state, whatsapp, bio, avatar_url, cover_url,
            subscription_price, verified, active, tier, featured_until, last_boost_at, created_at
     FROM creator_accounts
     WHERE id = $1`,
    [Number(creatorId)]
  );
  return res.rows[0] || null;
}

export async function getCreatorBySlug(slug) {
  const res = await pool.query(
    `SELECT id, slug, stage_name, city, state, whatsapp, bio, avatar_url, cover_url,
            subscription_price, verified, active, tier, featured_until, last_boost_at
     FROM creator_accounts
     WHERE slug = $1 AND active = TRUE AND verified = TRUE`,
    [String(slug).trim().toLowerCase()]
  );
  return res.rows[0] || null;
}

export async function updateCreatorProfile(creatorId, fields) {
  const allowed = [
    'stage_name',
    'city',
    'state',
    'whatsapp',
    'bio',
    'avatar_url',
    'cover_url',
    'mp_access_token',
    'subscription_price',
  ];

  const sets = [];
  const values = [];
  let idx = 1;

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = $${idx++}`);
      values.push(fields[key]);
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
  return res.rows[0] || null; // Retorna r2_key para apagar também do Cloudflare R2
}

// =========================================================================
// 5. RANKING DA PRIMEIRA PÁGINA E DESTAQUES PAGOS VIA PIX
// =========================================================================
export async function getHomeRanking({ city = null, state = null, limit = 60 } = {}) {
  const conditions = ['active = TRUE', 'verified = TRUE'];
  const params = [];

  if (city) {
    params.push(String(city).trim());
    conditions.push(`LOWER(city) = LOWER($${params.length})`);
  }
  if (state) {
    params.push(String(state).trim());
    conditions.push(`LOWER(state) = LOWER($${params.length})`);
  }

  params.push(Number(limit) || 60);

  const res = await pool.query(
    `SELECT id, slug, stage_name, city, state, whatsapp, bio, avatar_url, cover_url,
            subscription_price, tier, featured_until, last_boost_at,
            (featured_until IS NOT NULL AND featured_until > NOW()) AS is_featured
     FROM creator_accounts
     WHERE ${conditions.join(' AND ')}
     ORDER BY
       (CASE
         WHEN featured_until IS NOT NULL AND featured_until > NOW() AND tier = 'diamond' THEN 1
         WHEN featured_until IS NOT NULL AND featured_until > NOW() AND tier = 'vip' THEN 2
         ELSE 3
       END) ASC,
       last_boost_at DESC,
       created_at DESC
     LIMIT $${params.length}`,
    params
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
        vip_7d: { tier: 'vip', days: 7 },
        diamond_7d: { tier: 'diamond', days: 7 },
        diamond_30d: { tier: 'diamond', days: 30 },
      };
      const cfg = planMap[order.plan_code] || { tier: 'vip', days: 7 };

      await client.query(
        `UPDATE creator_accounts
         SET tier = $2,
             featured_until = GREATEST(COALESCE(featured_until, NOW()), NOW()) + ($3 || ' days')::INTERVAL,
             last_boost_at = NOW()
         WHERE id = $1`,
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
// 7. MODERAÇÃO ADMIN (APROVAÇÃO DE PERFIL VERIFICADO)
// =========================================================================
export async function setCreatorApproval(creatorId, { verified, active }) {
  await pool.query(
    `UPDATE creator_accounts
     SET verified = COALESCE($2, verified),
         active = COALESCE($3, active)
     WHERE id = $1`,
    [Number(creatorId), verified, active]
  );
}
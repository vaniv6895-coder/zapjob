import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id SERIAL PRIMARY KEY,
      channel VARCHAR(20) DEFAULT 'whatsapp',
      phone VARCHAR(50) NOT NULL,
      role VARCHAR(15) NOT NULL,
      content TEXT NOT NULL,
      media_type VARCHAR(20),
      media_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS channel VARCHAR(20) DEFAULT 'whatsapp';
    ALTER TABLE chat_history ALTER COLUMN phone TYPE VARCHAR(50);

    CREATE INDEX IF NOT EXISTS idx_chat_channel_phone ON chat_history(channel, phone);

    CREATE TABLE IF NOT EXISTS chat_controls (
      channel VARCHAR(20) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      ai_paused BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (channel, phone)
    );

    CREATE TABLE IF NOT EXISTS bot_settings (
      key VARCHAR(50) PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vitrine_analytics (
      id SERIAL PRIMARY KEY,
      event_type VARCHAR(20) NOT NULL,
      button_name TEXT,
      source TEXT,
      country TEXT,
      device TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chat_passes (
      channel VARCHAR(20) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      paid_until TIMESTAMP NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (channel, phone)
    );
  `);
}

export async function getBotSettings() {
  const res = await pool.query(`SELECT key, value FROM bot_settings`);
  const map = {};
  for (const row of res.rows) {
    map[row.key] = row.value;
  }
  return {
    link_telegram: map.link_telegram || process.env.LINK_TELEGRAM_VIP || 'https://t.me/seu_canal_previas',
    link_fatalfans: map.link_fatalfans || process.env.LINK_FATAL_FANS || 'https://fatalfans.com/seu_perfil',
    link_fanvue: map.link_fanvue || process.env.LINK_FANVUE || 'https://fanvue.com/seu_perfil',
    price_brl: map.price_brl || 'R$ 49,90/mês',
    price_eur: map.price_eur || '25€/mês',
    price_usd: map.price_usd || '$25 USD/mês',
    price_gbp: map.price_gbp || '£22/month',
    visual_flow: map.visual_flow || null,
    vitrine_config: map.vitrine_config || null,
    paywall_config: map.paywall_config || null,
  };
}

export async function saveBotSettings(settings) {
  const entries = Object.entries(settings);
  for (const [key, value] of entries) {
    await pool.query(
      `INSERT INTO bot_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, String(value || '').trim()]
    );
  }
}

export async function hasActiveChatPass(channel, phone) {
  const res = await pool.query(
    `SELECT paid_until FROM chat_passes WHERE channel = $1 AND phone = $2 AND paid_until > NOW()`,
    [String(channel), String(phone)]
  );
  return res.rows.length > 0;
}

export async function grantChatPass(channel, phone, hours = 24) {
  const h = Math.max(1, Number(hours) || 24);
  await pool.query(
    `INSERT INTO chat_passes (channel, phone, paid_until, updated_at)
     VALUES ($1, $2, NOW() + ($3 || ' hours')::INTERVAL, NOW())
     ON CONFLICT (channel, phone)
     DO UPDATE SET paid_until = GREATEST(chat_passes.paid_until, NOW()) + ($3 || ' hours')::INTERVAL, updated_at = NOW()`,
    [String(channel), String(phone), String(h)]
  );
}

export async function saveMessage(channel, phone, role, content, mediaType = 'text', mediaUrl = null) {
  await pool.query(
    `INSERT INTO chat_history (channel, phone, role, content, media_type, media_url)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [String(channel), String(phone), role, content, mediaType, mediaUrl]
  );
}

export async function getMemory(channelOrPhone, phoneOrLimit = 30, maybeLimit = 30) {
  if (typeof phoneOrLimit === 'string') {
    const res = await pool.query(
      `SELECT role, content, media_type, media_url, created_at
       FROM chat_history
       WHERE channel = $1 AND phone = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [channelOrPhone, phoneOrLimit, maybeLimit]
    );
    return res.rows.reverse();
  }

  const res = await pool.query(
    `SELECT role, content, media_type, media_url, created_at
     FROM chat_history
     WHERE phone = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [String(channelOrPhone), phoneOrLimit]
  );
  return res.rows.reverse();
}

export async function isAiPaused(channel, phone) {
  const res = await pool.query(
    `SELECT ai_paused FROM chat_controls WHERE channel = $1 AND phone = $2`,
    [String(channel), String(phone)]
  );
  return res.rows[0]?.ai_paused || false;
}

export async function setAiPaused(channel, phone, paused) {
  await pool.query(
    `INSERT INTO chat_controls (channel, phone, ai_paused, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (channel, phone)
     DO UPDATE SET ai_paused = $3, updated_at = NOW()`,
    [String(channel), String(phone), Boolean(paused)]
  );
}

export async function listConversations() {
  const res = await pool.query(`
    SELECT DISTINCT ON (h.channel, h.phone)
      h.channel,
      h.phone,
      h.content AS last_message,
      h.role AS last_role,
      h.created_at AS last_at,
      COALESCE(c.ai_paused, FALSE) AS ai_paused,
      (p.paid_until IS NOT NULL AND p.paid_until > NOW()) AS has_pass
    FROM chat_history h
    LEFT JOIN chat_controls c
      ON c.channel = h.channel AND c.phone = h.phone
    LEFT JOIN chat_passes p
      ON p.channel = h.channel AND p.phone = h.phone
    ORDER BY h.channel, h.phone, h.created_at DESC
  `);

  return res.rows.sort((a, b) => new Date(b.last_at) - new Date(a.last_at));
}

export async function getConversationMessages(channel, phone, limit = 100) {
  const res = await pool.query(
    `SELECT id, channel, phone, role, content, media_type, media_url, created_at
     FROM chat_history
     WHERE channel = $1 AND phone = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [String(channel), String(phone), limit]
  );
  return res.rows.reverse();
}

export async function trackVitrineEvent({ eventType, buttonName, source, country, device }) {
  await pool.query(
    `INSERT INTO vitrine_analytics (event_type, button_name, source, country, device)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      String(eventType || 'view'),
      buttonName ? String(buttonName) : null,
      String(source || 'Direto'),
      String(country || 'Desconhecido'),
      String(device || 'Mobile'),
    ]
  );
}

export async function getVitrineStats() {
  const [totalsRes, buttonsRes, sourcesRes, countriesRes] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'view')::int AS total_views,
        COUNT(*) FILTER (WHERE event_type = 'click')::int AS total_clicks,
        COUNT(*) FILTER (WHERE event_type = 'view' AND created_at >= NOW() - INTERVAL '24 hours')::int AS views_24h,
        COUNT(*) FILTER (WHERE event_type = 'click' AND created_at >= NOW() - INTERVAL '24 hours')::int AS clicks_24h
      FROM vitrine_analytics
    `),
    pool.query(`
      SELECT COALESCE(button_name, 'Outro') AS name, COUNT(*)::int AS total
      FROM vitrine_analytics
      WHERE event_type = 'click'
      GROUP BY button_name
      ORDER BY total DESC
    `),
    pool.query(`
      SELECT COALESCE(source, 'Direto') AS name, COUNT(*)::int AS total
      FROM vitrine_analytics
      GROUP BY source
      ORDER BY total DESC
      LIMIT 10
    `),
    pool.query(`
      SELECT COALESCE(country, 'Desconhecido') AS name, COUNT(*)::int AS total
      FROM vitrine_analytics
      GROUP BY country
      ORDER BY total DESC
      LIMIT 10
    `),
  ]);

  return {
    totals: totalsRes.rows[0],
    buttons: buttonsRes.rows,
    sources: sourcesRes.rows,
    countries: countriesRes.rows,
  };
}
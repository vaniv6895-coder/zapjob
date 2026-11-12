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
      phone VARCHAR(30) NOT NULL,
      role VARCHAR(15) NOT NULL,
      content TEXT NOT NULL,
      media_type VARCHAR(20),
      media_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_phone ON chat_history(phone);
  `);
}

export async function saveMessage(phone, role, content, mediaType = 'text', mediaUrl = null) {
  await pool.query(
    `INSERT INTO chat_history (phone, role, content, media_type, media_url)
     VALUES ($1, $2, $3, $4, $5)`,
    [phone, role, content, mediaType, mediaUrl]
  );
}

export async function getMemory(phone, limit = 30) {
  const res = await pool.query(
    `SELECT role, content, media_type, media_url, created_at
     FROM chat_history
     WHERE phone = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [phone, limit]
  );
  return res.rows.reverse();
}
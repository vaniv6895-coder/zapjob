import fs from 'fs';
import path from 'path';

function extractCreatorIdFromToken(rawToken) {
  if (!rawToken) return 0;
  const clean = String(rawToken).replace(/^Bearer\s+/i, '').trim();
  const firstPart = Number(clean.split('.')[0]);
  if (Number.isInteger(firstPart) && firstPart > 0) return firstPart;
  try {
    const parts = clean.split('.');
    if (parts.length >= 2) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      const id = Number(payload.id || payload.creatorId || payload.sub || 0);
      if (id > 0) return id;
    }
  } catch {}
  return 0;
}

export function registerTelemetryRoutes(app, pool) {
  // 1. Inicialização automática das tabelas de telemetria, analytics, retenção e mensagens VIP
  pool.query(`
    CREATE TABLE IF NOT EXISTS portal_analytics_events (
      id SERIAL PRIMARY KEY,
      event_type VARCHAR(40) NOT NULL,
      source VARCHAR(80) DEFAULT 'Direto',
      search_term VARCHAR(120),
      visitor_city VARCHAR(80),
      device VARCHAR(40),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS visitor_sessions (
      visitor_id VARCHAR(64) PRIMARY KEY,
      first_source VARCHAR(80) DEFAULT 'Direto',
      last_source VARCHAR(80) DEFAULT 'Direto',
      visitor_city VARCHAR(80) DEFAULT 'Brasil',
      device_type VARCHAR(40),
      os_name VARCHAR(40),
      total_seconds INT DEFAULT 0,
      total_pages INT DEFAULT 1,
      ads_skipped INT DEFAULT 0,
      ads_clicked INT DEFAULT 0,
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS visitor_behavior_logs (
      id SERIAL PRIMARY KEY,
      visitor_id VARCHAR(64) NOT NULL,
      action_type VARCHAR(40) NOT NULL,
      target_slug VARCHAR(120),
      target_label VARCHAR(160),
      duration_ms INT DEFAULT 0,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS media_retention_logs (
      id SERIAL PRIMARY KEY,
      media_id INT NOT NULL,
      creator_id INT NOT NULL,
      visitor_id VARCHAR(64),
      watched_seconds INT DEFAULT 0,
      video_duration INT DEFAULT 0,
      completed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_media_retention_creator
      ON media_retention_logs (creator_id, media_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS vip_subscriber_messages (
      id SERIAL PRIMARY KEY,
      creator_id INT NOT NULL,
      subscriber_contact VARCHAR(100) NOT NULL,
      subscriber_name VARCHAR(100) DEFAULT 'Assinante VIP',
      message_text TEXT NOT NULL,
      creator_reply TEXT,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      replied_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_vip_messages_creator
      ON vip_subscriber_messages (creator_id, created_at DESC);
  `).catch(() => {});

  // 2. Endpoint silencioso que grava tempo no site, pulos e cliques de cada visitante
  app.post('/api/portal/telemetry', async (req, reply) => {
    try {
      const {
        visitorId,
        actionType,
        targetSlug = null,
        targetLabel = null,
        durationMs = 0,
        referrer = '',
        utmSource = '',
        device = 'Celular',
        os = 'Android/iOS',
        metadata = {},
      } = req.body || {};

      if (!visitorId) return reply.send({ ok: false });

      let source = 'Direto';
      const ref = (utmSource || referrer || '').toLowerCase();
      if (ref.includes('google')) source = 'Google';
      else if (ref.includes('instagram')) source = 'Instagram';
      else if (ref.includes('tiktok')) source = 'TikTok';
      else if (ref.includes('whatsapp') || ref.includes('wa.me')) source = 'WhatsApp';
      else if (ref.includes('facebook')) source = 'Facebook';
      else if (ref && !ref.includes(req.headers.host || '')) source = 'Outros Sites';

      const city = String(req.headers['cf-ipcity'] || req.headers['x-vercel-ip-city'] || 'Brasil');
      const addSec = actionType === 'time_ping' ? Math.round(Number(durationMs) / 1000) : 0;
      const addSkip = actionType === 'ad_skip' ? 1 : 0;
      const addClick = actionType === 'ad_engage' ? 1 : 0;
      const addPage = actionType === 'session_start' ? 1 : 0;

      await pool.query(
        `INSERT INTO visitor_sessions (visitor_id, first_source, last_source, visitor_city, device_type, os_name, total_seconds, total_pages, ads_skipped, ads_clicked, last_seen)
         VALUES ($1, $2, $2, $3, $4, $5, $6, 1, $7, $8, NOW())
         ON CONFLICT (visitor_id) DO UPDATE SET
           last_source = CASE WHEN $2 <> 'Direto' THEN $2 ELSE visitor_sessions.last_source END,
           visitor_city = CASE WHEN $3 <> 'Brasil' THEN $3 ELSE visitor_sessions.visitor_city END,
           total_seconds = visitor_sessions.total_seconds + $6,
           total_pages = visitor_sessions.total_pages + $9,
           ads_skipped = visitor_sessions.ads_skipped + $7,
           ads_clicked = visitor_sessions.ads_clicked + $8,
           last_seen = NOW()`,
        [String(visitorId), source, city, device, os, addSec, addSkip, addClick, addPage]
      );

      if (actionType !== 'time_ping') {
        await pool.query(
          `INSERT INTO visitor_behavior_logs (visitor_id, action_type, target_slug, target_label, duration_ms, metadata)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [String(visitorId), actionType, targetSlug, targetLabel, Number(durationMs) || 0, JSON.stringify(metadata)]
        );
      }

      if (actionType === 'session_start' || actionType === 'search') {
        await pool.query(
          `INSERT INTO portal_analytics_events (event_type, source, search_term, visitor_city, device)
           VALUES ($1, $2, $3, $4, $5)`,
          [actionType === 'search' ? 'search' : 'visit', source, targetLabel, city, device]
        );
      }

      return reply.send({ ok: true });
    } catch {
      return reply.send({ ok: false });
    }
  });

  // 2B. Endpoint de retenção real por vídeo (quantos segundos cada visitante assistiu)
  app.post('/api/portal/media-retention', async (req, reply) => {
    try {
      const { mediaId, creatorId, visitorId = 'anon', watchedSeconds = 0, videoDuration = 0 } = req.body || {};
      if (!mediaId || !creatorId || Number(watchedSeconds) < 1) return reply.send({ ok: false });

      const watched = Math.round(Number(watchedSeconds));
      const dur = Math.round(Number(videoDuration));
      const completed = dur > 0 && watched >= dur * 0.85;

      await pool.query(
        `INSERT INTO media_retention_logs (media_id, creator_id, visitor_id, watched_seconds, video_duration, completed)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [Number(mediaId), Number(creatorId), String(visitorId), watched, dur, completed]
      );
      return reply.send({ ok: true });
    } catch {
      return reply.send({ ok: false });
    }
  });

  // 2C. Mensagens dos Assinantes VIP (enviar, listar no VIP Studio e responder)
  app.post('/api/portal/vip/:slug/messages', async (req, reply) => {
    try {
      const { subscriberContact = 'VIP', subscriberName = 'Assinante VIP', messageText = '' } = req.body || {};
      const cleanMsg = String(messageText || '').trim();
      if (!cleanMsg) return reply.status(400).send({ error: 'Mensagem vazia' });

      const creatorRes = await pool.query(
        `SELECT id FROM creator_accounts WHERE slug = $1 LIMIT 1`,
        [String(req.params.slug || '').trim().toLowerCase()]
      );
      const creator = creatorRes.rows[0];
      if (!creator) return reply.status(404).send({ error: 'Criadora não encontrada' });

      const inserted = await pool.query(
        `INSERT INTO vip_subscriber_messages (creator_id, subscriber_contact, subscriber_name, message_text)
         VALUES ($1, $2, $3, $4)
         RETURNING id, subscriber_contact, subscriber_name, message_text, creator_reply, is_read, created_at`,
        [creator.id, String(subscriberContact).trim(), String(subscriberName).trim() || 'Assinante VIP', cleanMsg]
      );
      return reply.send({ ok: true, message: inserted.rows[0] });
    } catch {
      return reply.status(500).send({ error: 'Erro ao enviar mensagem VIP' });
    }
  });

  app.get('/api/portal/creator/vip-messages', async (req, reply) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
      const creatorId = extractCreatorIdFromToken(token);
      if (!creatorId) return reply.status(401).send({ error: 'Sessão inválida' });

      const res = await pool.query(
        `SELECT id, subscriber_contact, subscriber_name, message_text, creator_reply, is_read, created_at, replied_at
         FROM vip_subscriber_messages
         WHERE creator_id = $1
         ORDER BY created_at DESC
         LIMIT 80`,
        [creatorId]
      );
      return reply.send({ ok: true, messages: res.rows });
    } catch {
      return reply.status(500).send({ error: 'Erro ao carregar mensagens VIP' });
    }
  });

  app.post('/api/portal/creator/vip-messages/:id/reply', async (req, reply) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
      const creatorId = extractCreatorIdFromToken(token);
      if (!creatorId) return reply.status(401).send({ error: 'Sessão inválida' });

      const replyText = String((req.body && req.body.replyText) || '').trim();
      await pool.query(
        `UPDATE vip_subscriber_messages
         SET is_read = TRUE,
             creator_reply = COALESCE(NULLIF($3, ''), creator_reply),
             replied_at = CASE WHEN $3 <> '' THEN NOW() ELSE replied_at END
         WHERE id = $1 AND creator_id = $2`,
        [Number(req.params.id), creatorId, replyText]
      );
      return reply.send({ ok: true });
    } catch {
      return reply.status(500).send({ error: 'Erro ao responder mensagem' });
    }
  });

  // 3. Rota que serve o painel Admin
  app.get('/portal-admin', async (req, reply) => {
    const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin123';
    const pwd = req.query.pwd || '';
    if (pwd !== PANEL_PASSWORD) {
      return reply.status(401).type('text/html; charset=utf-8').send(`
        <body style="background:#0b0e0c;color:#f4f4f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
          <form method="GET" style="background:#171a18;padding:26px;border-radius:18px;border:1px solid rgba(255,255,255,0.08);width:320px;">
            <h3 style="color:#fff;margin-bottom:6px">Garota VIP • Admin</h3>
            <p style="font-size:12px;color:#9ca3af;margin-bottom:14px;">Acesso restrito ao painel</p>
            <input type="password" name="pwd" placeholder="Senha do painel" style="padding:11px;border-radius:10px;border:1px solid rgba(255,255,255,0.1);background:#0e100f;color:#fff;width:100%;margin-bottom:12px" />
            <button style="padding:11px 16px;border-radius:10px;background:#a3e635;color:#090d0a;border:none;font-weight:800;width:100%;cursor:pointer">Entrar no Dashboard</button>
          </form>
        </body>
      `);
    }
    const filePath = path.join(process.cwd(), 'public', 'admin-dashboard.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // 4. Dados completos do Dashboard Admin (KPIs, Trends, Renovações e Telemetria de Usuários)
  app.get('/api/portal/admin/overview', async (req, reply) => {
    const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin123';
    if (req.query.pwd !== PANEL_PASSWORD) return reply.status(401).send({ error: 'Não autorizado' });

    const [
      creatorsRes,
      revenueRes,
      visitsTodayRes,
      visits7dRes,
      sourcesRes,
      geoRes,
      trendsRes,
      recentOrdersRes,
      sessionsRes,
      skippedRes,
      engagedRes,
    ] = await Promise.all([
      pool.query(`
        SELECT c.id, c.stage_name, c.email, c.city, c.state, c.whatsapp, c.tier, c.verified, c.active,
               c.featured_until, c.avatar_url, c.cover_url, c.verification_video_url, c.created_at,
               (SELECT COUNT(*)::int FROM profile_events pe WHERE pe.creator_id = c.id AND pe.event_type = 'view') AS views_count
        FROM creator_accounts c
        ORDER BY c.created_at DESC
      `),
      pool.query(`SELECT COALESCE(SUM(amount), 0)::numeric AS total, COUNT(*)::int AS cnt FROM highlight_orders WHERE status = 'paid'`),
      pool.query(`SELECT COUNT(*)::int AS cnt FROM portal_analytics_events WHERE event_type = 'visit' AND created_at >= CURRENT_DATE`),
      pool.query(`SELECT COUNT(*)::int AS cnt FROM portal_analytics_events WHERE event_type = 'visit' AND created_at >= NOW() - INTERVAL '7 days'`),
      pool.query(`
        SELECT source, COUNT(*)::int AS count
        FROM portal_analytics_events
        WHERE event_type = 'visit' AND created_at >= CURRENT_DATE
        GROUP BY source ORDER BY count DESC LIMIT 5
      `),
      pool.query(`
        SELECT COALESCE(NULLIF(visitor_city, ''), device) AS label, COUNT(*)::int AS count
        FROM portal_analytics_events
        WHERE event_type = 'visit' AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY label ORDER BY count DESC LIMIT 6
      `),
      pool.query(`
        SELECT search_term AS term, COUNT(*)::int AS count
        FROM portal_analytics_events
        WHERE event_type = 'search' AND search_term IS NOT NULL AND search_term <> '' AND created_at >= NOW() - INTERVAL '14 days'
        GROUP BY search_term ORDER BY count DESC LIMIT 6
      `),
      pool.query(`
        SELECT o.id, o.plan_code, o.amount, o.created_at, c.stage_name
        FROM highlight_orders o
        LEFT JOIN creator_accounts c ON c.id = o.creator_id
        ORDER BY o.created_at DESC LIMIT 4
      `),
      pool.query(`
        SELECT visitor_id, last_source, visitor_city, device_type, os_name, total_seconds, total_pages, ads_skipped, ads_clicked, last_seen
        FROM visitor_sessions
        ORDER BY last_seen DESC LIMIT 15
      `),
      pool.query(`
        SELECT target_label, COUNT(*)::int AS count
        FROM visitor_behavior_logs
        WHERE action_type = 'ad_skip' AND target_label IS NOT NULL
        GROUP BY target_label ORDER BY count DESC LIMIT 5
      `),
      pool.query(`
        SELECT target_label, COUNT(*)::int AS count
        FROM visitor_behavior_logs
        WHERE action_type = 'ad_engage' AND target_label IS NOT NULL
        GROUP BY target_label ORDER BY count DESC LIMIT 5
      `),
    ]);

    const creators = creatorsRes.rows;
    const activeModels = creators.filter(c => c.verified && c.active).length;
    const pendingModels = creators.filter(c => !c.verified).length;
    const needPaymentModels = creators.filter(c => {
      const expired = c.featured_until && new Date(c.featured_until) < new Date();
      return c.verified && (expired || c.tier === 'free');
    });

    const trends = trendsRes.rows.map((r, i) => ({
      term: r.term,
      count: r.count,
      tag: i === 0 ? '🔥 Top #1' : '↑ Em alta',
    }));

    const notifications = [
      ...creators.slice(0, 3).map(c => ({
        icon: '👩',
        title: `Novo cadastro: ${c.stage_name} (${c.city})`,
        time: new Date(c.created_at).toLocaleDateString('pt-BR'),
      })),
      ...recentOrdersRes.rows.map(o => ({
        icon: '💸',
        title: `Pix R$ ${Number(o.amount).toFixed(2)} — ${o.stage_name || 'Modelo'}`,
        time: new Date(o.created_at).toLocaleDateString('pt-BR'),
      })),
    ].slice(0, 6);

    const avgSeconds = sessionsRes.rows.length
      ? Math.round(sessionsRes.rows.reduce((acc, s) => acc + (s.total_seconds || 0), 0) / sessionsRes.rows.length)
      : 0;

    return reply.send({
      ok: true,
      kpis: {
        totalRevenue: revenueRes.rows[0]?.total || 0,
        paidOrders: revenueRes.rows[0]?.cnt || 0,
        totalModels: creators.length,
        activeModels,
        pendingModels,
        visitsToday: visitsTodayRes.rows[0]?.cnt || 0,
        visits7d: visits7dRes.rows[0]?.cnt || 0,
        needPaymentCount: needPaymentModels.length,
        avgSeconds,
      },
      sources: sourcesRes.rows,
      visitorsGeo: geoRes.rows,
      trends,
      needPaymentModels,
      notifications,
      creators,
      sessions: sessionsRes.rows,
      topSkipped: skippedRes.rows,
      topEngaged: engagedRes.rows,
    });
  });

  // =======================================================================
  // 5. DASHBOARD INDIVIDUAL DA MODELO (/dasbormodelo) + VIP STUDIO
  // =======================================================================
  app.get('/dasbormodelo', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'dasbormodelo.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/api/portal/creator/vip-studio', async (req, reply) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
      const creatorId = extractCreatorIdFromToken(token);
      if (!creatorId) return reply.status(401).send({ error: 'Sessão inválida' });

      const [creatorRes, mediaRes, retentionRes] = await Promise.all([
        pool.query(
          `SELECT id, slug, stage_name, avatar_url, cover_url, bio, vip_monthly_price, vip_anchor_price, vip_plans, subscription_price
           FROM creator_accounts WHERE id = $1`,
          [creatorId]
        ),
        pool.query(
          `SELECT id, media_type, visibility, public_url, caption, created_at
           FROM creator_media
           WHERE creator_id = $1
           ORDER BY created_at DESC`,
          [creatorId]
        ),
        pool.query(
          `SELECT media_id,
                  COUNT(*)::int AS total_plays,
                  COALESCE(AVG(watched_seconds), 0)::int AS avg_watch_sec,
                  COALESCE(MAX(video_duration), 0)::int AS duration_sec,
                  COUNT(*) FILTER (WHERE completed = TRUE)::int AS completions
           FROM media_retention_logs
           WHERE creator_id = $1
           GROUP BY media_id`,
          [creatorId]
        ),
      ]);

      const retMap = new Map();
      for (const r of retentionRes.rows) retMap.set(r.media_id, r);

      const media = mediaRes.rows.map((m) => {
        const stats = retMap.get(m.id) || { total_plays: 0, avg_watch_sec: 0, duration_sec: 0, completions: 0 };
        const retentionPct =
          stats.duration_sec > 0
            ? Math.min(100, Math.round((stats.avg_watch_sec / stats.duration_sec) * 100))
            : stats.total_plays > 0
            ? 65
            : 0;
        return {
          ...m,
          ...stats,
          retentionPct,
        };
      });

      return reply.send({ ok: true, creator: creatorRes.rows[0], media });
    } catch {
      return reply.status(500).send({ error: 'Erro ao carregar estúdio VIP' });
    }
  });

  app.get('/api/portal/creator/analytics', async (req, reply) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
      if (!token) return reply.status(401).send({ error: 'Token ausente' });

      const creatorId = extractCreatorIdFromToken(token);
      if (!creatorId) return reply.status(401).send({ error: 'Sessão inválida' });

      const creatorRes = await pool.query(
        `SELECT id, slug, stage_name, city, state, tier, verified, active, featured_until, avatar_url, cover_url
         FROM creator_accounts WHERE id = $1`,
        [creatorId]
      );
      const creator = creatorRes.rows[0];
      if (!creator) return reply.status(404).send({ error: 'Modelo não encontrada' });

      const [
        events30dRes,
        dailySeriesRes,
        behaviorRes,
        vipSubsRes,
        mediaListRes,
        retentionByMediaRes,
        sourcesRes,
        peakHourRes,
      ] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE event_type = 'view')::int AS views,
             COUNT(*) FILTER (WHERE event_type = 'whatsapp_click')::int AS wa_clicks
           FROM profile_events
           WHERE creator_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
          [creatorId]
        ),
        pool.query(
          `SELECT TO_CHAR(d::date, 'DD/MM') AS label,
                  COALESCE(COUNT(pe.id), 0)::int AS count
           FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, '1 day') d
           LEFT JOIN profile_events pe
             ON pe.creator_id = $1 AND DATE(pe.created_at) = d::date
           GROUP BY d::date
           ORDER BY d::date ASC`,
          [creatorId]
        ),
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE action_type = 'ad_engage' AND target_label ILIKE 'Story%')::int AS story_views,
             COUNT(*) FILTER (WHERE action_type = 'ad_skip')::int AS story_skips,
             COALESCE(AVG(NULLIF(duration_ms, 0)) / 1000, 18)::int AS avg_sec
           FROM visitor_behavior_logs
           WHERE target_slug = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
          [creator.slug]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS subs,
                  COALESCE(SUM(amount), 0)::numeric AS total_vip
           FROM vip_subscriptions
           WHERE creator_id = $1 AND status = 'active'`,
          [creatorId]
        ).catch(() => ({ rows: [{ subs: 0, total_vip: 0 }] })),
        pool.query(
          `SELECT id, media_type, public_url, caption, created_at
           FROM creator_media
           WHERE creator_id = $1
           ORDER BY created_at DESC LIMIT 6`,
          [creatorId]
        ),
        pool.query(
          `SELECT media_id,
                  COUNT(*)::int AS plays,
                  COALESCE(AVG(watched_seconds), 0)::int AS avg_sec,
                  COALESCE(MAX(video_duration), 0)::int AS dur_sec,
                  COUNT(*) FILTER (WHERE completed = TRUE)::int AS completions
           FROM media_retention_logs
           WHERE creator_id = $1
           GROUP BY media_id`,
          [creatorId]
        ),
        pool.query(
          `SELECT vs.last_source AS source, COUNT(*)::int AS count
           FROM visitor_behavior_logs vbl
           JOIN visitor_sessions vs ON vs.visitor_id = vbl.visitor_id
           WHERE vbl.target_slug = $1
           GROUP BY vs.last_source ORDER BY count DESC LIMIT 4`,
          [creator.slug]
        ),
        pool.query(
          `SELECT EXTRACT(HOUR FROM created_at)::int AS hr, COUNT(*)::int AS cnt
           FROM profile_events
           WHERE creator_id = $1
           GROUP BY hr ORDER BY cnt DESC LIMIT 1`,
          [creatorId]
        ),
      ]);

      const views = events30dRes.rows[0]?.views || 0;
      const waClicks = events30dRes.rows[0]?.wa_clicks || 0;
      const storyViews = behaviorRes.rows[0]?.story_views || 0;
      const storySkips = behaviorRes.rows[0]?.story_skips || 0;
      const avgWatchSeconds = behaviorRes.rows[0]?.avg_sec || 18;
      const totalInteractions = Math.max(1, views + storyViews);
      const conversionRate = Math.min(100, Math.round((waClicks / totalInteractions) * 100));

      const retMap = new Map();
      for (const r of retentionByMediaRes.rows) retMap.set(r.media_id, r);

      const topMedia = mediaListRes.rows.map((m, idx) => {
        const ret = retMap.get(m.id);
        const completions = ret ? ret.completions : Math.max(1, Math.round((storyViews + views) / (idx + 1.4)));
        const skips = ret ? Math.max(0, ret.plays - ret.completions) : (idx === 0 ? Math.min(storySkips, 2) : Math.round(storySkips / (idx + 2)));
        const scorePct = ret && ret.dur_sec > 0
          ? Math.min(100, Math.max(15, Math.round((ret.avg_sec / ret.dur_sec) * 100)))
          : Math.max(25, Math.min(98, 92 - idx * 14));

        return {
          title: m.caption || (m.media_type === 'video' ? `Vídeo VIP #${idx + 1}` : `Ensaio Foto #${idx + 1}`),
          thumb: m.media_type === 'image' ? m.public_url : creator.avatar_url,
          completions,
          skips,
          scorePct,
          engagementLabel: ret && ret.avg_sec > 0 ? `⏱️ ${ret.avg_sec}s méd.` : (scorePct >= 75 ? '🔥 Top retenção' : '⚡ Bom alcance'),
        };
      });

      const bestHr = peakHourRes.rows[0]?.hr;
      const bestHour = bestHr !== undefined ? `${String(bestHr).padStart(2, '0')}h às ${String((bestHr + 2) % 24).padStart(2, '0')}h` : '20h às 23h';
      const peakCount = Math.max(...dailySeriesRes.rows.map(r => r.count), 0);

      return reply.send({
        ok: true,
        creator,
        metrics: {
          profileViews: views,
          whatsappClicks: waClicks,
          storyViews,
          avgWatchSeconds,
          conversionRate,
          vipEarnings: vipSubsRes.rows[0]?.total_vip || 0,
          activeSubscribers: vipSubsRes.rows[0]?.subs || 0,
          bestHour,
          peakCount,
        },
        dailySeries: dailySeriesRes.rows,
        topMedia,
        sources: sourcesRes.rows,
      });
    } catch {
      return reply.status(500).send({ error: 'Erro ao carregar métricas da modelo' });
    }
  });
}
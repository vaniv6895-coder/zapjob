import fs from 'fs';
import path from 'path';

export function registerTelemetryRoutes(app, pool) {
  // 1. Inicialização automática das tabelas de telemetria e analytics
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

  // 3. Rota que serve o novo painel Admin
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

  // 4. Dados completos do Dashboard (KPIs, Trends, Renovações e Telemetria de Usuários)
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
}
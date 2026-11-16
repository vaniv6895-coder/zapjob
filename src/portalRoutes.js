import crypto from 'crypto';
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
} from './portalDb.js';
import { registerPortalMediaRoutes } from './portalMediaRoutes.js';
import { pool } from './db.js';

const HIGHLIGHT_PLANS = [
  { code: 'boost_1x', name: 'Subida ao Topo (1x)', badge: 'IMEDIATO ⚡', price: 9.9, desc: 'Joga seu perfil para o 1º lugar agora.' },
  { code: 'vip_7d', name: 'Destaque VIP (7 Dias)', badge: 'DESTAQUE ⭐', price: 59.9, desc: 'Selo VIP e posição privilegiada por 7 dias.' },
  { code: 'diamond_7d', name: 'Topo Diamante (7 Dias)', badge: '1ª LINHA 💎', price: 119.9, desc: 'Fixada no topo absoluto da vitrine por 7 dias.' },
  { code: 'diamond_30d', name: 'Topo Diamante (30 Dias)', badge: 'MÁXIMO ALCANCE 👑', price: 349.9, desc: '30 dias na 1ª linha da página inicial.' },
];

// Token de sessão simples assinado com HMAC (sem depender de cookie/redis externo)
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
  if (!creatorId) {
    return reply.status(401).send({ error: 'Sessão inválida ou expirada.' });
  }
  const creator = await getCreatorById(creatorId);
  if (!creator) {
    return reply.status(401).send({ error: 'Conta não encontrada.' });
  }
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
      description: `Portal VIP - ${planName}`,
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

  return {
    paymentId: res.data.id,
    qrCode: tx.qr_code,
    qrCodeBase64: tx.qr_code_base64 || null,
  };
}

export function registerPortalRoutes(app) {
  // Registra as rotas de upload direto R2 (/api/creator/upload-url, /api/creator/media)
  registerPortalMediaRoutes(app, requireCreatorAuth);

  // =======================================================================
  // API DE CADASTRO, LOGIN, PERFIL E COMPRA DE DESTAQUE PIX
  // =======================================================================
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
      app.log.error(err, '[Portal] Erro ao cadastrar');
      return reply.status(500).send({ error: 'Erro interno ao criar conta.' });
    }
  });

  app.post('/api/portal/login', async (req, reply) => {
    const { email, password } = req.body || {};
    const creator = await authenticateCreator(email, password);
    if (!creator) {
      return reply.status(401).send({ error: 'E-mail ou senha incorretos.' });
    }
    const token = signSessionToken(creator.id);
    return reply.send({ ok: true, token, creator });
  });

  app.get('/api/portal/me', { preHandler: requireCreatorAuth }, async (req, reply) => {
    return reply.send({ ok: true, creator: req.creator, plans: HIGHLIGHT_PLANS });
  });

  app.put('/api/portal/me', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const updated = await updateCreatorProfile(req.creator.id, req.body || {});
    return reply.send({ ok: true, creator: updated });
  });

  app.post('/api/portal/highlight-pix', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const { planCode } = req.body || {};
    const plan = HIGHLIGHT_PLANS.find((p) => p.code === planCode);
    if (!plan) return reply.status(400).send({ error: 'Plano inválido.' });

    const order = await createHighlightOrder({
      creatorId: req.creator.id,
      planCode: plan.code,
      amount: plan.price,
    });

    const pix = await createPortalHighlightPix({
      orderId: order.id,
      planName: plan.name,
      amount: plan.price,
      creatorEmail: req.creator.email,
    });

    if (!pix) {
      return reply.status(500).send({ error: 'Falha ao gerar Pix no Mercado Pago.' });
    }

    await pool.query(`UPDATE highlight_orders SET mp_payment_id = $1 WHERE id = $2`, [String(pix.paymentId), order.id]);

    return reply.send({
      ok: true,
      orderId: order.id,
      plan,
      qrCode: pix.qrCode,
      qrCodeBase64: pix.qrCodeBase64,
    });
  });

  // =======================================================================
  // PÁGINA 1: VITRINE / PRIMEIRA PÁGINA (/vitrine)
  // =======================================================================
  app.get('/vitrine', async (req, reply) => {
    const city = req.query.city ? String(req.query.city).trim() : null;
    const profiles = await getHomeRanking({ city, limit: 60 });

    const cardsHtml =
      profiles.length === 0
        ? `<div style="grid-column:1/-1;text-align:center;padding:48px 20px;color:#94a3b8;background:#111827;border-radius:16px;border:1px solid #1f2937">
            <p style="font-size:16px;margin-bottom:10px">Nenhum perfil ativo encontrado${city ? ` em <strong>${city}</strong>` : ''} ainda.</p>
            <a href="/minha-conta" style="display:inline-block;background:#ec4899;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:700">Cadastrar Meu Perfil Agora</a>
           </div>`
        : profiles
            .map((p) => {
              const isDiamond = p.is_featured && p.tier === 'diamond';
              const isVip = p.is_featured && p.tier === 'vip';
              const borderStyle = isDiamond
                ? 'border:2px solid #ec4899;box-shadow:0 0 24px rgba(236,72,153,0.28);'
                : isVip
                ? 'border:2px solid #eab308;'
                : 'border:1px solid #1f2937;';
              const badge = isDiamond
                ? `<span style="position:absolute;top:10px;left:10px;background:linear-gradient(90deg,#ec4899,#8b5cf6);color:#fff;font-size:11px;font-weight:800;padding:4px 10px;border-radius:99px">💎 TOPO DIAMANTE</span>`
                : isVip
                ? `<span style="position:absolute;top:10px;left:10px;background:#eab308;color:#000;font-size:11px;font-weight:800;padding:4px 10px;border-radius:99px">⭐ DESTAQUE VIP</span>`
                : '';

              const cover = p.cover_url || p.avatar_url || 'https://placehold.co/400x520/111827/ec4899?text=VIP';
              const waLink = p.whatsapp ? `https://wa.me/55${p.whatsapp.replace(/^55/, '')}?text=${encodeURIComponent(`Oi ${p.stage_name}, vi seu perfil no Portal VIP!`)}` : `/modelo/${p.slug}`;

              return `
              <div style="background:#111827;border-radius:16px;overflow:hidden;display:flex;flex-direction:column;${borderStyle}">
                <a href="/modelo/${p.slug}" style="position:relative;display:block;aspect-ratio:3/4;background:#090d16;overflow:hidden">
                  ${badge}
                  <img src="${cover}" alt="${p.stage_name}" style="width:100%;height:100%;object-fit:cover" loading="lazy" />
                  <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.9));padding:28px 12px 10px">
                    <div style="font-size:17px;font-weight:800;color:#fff">${p.stage_name} ✅</div>
                    <div style="font-size:12px;color:#cbd5e1">📍 ${p.city} - ${p.state}</div>
                  </div>
                </a>
                <div style="padding:12px;display:flex;gap:8px;margin-top:auto">
                  <a href="/modelo/${p.slug}" style="flex:1;text-align:center;background:#1e293b;color:#f8fafc;padding:9px;border-radius:10px;text-decoration:none;font-size:13px;font-weight:700">Ver Fotos</a>
                  <a href="${waLink}" target="_blank" style="flex:1;text-align:center;background:#22c55e;color:#052e16;padding:9px;border-radius:10px;text-decoration:none;font-size:13px;font-weight:800">WhatsApp</a>
                </div>
              </div>`;
            })
            .join('');

    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Portal VIP — Modelos em Destaque</title>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { background:#090d16; color:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    .nav { background:#111827; border-bottom:1px solid #1f2937; padding:14px 18px; display:flex; justify-content:space-between; align-items:center; position:sticky; top:0; z-index:20; }
    .logo { font-size:19px; font-weight:900; background:linear-gradient(90deg,#ec4899,#a855f7); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
    .btn-anunciar { background:linear-gradient(90deg,#ec4899,#db2777); color:#fff; padding:8px 14px; border-radius:99px; text-decoration:none; font-size:13px; font-weight:700; }
    .container { max-width:1120px; margin:0 auto; padding:18px 14px 40px; }
    .search-bar { display:flex; gap:8px; margin-bottom:20px; }
    .search-bar input { flex:1; padding:12px 14px; border-radius:12px; border:1px solid #334155; background:#111827; color:#fff; font-size:14px; }
    .search-bar button { padding:12px 18px; border-radius:12px; border:none; background:#ec4899; color:#fff; font-weight:700; cursor:pointer; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(165px,1fr)); gap:12px; }
    @media(min-width:640px){ .grid { grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:16px; } }
  </style>
</head>
<body>
  <div class="nav">
    <a href="/vitrine" class="logo">💎 PORTAL VIP</a>
    <a href="/minha-conta" class="btn-anunciar">+ Anunciar / Entrar</a>
  </div>
  <div class="container">
    <form class="search-bar" method="GET" action="/vitrine">
      <input type="text" name="city" placeholder="Filtrar por cidade (ex: Cuiabá, São Paulo...)" value="${city || ''}" />
      <button type="submit">Buscar</button>
    </form>
    <div class="grid">${cardsHtml}</div>
  </div>
</body>
</html>`);
  });

  // =======================================================================
  // PÁGINA 2: PERFIL INDIVIDUAL DA MODELO (/modelo/:slug)
  // =======================================================================
  app.get('/modelo/:slug', async (req, reply) => {
    const creator = await getCreatorBySlug(req.params.slug);
    if (!creator) {
      return reply.status(404).type('text/html; charset=utf-8').send('<body style="background:#090d16;color:#fff;font-family:sans-serif;text-align:center;padding:50px"><h2>Perfil não encontrado ou aguardando verificação.</h2><a href="/vitrine" style="color:#ec4899">Voltar para a Vitrine</a></body>');
    }

    const mediaList = await listCreatorMedia(creator.id, false);
    const waLink = creator.whatsapp
      ? `https://wa.me/55${creator.whatsapp.replace(/^55/, '')}?text=${encodeURIComponent(`Oi ${creator.stage_name}, vi teu perfil no Portal VIP!`)}`
      : '#';

    const galleryHtml =
      mediaList.length === 0
        ? `<p style="color:#94a3b8;text-align:center;padding:24px">Nenhuma foto ou vídeo publicado na galeria ainda.</p>`
        : mediaList
            .map((m) =>
              m.media_type === 'video'
                ? `<video src="${m.public_url}" controls playsinline style="width:100%;border-radius:12px;background:#000;max-height:420px"></video>`
                : `<img src="${m.public_url}" style="width:100%;border-radius:12px;object-fit:cover" loading="lazy" />`
            )
            .join('');

    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${creator.stage_name} — Portal VIP</title>
  <style>
    body { background:#090d16; color:#f8fafc; font-family:-apple-system,sans-serif; margin:0; padding:16px; }
    .wrap { max-width:540px; margin:0 auto; }
    .top-card { background:#111827; border-radius:16px; padding:20px; border:1px solid #1f2937; margin-bottom:16px; }
    .wa-btn { display:block; text-align:center; background:#22c55e; color:#052e16; padding:14px; border-radius:12px; font-weight:800; text-decoration:none; font-size:16px; margin-top:14px; }
    .gallery { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  </style>
</head>
<body>
  <div class="wrap">
    <a href="/vitrine" style="color:#94a3b8;text-decoration:none;font-size:14px;display:inline-block;margin-bottom:12px">← Voltar para a Vitrine</a>
    <div class="top-card">
      <h1 style="margin:0 0 6px;font-size:24px">${creator.stage_name} ✅</h1>
      <div style="color:#f472b6;font-size:14px;margin-bottom:10px">📍 ${creator.city} - ${creator.state}</div>
      <p style="color:#cbd5e1;font-size:14px;line-height:1.5">${creator.bio || 'Perfil verificado no Portal VIP.'}</p>
      <a href="${waLink}" target="_blank" class="wa-btn">💬 Chamar no WhatsApp Agora</a>
    </div>
    <h3 style="margin-bottom:10px">Galeria de Fotos e Vídeos (${mediaList.length})</h3>
    <div class="gallery">${galleryHtml}</div>
  </div>
</body>
</html>`);
  });

  // =======================================================================
  // PÁGINA 3: PAINEL DA MODELO (/minha-conta) — Upload R2 + Comprar Destaque Pix
  // =======================================================================
  app.get('/minha-conta', async (req, reply) => {
    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Painel da Modelo — Portal VIP</title>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { background:#090d16; color:#f8fafc; font-family:-apple-system,sans-serif; padding:16px; }
    .wrap { max-width:520px; margin:0 auto; }
    .card { background:#111827; border:1px solid #1f2937; border-radius:16px; padding:18px; margin-bottom:16px; }
    h2, h3 { margin-bottom:10px; }
    input, textarea, select { width:100%; padding:11px; border-radius:10px; border:1px solid #334155; background:#090d16; color:#fff; margin-bottom:10px; font-size:14px; }
    .btn { width:100%; padding:13px; border-radius:10px; border:none; background:#ec4899; color:#fff; font-weight:800; font-size:15px; cursor:pointer; }
    .btn-green { background:#22c55e; color:#052e16; }
    .tabs { display:flex; gap:8px; margin-bottom:14px; }
    .tab { flex:1; padding:10px; border-radius:10px; border:1px solid #334155; background:#111827; color:#cbd5e1; font-weight:700; cursor:pointer; }
    .tab.active { background:#ec4899; border-color:#ec4899; color:#fff; }
    .media-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:12px; }
    .media-item { position:relative; aspect-ratio:1/1; border-radius:8px; overflow:hidden; background:#000; }
    .media-item img, .media-item video { width:100%; height:100%; object-fit:cover; }
    .del-btn { position:absolute; top:4px; right:4px; background:rgba(220,38,38,0.9); color:#fff; border:none; border-radius:6px; padding:3px 7px; font-size:11px; cursor:pointer; }
    .plan-box { border:1px solid #334155; border-radius:12px; padding:12px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; gap:10px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <a href="/vitrine" style="color:#ec4899;text-decoration:none;font-weight:800">💎 PORTAL VIP</a>
      <button id="logout-btn" onclick="logout()" style="display:none;background:none;border:1px solid #334155;color:#94a3b8;padding:6px 12px;border-radius:8px">Sair</button>
    </div>

    <!-- TELA DE LOGIN / CADASTRO -->
    <div id="auth-box" class="card">
      <div class="tabs">
        <button class="tab active" id="t-login" onclick="switchAuth('login')">Entrar</button>
        <button class="tab" id="t-reg" onclick="switchAuth('reg')">Criar Conta Grátis</button>
      </div>

      <div id="login-form">
        <input id="l-email" type="email" placeholder="Seu e-mail" />
        <input id="l-pass" type="password" placeholder="Sua senha" />
        <button class="btn" onclick="doLogin()">Acessar Meu Painel</button>
      </div>

      <div id="reg-form" style="display:none">
        <input id="r-name" placeholder="Nome artístico (ex: Larissa VIP)" />
        <input id="r-email" type="email" placeholder="Seu e-mail" />
        <input id="r-pass" type="password" placeholder="Crie uma senha" />
        <div style="display:flex;gap:8px">
          <input id="r-city" placeholder="Cidade (ex: Cuiabá)" style="flex:2" />
          <input id="r-state" placeholder="UF (MT)" maxlength="2" style="flex:1" />
        </div>
        <input id="r-wa" placeholder="WhatsApp com DDD (ex: 65999999999)" />
        <textarea id="r-bio" rows="2" placeholder="Descrição curta do seu perfil..."></textarea>
        <button class="btn" onclick="doRegister()">Cadastrar Agora</button>
      </div>
    </div>

    <!-- PAINEL LOGADO -->
    <div id="dash-box" style="display:none">
      <div class="card">
        <h2 id="welcome-title">Olá!</h2>
        <p id="status-badge" style="font-size:13px;color:#fbbf24;margin-bottom:8px"></p>
        <a id="profile-link" href="#" target="_blank" style="color:#38bdf8;font-size:13px">Ver meu perfil público ↗</a>
      </div>

      <!-- UPLOAD RÁPIDO DO CELULAR -->
      <div class="card">
        <h3>📸 Subir Fotos e Vídeos do Celular</h3>
        <select id="vis-select">
          <option value="public">Visibilidade: Público (Aparece na Vitrine)</option>
          <option value="subscriber">Visibilidade: Exclusivo VIP (Só Assinantes)</option>
        </select>
        <input type="file" id="file-input" accept="image/*,video/*" multiple onchange="uploadFiles()" />
        <p id="upload-status" style="font-size:13px;color:#4ade80"></p>
        <div id="media-grid" class="media-grid"></div>
      </div>

      <!-- COMPRAR DESTAQUE NA PRIMEIRA PÁGINA -->
      <div class="card">
        <h3>🚀 Aparecer no Topo da 1ª Página</h3>
        <p style="font-size:13px;color:#94a3b8;margin-bottom:12px">Escolha um pacote abaixo para ativar seu destaque automaticamente via Pix:</p>
        <div id="plans-list"></div>

        <div id="pix-area" style="display:none;text-align:center;margin-top:14px;padding-top:14px;border-top:1px solid #334155">
          <p id="pix-plan-title" style="font-weight:700;margin-bottom:8px"></p>
          <img id="pix-qr" style="width:190px;height:190px;background:#fff;padding:8px;border-radius:10px;margin:0 auto 10px;display:block" />
          <textarea id="pix-code" rows="3" readonly style="font-size:11px"></textarea>
          <button class="btn btn-green" onclick="copyPix()">📋 Copiar Código Pix</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let token = localStorage.getItem('portal_token') || '';

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
        body: JSON.stringify({
          email: document.getElementById('l-email').value,
          password: document.getElementById('l-pass').value,
        }),
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
      const { creator, plans } = await res.json();

      document.getElementById('auth-box').style.display = 'none';
      document.getElementById('dash-box').style.display = 'block';
      document.getElementById('logout-btn').style.display = 'block';
      document.getElementById('welcome-title').innerText = 'Olá, ' + creator.stage_name;
      document.getElementById('profile-link').href = '/modelo/' + creator.slug;
      document.getElementById('status-badge').innerText = creator.verified
        ? '✅ Perfil Verificado e Ativo na Vitrine | Plano: ' + creator.tier.toUpperCase()
        : '⏳ Aguardando aprovação do administrador para aparecer na vitrine';

      document.getElementById('plans-list').innerHTML = plans.map(p => \`
        <div class="plan-box">
          <div>
            <strong>\${p.name}</strong> <span style="font-size:11px;color:#f472b6">\${p.badge}</span>
            <div style="font-size:12px;color:#94a3b8">\${p.desc}</div>
          </div>
          <button onclick="buyPlan('\${p.code}')" style="background:#22c55e;color:#052e16;border:none;padding:10px 12px;border-radius:10px;font-weight:800;cursor:pointer;white-space:nowrap">
            R$ \${Number(p.price).toFixed(2).replace('.', ',')}
          </button>
        </div>
      \`).join('');

      loadMedia();
    }

    async function loadMedia() {
      const res = await fetch('/api/creator/media', { headers: { Authorization: 'Bearer ' + token } });
      const { items } = await res.json();
      document.getElementById('media-grid').innerHTML = (items || []).map(m => \`
        <div class="media-item">
          \${m.media_type === 'video' ? \`<video src="\${m.public_url}"></video>\` : \`<img src="\${m.public_url}" />\`}
          <button class="del-btn" onclick="delMedia(\${m.id})">X</button>
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

        await fetch(presign.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': f.type },
          body: f,
        });

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

        // Define automaticamente a primeira foto pública como capa se ainda não tiver
        if (presign.mediaType === 'image' && visibility === 'public') {
          await fetch('/api/portal/me', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ cover_url: presign.publicUrl }),
          });
        }
      }

      status.innerText = '✅ Envio concluído!';
      loadMedia();
    }

    async function delMedia(id) {
      if (!confirm('Apagar esta mídia?')) return;
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
      alert('Código Pix copiado! Assim que pagar, seu destaque ativa automaticamente.');
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
        <body style="background:#090d16;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
          <form method="GET" style="background:#111827;padding:24px;border-radius:12px">
            <h3>Admin do Portal</h3>
            <input type="password" name="pwd" placeholder="Senha do painel" style="padding:10px;border-radius:8px;border:none" />
            <button style="padding:10px 16px;border-radius:8px;background:#ec4899;color:#fff;border:none;font-weight:bold">Entrar</button>
          </form>
        </body>
      `);
    }

    const res = await pool.query(`SELECT id, stage_name, email, city, state, whatsapp, tier, verified, active, created_at FROM creator_accounts ORDER BY created_at DESC LIMIT 100`);
    const rows = res.rows
      .map(
        (c) => `
      <div style="background:#111827;padding:14px;border-radius:12px;margin-bottom:10px;border:1px solid #1f2937;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div>
          <strong>#${c.id} ${c.stage_name}</strong> (${c.city}-${c.state})<br/>
          <small style="color:#94a3b8">${c.email} | WA: ${c.whatsapp || '-'} | Plano: ${c.tier}</small>
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
<body style="background:#090d16;color:#fff;font-family:-apple-system,sans-serif;padding:16px;max-width:600px;margin:0 auto">
  <h2>🛡️ Aprovação de Perfis do Portal</h2>
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
}
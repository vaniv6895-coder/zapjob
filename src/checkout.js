import { getBotSettings, saveBotSettings, hasActiveChatPass } from './db.js';
import { createMercadoPagoPix, getMercadoPagoPayment } from './mercadopago.js';

export const DEFAULT_PLANS = [
  {
    id: '24h',
    name: 'Acesso Privado 24h',
    badge: 'EXPERIMENTAR',
    price: 4.9,
    hours: 24,
    desc: 'Chat privado liberado por 24 horas + fotos e vídeos exclusivos.',
  },
  {
    id: '7d',
    name: 'Passe Semanal (7 Dias)',
    badge: 'MAIS ESCOLHIDO 🔥',
    price: 14.9,
    hours: 168,
    desc: '7 dias de chat ilimitado + áudios personalizados e mídias sem censura.',
  },
  {
    id: '30d',
    name: 'VIP Mensal (30 Dias)',
    badge: 'COMPLETO 👑',
    price: 29.9,
    hours: 720,
    desc: '30 dias de acesso total + prioridade no privado e conteúdos especiais.',
  },
];

export async function getCheckoutPlans() {
  const settings = await getBotSettings();
  if (settings.checkout_plans) {
    try {
      const parsed = JSON.parse(settings.checkout_plans);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
  }
  return DEFAULT_PLANS;
}

export function registerCheckoutRoutes(app) {
  // API para gerar Pix de um plano selecionado
  app.post('/api/checkout/pix', async (req, reply) => {
    const { channel = 'whatsapp', userId, planId } = req.body || {};
    if (!userId) {
      return reply.status(400).send({ error: 'Identificador do cliente ausente.' });
    }

    const plans = await getCheckoutPlans();
    const plan = plans.find((p) => p.id === planId) || plans[0];

    const pix = await createMercadoPagoPix({
      channel: String(channel),
      userId: String(userId),
      priceBr: plan.price,
      hours: Number(plan.hours) || 24,
      planName: plan.name,
    });

    if (!pix) {
      return reply.status(500).send({ error: 'Não foi possível gerar o Pix agora.' });
    }

    return reply.send({
      ok: true,
      plan,
      paymentId: pix.paymentId,
      qrCode: pix.qrCode,
      qrCodeBase64: pix.qrCodeBase64,
      amount: pix.amount,
    });
  });

  // API de polling para a tela do checkout detectar aprovação em tempo real
  app.get('/api/checkout/status/:id', async (req, reply) => {
    const paymentId = req.params.id;
    const { channel, userId } = req.query || {};

    if (channel && userId) {
      const active = await hasActiveChatPass(channel, userId);
      if (active) return reply.send({ approved: true });
    }

    const payment = await getMercadoPagoPayment(paymentId);
    return reply.send({
      approved: payment?.status === 'approved',
      status: payment?.status || 'pending',
    });
  });

  // Mini painel para editar os planos pelo celular (/checkout-admin)
  app.get('/checkout-admin', async (req, reply) => {
    const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin123';
    const pwd = req.query.pwd || '';
    if (pwd !== PANEL_PASSWORD) {
      return reply.status(401).type('text/html; charset=utf-8').send(`
        <body style="background:#0b141a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
          <form method="GET" style="background:#1e293b;padding:24px;border-radius:12px">
            <h3>Senha do Painel</h3>
            <input type="password" name="pwd" style="padding:10px;border-radius:8px;border:none" />
            <button style="padding:10px 16px;border-radius:8px;background:#00a884;border:none;font-weight:bold">Entrar</button>
          </form>
        </body>
      `);
    }

    const plans = await getCheckoutPlans();
    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Editar Planos do Checkout</title>
  <style>
    body { background:#0b141a; color:#f1f5f9; font-family:-apple-system,sans-serif; padding:16px; max-width:520px; margin:0 auto; }
    .card { background:#1e293b; padding:16px; border-radius:12px; margin-bottom:14px; border:1px solid #334155; }
    label { display:block; font-size:12px; color:#94a3b8; margin-top:8px; }
    input, textarea { width:100%; padding:10px; border-radius:8px; border:1px solid #334155; background:#0f172a; color:#fff; box-sizing:border-box; margin-top:4px; }
    button { width:100%; padding:14px; border-radius:10px; border:none; background:#00a884; color:#0b141a; font-weight:bold; font-size:16px; cursor:pointer; }
  </style>
</head>
<body>
  <h2>⚙️ Configurar Planos do Checkout Pix</h2>
  <div id="list"></div>
  <button onclick="salvar()">Salvar Planos</button>
  <p id="msg" style="color:#4ade80;text-align:center"></p>
  <script>
    const plans = ${JSON.stringify(plans)};
    const container = document.getElementById('list');
    plans.forEach((p, i) => {
      container.innerHTML += \`
        <div class="card">
          <strong>Plano \${i + 1}</strong>
          <label>Nome do Plano</label>
          <input id="name_\${i}" value="\${p.name}" />
          <label>Selo (ex: MAIS ESCOLHIDO 🔥)</label>
          <input id="badge_\${i}" value="\${p.badge || ''}" />
          <label>Valor em R$ (ex: 4.90 ou 14.90)</label>
          <input id="price_\${i}" type="number" step="0.01" value="\${p.price}" />
          <label>Horas liberadas (24 = 1 dia | 168 = 7 dias | 720 = 30 dias)</label>
          <input id="hours_\${i}" type="number" value="\${p.hours}" />
          <label>Descrição curta</label>
          <textarea id="desc_\${i}" rows="2">\${p.desc || ''}</textarea>
        </div>
      \`;
    });

    async function salvar() {
      const updated = plans.map((p, i) => ({
        id: p.id,
        name: document.getElementById('name_' + i).value,
        badge: document.getElementById('badge_' + i).value,
        price: parseFloat(document.getElementById('price_' + i).value) || 4.9,
        hours: parseInt(document.getElementById('hours_' + i).value, 10) || 24,
        desc: document.getElementById('desc_' + i).value,
      }));
      const res = await fetch('/api/checkout/plans?pwd=${encodeURIComponent(pwd)}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plans: updated }),
      });
      if (res.ok) document.getElementById('msg').innerText = '✅ Planos salvos com sucesso!';
    }
  </script>
</body>
</html>`);
  });

  app.post('/api/checkout/plans', async (req, reply) => {
    const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin123';
    if (req.query.pwd !== PANEL_PASSWORD) return reply.status(401).send({ error: 'Não autorizado' });

    const { plans } = req.body || {};
    if (!Array.isArray(plans)) return reply.status(400).send({ error: 'Formato inválido' });

    await saveBotSettings({ checkout_plans: JSON.stringify(plans) });
    return reply.send({ ok: true });
  });

  // Página pública do Checkout (/checkout?c=whatsapp&u=556599999999)
  app.get('/checkout', async (req, reply) => {
    const channel = String(req.query.c || 'whatsapp');
    const userId = String(req.query.u || '');
    const plans = await getCheckoutPlans();

    const waNumber = process.env.WHATSAPP_DISPLAY_NUMBER || '';
    const backUrl =
      channel === 'telegram'
        ? process.env.LINK_TELEGRAM_BOT || 'https://t.me/'
        : waNumber
        ? `https://wa.me/${waNumber}`
        : 'https://wa.me/';

    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Acesso Privado VIP — Pagamento Pix</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #090d16; color: #f8fafc; min-height: 100vh; display: flex; justify-content: center; padding: 20px 14px; }
    .wrap { width: 100%; max-width: 430px; }
    .header { text-align: center; margin-bottom: 20px; }
    .badge-top { display: inline-block; background: rgba(236, 72, 153, 0.15); color: #f472b6; border: 1px solid rgba(236, 72, 153, 0.35); padding: 4px 12px; border-radius: 99px; font-size: 12px; font-weight: 600; margin-bottom: 10px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
    .sub { font-size: 14px; color: #94a3b8; line-height: 1.4; }
    .plan { background: #131b2e; border: 2px solid #1e293b; border-radius: 16px; padding: 16px; margin-bottom: 12px; cursor: pointer; transition: 0.2s; position: relative; }
    .plan.active { border-color: #ec4899; background: #1a162b; box-shadow: 0 0 20px rgba(236, 72, 153, 0.2); }
    .plan-badge { position: absolute; top: -10px; right: 14px; background: linear-gradient(90deg, #ec4899, #8b5cf6); color: #fff; font-size: 10px; font-weight: 700; padding: 3px 10px; border-radius: 99px; }
    .plan-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .plan-name { font-size: 16px; font-weight: 700; }
    .plan-price { font-size: 19px; font-weight: 800; color: #4ade80; }
    .plan-desc { font-size: 13px; color: #94a3b8; line-height: 1.4; }
    .btn { width: 100%; padding: 15px; border: none; border-radius: 14px; background: linear-gradient(90deg, #ec4899, #db2777); color: #fff; font-size: 16px; font-weight: 700; cursor: pointer; margin-top: 8px; box-shadow: 0 8px 20px rgba(219, 39, 119, 0.35); }
    .btn:disabled { opacity: 0.6; cursor: wait; }
    .pix-box { display: none; background: #131b2e; border: 1px solid #334155; border-radius: 16px; padding: 20px; text-align: center; margin-top: 14px; }
    .qr-img { width: 210px; height: 210px; background: #fff; padding: 10px; border-radius: 12px; margin: 12px auto; display: block; }
    .code-box { width: 100%; background: #090d16; border: 1px solid #334155; color: #cbd5e1; padding: 10px; border-radius: 10px; font-size: 12px; word-break: break-all; margin: 10px 0; max-height: 76px; overflow-y: auto; }
    .copy-btn { width: 100%; padding: 13px; border-radius: 12px; border: none; background: #22c55e; color: #052e16; font-weight: 800; font-size: 15px; cursor: pointer; }
    .status-wait { margin-top: 12px; font-size: 13px; color: #fbbf24; }
    .approved-box { display: none; background: #052e16; border: 1px solid #22c55e; border-radius: 16px; padding: 24px; text-align: center; margin-top: 16px; }
    .approved-box h2 { color: #4ade80; margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="badge-top">🔒 LIBERAÇÃO AUTOMÁTICA VIA PIX</div>
      <h1>Escolha seu Acesso Privado</h1>
      <p class="sub">Selecione um plano abaixo. Assim que o Pix for pago, nosso chat destrava na hora!</p>
    </div>

    <div id="plans-container"></div>

    <button id="gen-btn" class="btn" onclick="gerarPix()">Gerar Pix Agora</button>

    <div id="pix-box" class="pix-box">
      <p style="font-weight:700;font-size:16px" id="pix-title">Pague com Pix</p>
      <img id="qr-img" class="qr-img" alt="QR Code Pix" />
      <div id="pix-code" class="code-box"></div>
      <button class="copy-btn" onclick="copiarPix()">📋 Copiar Código Pix</button>
      <p class="status-wait" id="status-txt">⏳ Aguardando confirmação do pagamento...</p>
    </div>

    <div id="approved-box" class="approved-box">
      <h2>✅ Pagamento Confirmado!</h2>
      <p style="color:#bbf7d0;font-size:14px;margin-bottom:14px">Seu acesso privado já foi liberado automaticamente no chat!</p>
      <a href="${backUrl}" style="display:inline-block;background:#22c55e;color:#052e16;padding:12px 20px;border-radius:10px;font-weight:700;text-decoration:none">Voltar para o Chat 💕</a>
    </div>
  </div>

  <script>
    const channel = ${JSON.stringify(channel)};
    const userId = ${JSON.stringify(userId)};
    const plans = ${JSON.stringify(plans)};
    let selectedPlanId = plans[1]?.id || plans[0]?.id;
    let pollTimer = null;

    function renderPlans() {
      const box = document.getElementById('plans-container');
      box.innerHTML = plans.map(p => \`
        <div class="plan \${p.id === selectedPlanId ? 'active' : ''}" onclick="selectPlan('\${p.id}')">
          \${p.badge ? \`<span class="plan-badge">\${p.badge}</span>\` : ''}
          <div class="plan-top">
            <span class="plan-name">\${p.name}</span>
            <span class="plan-price">R$ \${Number(p.price).toFixed(2).replace('.', ',')}</span>
          </div>
          <div class="plan-desc">\${p.desc || ''}</div>
        </div>
      \`).join('');
    }

    function selectPlan(id) {
      selectedPlanId = id;
      renderPlans();
      document.getElementById('pix-box').style.display = 'none';
      if (pollTimer) clearInterval(pollTimer);
    }

    async function gerarPix() {
      const btn = document.getElementById('gen-btn');
      btn.disabled = true;
      btn.innerText = 'Gerando Pix...';

      try {
        const res = await fetch('/api/checkout/pix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel, userId, planId: selectedPlanId }),
        });
        const data = await res.json();
        if (!data.ok) {
          alert(data.error || 'Erro ao gerar Pix');
          return;
        }

        document.getElementById('pix-title').innerText = \`\${data.plan.name} — R$ \${Number(data.amount).toFixed(2).replace('.', ',')}\`;
        const qrImg = document.getElementById('qr-img');
        if (data.qrCodeBase64) {
          qrImg.src = 'data:image/png;base64,' + data.qrCodeBase64;
          qrImg.style.display = 'block';
        } else {
          qrImg.style.display = 'none';
        }
        document.getElementById('pix-code').innerText = data.qrCode;
        document.getElementById('pix-box').style.display = 'block';

        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(async () => {
          const stRes = await fetch(\`/api/checkout/status/\${data.paymentId}?channel=\${encodeURIComponent(channel)}&userId=\${encodeURIComponent(userId)}\`);
          const st = await stRes.json();
          if (st.approved) {
            clearInterval(pollTimer);
            document.getElementById('pix-box').style.display = 'none';
            document.getElementById('gen-btn').style.display = 'none';
            document.getElementById('plans-container').style.display = 'none';
            document.getElementById('approved-box').style.display = 'block';
          }
        }, 3000);
      } finally {
        btn.disabled = false;
        btn.innerText = 'Gerar Pix Agora';
      }
    }

    function copiarPix() {
      const code = document.getElementById('pix-code').innerText;
      navigator.clipboard.writeText(code);
      const btn = document.querySelector('.copy-btn');
      btn.innerText = '✅ Código Pix Copiado!';
      setTimeout(() => (btn.innerText = '📋 Copiar Código Pix'), 2500);
    }

    renderPlans();
  </script>
</body>
</html>`);
  });
}
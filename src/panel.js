import fs from 'fs';
import os from 'os';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import {
  pool,
  listConversations,
  getConversationMessages,
  saveMessage,
  setAiPaused,
  isAiPaused,
  getBotSettings,
  saveBotSettings,
  trackVitrineEvent,
  getVitrineStats,
  grantChatPass
} from './db.js';
import { sendWhatsAppText } from './whatsapp.js';
import { sendTelegramText } from './telegram.js';
import { sendMessengerText } from './messenger.js';
import { uploadMedia } from './storage.js';

ffmpeg.setFfmpegPath(ffmpegStatic);

function convertAudioBufferToOggOpus(inputBuffer) {
  return new Promise((resolve, reject) => {
    const tmpIn = path.join(os.tmpdir(), `in_${Date.now()}_${Math.random().toString(36).slice(2)}.webm`);
    const tmpOut = path.join(os.tmpdir(), `out_${Date.now()}_${Math.random().toString(36).slice(2)}.ogg`);

    fs.writeFileSync(tmpIn, inputBuffer);

    ffmpeg(tmpIn)
      .noVideo()
      .audioCodec('libopus')
      .audioChannels(1)
      .audioFrequency(48000)
      .audioBitrate('32k')
      .format('ogg')
      .on('end', () => {
        try {
          const oggBuffer = fs.readFileSync(tmpOut);
          fs.unlinkSync(tmpIn);
          fs.unlinkSync(tmpOut);
          resolve(oggBuffer);
        } catch (e) {
          reject(e);
        }
      })
      .on('error', (err) => {
        try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch {}
        try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
        reject(err);
      })
      .save(tmpOut);
  });
}

export function registerPanelRoutes(app) {
  const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin123';

  function checkAuth(req, reply) {
    const auth = req.headers['x-panel-password'] || req.query.pwd;
    if (auth !== PANEL_PASSWORD) {
      reply.status(401).send({ error: 'Senha incorreta' });
      return false;
    }
    return true;
  }

  // Webhook automático do Stripe (checkout.session.completed) para liberar o chat na hora
  app.post('/webhook/stripe', async (req, reply) => {
    try {
      const event = req.body || {};
      if (event.type === 'checkout.session.completed') {
        const ref = event.data?.object?.client_reference_id || '';
        const idx = ref.indexOf('_');
        if (idx > 0) {
          const channel = ref.slice(0, idx);
          const phone = ref.slice(idx + 1);
          const settings = await getBotSettings();
          let hours = 24;
          try {
            if (settings.paywall_config) hours = Number(JSON.parse(settings.paywall_config).hours) || 24;
          } catch {}
          await grantChatPass(channel, phone, hours);
          await setAiPaused(channel, phone, false);
          const confirmMsg = `Payment confirmed babe! 💕 Your private chat is unlocked for ${hours}h. What were we talking about? 😊`;
          if (channel === 'whatsapp') await sendWhatsAppText(phone, confirmMsg);
          if (channel === 'telegram') await sendTelegramText(phone, confirmMsg);
          if (channel === 'messenger') await sendMessengerText(phone, confirmMsg);
          await saveMessage(channel, phone, 'assistant', confirmMsg, 'text', null);
        }
      }
    } catch (e) {
      console.error('[STRIPE WEBHOOK]', e);
    }
    return { received: true };
  });

  // Liberar acesso manualmente pelo celular (1 toque)
  app.post('/api/panel/grant-pass', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const { channel, phone, hours } = req.body || {};
    const h = Number(hours) || 24;
    await grantChatPass(channel, phone, h);
    await setAiPaused(channel, phone, false);
    return { ok: true };
  });

  // Rota pública (CORS liberado) para a vitrine externa carregar foto, capa, @usuario e botões
  app.get('/api/vitrine/config', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    const settings = await getBotSettings();
    let config = null;
    try {
      if (settings.vitrine_config) config = JSON.parse(settings.vitrine_config);
    } catch {}
    return { config };
  });

  // Rota pública (CORS liberado) para a vitrine externa registrar visitas e cliques reais
  app.options('/api/vitrine/track', async (req, reply) => {
    reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'POST, OPTIONS')
      .header('Access-Control-Allow-Headers', 'Content-Type')
      .send();
  });

  app.post('/api/vitrine/track', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const country = req.headers['cf-ipcountry'] || body.country || 'Desconhecido';
    await trackVitrineEvent({
      eventType: body.eventType,
      buttonName: body.buttonName,
      source: body.source,
      country,
      device: body.device,
    });
    return { ok: true };
  });

  // Relatório de cliques reais da vitrine para o /painel
  app.get('/api/panel/analytics', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const stats = await getVitrineStats();
    return { stats };
  });

  // Limpar registros de teste do analítico
  app.post('/api/panel/analytics/reset', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    await pool.query('TRUNCATE TABLE vitrine_analytics RESTART IDENTITY');
    return { ok: true };
  });

  // Listar todas as conversas (WhatsApp, Telegram, Messenger)
  app.get('/api/panel/conversations', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const rows = await listConversations();
    return { conversations: rows };
  });

  // Buscar mensagens de um contato específico
  app.get('/api/panel/messages', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const { channel, phone } = req.query;
    const messages = await getConversationMessages(channel, phone, 150);
    const paused = await isAiPaused(channel, phone);
    return { messages, ai_paused: paused };
  });

  // Pausar ou reativar a IA para um contato
  app.post('/api/panel/toggle-ai', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const { channel, phone, paused } = req.body;
    await setAiPaused(channel, phone, paused);
    return { ok: true, ai_paused: Boolean(paused) };
  });

  // Enviar mensagem manual pelo painel (e pausar IA automaticamente para não atropelar)
  app.post('/api/panel/send', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const { channel, phone, text } = req.body;
    if (!text?.trim()) return reply.status(400).send({ error: 'Mensagem vazia' });

    if (channel === 'whatsapp') {
      await sendWhatsAppText(phone, text);
    } else if (channel === 'telegram') {
      await sendTelegramText(phone, text);
    } else if (channel === 'messenger') {
      await sendMessengerText(phone, text);
    }

    await saveMessage(channel, phone, 'assistant', text, 'text', null);
    await setAiPaused(channel, phone, true);

    return { ok: true };
  });

  // Buscar e salvar links VIP e preços
  app.get('/api/panel/settings', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const settings = await getBotSettings();
    return { settings };
  });

  app.post('/api/panel/settings', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    await saveBotSettings(req.body || {});
    return { ok: true };
  });

  // Upload de mídia pré-gravada (Áudio PTT, Vídeo, Imagem) para o Cloudflare R2
  app.post('/api/panel/upload-media', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const data = await req.file();
    if (!data) return reply.status(400).send({ error: 'Nenhum arquivo enviado' });

    let buffer = await data.toBuffer();
    let mimeType = data.mimetype || 'application/octet-stream';
    let cleanName = data.filename.replace(/[^a-zA-Z0-9._-]/g, '');

    const isAudio =
      mimeType.startsWith('audio/') ||
      mimeType.includes('webm') ||
      /\.(ogg|webm|wav|m4a|opus|mp3)$/i.test(cleanName);

    if (isAudio) {
      buffer = await convertAudioBufferToOggOpus(buffer);
      mimeType = 'audio/ogg';
      cleanName = cleanName.replace(/\.[^.]+$/, '') + '.ogg';
    }

    const fileId = `${Date.now()}_${cleanName}`;
    const url = await uploadMedia(buffer, 'flow_presets', fileId, mimeType);
    return { ok: true, url, mimeType };
  });

  // Salvar e carregar o fluxo visual no PostgreSQL
  app.get('/api/panel/flow', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const settings = await getBotSettings();
    let flow = { nodes: [], edges: [] };
    try {
      if (settings.visual_flow) flow = JSON.parse(settings.visual_flow);
    } catch {}
    return { flow };
  });

  app.post('/api/panel/flow', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    await saveBotSettings({ visual_flow: JSON.stringify(req.body || {}) });
    return { ok: true };
  });

  // Interface Web (/painel)
  app.get('/painel', async (req, reply) => {
    reply.type('text/html; charset=utf-8').send(PANEL_HTML);
  });
}

const PANEL_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Painel CRM - Atendimento</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0b141a; color: #e9edef; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
    
    /* Login & Modais */
    #login-screen, #settings-modal, #analytics-modal, #vitrine-modal, #paywall-modal { position: fixed; inset: 0; background: rgba(11,20,26,0.95); display: flex; align-items: center; justify-content: center; z-index: 999; padding: 16px; }
    #settings-modal, #analytics-modal, #vitrine-modal, #paywall-modal { display: none; overflow-y: auto; }
    .modal-box { background: #202c33; padding: 24px; border-radius: 12px; width: 100%; max-width: 480px; box-shadow: 0 8px 24px rgba(0,0,0,0.45); max-height: 90vh; overflow-y: auto; }
    .modal-box h2 { margin-bottom: 6px; color: #00a884; font-size: 18px; }
    .modal-box p { font-size: 13px; color: #8696a0; margin-bottom: 14px; }
    .modal-box label { display: block; font-size: 12px; color: #aebac1; margin-bottom: 4px; margin-top: 10px; }
    .modal-box input, .modal-box textarea { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a3942; background: #111b21; color: #fff; font-size: 14px; }
    .pwd-wrapper { position: relative; display: flex; align-items: center; }
    .pwd-wrapper input { padding-right: 42px; }
    .pwd-eye { position: absolute; right: 10px; background: none; border: none; color: #8696a0; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 4px; }
    .pwd-eye:hover { color: #00a884; }
    .btn-primary { width: 100%; padding: 12px; border-radius: 8px; border: none; background: #00a884; color: #111b21; font-weight: bold; font-size: 15px; cursor: pointer; margin-top: 16px; }
    .btn-secondary { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #2a3942; background: transparent; color: #8696a0; font-size: 14px; cursor: pointer; margin-top: 8px; }

    /* Analytics Grid */
    .kpi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
    .kpi-card { background: #111b21; padding: 12px; border-radius: 8px; border: 1px solid #2a3942; }
    .kpi-val { font-size: 22px; font-weight: bold; color: #00a884; }
    .kpi-lbl { font-size: 11px; color: #8696a0; margin-top: 2px; }
    .stat-section { margin-top: 14px; }
    .stat-section h4 { font-size: 13px; color: #38bdf8; margin-bottom: 6px; border-bottom: 1px solid #2a3942; padding-bottom: 4px; }
    .stat-row { display: flex; justify-content: space-between; font-size: 13px; padding: 5px 0; border-bottom: 1px solid rgba(42,57,66,0.4); }
    .stat-count { font-weight: bold; color: #25d366; }

    /* App Layout */
    #app { display: flex; height: 100vh; width: 100%; }
    #sidebar { width: 390px; background: #111b21; border-right: 1px solid #2a3942; display: flex; flex-direction: column; }
    .sidebar-header { background: #202c33; padding: 12px 14px; display: flex; justify-content: space-between; align-items: center; gap: 6px; }
    .sidebar-header h3 { font-size: 15px; }
    .header-actions { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
    .nav-pill { background: #005c4b; color: #25d366; border: none; padding: 6px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; text-decoration: none; }
    .nav-pill.blue { background: #1c3d5a; color: #38bdf8; }
    .nav-pill.amber { background: #451a03; color: #fbbf24; }
    .nav-pill.purple { background: #3b2667; color: #c084fc; }
    .nav-pill.pink { background: #500724; color: #f472b6; }
    .filter-bar { display: flex; gap: 6px; padding: 8px 12px; background: #111b21; border-bottom: 1px solid #202c33; overflow-x: auto; }
    .filter-btn { background: #202c33; color: #8696a0; border: none; padding: 6px 12px; border-radius: 16px; font-size: 12px; cursor: pointer; white-space: nowrap; }
    .filter-btn.active { background: #00a884; color: #111b21; font-weight: bold; }
    #conv-list { flex: 1; overflow-y: auto; }
    .conv-item { padding: 12px 16px; border-bottom: 1px solid #202c33; cursor: pointer; display: flex; flex-direction: column; gap: 4px; transition: background 0.15s; }
    .conv-item:hover, .conv-item.active { background: #2a3942; }
    .conv-top { display: flex; justify-content: space-between; align-items: center; }
    .conv-phone { font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; font-weight: bold; }
    .badge-whatsapp { background: #005c4b; color: #25d366; }
    .badge-telegram { background: #1c3d5a; color: #38bdf8; }
    .badge-messenger { background: #3b2667; color: #c084fc; }
    .badge-paused { background: #7f1d1d; color: #fca5a5; }
    .badge-paid { background: #14532d; color: #86efac; }
    .conv-time { font-size: 11px; color: #8696a0; }
    .conv-preview { font-size: 13px; color: #8696a0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* Chat Area */
    #chat-area { flex: 1; display: flex; flex-direction: column; background: #0b141a; }
    #chat-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: #8696a0; flex-direction: column; gap: 8px; padding: 20px; text-align: center; }
    #chat-active { display: none; flex-direction: column; height: 100%; }
    .chat-header { background: #202c33; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #2a3942; gap: 8px; flex-wrap: wrap; }
    .chat-header-left { display: flex; align-items: center; gap: 10px; }
    #back-btn { display: none; background: none; border: none; color: #00a884; font-size: 20px; cursor: pointer; }
    .ai-btn { padding: 8px 10px; border-radius: 8px; border: none; font-size: 12px; font-weight: bold; cursor: pointer; }
    .ai-on { background: #005c4b; color: #25d366; }
    .ai-off { background: #7f1d1d; color: #fca5a5; }
    .pass-btn { background: #1c3d5a; color: #38bdf8; padding: 8px 10px; border-radius: 8px; border: none; font-size: 12px; font-weight: bold; cursor: pointer; }

    #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
    .msg { max-width: 78%; padding: 8px 12px; border-radius: 8px; font-size: 14px; line-height: 1.4; word-wrap: break-word; position: relative; }
    .msg-user { align-self: flex-start; background: #202c33; color: #e9edef; border-top-left-radius: 0; }
    .msg-assistant { align-self: flex-end; background: #005c4b; color: #e9edef; border-top-right-radius: 0; }
    .msg-meta { font-size: 10px; color: #8696a0; text-align: right; margin-top: 4px; }
    .msg img, .msg video { max-width: 100%; border-radius: 6px; margin-bottom: 6px; display: block; }
    .msg audio { max-width: 100%; margin-bottom: 6px; }

    .chat-input-bar { background: #202c33; padding: 10px 14px; display: flex; gap: 10px; align-items: center; }
    .chat-input-bar input { flex: 1; padding: 12px; border-radius: 8px; border: none; background: #2a3942; color: #fff; font-size: 15px; outline: none; }
    .chat-input-bar button { background: #00a884; color: #111b21; border: none; padding: 12px 18px; border-radius: 8px; font-weight: bold; cursor: pointer; }

    @media (max-width: 768px) {
      #sidebar { width: 100%; }
      #chat-area { display: none; width: 100%; }
      body.chat-open #sidebar { display: none; }
      body.chat-open #chat-area { display: flex; }
      #back-btn { display: inline-block; }
    }
  </style>
</head>
<body>

  <div id="login-screen">
    <div class="modal-box" style="text-align:center;">
      <h2>Painel VIP</h2>
      <p>Digite a senha de acesso para acompanhar as conversas</p>
      <div class="pwd-wrapper">
        <input type="password" id="pwd-input" placeholder="Senha do painel" onkeydown="if(event.key==='Enter') login()" />
        <button type="button" class="pwd-eye" onclick="togglePasswordVisibility()" title="Mostrar/ocultar senha" aria-label="Mostrar ou ocultar senha">
          <svg id="eye-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>
      </div>
      <button class="btn-primary" onclick="login()">Entrar</button>
    </div>
  </div>

  <div id="settings-modal">
    <div class="modal-box">
      <h2>Links e Valores VIP</h2>
      <p>Edite aqui e a IA já passa a mandar os links novos na hora.</p>
      <label>Link Canal de Prévias (Telegram)</label>
      <input type="text" id="set-telegram" placeholder="https://t.me/..." />
      <label>Link Fatal Fans (Brasil - R$)</label>
      <input type="text" id="set-fatalfans" placeholder="https://fatalfans.com/..." />
      <label>Valor Brasil (Reais)</label>
      <input type="text" id="set-brl" placeholder="R$ 49,90/mês" />
      <label>Link Fanvue (Gringos - EUR / USD / GBP)</label>
      <input type="text" id="set-fanvue" placeholder="https://fanvue.com/..." />
      <label>Valor Europa (Euros)</label>
      <input type="text" id="set-eur" placeholder="25€/mês" />
      <label>Valor Equador / Panamá (Dólar)</label>
      <input type="text" id="set-usd" placeholder="$25 USD/mês" />
      <label>Valor Reino Unido (Libras)</label>
      <input type="text" id="set-gbp" placeholder="£22/month" />
      <button class="btn-primary" onclick="saveSettings()">Salvar Alterações</button>
      <button class="btn-secondary" onclick="closeSettings()">Fechar</button>
    </div>
  </div>

  <div id="paywall-modal">
    <div class="modal-box">
      <h2>💳 Cobrar para Conversar (Paywall)</h2>
      <p>Configure pelo celular quantas mensagens são grátis antes de exigir pagamento para continuar o chat.</p>

      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;color:#fff;margin-top:8px;">
        <input type="checkbox" id="pw-enabled" style="width:18px;height:18px;" />
        Ativar Paywall no Chat
      </label>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div>
          <label>Msgs grátis p/ lead</label>
          <input type="number" id="pw-free" value="3" min="0" />
        </div>
        <div>
          <label>Horas liberadas após pagar</label>
          <input type="number" id="pw-hours" value="24" min="1" />
        </div>
      </div>

      <label>Link Pagamento Gringa (Stripe US$ 1)</label>
      <input type="text" id="pw-link-intl" placeholder="https://buy.stripe.com/..." />
      <label>Texto Cobrança Gringa (Inglês/Espanhol)</label>
      <textarea id="pw-msg-intl" rows="2" placeholder="Babe, unlock 24h of private chat with me for just $1 💕"></textarea>

      <label>Link Pagamento Brasil (PIX / Checkout R$ 4,90)</label>
      <input type="text" id="pw-link-br" placeholder="https://..." />
      <label>Texto Cobrança Brasil (Português)</label>
      <textarea id="pw-msg-br" rows="2" placeholder="Amor, libera seu acesso privado de 24h por R$ 4,90 para continuarmos 💕"></textarea>

      <button class="btn-primary" onclick="savePaywallConfig()">Salvar Paywall</button>
      <button class="btn-secondary" onclick="closePaywallModal()">Fechar</button>
    </div>
  </div>

  <div id="analytics-modal">
    <div class="modal-box">
      <h2>📊 Cliques e Origem da Vitrine</h2>
      <p>Dados reais em tempo real de visitas e cliques nos botões da sua bio.</p>
      <div id="analytics-content">Carregando...</div>
      <button class="btn-secondary" style="border-color:#7f1d1d;color:#fca5a5;margin-top:14px;" onclick="resetAnalytics()">🗑️ Zerar Contadores (Limpar Testes)</button>
      <button class="btn-secondary" onclick="closeAnalytics()">Fechar</button>
    </div>
  </div>

  <div id="vitrine-modal">
    <div class="modal-box">
      <h2>🎨 Editar Vitrine (Link-in-Bio)</h2>
      <p>Suba a foto de perfil, capa de fundo e edite os botões. Atualiza no ar na hora!</p>

      <label>@Usuário</label>
      <input type="text" id="vit-handle" placeholder="@bellalonguinho" />

      <label>Foto de Perfil (Subir imagem ou colar URL)</label>
      <div style="display:flex;gap:8px;align-items:center;margin-top:4px;">
        <input type="text" id="vit-avatar" placeholder="https://..." style="flex:1;" />
        <label style="background:#1c3d5a;color:#38bdf8;padding:10px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:bold;white-space:nowrap;margin:0;">
          📷 Subir Foto
          <input type="file" accept="image/*" style="display:none;" onchange="uploadVitrineAvatar(event)" />
        </label>
      </div>

      <label>Foto de Fundo / Capa (Opcional)</label>
      <div style="display:flex;gap:8px;align-items:center;margin-top:4px;">
        <input type="text" id="vit-bg" placeholder="https://... (deixe vazio p/ fundo padrão)" style="flex:1;" />
        <label style="background:#1c3d5a;color:#38bdf8;padding:10px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:bold;white-space:nowrap;margin:0;">
          🖼️ Subir Capa
          <input type="file" accept="image/*" style="display:none;" onchange="uploadVitrineBg(event)" />
        </label>
      </div>

      <label style="margin-top:14px;">Botões da Vitrine</label>
      <div id="vit-links-list" style="display:flex;flex-direction:column;gap:8px;margin-top:6px;"></div>
      <button type="button" class="btn-secondary" onclick="addVitrineLinkRow()" style="border-style:dashed;color:#38bdf8;">+ Adicionar Botão</button>

      <button class="btn-primary" onclick="saveVitrineConfig()">Salvar Vitrine</button>
      <button class="btn-secondary" onclick="closeVitrineModal()">Fechar</button>
    </div>
  </div>

  <div id="app">
    <div id="sidebar">
      <div class="sidebar-header">
        <h3>Conversas</h3>
        <div class="header-actions">
          <button class="nav-pill pink" onclick="openPaywallModal()">💳 Paywall</button>
          <button class="nav-pill purple" onclick="openVitrineModal()">🎨 Vitrine</button>
          <button class="nav-pill amber" onclick="openAnalytics()">📊 Cliques</button>
          <a href="/fluxo" class="nav-pill blue">⚡ Fluxos</a>
          <button class="nav-pill" onclick="openSettings()">Links VIP</button>
          <button onclick="logout()" style="background:none;border:none;color:#8696a0;cursor:pointer;font-size:11px;">Sair</button>
        </div>
      </div>
      <div class="filter-bar">
        <button class="filter-btn active" onclick="setFilter('all', this)">Todos</button>
        <button class="filter-btn" onclick="setFilter('whatsapp', this)">WhatsApp</button>
        <button class="filter-btn" onclick="setFilter('telegram', this)">Telegram</button>
        <button class="filter-btn" onclick="setFilter('messenger', this)">Messenger</button>
      </div>
      <div id="conv-list"></div>
    </div>

    <div id="chat-area">
      <div id="chat-empty">
        <p>Selecione uma conversa ao lado ou use o menu acima para configurar o <strong>Paywall</strong>, <strong>Vitrine</strong>, <strong>Cliques</strong>, <strong>Links VIP</strong> e <strong>Fluxos</strong>.</p>
      </div>
      <div id="chat-active">
        <div class="chat-header">
          <div class="chat-header-left">
            <button id="back-btn" onclick="closeChatMobile()">←</button>
            <div>
              <div id="active-phone" style="font-weight:bold;font-size:15px;"></div>
              <div id="active-channel" style="font-size:12px;color:#8696a0;"></div>
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <button class="pass-btn" onclick="grantManualPass()">🔓 Liberar 24h</button>
            <button id="toggle-ai-btn" class="ai-btn ai-on" onclick="toggleAI()">IA Ativa</button>
          </div>
        </div>
        <div id="messages"></div>
        <div class="chat-input-bar">
          <input type="text" id="msg-input" placeholder="Digite uma resposta manual (pausa a IA)..." onkeydown="if(event.key==='Enter') sendManual()" />
          <button onclick="sendManual()">Enviar</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let password = localStorage.getItem('panel_pwd') || '';
    let conversations = [];
    let currentFilter = 'all';
    let selectedChat = null;
    let currentAiPaused = false;
    let vitrineLinksState = [];

    function togglePasswordVisibility() {
      const input = document.getElementById('pwd-input');
      const icon = document.getElementById('eye-icon');
      const isHidden = input.type === 'password';
      input.type = isHidden ? 'text' : 'password';
      icon.innerHTML = isHidden
        ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>'
        : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
    }

    if (password) {
      verifyAndStart();
    }

    async function login() {
      password = document.getElementById('pwd-input').value.trim();
      await verifyAndStart();
    }

    async function verifyAndStart() {
      const res = await fetch('/api/panel/conversations', { headers: { 'x-panel-password': password } });
      if (res.ok) {
        localStorage.setItem('panel_pwd', password);
        document.getElementById('login-screen').style.display = 'none';
        const data = await res.json();
        conversations = data.conversations;
        renderConversations();
        setInterval(refreshAll, 3500);
      } else {
        alert('Senha incorreta');
        localStorage.removeItem('panel_pwd');
      }
    }

    function logout() {
      localStorage.removeItem('panel_pwd');
      location.reload();
    }

    async function openPaywallModal() {
      document.getElementById('paywall-modal').style.display = 'flex';
      const res = await fetch('/api/panel/settings', { headers: { 'x-panel-password': password } });
      if (!res.ok) return;
      const { settings } = await res.json();
      let pw = { enabled: false, freeMessages: 3, hours: 24, linkIntl: '', msgIntl: '', linkBr: '', msgBr: '' };
      try {
        if (settings.paywall_config) pw = { ...pw, ...JSON.parse(settings.paywall_config) };
      } catch {}
      document.getElementById('pw-enabled').checked = Boolean(pw.enabled);
      document.getElementById('pw-free').value = pw.freeMessages ?? 3;
      document.getElementById('pw-hours').value = pw.hours ?? 24;
      document.getElementById('pw-link-intl').value = pw.linkIntl || '';
      document.getElementById('pw-msg-intl').value = pw.msgIntl || '';
      document.getElementById('pw-link-br').value = pw.linkBr || '';
      document.getElementById('pw-msg-br').value = pw.msgBr || '';
    }

    function closePaywallModal() {
      document.getElementById('paywall-modal').style.display = 'none';
    }

    async function savePaywallConfig() {
      const payload = {
        enabled: document.getElementById('pw-enabled').checked,
        freeMessages: Number(document.getElementById('pw-free').value) || 0,
        hours: Number(document.getElementById('pw-hours').value) || 24,
        linkIntl: document.getElementById('pw-link-intl').value.trim(),
        msgIntl: document.getElementById('pw-msg-intl').value.trim(),
        linkBr: document.getElementById('pw-link-br').value.trim(),
        msgBr: document.getElementById('pw-msg-br').value.trim(),
      };
      const res = await fetch('/api/panel/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-panel-password': password },
        body: JSON.stringify({ paywall_config: JSON.stringify(payload) })
      });
      if (res.ok) {
        alert('Configuração do Paywall salva!');
        closePaywallModal();
      }
    }

    async function grantManualPass() {
      if (!selectedChat) return;
      const res = await fetch('/api/panel/grant-pass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-panel-password': password },
        body: JSON.stringify({ channel: selectedChat.channel, phone: selectedChat.phone, hours: 24 })
      });
      if (res.ok) {
        alert('Acesso liberado por 24h e IA reativada para este contato!');
        await refreshAll();
      }
    }

    async function openVitrineModal() {
      document.getElementById('vitrine-modal').style.display = 'flex';
      const res = await fetch('/api/panel/settings', { headers: { 'x-panel-password': password } });
      if (!res.ok) return;
      const { settings } = await res.json();
      let cfg = {
        handle: '@bellalonguinho',
        avatarUrl: '',
        bgUrl: '',
        links: [
          { title: 'FATALFANS 🙈', url: settings.link_fatalfans || '', icon: 'dots' },
          { title: 'PRIVACY / VIP 🥵', url: settings.link_fanvue || '', icon: 'lock' },
          { title: 'PRÉVIAS GRÁTIS (TELEGRAM) ✈️', url: settings.link_telegram || '', icon: 'lock' }
        ]
      };
      try {
        if (settings.vitrine_config) cfg = JSON.parse(settings.vitrine_config);
      } catch {}

      document.getElementById('vit-handle').value = cfg.handle || '';
      document.getElementById('vit-avatar').value = cfg.avatarUrl || '';
      document.getElementById('vit-bg').value = cfg.bgUrl || '';
      vitrineLinksState = Array.isArray(cfg.links) ? cfg.links : [];
      renderVitrineRows();
    }

    function closeVitrineModal() {
      document.getElementById('vitrine-modal').style.display = 'none';
    }

    function renderVitrineRows() {
      const box = document.getElementById('vit-links-list');
      box.innerHTML = vitrineLinksState.map((item, i) => \`
        <div style="background:#111b21;padding:8px;border-radius:8px;border:1px solid #2a3942;display:flex;flex-direction:column;gap:6px;">
          <div style="display:flex;gap:6px;">
            <input type="text" placeholder="Nome do botão" value="\${escapeHtml(item.title)}" oninput="vitrineLinksState[\${i}].title=this.value" style="flex:1;" />
            <select onchange="vitrineLinksState[\${i}].icon=this.value" style="background:#202c33;color:#fff;border:1px solid #2a3942;border-radius:8px;padding:0 8px;font-size:12px;">
              <option value="lock" \${item.icon === 'lock' ? 'selected' : ''}>🔒 Cadeado</option>
              <option value="dots" \${item.icon === 'dots' ? 'selected' : ''}>⋮ Pontinhos</option>
            </select>
            <button type="button" onclick="vitrineLinksState.splice(\${i},1);renderVitrineRows()" style="background:#7f1d1d;color:#fca5a5;border:none;border-radius:6px;padding:0 10px;cursor:pointer;">✕</button>
          </div>
          <input type="text" placeholder="https://..." value="\${escapeHtml(item.url)}" oninput="vitrineLinksState[\${i}].url=this.value" />
        </div>
      \`).join('');
    }

    function addVitrineLinkRow() {
      vitrineLinksState.push({ title: 'NOVO LINK 🔥', url: 'https://', icon: 'lock' });
      renderVitrineRows();
    }

    async function uploadVitrineAvatar(event) {
      const file = event.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/panel/upload-media', {
        method: 'POST',
        headers: { 'x-panel-password': password },
        body: fd
      });
      if (res.ok) {
        const data = await res.json();
        document.getElementById('vit-avatar').value = data.url;
        alert('Foto de perfil enviada com sucesso!');
      } else {
        alert('Erro ao enviar foto.');
      }
    }

    async function uploadVitrineBg(event) {
      const file = event.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/panel/upload-media', {
        method: 'POST',
        headers: { 'x-panel-password': password },
        body: fd
      });
      if (res.ok) {
        const data = await res.json();
        document.getElementById('vit-bg').value = data.url;
        alert('Foto de capa enviada com sucesso!');
      } else {
        alert('Erro ao enviar capa.');
      }
    }

    async function saveVitrineConfig() {
      const payload = {
        handle: document.getElementById('vit-handle').value.trim(),
        avatarUrl: document.getElementById('vit-avatar').value.trim(),
        bgUrl: document.getElementById('vit-bg').value.trim(),
        links: vitrineLinksState.filter(l => l.title && l.url)
      };
      const res = await fetch('/api/panel/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-panel-password': password },
        body: JSON.stringify({ vitrine_config: JSON.stringify(payload) })
      });
      if (res.ok) {
        alert('Vitrine atualizada! Já está valendo no ar.');
        closeVitrineModal();
      }
    }

    async function openAnalytics() {
      document.getElementById('analytics-modal').style.display = 'flex';
      document.getElementById('analytics-content').innerHTML = 'Carregando estatísticas...';
      const res = await fetch('/api/panel/analytics', { headers: { 'x-panel-password': password } });
      if (!res.ok) return;
      const { stats } = await res.json();
      const t = stats.totals || {};

      const renderRows = (arr) =>
        arr && arr.length
          ? arr.map(r => \`<div class="stat-row"><span>\${escapeHtml(r.name)}</span><span class="stat-count">\${r.total}</span></div>\`).join('')
          : '<div style="font-size:12px;color:#8696a0;padding:4px 0;">Nenhum dado registrado ainda.</div>';

      document.getElementById('analytics-content').innerHTML = \`
        <div class="kpi-grid">
          <div class="kpi-card"><div class="kpi-val">\${t.views_24h || 0}</div><div class="kpi-lbl">Visitas (24h) • Total: \${t.total_views || 0}</div></div>
          <div class="kpi-card"><div class="kpi-val">\${t.clicks_24h || 0}</div><div class="kpi-lbl">Cliques (24h) • Total: \${t.total_clicks || 0}</div></div>
        </div>
        <div class="stat-section"><h4>Cliques por Botão</h4>\${renderRows(stats.buttons)}</div>
        <div class="stat-section"><h4>De onde vieram (Origem)</h4>\${renderRows(stats.sources)}</div>
        <div class="stat-section"><h4>Países / Idiomas</h4>\${renderRows(stats.countries)}</div>
      \`;
    }

    async function resetAnalytics() {
      if (!confirm('Tem certeza que deseja zerar todos os contadores de visitas e cliques?')) return;
      const res = await fetch('/api/panel/analytics/reset', {
        method: 'POST',
        headers: { 'x-panel-password': password }
      });
      if (res.ok) {
        await openAnalytics();
      }
    }

    function closeAnalytics() {
      document.getElementById('analytics-modal').style.display = 'none';
    }

    async function openSettings() {
      const res = await fetch('/api/panel/settings', { headers: { 'x-panel-password': password } });
      if (res.ok) {
        const { settings } = await res.json();
        document.getElementById('set-telegram').value = settings.link_telegram || '';
        document.getElementById('set-fatalfans').value = settings.link_fatalfans || '';
        document.getElementById('set-brl').value = settings.price_brl || '';
        document.getElementById('set-fanvue').value = settings.link_fanvue || '';
        document.getElementById('set-eur').value = settings.price_eur || '';
        document.getElementById('set-usd').value = settings.price_usd || '';
        document.getElementById('set-gbp').value = settings.price_gbp || '';
        document.getElementById('settings-modal').style.display = 'flex';
      }
    }

    function closeSettings() {
      document.getElementById('settings-modal').style.display = 'none';
    }

    async function saveSettings() {
      const payload = {
        link_telegram: document.getElementById('set-telegram').value,
        link_fatalfans: document.getElementById('set-fatalfans').value,
        price_brl: document.getElementById('set-brl').value,
        link_fanvue: document.getElementById('set-fanvue').value,
        price_eur: document.getElementById('set-eur').value,
        price_usd: document.getElementById('set-usd').value,
        price_gbp: document.getElementById('set-gbp').value,
      };
      const res = await fetch('/api/panel/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-panel-password': password },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        alert('Links e valores salvos com sucesso!');
        closeSettings();
      }
    }

    function setFilter(filter, btn) {
      currentFilter = filter;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderConversations();
    }

    function formatTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + ' ' + d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    }

    function renderConversations() {
      const list = document.getElementById('conv-list');
      const filtered = currentFilter === 'all' ? conversations : conversations.filter(c => c.channel === currentFilter);
      list.innerHTML = filtered.map(c => {
        const isActive = selectedChat && selectedChat.channel === c.channel && selectedChat.phone === c.phone;
        return \`
          <div class="conv-item \${isActive ? 'active' : ''}" onclick="openChat('\${c.channel}', '\${c.phone}')">
            <div class="conv-top">
              <span class="conv-phone">
                +\${c.phone}
                <span class="badge badge-\${c.channel}">\${c.channel}</span>
                \${c.has_pass ? '<span class="badge badge-paid">VIP Ativo</span>' : ''}
                \${c.ai_paused ? '<span class="badge badge-paused">IA Pausada</span>' : ''}
              </span>
              <span class="conv-time">\${formatTime(c.last_at)}</span>
            </div>
            <div class="conv-preview">\${c.last_role === 'assistant' ? '✓ ' : ''}\${escapeHtml(c.last_message)}</div>
          </div>
        \`;
      }).join('');
    }

    async function openChat(channel, phone) {
      selectedChat = { channel, phone };
      document.body.classList.add('chat-open');
      document.getElementById('chat-empty').style.display = 'none';
      document.getElementById('chat-active').style.display = 'flex';
      document.getElementById('active-phone').textContent = '+' + phone;
      document.getElementById('active-channel').textContent = channel.toUpperCase();
      renderConversations();
      await loadMessages(true);
    }

    function closeChatMobile() {
      document.body.classList.remove('chat-open');
      selectedChat = null;
    }

    async function loadMessages(scrollBottom = false) {
      if (!selectedChat) return;
      const res = await fetch(\`/api/panel/messages?channel=\${selectedChat.channel}&phone=\${selectedChat.phone}\`, {
        headers: { 'x-panel-password': password }
      });
      if (!res.ok) return;
      const data = await res.json();
      currentAiPaused = data.ai_paused;
      updateAiButton();

      const box = document.getElementById('messages');
      const wasAtBottom = box.scrollHeight - box.scrollTop <= box.clientHeight + 80;

      box.innerHTML = data.messages.map(m => {
        let mediaHtml = '';
        if (m.media_url && m.media_type === 'image') mediaHtml = \`<img src="\${m.media_url}" />\`;
        if (m.media_url && m.media_type === 'video') mediaHtml = \`<video src="\${m.media_url}" controls></video>\`;
        if (m.media_url && m.media_type === 'audio') mediaHtml = \`<audio src="\${m.media_url}" controls></audio>\`;

        return \`
          <div class="msg \${m.role === 'user' ? 'msg-user' : 'msg-assistant'}">
            \${mediaHtml}
            <div>\${escapeHtml(m.content).replace(/\\n/g, '<br>')}</div>
            <div class="msg-meta">\${formatTime(m.created_at)}</div>
          </div>
        \`;
      }).join('');

      if (scrollBottom || wasAtBottom) {
        box.scrollTop = box.scrollHeight;
      }
    }

    function updateAiButton() {
      const btn = document.getElementById('toggle-ai-btn');
      if (currentAiPaused) {
        btn.className = 'ai-btn ai-off';
        btn.textContent = 'IA Pausada';
      } else {
        btn.className = 'ai-btn ai-on';
        btn.textContent = 'IA Ativa';
      }
    }

    async function toggleAI() {
      if (!selectedChat) return;
      await fetch('/api/panel/toggle-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-panel-password': password },
        body: JSON.stringify({ channel: selectedChat.channel, phone: selectedChat.phone, paused: !currentAiPaused })
      });
      await refreshAll();
    }

    async function sendManual() {
      if (!selectedChat) return;
      const input = document.getElementById('msg-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';

      await fetch('/api/panel/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-panel-password': password },
        body: JSON.stringify({ channel: selectedChat.channel, phone: selectedChat.phone, text })
      });
      await refreshAll(true);
    }

    async function refreshAll(scrollBottom = false) {
      const res = await fetch('/api/panel/conversations', { headers: { 'x-panel-password': password } });
      if (res.ok) {
        const data = await res.json();
        conversations = data.conversations;
        renderConversations();
      }
      if (selectedChat) {
        await loadMessages(scrollBottom);
      }
    }

    function escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
  </script>
</body>
</html>`;
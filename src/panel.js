import {
  listConversations,
  getConversationMessages,
  saveMessage,
  setAiPaused,
  isAiPaused,
  getBotSettings,
  saveBotSettings
} from './db.js';
import { sendWhatsAppText } from './whatsapp.js';
import { sendTelegramText } from './telegram.js';
import { sendMessengerText } from './messenger.js';
import { uploadMedia } from './storage.js';

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

  // Upload de mídia pré-gravada (Áudio, Vídeo, Imagem) para o Cloudflare R2
  app.post('/api/panel/upload-media', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const data = await req.file();
    if (!data) return reply.status(400).send({ error: 'Nenhum arquivo enviado' });

    const buffer = await data.toBuffer();
    const mimeType = data.mimetype || 'application/octet-stream';
    const fileId = `${Date.now()}_${data.filename.replace(/[^a-zA-Z0-9._-]/g, '')}`;

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
    #login-screen, #settings-modal { position: fixed; inset: 0; background: rgba(11,20,26,0.95); display: flex; align-items: center; justify-content: center; z-index: 999; padding: 16px; }
    #settings-modal { display: none; overflow-y: auto; }
    .modal-box { background: #202c33; padding: 24px; border-radius: 12px; width: 100%; max-width: 420px; box-shadow: 0 8px 24px rgba(0,0,0,0.45); }
    .modal-box h2 { margin-bottom: 6px; color: #00a884; font-size: 18px; }
    .modal-box p { font-size: 13px; color: #8696a0; margin-bottom: 14px; }
    .modal-box label { display: block; font-size: 12px; color: #aebac1; margin-bottom: 4px; margin-top: 10px; }
    .modal-box input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a3942; background: #111b21; color: #fff; font-size: 14px; }
    .btn-primary { width: 100%; padding: 12px; border-radius: 8px; border: none; background: #00a884; color: #111b21; font-weight: bold; font-size: 15px; cursor: pointer; margin-top: 16px; }
    .btn-secondary { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #2a3942; background: transparent; color: #8696a0; font-size: 14px; cursor: pointer; margin-top: 8px; }

    /* App Layout */
    #app { display: flex; height: 100vh; width: 100%; }
    #sidebar { width: 360px; background: #111b21; border-right: 1px solid #2a3942; display: flex; flex-direction: column; }
    .sidebar-header { background: #202c33; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }
    .sidebar-header h3 { font-size: 16px; }
    .header-actions { display: flex; gap: 6px; align-items: center; }
    .nav-pill { background: #005c4b; color: #25d366; border: none; padding: 6px 10px; border-radius: 6px; font-size: 12px; font-weight: bold; cursor: pointer; text-decoration: none; }
    .nav-pill.blue { background: #1c3d5a; color: #38bdf8; }
    .filter-bar { display: flex; gap: 6px; padding: 8px 12px; background: #111b21; border-bottom: 1px solid #202c33; overflow-x: auto; }
    .filter-btn { background: #202c33; color: #8696a0; border: none; padding: 6px 12px; border-radius: 16px; font-size: 12px; cursor: pointer; white-space: nowrap; }
    .filter-btn.active { background: #00a884; color: #111b21; font-weight: bold; }
    #conv-list { flex: 1; overflow-y: auto; }
    .conv-item { padding: 12px 16px; border-bottom: 1px solid #202c33; cursor: pointer; display: flex; flex-direction: column; gap: 4px; transition: background 0.15s; }
    .conv-item:hover, .conv-item.active { background: #2a3942; }
    .conv-top { display: flex; justify-content: space-between; align-items: center; }
    .conv-phone { font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 6px; }
    .badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; font-weight: bold; }
    .badge-whatsapp { background: #005c4b; color: #25d366; }
    .badge-telegram { background: #1c3d5a; color: #38bdf8; }
    .badge-messenger { background: #3b2667; color: #c084fc; }
    .badge-paused { background: #7f1d1d; color: #fca5a5; }
    .conv-time { font-size: 11px; color: #8696a0; }
    .conv-preview { font-size: 13px; color: #8696a0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* Chat Area */
    #chat-area { flex: 1; display: flex; flex-direction: column; background: #0b141a; }
    #chat-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: #8696a0; flex-direction: column; gap: 8px; padding: 20px; text-align: center; }
    #chat-active { display: none; flex-direction: column; height: 100%; }
    .chat-header { background: #202c33; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #2a3942; }
    .chat-header-left { display: flex; align-items: center; gap: 10px; }
    #back-btn { display: none; background: none; border: none; color: #00a884; font-size: 20px; cursor: pointer; }
    .ai-btn { padding: 8px 12px; border-radius: 8px; border: none; font-size: 13px; font-weight: bold; cursor: pointer; }
    .ai-on { background: #005c4b; color: #25d366; }
    .ai-off { background: #7f1d1d; color: #fca5a5; }

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
      <input type="password" id="pwd-input" placeholder="Senha do painel" onkeydown="if(event.key==='Enter') login()" />
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

  <div id="app">
    <div id="sidebar">
      <div class="sidebar-header">
        <h3>Conversas</h3>
        <div class="header-actions">
          <a href="/fluxo" class="nav-pill blue">⚡ Fluxos</a>
          <button class="nav-pill" onclick="openSettings()">Links VIP</button>
          <button onclick="logout()" style="background:none;border:none;color:#8696a0;cursor:pointer;font-size:12px;">Sair</button>
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
        <p>Selecione uma conversa ao lado para visualizar ou use o menu acima para editar <strong>Links VIP</strong> e <strong>Fluxos</strong>.</p>
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
          <button id="toggle-ai-btn" class="ai-btn ai-on" onclick="toggleAI()">IA Ativa</button>
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
        btn.textContent = 'IA Pausada (Clique p/ Ativar)';
      } else {
        btn.className = 'ai-btn ai-on';
        btn.textContent = 'IA Ativa (Clique p/ Pausar)';
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
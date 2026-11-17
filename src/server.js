import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'fs';
import { registerPortalRoutes } from './portalRoutes.js';
import { ensureVipTables, registerVipFeedRoutes } from './vipFeedRoutes.js';
import path from 'path';
import dotenv from 'dotenv';
import {
  pool,
  initDB,
  saveMessage,
  isAiPaused,
  setAiPaused,
  grantChatPass,
  getExpiredUnnotifiedPasses,
  markPassRenewalNotified,
} from './db.js';
import { initPortalDB, approveHighlightOrder } from './portalDb.js';
import { downloadWhatsAppMedia, sendWhatsAppTyping, sendWhatsAppText } from './whatsapp.js';
import { downloadTelegramMedia, sendTelegramText } from './telegram.js';
import { downloadMessengerMedia } from './messenger.js';
import { uploadMedia } from './storage.js';
import { runHybridFlow } from './flowEngine.js';
import { registerPanelRoutes } from './panel.js';
import { registerCheckoutRoutes } from './checkout.js';
import { getMercadoPagoPayment } from './mercadopago.js';

dotenv.config();

const app = Fastify({ logger: true });

// =========================================================================
// BUFFER E ESCUTA ATIVA DE 3 SEGUNDOS (Agrupador de mensagens por cliente)
// =========================================================================
const clientBuffers = new Map();
const clientTimers = new Map();
const processedMpPayments = new Set();

function agendarRespostaIA({ channel, userId, textContent, mediaBuffer, mediaMime, lastMessageId }) {
  const key = `${channel}:${userId}`;
  const atual = clientBuffers.get(key) || {
    textos: [],
    mediaBuffer: null,
    mediaMime: null,
    lastMessageId: null,
  };

  if (textContent) atual.textos.push(textContent);
  if (mediaBuffer) {
    atual.mediaBuffer = mediaBuffer;
    atual.mediaMime = mediaMime;
  }
  if (lastMessageId) {
    atual.lastMessageId = lastMessageId;
  }
  clientBuffers.set(key, atual);

  if (clientTimers.has(key)) {
    clearTimeout(clientTimers.get(key));
  }

  const timer = setTimeout(async () => {
    const pacote = clientBuffers.get(key);
    clientBuffers.delete(key);
    clientTimers.delete(key);

    if (!pacote) return;

    try {
      const mensagemAgrupada = pacote.textos.join('\n');
      await runHybridFlow({
        channel,
        userId,
        userMessage: mensagemAgrupada,
        mediaBuffer: pacote.mediaBuffer,
        mediaMime: pacote.mediaMime,
        lastMessageId: pacote.lastMessageId,
      });
    } catch (err) {
      app.log.error(err, `[Buffer 3s] Erro ao processar resposta para ${key}`);
    }
  }, 3000);

  clientTimers.set(key, timer);
}

app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

// Serve os scripts de proteção anti-print e marcação de celular (device-id)
app.get('/vip-shield.js', async (req, reply) => {
  const code = fs.readFileSync(path.resolve('src/vip-shield.js'), 'utf8');
  return reply.type('application/javascript; charset=utf-8').send(code);
});

app.get('/device-id.js', async (req, reply) => {
  const code = fs.readFileSync(path.resolve('src/device-id.js'), 'utf8');
  return reply.type('application/javascript; charset=utf-8').send(code);
});

// Página inicial neutra (para aprovação de domínio na Meta)
app.get('/', async (req, reply) => {
  return reply.status(200).type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mia Digital Studio - Atendimento Oficial</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; padding: 20px; }
    .card { background: #1e293b; padding: 36px; border-radius: 16px; max-width: 420px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
    h1 { font-size: 22px; margin-bottom: 10px; color: #38bdf8; }
    p { font-size: 15px; color: #94a3b8; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Mia Digital Studio</h1>
    <p>Canal oficial de atendimento e suporte ao cliente.</p>
  </div>
</body>
</html>`);
});

// Rota do Construtor Visual de Fluxos (/fluxo) — Protegida por senha real no servidor
app.get('/fluxo', async (req, reply) => {
  const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin123';
  const pwd = req.query.pwd || req.headers['x-panel-password'];

  if (pwd !== PANEL_PASSWORD) {
    return reply.status(401).type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Acesso Restrito - FlowBuilder</title>
  <style>
    body { background:#0b141a; color:#e9edef; font-family:-apple-system,sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; padding:16px; }
    .box { background:#202c33; padding:24px; border-radius:12px; width:100%; max-width:380px; border:1px solid #2a3942; text-align:center; box-shadow:0 12px 32px rgba(0,0,0,0.55); }
    h2 { color:#00a884; margin-bottom:8px; font-size:18px; }
    p { color:#8696a0; font-size:13px; margin-bottom:14px; }
    input { width:100%; padding:11px; border-radius:8px; border:1px solid #2a3942; background:#111b21; color:#fff; font-size:14px; box-sizing:border-box; }
    input:focus { border-color:#00a884; outline:none; }
    button { width:100%; padding:12px; border-radius:8px; border:none; background:#00a884; color:#111b21; font-weight:bold; font-size:14px; cursor:pointer; margin-top:12px; }
  </style>
</head>
<body>
  <div class="box">
    <h2>🔒 Acesso Restrito - Fluxos</h2>
    <p>${pwd ? '❌ Senha incorreta! Tente novamente.' : 'Digite a senha do painel para abrir o FlowBuilder.'}</p>
    <input type="password" id="p" placeholder="Senha do painel" onkeydown="if(event.key==='Enter') go()" />
    <button onclick="go()">Entrar</button>
  </div>
  <script>
    const saved = localStorage.getItem('panel_pwd');
    if (saved && !location.search.includes('pwd=')) {
      location.href = '/fluxo?pwd=' + encodeURIComponent(saved);
    }
    function go() {
      const v = document.getElementById('p').value.trim();
      if (!v) return;
      localStorage.setItem('panel_pwd', v);
      location.href = '/fluxo?pwd=' + encodeURIComponent(v);
    }
  </script>
</body>
</html>`);
  }

  const htmlPath = path.join(process.cwd(), 'index.html');
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  }
  return reply.status(404).send('Arquivo index.html não encontrado na raiz.');
});

// Registra o Painel CRM (/painel), Checkout Próprio, Portal e Área VIP
registerPanelRoutes(app);
registerCheckoutRoutes(app);
registerPortalRoutes(app);
registerVipFeedRoutes(app);

// Verificação de Webhook (WhatsApp e Messenger)
app.get('/webhook', async (req, reply) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return reply.status(200).send(challenge);
  }
  return reply.status(403).send('Token inválido');
});

// 1. Webhook Meta (WhatsApp + Facebook Messenger)
app.post('/webhook', async (req, reply) => {
  reply.status(200).send('EVENT_RECEIVED');
  const body = req.body;

  try {
    if (body.object === 'whatsapp_business_account') {
      const value = body?.entry?.[0]?.changes?.[0]?.value;

      const echoMsg = value?.message_echoes?.[0];
      if (echoMsg) {
        const customerPhone = echoMsg.to;
        const echoText = echoMsg.text?.body || '[Mídia enviada manualmente pelo celular]';
        await saveMessage('whatsapp', customerPhone, 'assistant', echoText, 'text', null);
        await setAiPaused('whatsapp', customerPhone, true);
        return;
      }

      const message = value?.messages?.[0];
      if (!message) return;

      const from = message.from;
      const messageId = message.id;
      const type = message.type;
      let textContent = '';
      let savedMediaUrl = null;
      let mediaBuffer = null;
      let mediaMime = null;

      if (type === 'text') {
        textContent = message.text.body;
      } else if (['audio', 'image', 'video'].includes(type)) {
        const mediaId = message[type].id;
        const caption = message[type].caption || '';
        const downloaded = await downloadWhatsAppMedia(mediaId);
        mediaBuffer = downloaded.buffer;
        mediaMime = downloaded.mimeType;

        savedMediaUrl = await uploadMedia(mediaBuffer, `whatsapp_${from}`, mediaId, mediaMime);
        textContent = caption ? `[${type}]: ${caption}` : `[Cliente enviou ${type}]`;
      } else {
        return;
      }

      await saveMessage('whatsapp', from, 'user', textContent, type, savedMediaUrl);
      sendWhatsAppTyping(messageId);

      agendarRespostaIA({
        channel: 'whatsapp',
        userId: from,
        textContent,
        mediaBuffer: ['audio', 'image'].includes(type) ? mediaBuffer : null,
        mediaMime: ['audio', 'image'].includes(type) ? mediaMime : null,
        lastMessageId: messageId,
      });
    }

    if (body.object === 'page') {
      const messaging = body?.entry?.[0]?.messaging?.[0];
      if (!messaging?.message || messaging.message.is_echo) return;

      const senderId = messaging.sender.id;
      const msg = messaging.message;
      let textContent = msg.text || '';
      let mediaType = 'text';
      let savedMediaUrl = null;
      let mediaBuffer = null;
      let mediaMime = null;

      if (msg.attachments?.[0]) {
        const att = msg.attachments[0];
        mediaType = att.type;
        const downloaded = await downloadMessengerMedia(att.payload.url);
        mediaBuffer = downloaded.buffer;
        mediaMime = downloaded.mimeType;

        savedMediaUrl = await uploadMedia(mediaBuffer, `messenger_${senderId}`, Date.now(), mediaMime);
        textContent = textContent || `[Cliente enviou ${mediaType}]`;
      }

      if (!textContent && !savedMediaUrl) return;

      await saveMessage('messenger', senderId, 'user', textContent, mediaType, savedMediaUrl);

      if (await isAiPaused('messenger', senderId)) return;

      agendarRespostaIA({
        channel: 'messenger',
        userId: senderId,
        textContent,
        mediaBuffer: ['audio', 'image'].includes(mediaType) ? mediaBuffer : null,
        mediaMime: ['audio', 'image'].includes(mediaType) ? mediaMime : null,
        lastMessageId: null,
      });
    }
  } catch (err) {
    app.log.error(err, 'Erro no webhook Meta');
  }
});

// 2. Webhook Telegram
app.post('/webhook/telegram', async (req, reply) => {
  reply.status(200).send('OK');
  const msg = req.body?.message;
  if (!msg) return;

  try {
    const chatId = msg.chat.id;
    let textContent = msg.text || msg.caption || '';
    let mediaType = 'text';
    let savedMediaUrl = null;
    let mediaBuffer = null;
    let mediaMime = null;

    if (msg.voice || msg.audio) {
      mediaType = 'audio';
      const fileId = (msg.voice || msg.audio).file_id;
      const downloaded = await downloadTelegramMedia(fileId, 'audio/ogg');
      mediaBuffer = downloaded.buffer;
      mediaMime = downloaded.mimeType;
      savedMediaUrl = await uploadMedia(mediaBuffer, `telegram_${chatId}`, fileId, mediaMime);
      textContent = textContent || '[Cliente enviou áudio]';
    } else if (msg.photo) {
      mediaType = 'image';
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const downloaded = await downloadTelegramMedia(fileId, 'image/jpeg');
      mediaBuffer = downloaded.buffer;
      mediaMime = downloaded.mimeType;
      savedMediaUrl = await uploadMedia(mediaBuffer, `telegram_${chatId}`, fileId, mediaMime);
      textContent = textContent || '[Cliente enviou imagem]';
    } else if (msg.video) {
      mediaType = 'video';
      const fileId = msg.video.file_id;
      const downloaded = await downloadTelegramMedia(fileId, 'video/mp4');
      mediaBuffer = downloaded.buffer;
      mediaMime = downloaded.mimeType;
      savedMediaUrl = await uploadMedia(mediaBuffer, `telegram_${chatId}`, fileId, mediaMime);
      textContent = `[Vídeo salvo em ${savedMediaUrl}] ${textContent}`;
    }

    if (!textContent && !savedMediaUrl) return;

    await saveMessage('telegram', chatId, 'user', textContent, mediaType, savedMediaUrl);

    if (await isAiPaused('telegram', chatId)) return;

    agendarRespostaIA({
      channel: 'telegram',
      userId: chatId,
      textContent,
      mediaBuffer: ['audio', 'image'].includes(mediaType) ? mediaBuffer : null,
      mediaMime: ['audio', 'image'].includes(mediaType) ? mediaMime : null,
      lastMessageId: null,
    });
  } catch (err) {
    app.log.error(err, 'Erro no webhook Telegram');
  }
});

// 3. Webhook Mercado Pago (Liberação automática de Pix — Bot + Portal + VIP PPV)
app.post('/webhook/mercadopago', async (req, reply) => {
  reply.status(200).send('OK');

  try {
    const body = req.body || {};
    const query = req.query || {};
    const topic = body.type || body.topic || query.topic || query.type;
    const paymentId = body?.data?.id || query['data.id'] || query.id;

    if (topic !== 'payment' || !paymentId) return;

    const paymentIdStr = String(paymentId);
    if (processedMpPayments.has(paymentIdStr)) return;
    processedMpPayments.add(paymentIdStr);

    const payment = await getMercadoPagoPayment(paymentIdStr);
    if (!payment || payment.status !== 'approved') {
      processedMpPayments.delete(paymentIdStr);
      return;
    }

    const extRef = String(payment.external_reference || '');

    // Caso A: Pagamento de Conteúdo VIP Visualização Única (external_reference = "vip_ppv:unlockId")
    if (extRef.startsWith('vip_ppv:')) {
      const unlockId = Number(extRef.split(':')[1]);
      if (unlockId) {
        await pool.query(`UPDATE ppv_unlocks SET paid = TRUE WHERE id = $1`, [unlockId]);
        app.log.info(`[VIP PPV] ✅ Visualização única #${unlockId} liberada para o dispositivo comprador`);
      }
      return;
    }

    // Caso B: Pagamento de destaque do Portal (external_reference = "portal:orderId")
    if (extRef.startsWith('portal:')) {
      const orderId = Number(extRef.split(':')[1]);
      if (orderId) {
        const order = await approveHighlightOrder(orderId, paymentIdStr);
        if (order) {
          app.log.info(`[Portal] ✅ Destaque #${orderId} (${order.plan_code}) aprovado para criadora #${order.creator_id}`);
        }
      }
      return;
    }

    // Caso C: Pagamento de passe do Chat Bot (external_reference = "channel:userId:hours")
    const [channel, userId, hoursRaw] = extRef.split(':');
    const hours = Number(hoursRaw) || 24;

    if (!channel || !userId) {
      app.log.warn(`[MercadoPago] Pagamento ${paymentIdStr} aprovado sem external_reference válido: ${extRef}`);
      return;
    }

    await grantChatPass(channel, userId, hours);
    app.log.info(`[MercadoPago] ✅ Passe de ${hours}h liberado automaticamente para ${channel}:${userId} (Pagamento ${paymentIdStr})`);

    const unlockMsg = `Amei amor, já caiu aqui pra mim 💕 Nosso chat privado tá 100% liberado por ${hours}h! Agora somos só nós dois... o que você quer ver primeiro? 😈`;
    await saveMessage(channel, userId, 'assistant', unlockMsg, 'text', null);

    if (channel === 'whatsapp') {
      await sendWhatsAppText(userId, unlockMsg);
    } else if (channel === 'telegram') {
      await sendTelegramText(userId, unlockMsg);
    }
  } catch (err) {
    app.log.error(err, '[MercadoPago] Erro ao processar webhook');
  }
});

const start = async () => {
  await initDB();
  await initPortalDB();
  await ensureVipTables();

  // Robô de Renovação Automática: verifica a cada 5 min se algum plano venceu e dispara lembrete com o checkout
  setInterval(async () => {
    try {
      const expired = await getExpiredUnnotifiedPasses();
      const publicBase = (process.env.PUBLIC_URL || 'https://zapjob-production.up.railway.app').replace(/\/$/, '');

      for (const row of expired) {
        await markPassRenewalNotified(row.channel, row.phone);
        const renewUrl = `${publicBase}/checkout?c=${encodeURIComponent(row.channel)}&u=${encodeURIComponent(row.phone)}`;
        const renewMsg = `Oi amor, teu acesso VIP ao meu privado acabou de expirar 😢 Não quero parar nossa conversa agora... escolhe um plano aqui pra renovar na hora (24h, 7 dias ou 30 dias) 💕:\n\n👉 ${renewUrl}`;

        await saveMessage(row.channel, row.phone, 'assistant', renewMsg, 'text', null);

        if (row.channel === 'whatsapp') {
          await sendWhatsAppText(row.phone, renewMsg);
        } else if (row.channel === 'telegram') {
          await sendTelegramText(row.phone, renewMsg);
        }
        app.log.info(`[Renovação] Mensagem de renovação enviada para ${row.channel}:${row.phone}`);
      }
    } catch (err) {
      app.log.error(err, '[Renovação] Erro ao verificar passes expirados');
    }
  }, 5 * 60 * 1000);

  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: '0.0.0.0' });
};

start();
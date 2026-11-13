import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { initDB, saveMessage, isAiPaused, setAiPaused } from './db.js';
import { downloadWhatsAppMedia, sendWhatsAppText } from './whatsapp.js';
import { downloadTelegramMedia, sendTelegramText } from './telegram.js';
import { downloadMessengerMedia, sendMessengerText } from './messenger.js';
import { uploadMedia } from './storage.js';
import { generateAgentReply } from './ai.js';
import { registerPanelRoutes } from './panel.js';

dotenv.config();

const app = Fastify({ logger: true });

// =========================================================================
// BUFFER E ESCUTA ATIVA DE 3 SEGUNDOS (Agrupador de mensagens por cliente)
// =========================================================================
const clientBuffers = new Map();
const clientTimers = new Map();

function agendarRespostaIA({ channel, userId, textContent, mediaBuffer, mediaMime, sendFn }) {
  const key = `${channel}:${userId}`;
  const atual = clientBuffers.get(key) || { textos: [], mediaBuffer: null, mediaMime: null };

  if (textContent) atual.textos.push(textContent);
  if (mediaBuffer) {
    atual.mediaBuffer = mediaBuffer;
    atual.mediaMime = mediaMime;
  }
  clientBuffers.set(key, atual);

  // Reinicia a contagem de 3 segundos sempre que o cliente mandar outra mensagem seguida
  if (clientTimers.has(key)) {
    clearTimeout(clientTimers.get(key));
  }

  const timer = setTimeout(async () => {
    const pacote = clientBuffers.get(key);
    clientBuffers.delete(key);
    clientTimers.delete(key);

    if (!pacote) return;

    try {
      if (await isAiPaused(channel, userId)) return;

      const mensagemAgrupada = pacote.textos.join('\n');
      const aiReply = await generateAgentReply(
        channel,
        userId,
        mensagemAgrupada,
        pacote.mediaBuffer,
        pacote.mediaMime
      );

      if (aiReply) {
        await saveMessage(channel, userId, 'assistant', aiReply, 'text', null);
        await sendFn(userId, aiReply);
      }
    } catch (err) {
      app.log.error(err, `[Buffer 3s] Erro ao processar resposta para ${key}`);
    }
  }, 3000);

  clientTimers.set(key, timer);
}

// Loop de escuta/monitoramento ativo a cada 3 segundos
setInterval(() => {
  if (clientBuffers.size > 0) {
    app.log.debug(`[Escuta 3s] ${clientBuffers.size} conversa(s) aguardando janela de 3s...`);
  }
}, 3000);

// Habilita upload de áudios, fotos e vídeos pré-gravados (até 50MB)
app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

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

// Rota do Construtor Visual de Fluxos (/fluxo)
app.get('/fluxo', async (req, reply) => {
  const htmlPath = path.join(process.cwd(), 'index.html');
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  }
  return reply.status(404).send('Arquivo index.html não encontrado na raiz.');
});

// Registra o Painel CRM (/painel)
registerPanelRoutes(app);

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
    // --- FLUXO WHATSAPP ---
    if (body.object === 'whatsapp_business_account') {
      const value = body?.entry?.[0]?.changes?.[0]?.value;

      // Detecta resposta manual enviada pelo app WhatsApp Business no celular (Coexistência)
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

      if (await isAiPaused('whatsapp', from)) return;

      // Enfileira no buffer de 3 segundos antes de chamar a IA
      agendarRespostaIA({
        channel: 'whatsapp',
        userId: from,
        textContent,
        mediaBuffer: ['audio', 'image'].includes(type) ? mediaBuffer : null,
        mediaMime: ['audio', 'image'].includes(type) ? mediaMime : null,
        sendFn: sendWhatsAppText,
      });
    }

    // --- FLUXO FACEBOOK MESSENGER ---
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
        sendFn: sendMessengerText,
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
      sendFn: sendTelegramText,
    });
  } catch (err) {
    app.log.error(err, 'Erro no webhook Telegram');
  }
});

const start = async () => {
  await initDB();
  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: '0.0.0.0' });
};

start();
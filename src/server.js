import Fastify from 'fastify';
import dotenv from 'dotenv';
import { initDB, saveMessage, isAiPaused } from './db.js';
import { downloadWhatsAppMedia, sendWhatsAppText } from './whatsapp.js';
import { downloadTelegramMedia, sendTelegramText } from './telegram.js';
import { downloadMessengerMedia, sendMessengerText } from './messenger.js';
import { uploadMedia } from './storage.js';
import { generateAgentReply } from './ai.js';
import { registerPanelRoutes } from './panel.js';

dotenv.config();

const app = Fastify({ logger: true });

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
      const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
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

      // Se a IA estiver pausada manualmente no painel, não responde automático
      if (await isAiPaused('whatsapp', from)) return;

      const aiReply = await generateAgentReply(
        'whatsapp',
        from,
        textContent,
        ['audio', 'image'].includes(type) ? mediaBuffer : null,
        ['audio', 'image'].includes(type) ? mediaMime : null
      );

      await saveMessage('whatsapp', from, 'assistant', aiReply, 'text', null);
      await sendWhatsAppText(from, aiReply);
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

      const aiReply = await generateAgentReply(
        'messenger',
        senderId,
        textContent,
        ['audio', 'image'].includes(mediaType) ? mediaBuffer : null,
        ['audio', 'image'].includes(mediaType) ? mediaMime : null
      );

      await saveMessage('messenger', senderId, 'assistant', aiReply, 'text', null);
      await sendMessengerText(senderId, aiReply);
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

    const aiReply = await generateAgentReply(
      'telegram',
      chatId,
      textContent,
      ['audio', 'image'].includes(mediaType) ? mediaBuffer : null,
      ['audio', 'image'].includes(mediaType) ? mediaMime : null
    );

    await saveMessage('telegram', chatId, 'assistant', aiReply, 'text', null);
    await sendTelegramText(chatId, aiReply);
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
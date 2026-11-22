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

async function uploadWhatsAppProfilePhotoHandle(token, buffer, mimeType) {
  const debugRes = await fetch(`https://graph.facebook.com/v21.0/debug_token?input_token=${encodeURIComponent(token)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const debugData = await debugRes.json();
  const appId = debugData?.data?.app_id || 'app';

  const sessionRes = await fetch(
    `https://graph.facebook.com/v21.0/${appId}/uploads?file_length=${buffer.length}&file_type=${encodeURIComponent(mimeType)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  const sessionData = await sessionRes.json();
  if (!sessionData?.id) {
    throw new Error(sessionData?.error?.message || 'Falha ao iniciar sessão de upload na Meta');
  }

  const uploadRes = await fetch(`https://graph.facebook.com/v21.0/${sessionData.id}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${token}`,
      file_offset: '0',
      'Content-Type': mimeType
    },
    body: buffer
  });
  const uploadData = await uploadRes.json();
  if (!uploadData?.h) {
    throw new Error(uploadData?.error?.message || 'Falha ao enviar bytes da foto para a Meta');
  }
  return uploadData.h;
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

  // Buscar perfil atual do WhatsApp Cloud API
  app.get('/api/panel/whatsapp-profile', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const token = process.env.WHATSAPP_TOKEN || process.env.META_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID || process.env.PHONE_NUMBER_ID;
    if (!token || !phoneId) {
      return reply.status(400).send({ error: 'WHATSAPP_TOKEN ou WHATSAPP_PHONE_ID não configurados no Railway' });
    }
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${phoneId}/whatsapp_business_profile?fields=about,description,websites,profile_picture_url`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    const profile = data?.data?.[0] || {};
    return { ok: true, profile };
  });

  // Atualizar foto de perfil, recado ("Sobre") e site do WhatsApp Cloud API direto pelo celular
  app.post('/api/panel/whatsapp-profile', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const token = process.env.WHATSAPP_TOKEN || process.env.META_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID || process.env.PHONE_NUMBER_ID;
    if (!token || !phoneId) {
      return reply.status(400).send({ error: 'WHATSAPP_TOKEN ou WHATSAPP_PHONE_ID não configurados no Railway' });
    }

    try {
      let about = '';
      let website = '';
      let photoBuffer = null;
      let photoMime = 'image/jpeg';

      if (req.isMultipart()) {
        const parts = req.parts();
        for await (const part of parts) {
          if (part.type === 'file') {
            photoBuffer = await part.toBuffer();
            photoMime = part.mimetype || 'image/jpeg';
          } else if (part.fieldname === 'about') {
            about = String(part.value || '').trim();
          } else if (part.fieldname === 'website') {
            website = String(part.value || '').trim();
          }
        }
      } else {
        const body = req.body || {};
        about = String(body.about || '').trim();
        website = String(body.website || '').trim();
      }

      const payload = { messaging_product: 'whatsapp' };
      if (about) payload.about = about;
      if (website) payload.websites = [website];

      if (photoBuffer && photoBuffer.length > 0) {
        const handle = await uploadWhatsAppProfilePhotoHandle(token, photoBuffer, photoMime);
        payload.profile_picture_handle = handle;
      }

      const updateRes = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/whatsapp_business_profile`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const updateData = await updateRes.json();
      if (!updateRes.ok || updateData?.error) {
        return reply.status(400).send({ error: updateData?.error?.message || 'Erro ao atualizar perfil na Meta' });
      }
      return { ok: true };
    } catch (err) {
      console.error('[WA PROFILE]', err);
      return reply.status(500).send({ error: err.message || 'Erro interno ao atualizar perfil' });
    }
  });

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

  // Gerar legenda quente com Gemini para o post de prévia no Telegram
  app.post('/api/panel/telegram-preview/caption', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const { contextHint = '', mood = 'provocante' } = req.body || {};
    const geminiKey = process.env.GEMINI_API_KEY;

    const fallbackCaptions = [
      'Acabei de tirar essa foto e não consegui guardar só pra mim... 🔥 Vem ver o que ficou de fora no VIP.',
      'Olhando assim você já imagina o que tem lá no privado... 😈 Corre antes que eu apague.',
      'Bastidores de hoje à noite tá pegando fogo... 💋 Quem quer a versão completa?',
    ];

    if (geminiKey) {
      try {
        const prompt = `Escreva 1 legenda curta, quente e provocante em português para postar junto com uma foto em um canal/grupo de prévias no Telegram.
Tom: ${mood}.
${contextHint ? `Contexto da foto: ${contextHint}.` : ''}
Use no máximo 2 frases, inclua 1 ou 2 emojis sensuais e termine com um gancho para o VIP sem parecer spam. Responda APENAS o texto da legenda.`;

        const aiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
            }),
          }
        );
        const aiData = await aiRes.json();
        const text = aiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) return { ok: true, caption: text.replace(/^["']|["']$/g, '') };
      } catch {}
    }

    const pick = fallbackCaptions[Math.floor(Math.random() * fallbackCaptions.length)];
    return { ok: true, caption: pick };
  });

  // Upload da foto e envio direto com legenda para o grupo/canal de prévias do Telegram
  app.post('/api/panel/telegram-preview/send', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return reply.status(400).send({ error: 'TELEGRAM_BOT_TOKEN não configurado no Railway.' });
    }

    try {
      let chatId = '';
      let caption = '';
      let photoBuffer = null;
      let photoMime = 'image/jpeg';
      let filename = 'previa.jpg';

      if (req.isMultipart()) {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            photoBuffer = await part.toBuffer();
            photoMime = part.mimetype || 'image/jpeg';
            filename = part.filename || 'previa.jpg';
          } else if (part.fieldname === 'chatId') {
            chatId = String(part.value || '').trim();
          } else if (part.fieldname === 'caption') {
            caption = String(part.value || '').trim();
          }
        }
      } else {
        const body = req.body || {};
        chatId = String(body.chatId || '').trim();
        caption = String(body.caption || '').trim();
      }

      if (!chatId) {
        return reply.status(400).send({ error: 'Informe o ID ou @canal do grupo de prévias no Telegram.' });
      }
      if (!photoBuffer || photoBuffer.length === 0) {
        return reply.status(400).send({ error: 'Selecione uma foto para enviar.' });
      }

      try {
        const cleanName = filename.replace(/[^a-zA-Z0-9._-]/g, '');
        await uploadMedia(photoBuffer, 'telegram_previews', `${Date.now()}_${cleanName}`, photoMime);
      } catch {}

      const form = new FormData();
      form.append('chat_id', chatId);
      if (caption) form.append('caption', caption);
      form.append('photo', new Blob([photoBuffer], { type: photoMime }), filename);

      const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST',
        body: form,
      });
      const tgData = await tgRes.json();

      if (!tgRes.ok || !tgData.ok) {
        return reply.status(400).send({
          error: tgData?.description || 'Falha ao enviar foto no Telegram. Verifique se o bot está no grupo/canal.',
        });
      }

      return { ok: true, messageId: tgData.result?.message_id };
    } catch (err) {
      console.error('[TG PREVIEW SEND]', err);
      return reply.status(500).send({ error: err.message || 'Erro ao enviar prévia no Telegram.' });
    }
  });

  // Interface Web (/painel) carregada de public/painel.html
  app.get('/painel', async (req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'painel.html');
    const html = fs.readFileSync(filePath, 'utf-8');
    return reply.type('text/html; charset=utf-8').send(html);
  });
}
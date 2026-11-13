import axios from 'axios';
import FormData from 'form-data';

const META_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID;
const GRAPH_URL = 'https://graph.facebook.com/v21.0';

const authHeaders = () => ({
  Authorization: `Bearer ${META_TOKEN}`,
  'Content-Type': 'application/json',
});

export async function downloadWhatsAppMedia(mediaId) {
  const metaRes = await axios.get(`${GRAPH_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${META_TOKEN}` },
  });

  const { url, mime_type } = metaRes.data;

  const fileRes = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${META_TOKEN}` },
  });

  return {
    buffer: Buffer.from(fileRes.data),
    mimeType: mime_type,
  };
}

// Marca como lida e ativa o indicador "digitando..." no WhatsApp do cliente
export async function sendWhatsAppTyping(messageId) {
  if (!messageId) return;
  try {
    await axios.post(
      `${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: {
          type: 'text',
        },
      },
      { headers: authHeaders() }
    );
  } catch (err) {
    console.warn('[WhatsApp] Aviso ao enviar typing_indicator:', err?.response?.data || err.message);
  }
}

export async function sendWhatsAppText(to, text) {
  await axios.post(
    `${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    },
    { headers: authHeaders() }
  );
}

// Baixa a mídia do R2, faz upload direto para a Meta (POST /media) e envia pelo media_id
export async function sendWhatsAppMedia(to, mediaUrl, mediaKind = null) {
  let type = mediaKind;
  if (!type) {
    if (/\.(ogg|mp3|wav|m4a|opus|webm)(\?|$)/i.test(mediaUrl)) type = 'audio';
    else if (/\.(mp4|mov|avi)(\?|$)/i.test(mediaUrl)) type = 'video';
    else type = 'image';
  }

  // 1. Baixa o arquivo do link R2
  const fileRes = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(fileRes.data);
  let contentType = fileRes.headers['content-type'] || '';

  // Ajusta MIME types exigidos pela Cloud API do WhatsApp
  if (type === 'audio') {
    contentType = /\.mp3(\?|$)/i.test(mediaUrl) || contentType.includes('mpeg') ? 'audio/mpeg' : 'audio/ogg';
  } else if (type === 'video' && (!contentType || contentType.includes('octet-stream'))) {
    contentType = 'video/mp4';
  } else if (type === 'image' && (!contentType || contentType.includes('octet-stream'))) {
    contentType = 'image/jpeg';
  }

  const ext = type === 'audio' ? (contentType === 'audio/mpeg' ? 'mp3' : 'ogg') : type === 'video' ? 'mp4' : 'jpg';

  // 2. Faz upload direto para os servidores da Meta para obter o media_id
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', buffer, {
    filename: `midia_${Date.now()}.${ext}`,
    contentType,
  });

  const uploadRes = await axios.post(`${GRAPH_URL}/${PHONE_NUMBER_ID}/media`, form, {
    headers: {
      Authorization: `Bearer ${META_TOKEN}`,
      ...form.getHeaders(),
    },
  });

  const mediaId = uploadRes.data?.id;
  if (!mediaId) {
    throw new Error('Falha ao obter media_id da Meta no upload');
  }

  // 3. Dispara a mensagem no WhatsApp usando o media_id oficial
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type,
    [type]: {
      id: mediaId,
    },
  };

  await axios.post(`${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`, payload, {
    headers: authHeaders(),
  });
}
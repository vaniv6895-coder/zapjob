import axios from 'axios';

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

// Envia áudio (nota de voz), vídeo ou imagem a partir do link público do Cloudflare R2
export async function sendWhatsAppMedia(to, mediaUrl, mediaKind = null) {
  let type = mediaKind;
  if (!type) {
    if (/\.(ogg|mp3|wav|m4a|opus|webm)(\?|$)/i.test(mediaUrl)) type = 'audio';
    else if (/\.(mp4|mov|avi)(\?|$)/i.test(mediaUrl)) type = 'video';
    else type = 'image';
  }

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type,
    [type]: {
      link: mediaUrl,
    },
  };

  await axios.post(`${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`, payload, {
    headers: authHeaders(),
  });
}
import axios from 'axios';

const META_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID;
const GRAPH_URL = 'https://graph.facebook.com/v21.0';

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

export async function sendWhatsAppText(to, text) {
  await axios.post(
    `${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${META_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}
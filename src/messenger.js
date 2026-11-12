import axios from 'axios';

const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN;
const GRAPH_URL = 'https://graph.facebook.com/v21.0';

export async function downloadMessengerMedia(attachmentUrl) {
  const fileRes = await axios.get(attachmentUrl, {
    responseType: 'arraybuffer',
  });

  return {
    buffer: Buffer.from(fileRes.data),
    mimeType: fileRes.headers['content-type'] || 'application/octet-stream',
  };
}

export async function sendMessengerText(recipientId, text) {
  await axios.post(
    `${GRAPH_URL}/me/messages?access_token=${PAGE_TOKEN}`,
    {
      recipient: { id: recipientId },
      message: { text },
    }
  );
}
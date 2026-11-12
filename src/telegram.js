import axios from 'axios';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

export async function downloadTelegramMedia(fileId, defaultMime) {
  const fileInfo = await axios.get(`${TG_API}/getFile?file_id=${fileId}`);
  const filePath = fileInfo.data.result.file_path;

  const fileRes = await axios.get(`https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`, {
    responseType: 'arraybuffer',
  });

  return {
    buffer: Buffer.from(fileRes.data),
    mimeType: defaultMime,
  };
}

export async function sendTelegramText(chatId, text) {
  await axios.post(`${TG_API}/sendMessage`, {
    chat_id: chatId,
    text,
  });
}
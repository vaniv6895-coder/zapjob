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

// Exibe "digitando..." ou "gravando áudio..." no topo do chat do Telegram
export async function sendTelegramAction(chatId, action = 'typing') {
  try {
    await axios.post(`${TG_API}/sendChatAction`, {
      chat_id: chatId,
      action, // 'typing', 'record_voice', 'upload_photo', 'upload_video'
    });
  } catch (err) {
    console.warn('[Telegram] Falha ao enviar sendChatAction:', err?.response?.data || err.message);
  }
}

export async function sendTelegramText(chatId, text) {
  if (!text?.trim()) return;
  await axios.post(`${TG_API}/sendMessage`, {
    chat_id: chatId,
    text,
  });
}

// Envia áudio (nota de voz), foto ou vídeo nativamente a partir da URL do R2 (com legenda opcional para agendamentos)
export async function sendTelegramMedia(chatId, url, kind = 'image', caption = '') {
  if (!url?.startsWith('http')) return;

  if (kind === 'audio') {
    await sendTelegramAction(chatId, 'record_voice');
    // sendVoice exibe a barrinha de onda sonora como áudio gravado na hora;
    // se o formato for mp3 longo e falhar no sendVoice, faz fallback automático para sendAudio
    try {
      await axios.post(`${TG_API}/sendVoice`, {
        chat_id: chatId,
        voice: url,
        ...(caption ? { caption } : {}),
      });
    } catch {
      await axios.post(`${TG_API}/sendAudio`, {
        chat_id: chatId,
        audio: url,
        ...(caption ? { caption } : {}),
      });
    }
    return;
  }

  if (kind === 'video') {
    await sendTelegramAction(chatId, 'upload_video');
    await axios.post(`${TG_API}/sendVideo`, {
      chat_id: chatId,
      video: url,
      ...(caption ? { caption } : {}),
    });
    return;
  }

  await sendTelegramAction(chatId, 'upload_photo');
  await axios.post(`${TG_API}/sendPhoto`, {
    chat_id: chatId,
    photo: url,
    ...(caption ? { caption } : {}),
  });
}
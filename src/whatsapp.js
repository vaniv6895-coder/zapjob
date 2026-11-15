import axios from 'axios';
import FormData from 'form-data';
import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const META_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID;
const GRAPH_URL = 'https://graph.facebook.com/v21.0';

const authHeaders = () => ({
  Authorization: `Bearer ${META_TOKEN}`,
  'Content-Type': 'application/json',
});

function convertAudioToOggOpus(inputBuffer) {
  return new Promise(async (resolve, reject) => {
    const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tmpIn = path.join(os.tmpdir(), `in_${uid}.audio`);
    const tmpOut = path.join(os.tmpdir(), `out_${uid}.ogg`);

    try {
      await fs.writeFile(tmpIn, inputBuffer);
      execFile(
        ffmpegPath,
        ['-y', '-i', tmpIn, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', tmpOut],
        async (err) => {
          try {
            if (err) return reject(err);
            const oggBuffer = await fs.readFile(tmpOut);
            resolve(oggBuffer);
          } catch (readErr) {
            reject(readErr);
          } finally {
            fs.unlink(tmpIn).catch(() => {});
            fs.unlink(tmpOut).catch(() => {});
          }
        }
      );
    } catch (writeErr) {
      reject(writeErr);
    }
  });
}

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

export async function sendWhatsAppTyping(messageId, indicatorType = 'text') {
  if (!messageId) return;
  try {
    await axios.post(
      `${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: {
          type: indicatorType === 'audio' ? 'audio' : 'text',
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

export async function sendWhatsAppMedia(to, mediaUrl, mediaKind = null) {
  let type = mediaKind;
  if (!type) {
    if (/\.(ogg|mp3|wav|m4a|opus|webm)(\?|$)/i.test(mediaUrl)) type = 'audio';
    else if (/\.(mp4|mov|avi)(\?|$)/i.test(mediaUrl)) type = 'video';
    else type = 'image';
  }

  const fileRes = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
  let buffer = Buffer.from(fileRes.data);
  let contentType = fileRes.headers['content-type'] || '';
  let ext = 'jpg';

  if (type === 'audio') {
    // Converte qualquer áudio (MP3, WAV, M4A, OGG) para OGG/Opus 48kHz mono nativo do WhatsApp PTT
    buffer = await convertAudioToOggOpus(buffer);
    contentType = 'audio/ogg; codecs=opus';
    ext = 'ogg';
  } else if (type === 'video') {
    if (!contentType || contentType.includes('octet-stream')) contentType = 'video/mp4';
    ext = 'mp4';
  } else {
    if (!contentType || contentType.includes('octet-stream')) contentType = 'image/jpeg';
    ext = 'jpg';
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', buffer, {
    filename: `voice_${Date.now()}.${ext}`,
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

  const mediaObject = { id: mediaId };
  if (type === 'audio') {
    mediaObject.voice = true;
  }

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type,
    [type]: mediaObject,
  };

  await axios.post(`${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`, payload, {
    headers: authHeaders(),
  });
}
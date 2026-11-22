import { pool, getBotSettings, getMemory, saveMessage, isAiPaused } from './db.js';
import { getCreatorById, listCreatorMedia } from './portalDb.js';
import { sendWhatsAppText, sendWhatsAppMedia, sendWhatsAppTyping } from './whatsapp.js';
import { sendTelegramText, sendTelegramMedia, sendTelegramAction } from './telegram.js';
import { sendMessengerText } from './messenger.js';
import { generateAgentReply } from './ai.js';
import { listR2MediaCatalog } from './storage.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanMediaUrl(url = '') {
  return String(url || '')
    .trim()
    .replace(/(\.mp4|\.mov|\.avi|\.m4v|\.jpg|\.jpeg|\.png|\.webp)(\1)+(?=$|\?)/i, '$1');
}

function detectMediaKind(url, declaredKind) {
  if (declaredKind === 'video' || declaredKind === 'audio' || declaredKind === 'image') {
    return declaredKind;
  }
  if (/\.(ogg|mp3|wav|m4a|opus|webm)(\?|$)/i.test(url)) return 'audio';
  if (/\.(mp4|mov|avi|m4v)(\?|$)/i.test(url)) return 'video';
  return 'image';
}

function normalizeTextForDedupe(str = '') {
  return String(str || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function extractOfferSignature(str = '') {
  const s = String(str || '');
  const pixMatch = s.match(/000201[0-9a-zA-Z@._-]+/);
  const urlMatch = s.match(/https?:\/\/[^\s)]+/i);
  const pixPart = pixMatch ? pixMatch[0].slice(0, 48) : '';
  const urlPart = urlMatch ? urlMatch[0].toLowerCase() : '';
  if (!pixPart && !urlPart) return '';
  return `${pixPart}|${urlPart}`;
}

function isDuplicateAssistantText(cleanText, assistantHistory = []) {
  const normNew = normalizeTextForDedupe(cleanText);
  if (!normNew) return true;

  const newOfferSig = extractOfferSignature(cleanText);
  const recentAssistantMsgs = assistantHistory.slice(-6);

  for (const prev of recentAssistantMsgs) {
    const prevText = String(prev?.content || '');
    const normPrev = normalizeTextForDedupe(prevText);

    if (normPrev && normPrev === normNew) {
      return true;
    }

    if (newOfferSig) {
      const prevOfferSig = extractOfferSignature(prevText);
      if (prevOfferSig && prevOfferSig === newOfferSig) {
        return true;
      }
    }
  }

  return false;
}

function isPhotoRequest(text = '') {
  return /\b(foto|fotos|imagem|imagens|pic|pics|photo|manda uma foto|me manda foto|cad[eê] a foto|mostra)\b/i.test(
    String(text || '')
  );
}

function detectClientLanguage(text, userId, history = []) {
  const t = (text || '').toLowerCase();
  const phone = String(userId || '').replace(/\D/g, '');

  if (phone.startsWith('55')) return 'PT_BR';
  if (phone.startsWith('351')) return 'PT_EU';
  if (/^(49|43|41)/.test(phone)) return 'DE';
  if (/^(34|593|507|52|54|57|56|51|58|591|595|598|506|503|502|504|505)/.test(phone)) return 'ES';
  if (/^(1|44|61|64|353)/.test(phone)) return 'EN';

  if (
    /\b(hallo|guten tag|guten abend|servus|moin|wie gehts|wie geht's|schön|hübsch|preis|wie viel|woher|deutschland|österreich|schweiz|bild|fotos|sprachnachricht|stimme)\b/i.test(t) ||
    /[äöüß]/i.test(t)
  ) {
    return 'DE';
  }

  if (
    /\b(oi+|ol[aá]|tudo bem|td bem|bom dia|boa tarde|boa noite|linda|gata|gira|fixe|quanto|valor|pre[cç]o|voc[eê]|vc|tu|de onde|telem[oó]vel|[aá]udio|v[ií]deo|cad[eê]|manda|quero|sim|n[aã]o)\b/i.test(t) ||
    /[çãõêôâ]/i.test(t)
  ) {
    if (/\b(fixe|gira|telem[oó]vel|portugal|lisboa|porto)\b/i.test(t)) return 'PT_EU';
    return 'PT_BR';
  }

  if (
    /\b(hola|buenas|quetal|qué tal|como estas|cómo estás|guapa|hermosa|cuanto|cuánto|precio|de donde|de dónde|españa|ecuador|panama|panamá|mexico|méxico|colombia|chile|argentina|peru|perú)\b/i.test(t) ||
    /[¿¡ñ]/i.test(t)
  ) {
    return 'ES';
  }

  if (
    /\b(hi+|hello|hey|how are you|what's up|whats up|beautiful|gorgeous|cute|how much|price|where are you from|link|pic|pics|photo|video|voice)\b/i.test(t)
  ) {
    return 'EN';
  }

  const pastText = history.map((m) => m.content || '').join(' ');
  if (/\b(voc[eê]|oi|ol[aá]|tudo bem|kkkk)\b/i.test(pastText)) return 'PT_BR';
  if (/\b(hola|jajaja|guapa)\b/i.test(pastText)) return 'ES';
  if (/\b(hello|hi|babe|haha)\b/i.test(pastText)) return 'EN';
  if (/\b(hallo|süßer)\b/i.test(pastText)) return 'DE';

  return 'PT_BR';
}

function isLanguageMatch(nodeLang, clientLang) {
  if (!nodeLang || nodeLang === 'ALL') return true;
  if (nodeLang === clientLang) return true;
  if (nodeLang === 'PT' && (clientLang === 'PT_BR' || clientLang === 'PT_EU')) return true;
  return false;
}

function extractFlowVideos(flow, sentUrlsSet, clientLang) {
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const videos = [];

  for (const n of nodes) {
    if (n.type !== 'media' || typeof n.text !== 'string' || !n.text.trim().startsWith('http')) continue;
    const url = cleanMediaUrl(n.text);
    if (!url || sentUrlsSet.has(url)) continue;

    const kind = detectMediaKind(url, n.mediaKind);
    if (kind !== 'video') continue;

    const lang = n.mediaLang || 'ALL';
    if (!isLanguageMatch(lang, clientLang)) continue;

    videos.push({ url, kind, lang });
  }

  return videos;
}

// Busca sempre a mídia mais recente subida pelo celular (Galeria do Bot -> Perfil da Modelo)
async function resolveLatestBotOrCreatorMedia(creatorId, sentUrlsSet, preferredType = null) {
  // 1. Primeiro olha a galeria direta do bot (bot_active_media), ordenada do mais novo para o mais antigo
  try {
    const params = [];
    let where = 'WHERE active = TRUE';
    if (preferredType) {
      params.push(preferredType);
      where += ` AND media_type = $1`;
    }
    const res = await pool.query(
      `SELECT media_type, public_url
       FROM bot_active_media
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT 20`,
      params
    );
    for (const row of res.rows) {
      const url = cleanMediaUrl(row.public_url || '');
      if (url.startsWith('http') && !sentUrlsSet.has(url)) {
        return url;
      }
    }
  } catch (err) {
    console.warn('[FlowEngine] Erro ao ler bot_active_media:', err.message);
  }

  // 2. Depois olha a galeria da modelo vinculada (ou a modelo mais recente cadastrada)
  let targetCreatorId = creatorId;
  if (!targetCreatorId) {
    try {
      const cRes = await pool.query(`SELECT id FROM creator_accounts ORDER BY id DESC LIMIT 1`);
      targetCreatorId = cRes.rows[0]?.id || null;
    } catch {}
  }

  if (targetCreatorId) {
    try {
      const mediaItems = await listCreatorMedia(targetCreatorId, true);
      if (Array.isArray(mediaItems) && mediaItems.length > 0) {
        for (const item of mediaItems) {
          const kind = item?.media_type || detectMediaKind(item?.public_url || '');
          if (preferredType && kind !== preferredType) continue;
          const url = cleanMediaUrl(item?.public_url || '');
          if (url.startsWith('http') && !sentUrlsSet.has(url)) {
            return url;
          }
        }
      }
    } catch (err) {
      console.warn('[FlowEngine] Erro ao buscar vídeos da galeria da modelo:', err.message);
    }

    try {
      const creator = await getCreatorById(targetCreatorId);
      const verVideo = cleanMediaUrl(creator?.verification_video_url || '');
      if ((!preferredType || preferredType === 'video') && verVideo.startsWith('http') && !sentUrlsSet.has(verVideo)) {
        return verVideo;
      }
    } catch (err) {
      console.warn('[FlowEngine] Erro ao buscar verification_video_url da modelo:', err.message);
    }
  }

  return null;
}

async function sendTypingIndicator(channel, userId, lastMessageId, kind = 'text') {
  if (channel === 'whatsapp' && lastMessageId) {
    await sendWhatsAppTyping(lastMessageId, kind === 'audio' ? 'audio' : 'text');
  } else if (channel === 'telegram') {
    const actionMap = { audio: 'record_voice', video: 'upload_video', image: 'upload_photo', text: 'typing' };
    await sendTelegramAction(userId, actionMap[kind] || 'typing');
  }
}

async function sendChannelText(channel, userId, text) {
  if (!text?.trim()) return;
  if (channel === 'whatsapp') await sendWhatsAppText(userId, text);
  else if (channel === 'telegram') await sendTelegramText(userId, text);
  else if (channel === 'messenger') await sendMessengerText(userId, text);
}

async function sendChannelMedia(channel, userId, url, kind, caption = '') {
  const cleanUrl = cleanMediaUrl(url);
  if (!cleanUrl?.startsWith('http')) return;
  if (channel === 'whatsapp') {
    await sendWhatsAppMedia(userId, cleanUrl, kind);
  } else if (channel === 'telegram') {
    await sendTelegramMedia(userId, cleanUrl, kind, caption);
  } else if (channel === 'messenger') {
    await sendMessengerText(userId, cleanUrl);
  }
}

export async function runHybridFlow({ channel, userId, userMessage, mediaBuffer, mediaMime, lastMessageId }) {
  const [settings, aiPaused, audioCatalog] = await Promise.all([
    getBotSettings(),
    isAiPaused(channel, userId),
    listR2MediaCatalog('audiozabe/'),
  ]);

  let flow = { nodes: [], edges: [] };
  try {
    if (settings.visual_flow) {
      flow =
        typeof settings.visual_flow === 'string'
          ? JSON.parse(settings.visual_flow)
          : settings.visual_flow;
    }
  } catch (err) {
    console.warn('[FlowEngine] Erro ao ler visual_flow:', err.message);
  }

  const history = await getMemory(channel, userId, 60);
  const assistantMessages = history.filter((m) => m.role === 'assistant');
  const assistantAlreadyReplied = assistantMessages.length > 0;
  const isFirstContact = !assistantAlreadyReplied;
  const userMsgCount = history.filter((m) => m.role === 'user').length;
  const clientLang = detectClientLanguage(userMessage, userId, history);

  const sentUrls = new Set();
  for (const msg of history) {
    if (msg.media_url) {
      const cleaned = cleanMediaUrl(msg.media_url);
      if (cleaned) sentUrls.add(cleaned);
    }
    const tagMatch = String(msg.content || '').match(/\[ENVIAR_MIDIA:(https?:\/\/[^\]]+)\]/i);
    if (tagMatch) {
      const cleanedTagUrl = cleanMediaUrl(tagMatch[1]);
      if (cleanedTagUrl) sentUrls.add(cleanedTagUrl);
    }
  }

  const welcomeTranscripts = {
    PT_BR: 'Oi lindo, que bom que você me chamou aqui no privado. Tava mesmo precisando de uma companhia legal hoje pra conversar. Me fala, de onde você é?',
    PT_EU: 'Olá lindo, que bom que me chamaste aqui no privado. Estava mesmo a precisar de uma companhia gira hoje para conversar. Diz-me, de onde és?',
    ES: 'Hola lindo, qué bueno que me escribiste aquí al privado. Justo estaba necesitando una buena compañía hoy para conversar. Dime, ¿de dónde eres?',
    EN: 'Hey handsome, so glad you messaged me privately here. I was really needing some good company to chat with today. Tell me, where are you from?',
    DE: 'Hey Süßer, wie schön dass du mir hier privat schreibst. Ich habe heute wirklich nette Gesellschaft zum Quatschen gebraucht. Sag mal, woher kommst du?',
  };

  if (isFirstContact) {
    const r2Welcome =
      audioCatalog.find((item) => item.kind === 'audio' && item.lang === clientLang && item.isWelcome) ||
      audioCatalog.find((item) => item.kind === 'audio' && item.lang === clientLang);

    if (r2Welcome && !sentUrls.has(cleanMediaUrl(r2Welcome.url))) {
      try {
        const welcomeUrl = cleanMediaUrl(r2Welcome.url);
        await sendTypingIndicator(channel, userId, lastMessageId, 'audio');
        await sleep(3200);
        await sendChannelMedia(channel, userId, welcomeUrl, 'audio');
        const spokenText = welcomeTranscripts[clientLang] || welcomeTranscripts.PT_BR;
        await saveMessage(channel, userId, 'assistant', spokenText, 'audio', welcomeUrl);
        return;
      } catch (err) {
        console.error('[FlowEngine] Erro ao enviar boas-vindas do R2:', err?.response?.data || err.message);
      }
    }
  }

  if (aiPaused) return;

  const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
  const sentAudioLastTurn = Boolean(lastAssistantMsg && lastAssistantMsg.media_type === 'audio');

  await sendTypingIndicator(channel, userId, lastMessageId, 'text');

  const langLabels = {
    PT_BR: 'Português do Brasil (PT-BR)',
    PT_EU: 'Português de Portugal (PT-PT)',
    ES: 'Espanhol (ES)',
    EN: 'Inglês (EN)',
    DE: 'Alemão (DE)',
  };
  const humanLang = langLabels[clientLang] || clientLang;

  const contextualMessage = `${userMessage}\n\n[IDIOMA DETECTADO DO CLIENTE: ${humanLang}]`;
  const rawAiReply = await generateAgentReply(channel, userId, contextualMessage, mediaBuffer, mediaMime);

  if (rawAiReply) {
    const mediaRegex = /\[ENVIAR_MIDIA:\s*(https?:\/\/[^\]\s]+)\s*\]/gi;
    const mediaUrls = [];
    let match;
    while ((match = mediaRegex.exec(rawAiReply)) !== null) {
      const foundUrl = cleanMediaUrl(match[1]);
      // Ignora links antigos da pasta previa/ para não atropelar a mídia nova subida pelo celular
      if (foundUrl && !foundUrl.includes('/previa/') && !sentUrls.has(foundUrl) && !mediaUrls.includes(foundUrl)) {
        mediaUrls.push(foundUrl);
      }
    }

    const creatorId = settings?.active_creator_id || settings?.creator_id || null;

    if (mediaUrls.length === 0 && userMsgCount >= 2 && !sentAudioLastTurn) {
      const preferredType = isPhotoRequest(userMessage) ? 'image' : null;
      const latestMedia =
        (await resolveLatestBotOrCreatorMedia(creatorId, sentUrls, preferredType)) ||
        (await resolveLatestBotOrCreatorMedia(creatorId, sentUrls, null));

      if (latestMedia) {
        mediaUrls.push(latestMedia);
      } else {
        const availableFlowVideos = extractFlowVideos(flow, sentUrls, clientLang);
        if (availableFlowVideos.length > 0) {
          mediaUrls.push(cleanMediaUrl(availableFlowVideos[availableFlowVideos.length - 1].url));
        }
      }
    }

    let cleanText = rawAiReply.replace(mediaRegex, '').trim();

    if (cleanText && isDuplicateAssistantText(cleanText, assistantMessages)) {
      if (isPhotoRequest(userMessage) && mediaUrls.length === 0) {
        cleanText = 'As fotos completas e os ensaios ficam lá dentro do meu acesso VIP, bem mais à vontade pra você ver tudo sem pressa 😉 Dá uma olhada no link que te mandei.';
      } else {
        cleanText = '';
      }
    }

    if (cleanText && !isDuplicateAssistantText(cleanText, assistantMessages)) {
      await sendTypingIndicator(channel, userId, lastMessageId, 'text');
      await sleep(1600);
      await saveMessage(channel, userId, 'assistant', cleanText, 'text', null);
      await sendChannelText(channel, userId, cleanText);
      assistantMessages.push({ role: 'assistant', content: cleanText, media_type: 'text' });
    }

    const urlToSend = mediaUrls.find((u) => !sentUrls.has(cleanMediaUrl(u)));
    if (urlToSend) {
      const cleanUrl = cleanMediaUrl(urlToSend);
      const kind = detectMediaKind(cleanUrl);
      if (kind === 'audio' && sentAudioLastTurn) return;

      try {
        console.log(`[FlowEngine] Enviando ${kind} atualizado para ${userId}: ${cleanUrl}`);
        await sendTypingIndicator(channel, userId, lastMessageId, kind);
        await sleep(kind === 'audio' ? 3500 : 1800);
        await sendChannelMedia(channel, userId, cleanUrl, kind);
        await saveMessage(channel, userId, 'assistant', `[${kind} enviado]`, kind, cleanUrl);
        sentUrls.add(cleanUrl);
      } catch (mediaErr) {
        console.error('[FlowEngine] Erro ao enviar mídia:', mediaErr?.response?.data || mediaErr.message);
      }
    }
  }
}
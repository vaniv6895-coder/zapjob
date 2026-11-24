import { getBotSettings, getMemory, saveMessage, isAiPaused } from './db.js';
import { sendWhatsAppText, sendWhatsAppMedia, sendWhatsAppTyping } from './whatsapp.js';
import { sendTelegramText, sendTelegramMedia, sendTelegramAction } from './telegram.js';
import { sendMessengerText } from './messenger.js';
import { generateAgentReply } from './ai.js';
import { listR2MediaCatalog } from './storage.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanMediaUrl(url = '') {
  return String(url || '').trim();
}

function detectMediaKind(url, declaredKind) {
  if (declaredKind === 'video' || declaredKind === 'audio' || declaredKind === 'image') {
    return declaredKind;
  }
  if (/\.(ogg|mp3|wav|m4a|opus)(\?|$)/i.test(url)) return 'audio';
  if (/\.(mp4|mov|avi|m4v|webm)(\?|$)/i.test(url)) return 'video';
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

function isMediaTriggerRequest(text = '') {
  return /\b(v[ií]deo|videos|foto|fotos|imagem|imagens|pic|pics|photo|manda|me manda|cad[eê]|mostra|pr[eé]via|previas|ver)\b/i.test(
    String(text || '')
  );
}

function isPhotoRequest(text = '') {
  return /\b(foto|fotos|imagem|imagens|pic|pics|photo)\b/i.test(String(text || ''));
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

function pickFlowMedia(flow, sentUrlsSet, clientLang, { preferPhoto = false, allowRepeatIfOnlyOne = false } = {}) {
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const allMediaNodes = [];

  for (const n of nodes) {
    if (n.type !== 'media' || typeof n.text !== 'string') continue;
    const url = cleanMediaUrl(n.text);
    if (!url.startsWith('http')) continue;

    const kind = detectMediaKind(url, n.mediaKind);
    if (kind === 'audio') continue;

    const lang = n.mediaLang || 'ALL';
    if (!isLanguageMatch(lang, clientLang)) continue;

    allMediaNodes.push({ url, kind, lang });
  }

  if (allMediaNodes.length === 0) return null;

  const targetKind = preferPhoto ? 'image' : 'video';
  let typedPool = allMediaNodes.filter((m) => m.kind === targetKind);
  if (typedPool.length === 0) {
    typedPool = allMediaNodes;
  }

  const unsent = typedPool.filter((m) => !sentUrlsSet.has(m.url));
  if (unsent.length > 0) {
    return unsent[unsent.length - 1];
  }

  if (allowRepeatIfOnlyOne && typedPool.length > 0) {
    return typedPool[typedPool.length - 1];
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
  const isFirstContact = assistantMessages.length === 0;
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
  const explicitMediaAsk = isMediaTriggerRequest(userMessage);

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

  const sentThisTurn = new Set();

  function isAlreadySent(url) {
    const clean = cleanMediaUrl(url);
    return !clean || sentUrls.has(clean) || sentThisTurn.has(clean);
  }

  let selectedMedia = null;
  let cleanText = '';

  if (rawAiReply) {
    const mediaRegex = /\[ENVIAR_MIDIA:\s*(https?:\/\/[^\]\s]+)\s*\]/gi;
    const tagMatches = [...rawAiReply.matchAll(mediaRegex)];
    cleanText = rawAiReply.replace(mediaRegex, '').trim();

    for (const m of tagMatches) {
      const candidateUrl = cleanMediaUrl(m[1]);
      if (candidateUrl && !isAlreadySent(candidateUrl)) {
        selectedMedia = {
          url: candidateUrl,
          kind: detectMediaKind(candidateUrl, null),
          lang: clientLang,
        };
        break;
      }
    }

    if (cleanText && isDuplicateAssistantText(cleanText, assistantMessages)) {
      cleanText = '';
    }

    if (cleanText) {
      await sendTypingIndicator(channel, userId, lastMessageId, 'text');
      await sleep(1400);
      await saveMessage(channel, userId, 'assistant', cleanText, 'text', null);
      await sendChannelText(channel, userId, cleanText);
      assistantMessages.push({ role: 'assistant', content: cleanText, media_type: 'text' });
    }
  }

  if (!selectedMedia && (explicitMediaAsk || (userMsgCount >= 2 && !sentAudioLastTurn))) {
    selectedMedia = pickFlowMedia(flow, sentUrls, clientLang, {
      preferPhoto: isPhotoRequest(userMessage),
      allowRepeatIfOnlyOne: false,
    });

    if (!selectedMedia && Array.isArray(flow?.nodes)) {
      const anyMediaNode = [...flow.nodes]
        .reverse()
        .find((n) => {
          if (n.type !== 'media' || typeof n.text !== 'string') return false;
          const u = cleanMediaUrl(n.text);
          if (!u.startsWith('http') || isAlreadySent(u)) return false;
          const k = detectMediaKind(u, n.mediaKind);
          return k === 'video' || k === 'image';
        });

      if (anyMediaNode) {
        const cleanU = cleanMediaUrl(anyMediaNode.text);
        selectedMedia = {
          url: cleanU,
          kind: detectMediaKind(cleanU, anyMediaNode.mediaKind),
          lang: anyMediaNode.mediaLang || 'ALL',
        };
      }
    }
  }

  if (selectedMedia && selectedMedia.url && !isAlreadySent(selectedMedia.url)) {
    try {
      const targetUrl = cleanMediaUrl(selectedMedia.url);
      sentThisTurn.add(targetUrl);
      console.log(`[FlowEngine] Enviando ${selectedMedia.kind} único para ${userId}: ${targetUrl}`);
      await sendTypingIndicator(channel, userId, lastMessageId, selectedMedia.kind);
      await sleep(1500);
      await sendChannelMedia(channel, userId, targetUrl, selectedMedia.kind);
      await saveMessage(channel, userId, 'assistant', `[${selectedMedia.kind} enviado]`, selectedMedia.kind, targetUrl);
      sentUrls.add(targetUrl);
    } catch (mediaErr) {
      console.error('[FlowEngine] Erro ao enviar mídia do fluxo:', mediaErr?.response?.data || mediaErr?.data || mediaErr.message);
    }
  }
}
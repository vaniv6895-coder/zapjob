import { getBotSettings, getMemory, saveMessage, isAiPaused } from './db.js';
import { sendWhatsAppText, sendWhatsAppMedia, sendWhatsAppTyping } from './whatsapp.js';
import { sendTelegramText, sendTelegramMedia, sendTelegramAction } from './telegram.js';
import { sendMessengerText } from './messenger.js';
import { generateAgentReply } from './ai.js';
import { listR2MediaCatalog } from './storage.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function detectMediaKind(url, declaredKind) {
  if (declaredKind) return declaredKind;
  if (/\.(ogg|mp3|wav|m4a|opus|webm)(\?|$)/i.test(url)) return 'audio';
  if (/\.(mp4|mov|avi)(\?|$)/i.test(url)) return 'video';
  return 'image';
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
  if (!url?.startsWith('http')) return;
  if (channel === 'whatsapp') {
    await sendWhatsAppMedia(userId, url, kind);
  } else if (channel === 'telegram') {
    await sendTelegramMedia(userId, url, kind, caption);
  } else if (channel === 'messenger') {
    await sendMessengerText(userId, url);
  }
}

export async function runHybridFlow({ channel, userId, userMessage, mediaBuffer, mediaMime, lastMessageId }) {
  const [settings, aiPaused, r2Catalog] = await Promise.all([
    getBotSettings(),
    isAiPaused(channel, userId),
    listR2MediaCatalog('audiozabe/'),
  ]);

  let flow = { nodes: [], edges: [] };
  try {
    if (settings.visual_flow) {
      flow = JSON.parse(settings.visual_flow);
    }
  } catch (err) {
    console.warn('[FlowEngine] Erro ao ler visual_flow:', err.message);
  }

  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const edges = Array.isArray(flow.edges) ? flow.edges : [];

  const history = await getMemory(channel, userId, 60);
  const assistantAlreadyReplied = history.some((m) => m.role === 'assistant');
  const isFirstContact = !assistantAlreadyReplied;
  const clientLang = detectClientLanguage(userMessage, userId, history);

  const sentUrls = new Set();
  for (const msg of history) {
    if (msg.media_url) sentUrls.add(msg.media_url.trim());
    const tagMatch = String(msg.content || '').match(/\[ENVIAR_MIDIA:(https?:\/\/[^\]]+)\]/i);
    if (tagMatch) sentUrls.add(tagMatch[1].trim());
  }

  console.log(`[FlowEngine] Usuário: ${userId} | 1º Contato: ${isFirstContact} | Idioma: ${clientLang} | R2 Itens: ${r2Catalog.length}`);

  const welcomeTranscripts = {
    PT_BR: 'Oi lindo, que bom que você me chamou aqui no privado. Tava mesmo precisando de uma companhia legal hoje pra conversar. Me fala, de onde você é?',
    PT_EU: 'Olá lindo, que bom que me chamaste aqui no privado. Estava mesmo a precisar de uma companhia gira hoje para conversar. Diz-me, de onde és?',
    ES: 'Hola lindo, qué bueno que me escribiste aquí al privado. Justo estaba necesitando una buena compañía hoy para conversar. Dime, ¿de dónde eres?',
    EN: 'Hey handsome, so glad you messaged me privately here. I was really needing some good company to chat with today. Tell me, where are you from?',
    DE: 'Hey Süßer, wie schön dass du mir hier privat schreibst. Ich habe heute wirklich nette Gesellschaft zum Quatschen gebraucht. Sag mal, woher kommst du?',
  };

  // REGRA 1: No 1º contato, dispara APENAS o Áudio 01 de boas-vindas do R2 e PARA (espera o cliente responder!)
  if (isFirstContact) {
    const r2Welcome =
      r2Catalog.find((item) => item.kind === 'audio' && item.lang === clientLang && item.isWelcome) ||
      r2Catalog.find((item) => item.kind === 'audio' && item.lang === clientLang);

    if (r2Welcome) {
      try {
        console.log(`[FlowEngine] 1º contato -> Enviando SOMENTE Áudio 01 (${clientLang}): ${r2Welcome.url}`);
        await sendTypingIndicator(channel, userId, lastMessageId, 'audio');
        await sleep(3200);
        await sendChannelMedia(channel, userId, r2Welcome.url, 'audio');
        const spokenText = welcomeTranscripts[clientLang] || welcomeTranscripts.PT_BR;
        await saveMessage(channel, userId, 'assistant', spokenText, 'audio', r2Welcome.url);
        return; // Encerra o turno aqui para esperar a resposta do cliente!
      } catch (err) {
        console.error('[FlowEngine] Erro ao enviar boas-vindas do R2:', err?.response?.data || err.message);
      }
    }
  }

  if (aiPaused) return;

  // Verifica se o bot acabou de enviar um áudio na última mensagem (evita metralhar áudios seguidos)
  const assistantMessages = history.filter((m) => m.role === 'assistant');
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
      const foundUrl = match[1].trim();
      if (!sentUrls.has(foundUrl)) {
        mediaUrls.push(foundUrl);
      }
    }

    const cleanText = rawAiReply.replace(mediaRegex, '').trim();

    if (cleanText) {
      await sendTypingIndicator(channel, userId, lastMessageId, 'text');
      await sleep(1600);
      await saveMessage(channel, userId, 'assistant', cleanText, 'text', null);
      await sendChannelText(channel, userId, cleanText);
    }

    // Envia no máximo 1 mídia por turno, e bloqueia áudio se acabou de mandar áudio no turno anterior
    const urlToSend = mediaUrls[0];
    if (urlToSend) {
      const kind = detectMediaKind(urlToSend);
      if (kind === 'audio' && sentAudioLastTurn) {
        console.log('[FlowEngine] Áudio segurado neste turno para não atropelar a conversa.');
        return;
      }

      try {
        console.log(`[FlowEngine] Enviando ${kind} contextual para ${userId}: ${urlToSend}`);
        await sendTypingIndicator(channel, userId, lastMessageId, kind);
        await sleep(kind === 'audio' ? 3500 : 1800);
        await sendChannelMedia(channel, userId, urlToSend, kind);
        await saveMessage(channel, userId, 'assistant', `[${kind} enviado]`, kind, urlToSend);
        sentUrls.add(urlToSend);
      } catch (mediaErr) {
        console.error('[FlowEngine] Erro ao enviar mídia:', mediaErr?.response?.data || mediaErr.message);
      }
    }
  }
}
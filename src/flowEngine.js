import { getBotSettings, getMemory, saveMessage, isAiPaused } from './db.js';
import { sendWhatsAppText, sendWhatsAppMedia, sendWhatsAppTyping } from './whatsapp.js';
import { sendTelegramText, sendTelegramMedia, sendTelegramAction } from './telegram.js';
import { sendMessengerText } from './messenger.js';
import { generateAgentReply } from './ai.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function detectMediaKind(url, declaredKind) {
  if (declaredKind) return declaredKind;
  if (/\.(ogg|mp3|wav|m4a|opus|webm)(\?|$)/i.test(url)) return 'audio';
  if (/\.(mp4|mov|avi)(\?|$)/i.test(url)) return 'video';
  return 'image';
}

// Detecta o idioma/região do cliente (PT_BR, PT_EU, ES, EN, DE) pelo texto, DDI e histórico
function detectClientLanguage(text, userId, history = []) {
  const t = (text || '').toLowerCase();
  const phone = String(userId || '').replace(/\D/g, '');

  // Prioridade máxima para DDI do WhatsApp (evita trocar idioma no meio da conversa)
  if (phone.startsWith('55')) return 'PT_BR';
  if (phone.startsWith('351')) return 'PT_EU';
  if (/^(49|43|41)/.test(phone)) return 'DE';
  if (/^(34|593|507|52|54|57|56|51|58|591|595|598|506|503|502|504|505)/.test(phone)) return 'ES';
  if (/^(1|44|61|64|353)/.test(phone)) return 'EN';

  // 1. Alemão (DE)
  if (
    /\b(hallo|guten tag|guten abend|servus|moin|wie gehts|wie geht's|schön|hübsch|preis|wie viel|woher|deutschland|österreich|schweiz|bild|fotos|sprachnachricht|stimme)\b/i.test(t) ||
    /[äöüß]/i.test(t)
  ) {
    return 'DE';
  }

  // 2. Português (checado ANTES do Espanhol para palavras com acento como "áudio", "vídeo", "você", "está")
  if (
    /\b(oi+|ol[aá]|tudo bem|td bem|bom dia|boa tarde|boa noite|linda|gata|gira|fixe|quanto|valor|pre[cç]o|voc[eê]|vc|tu|de onde|telem[oó]vel|[aá]udio|v[ií]deo|cad[eê]|manda|quero|sim|n[aã]o)\b/i.test(t) ||
    /[çãõêôâ]/i.test(t)
  ) {
    if (/\b(fixe|gira|telem[oó]vel|portugal|lisboa|porto)\b/i.test(t)) {
      return 'PT_EU';
    }
    return 'PT_BR';
  }

  // 3. Espanhol (ES)
  if (
    /\b(hola|buenas|quetal|qué tal|como estas|cómo estás|guapa|hermosa|cuanto|cuánto|precio|de donde|de dónde|españa|ecuador|panama|panamá|mexico|méxico|colombia|chile|argentina|peru|perú)\b/i.test(t) ||
    /[¿¡ñ]/i.test(t)
  ) {
    return 'ES';
  }

  // 4. Inglês (EN)
  if (
    /\b(hi+|hello|hey|how are you|what's up|whats up|beautiful|gorgeous|cute|how much|price|where are you from|link|pic|pics|photo|video|voice)\b/i.test(t)
  ) {
    return 'EN';
  }

  // 5. Se mandou só "ok" ou emoji, mantém o idioma já usado no histórico
  const pastText = history.map((m) => m.content || '').join(' ');
  if (/\b(voc[eê]|oi|ol[aá]|tudo bem|kkkk)\b/i.test(pastText)) return 'PT_BR';
  if (/\b(hola|jajaja|guapa)\b/i.test(pastText)) return 'ES';
  if (/\b(hello|hi|babe|haha)\b/i.test(pastText)) return 'EN';
  if (/\b(hallo|süßer)\b/i.test(pastText)) return 'DE';

  return 'PT_BR';
}

// Compatibilidade caso algum nó antigo ainda esteja salvo como 'PT' genérico
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
  const [settings, aiPaused] = await Promise.all([
    getBotSettings(),
    isAiPaused(channel, userId),
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

  console.log(`[FlowEngine] Usuário: ${userId} | 1º Contato: ${isFirstContact} | Idioma: ${clientLang} | IA Pausada: ${aiPaused}`);

  const getNextNodes = (nodeId) =>
    edges
      .filter((e) => e.from === nodeId)
      .map((e) => nodes.find((n) => n.id === e.to))
      .filter(Boolean);

  const msgLower = (userMessage || '').toLowerCase();
  const matchedCondition = nodes.find((n) => {
    if (n.type !== 'condition' || !n.text) return false;
    const rawKeywords = n.text.replace(/^cont[eé]m:\s*/i, '');
    const keywords = rawKeywords
      .split(/[,;|]/)
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    return keywords.some((kw) => msgLower.includes(kw));
  });

  let startNode = null;
  if (matchedCondition) {
    startNode = matchedCondition;
  } else if (aiPaused || isFirstContact) {
    startNode = nodes.find((n) => n.type === 'trigger') || null;
  }

  const executedFlowSummary = [];
  let reachedAiNode = false;
  let aiExtraInstruction = '';
  let sentMediaInThisTurn = false;

  if (startNode) {
    const visited = new Set([startNode.id]);
    let queue = getNextNodes(startNode.id);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current.id)) continue;
      visited.add(current.id);

      if (current.type === 'delay') {
        const secs = Math.min(15, Math.max(1, Number(current.text) || 3));
        await sendTypingIndicator(channel, userId, lastMessageId, 'text');
        await sleep(secs * 1000);
      } else if (current.type === 'message' && current.text?.trim()) {
        await sendTypingIndicator(channel, userId, lastMessageId, 'text');
        await sleep(1500);
        await sendChannelText(channel, userId, current.text.trim());
        await saveMessage(channel, userId, 'assistant', current.text.trim(), 'text', null);
        executedFlowSummary.push(`Você enviou a mensagem: "${current.text.trim()}"`);
      } else if (current.type === 'media' && current.text?.trim().startsWith('http')) {
        if (!isLanguageMatch(current.mediaLang, clientLang)) {
          const nexts = getNextNodes(current.id);
          queue.push(...nexts);
          continue;
        }

        const url = current.text.trim();
        const kind = detectMediaKind(url, current.mediaKind);
        try {
          console.log(`[FlowEngine] Enviando ${kind} (${clientLang}) do fluxo para ${userId}: ${url}`);
          await sendTypingIndicator(channel, userId, lastMessageId, kind);
          await sleep(kind === 'audio' ? 3500 : 1800);
          await sendChannelMedia(channel, userId, url, kind);
          await saveMessage(channel, userId, 'assistant', `[${kind} enviado pelo fluxo]`, kind, url);
          sentUrls.add(url);
          executedFlowSummary.push(`Você enviou um(a) ${kind} (${url}) ao cliente.`);
          sentMediaInThisTurn = true;
        } catch (mediaErr) {
          console.error('[FlowEngine] Erro ao enviar mídia do fluxo:', mediaErr?.response?.data || mediaErr.message);
        }
      } else if (current.type === 'ai') {
        reachedAiNode = true;
        aiExtraInstruction = current.text || '';
        break;
      }

      const nexts = getNextNodes(current.id);
      queue.push(...nexts);
    }
  }

  // GATILHO AUTOMÁTICO DE BOAS-VINDAS POR IDIOMA NO 1º CONTATO
  if (isFirstContact && !sentMediaInThisTurn) {
    const welcomeAudio = nodes.find((n) => {
      if (n.type !== 'media' || !n.text?.trim().startsWith('http')) return false;
      const kind = detectMediaKind(n.text.trim(), n.mediaKind);
      if (kind !== 'audio') return false;
      const matchesLang = isLanguageMatch(n.mediaLang, clientLang);
      const isWelcomeLabel = /boas|vindas|oi|hola|hi|hey|hallo|willkommen|inicio|inicial|sauda/i.test(n.mediaLabel || '');
      return matchesLang && isWelcomeLabel;
    });

    if (welcomeAudio) {
      const url = welcomeAudio.text.trim();
      try {
        console.log(`[FlowEngine] Disparando áudio de boas-vindas (${clientLang}) para ${userId}: ${url}`);
        await sendTypingIndicator(channel, userId, lastMessageId, 'audio');
        await sleep(3500);
        await sendChannelMedia(channel, userId, url, 'audio');
        await saveMessage(channel, userId, 'assistant', `[Áudio de boas-vindas ${clientLang} enviado]`, 'audio', url);
        sentUrls.add(url);
        executedFlowSummary.push(`Você acabou de enviar seu áudio de boas-vindas em ${clientLang} (${welcomeAudio.mediaLabel || ''}).`);
        sentMediaInThisTurn = true;
      } catch (err) {
        console.error('[FlowEngine] Erro ao enviar áudio de boas-vindas:', err?.response?.data || err.message);
      }
    }
  }

  const shouldCallAi = !aiPaused && (!startNode || reachedAiNode);

  if (shouldCallAi) {
    await sendTypingIndicator(channel, userId, lastMessageId, 'text');

    const langLabels = {
      PT_BR: 'Português do Brasil (PT-BR)',
      PT_EU: 'Português de Portugal (PT-PT)',
      ES: 'Espanhol (ES)',
      EN: 'Inglês (EN)',
      DE: 'Alemão (DE)',
    };
    const humanLang = langLabels[clientLang] || clientLang;

    let contextualMessage = `${userMessage}\n\n[IDIOMA DETECTADO DO CLIENTE: ${humanLang}]`;
    if (executedFlowSummary.length > 0) {
      contextualMessage += `\n[SISTEMA - Ações já enviadas agora: ${executedFlowSummary.join(' | ')}. Continue a conversa naturalmente em ${humanLang} sem repetir o que já foi enviado.${aiExtraInstruction ? ` Foco: ${aiExtraInstruction}` : ''}]`;
    }

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

      // Fallback automático filtrado pelo idioma e sem repetir mídias já enviadas
      if (mediaUrls.length === 0 && !sentMediaInThisTurn) {
        const unsentMediaNodes = nodes.filter(
          (n) => n.type === 'media' && n.text?.trim().startsWith('http') && !sentUrls.has(n.text.trim())
        );
        if (unsentMediaNodes.length > 0) {
          let requestedKind = null;
          if (/\b(foto|fotinho|imagem|amostra|pr[eé]via|ver voc[eê]|te ver|pic|pics|photo|bild|bilder)\b/i.test(msgLower)) requestedKind = 'image';
          else if (/\b(v[ií]deo|videozinho|gravacao|grava[cç][aã]o|video)\b/i.test(msgLower)) requestedKind = 'video';
          else if (/\b([aá]udio|voz|fala comigo|manda voz|voice|audio|sprachnachricht|stimme)\b/i.test(msgLower)) requestedKind = 'audio';

          if (requestedKind) {
            const matching = unsentMediaNodes.filter((n) => {
              const k = detectMediaKind(n.text.trim(), n.mediaKind);
              return k === requestedKind && isLanguageMatch(n.mediaLang, clientLang);
            });
            const chosen = matching[0] || unsentMediaNodes.find((n) => detectMediaKind(n.text.trim(), n.mediaKind) === requestedKind);
            if (chosen) {
              mediaUrls.push(chosen.text.trim());
            }
          }
        }
      }

      const cleanText = rawAiReply.replace(mediaRegex, '').trim();

      if (cleanText) {
        await sendTypingIndicator(channel, userId, lastMessageId, 'text');
        await sleep(1400);
        await saveMessage(channel, userId, 'assistant', cleanText, 'text', null);
        await sendChannelText(channel, userId, cleanText);
      }

      for (const url of mediaUrls) {
        const kind = detectMediaKind(url);
        try {
          console.log(`[FlowEngine] Enviando ${kind} para ${userId}: ${url}`);
          await sendTypingIndicator(channel, userId, lastMessageId, kind);
          await sleep(kind === 'audio' ? 3500 : 1800);
          await sendChannelMedia(channel, userId, url, kind);
          await saveMessage(channel, userId, 'assistant', `[${kind} enviado]`, kind, url);
          sentUrls.add(url);
        } catch (mediaErr) {
          console.error('[FlowEngine] Erro ao enviar mídia:', mediaErr?.response?.data || mediaErr.message);
        }
      }
    }
  }
}
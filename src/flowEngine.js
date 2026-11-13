import { getBotSettings, getMemory, saveMessage, isAiPaused } from './db.js';
import { sendWhatsAppText, sendWhatsAppMedia, sendWhatsAppTyping } from './whatsapp.js';
import { sendTelegramText } from './telegram.js';
import { sendMessengerText } from './messenger.js';
import { generateAgentReply } from './ai.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function detectMediaKind(url, declaredKind) {
  if (declaredKind) return declaredKind;
  if (/\.(ogg|mp3|wav|m4a|opus|webm)(\?|$)/i.test(url)) return 'audio';
  if (/\.(mp4|mov|avi)(\?|$)/i.test(url)) return 'video';
  return 'image';
}

// Detecta o idioma da mensagem do cliente (PT, ES ou EN) com fallback pelo DDI do número
function detectClientLanguage(text, userId) {
  const t = (text || '').toLowerCase();

  // Palavras típicas em Espanhol
  if (/\b(hola|buenas|quetal|qué tal|como estas|cómo estás|guapa|hermosa|cuanto|cuánto|precio|de donde|de dónde|españa|ecuador|panama|panamá|mexico|méxico|colombia|chile|argentina|peru|perú)\b/i.test(t) || /[¿¡ñáéíóú]/i.test(t)) {
    // Diferencia palavras exclusivas do português (ç, ã, õ, você, oi, tudo)
    if (!/\b(voc[eê]|tudo bem|oi|ol[aá]|obrigado|pre[cç]o|quanto custa)\b/i.test(t) && !/[çãõ]/i.test(t)) {
      return 'ES';
    }
  }

  // Palavras típicas em Inglês
  if (/\b(hi|hello|hey|how are you|what's up|whats up|beautiful|gorgeous|cute|how much|price|where are you from|link|pic|pics|photo|video|voice)\b/i.test(t)) {
    return 'EN';
  }

  // Palavras típicas em Português
  if (/\b(oi|ol[aá]|tudo bem|td bem|bom dia|boa tarde|boa noite|linda|gata|quanto|valor|pre[cç]o|voc[eê]|vc|de onde)\b/i.test(t) || /[çãõ]/i.test(t)) {
    return 'PT';
  }

  // Fallback pelo DDI do WhatsApp caso o cliente mande só "👋" ou "?"
  const phone = String(userId || '').replace(/\D/g, '');
  if (phone.startsWith('55') || phone.startsWith('351')) return 'PT';
  if (/^(34|593|507|52|54|57|56|51|58|591|595|598|506|503|502|504|505)/.test(phone)) return 'ES';
  if (/^(1|44|61|64|353)/.test(phone)) return 'EN';

  return 'PT';
}

async function sendChannelText(channel, userId, text) {
  if (!text?.trim()) return;
  if (channel === 'whatsapp') await sendWhatsAppText(userId, text);
  else if (channel === 'telegram') await sendTelegramText(userId, text);
  else if (channel === 'messenger') await sendMessengerText(userId, text);
}

async function sendChannelMedia(channel, userId, url, kind) {
  if (!url?.startsWith('http')) return;
  if (channel === 'whatsapp') {
    await sendWhatsAppMedia(userId, url, kind);
  } else if (channel === 'telegram') {
    await sendTelegramText(userId, url);
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

  const history = await getMemory(channel, userId, 30);
  const assistantAlreadyReplied = history.some((m) => m.role === 'assistant');
  const isFirstContact = !assistantAlreadyReplied;
  const clientLang = detectClientLanguage(userMessage, userId);

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
        if (channel === 'whatsapp' && lastMessageId) await sendWhatsAppTyping(lastMessageId, 'text');
        await sleep(secs * 1000);
      } else if (current.type === 'message' && current.text?.trim()) {
        if (channel === 'whatsapp' && lastMessageId) {
          await sendWhatsAppTyping(lastMessageId, 'text');
          await sleep(1000);
        }
        await sendChannelText(channel, userId, current.text.trim());
        await saveMessage(channel, userId, 'assistant', current.text.trim(), 'text', null);
        executedFlowSummary.push(`Você enviou a mensagem: "${current.text.trim()}"`);
      } else if (current.type === 'media' && current.text?.trim().startsWith('http')) {
        // Se o balão conectado tiver um idioma específico diferente do cliente, pula ele
        if (current.mediaLang && current.mediaLang !== 'ALL' && current.mediaLang !== clientLang) {
          const nexts = getNextNodes(current.id);
          queue.push(...nexts);
          continue;
        }

        const url = current.text.trim();
        const kind = detectMediaKind(url, current.mediaKind);
        try {
          console.log(`[FlowEngine] Enviando ${kind} (${clientLang}) do fluxo para ${userId}: ${url}`);
          if (channel === 'whatsapp' && lastMessageId) {
            await sendWhatsAppTyping(lastMessageId, kind === 'audio' ? 'audio' : 'text');
            await sleep(1500);
          }
          await sendChannelMedia(channel, userId, url, kind);
          await saveMessage(channel, userId, 'assistant', `[${kind} enviado pelo fluxo]`, kind, url);
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

  // GATILHO AUTOMÁTICO DE BOAS-VINDAS POR IDIOMA NO 1º CONTATO:
  // Se for a 1ª mensagem do cliente e houver um áudio cadastrado com o idioma dele (e descrição "boas-vindas" ou "oi"), dispara agora!
  if (isFirstContact && !sentMediaInThisTurn) {
    const welcomeAudio = nodes.find((n) => {
      if (n.type !== 'media' || !n.text?.trim().startsWith('http')) return false;
      const kind = detectMediaKind(n.text.trim(), n.mediaKind);
      if (kind !== 'audio') return false;
      const matchesLang = n.mediaLang === clientLang;
      const isWelcomeLabel = /boas|vindas|oi|hola|hi|inicio|inicial|sauda/i.test(n.mediaLabel || '');
      return matchesLang && isWelcomeLabel;
    });

    if (welcomeAudio) {
      const url = welcomeAudio.text.trim();
      try {
        console.log(`[FlowEngine] Disparando áudio de boas-vindas (${clientLang}) para ${userId}: ${url}`);
        if (channel === 'whatsapp' && lastMessageId) {
          await sendWhatsAppTyping(lastMessageId, 'audio');
          await sleep(1800);
        }
        await sendChannelMedia(channel, userId, url, 'audio');
        await saveMessage(channel, userId, 'assistant', `[Áudio de boas-vindas ${clientLang} enviado]`, 'audio', url);
        executedFlowSummary.push(`Você acabou de enviar seu áudio de boas-vindas em ${clientLang} (${welcomeAudio.mediaLabel || ''}).`);
        sentMediaInThisTurn = true;
      } catch (err) {
        console.error('[FlowEngine] Erro ao enviar áudio de boas-vindas:', err?.response?.data || err.message);
      }
    }
  }

  const shouldCallAi = !aiPaused && (!startNode || reachedAiNode);

  if (shouldCallAi) {
    if (channel === 'whatsapp' && lastMessageId) {
      await sendWhatsAppTyping(lastMessageId, 'text');
    }

    let contextualMessage = `${userMessage}\n\n[IDIOMA DETECTADO DO CLIENTE: ${clientLang}]`;
    if (executedFlowSummary.length > 0) {
      contextualMessage += `\n[SISTEMA - Ações já enviadas agora: ${executedFlowSummary.join(' | ')}. Continue a conversa naturalmente em ${clientLang} sem repetir o que já foi enviado.${aiExtraInstruction ? ` Foco: ${aiExtraInstruction}` : ''}]`;
    }

    const rawAiReply = await generateAgentReply(channel, userId, contextualMessage, mediaBuffer, mediaMime);
    if (rawAiReply) {
      const mediaRegex = /\[ENVIAR_MIDIA:\s*(https?:\/\/[^\]\s]+)\s*\]/gi;
      const mediaUrls = [];
      let match;
      while ((match = mediaRegex.exec(rawAiReply)) !== null) {
        mediaUrls.push(match[1]);
      }

      // Fallback automático filtrado pelo idioma do cliente
      if (mediaUrls.length === 0 && !sentMediaInThisTurn) {
        const allMediaNodes = nodes.filter((n) => n.type === 'media' && n.text?.trim().startsWith('http'));
        if (allMediaNodes.length > 0) {
          let requestedKind = null;
          if (/\b(foto|fotinho|imagem|amostra|pr[eé]via|ver voc[eê]|te ver|pic|pics|photo|foto)\b/i.test(msgLower)) requestedKind = 'image';
          else if (/\b(v[ií]deo|videozinho|gravacao|grava[cç][aã]o|video)\b/i.test(msgLower)) requestedKind = 'video';
          else if (/\b([aá]udio|voz|fala comigo|manda voz|voice|audio)\b/i.test(msgLower)) requestedKind = 'audio';

          if (requestedKind) {
            const matching = allMediaNodes.filter((n) => {
              const k = detectMediaKind(n.text.trim(), n.mediaKind);
              const langOk = !n.mediaLang || n.mediaLang === 'ALL' || n.mediaLang === clientLang;
              return k === requestedKind && langOk;
            });
            const chosen = matching[0] || allMediaNodes.find((n) => detectMediaKind(n.text.trim(), n.mediaKind) === requestedKind);
            if (chosen) {
              mediaUrls.push(chosen.text.trim());
            }
          }
        }
      }

      const cleanText = rawAiReply.replace(mediaRegex, '').trim();

      if (cleanText) {
        await saveMessage(channel, userId, 'assistant', cleanText, 'text', null);
        await sendChannelText(channel, userId, cleanText);
      }

      for (const url of mediaUrls) {
        const kind = detectMediaKind(url);
        try {
          console.log(`[FlowEngine] Enviando ${kind} para ${userId}: ${url}`);
          if (channel === 'whatsapp' && lastMessageId) {
            await sendWhatsAppTyping(lastMessageId, kind === 'audio' ? 'audio' : 'text');
            await sleep(1500);
          }
          await sendChannelMedia(channel, userId, url, kind);
          await saveMessage(channel, userId, 'assistant', `[${kind} enviado]`, kind, url);
        } catch (mediaErr) {
          console.error('[FlowEngine] Erro ao enviar mídia:', mediaErr?.response?.data || mediaErr.message);
        }
      }
    }
  }
}
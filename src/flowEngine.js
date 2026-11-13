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

  console.log(`[FlowEngine] Usuário: ${userId} | Nodes: ${nodes.length} | Edges: ${edges.length} | IA Pausada: ${aiPaused}`);

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

  const history = await getMemory(channel, userId, 30);
  const assistantAlreadyReplied = history.some((m) => m.role === 'assistant');

  let startNode = null;
  if (matchedCondition) {
    startNode = matchedCondition;
  } else if (aiPaused || !assistantAlreadyReplied) {
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
        const url = current.text.trim();
        const kind = detectMediaKind(url, current.mediaKind);
        try {
          console.log(`[FlowEngine] Enviando ${kind} do fluxo para ${userId}: ${url}`);
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

  const shouldCallAi = !aiPaused && (!startNode || reachedAiNode);

  if (shouldCallAi) {
    if (channel === 'whatsapp' && lastMessageId) {
      await sendWhatsAppTyping(lastMessageId, 'text');
    }

    let contextualMessage = userMessage;
    if (executedFlowSummary.length > 0) {
      contextualMessage = `${userMessage}\n\n[SISTEMA - Ações já enviadas agora: ${executedFlowSummary.join(' | ')}. Continue a conversa naturalmente sem repetir o que já foi enviado.${aiExtraInstruction ? ` Foco: ${aiExtraInstruction}` : ''}]`;
    }

    const rawAiReply = await generateAgentReply(channel, userId, contextualMessage, mediaBuffer, mediaMime);
    if (rawAiReply) {
      const mediaRegex = /\[ENVIAR_MIDIA:\s*(https?:\/\/[^\]\s]+)\s*\]/gi;
      const mediaUrls = [];
      let match;
      while ((match = mediaRegex.exec(rawAiReply)) !== null) {
        mediaUrls.push(match[1]);
      }

      // Fallback automático: se o cliente pediu foto/amostra/vídeo/áudio e a IA não colocou a tag,
      // pega uma mídia cadastrada no /fluxo e dispara automaticamente!
      if (mediaUrls.length === 0 && !sentMediaInThisTurn) {
        const allMediaNodes = nodes.filter((n) => n.type === 'media' && n.text?.trim().startsWith('http'));
        if (allMediaNodes.length > 0) {
          let requestedKind = null;
          if (/\b(foto|fotinho|imagem|amostra|pr[eé]via|ver voc[eê]|te ver)\b/i.test(msgLower)) requestedKind = 'image';
          else if (/\b(v[ií]deo|videozinho|gravacao|grava[cç][aã]o)\b/i.test(msgLower)) requestedKind = 'video';
          else if (/\b([aá]udio|voz|fala comigo|manda voz)\b/i.test(msgLower)) requestedKind = 'audio';

          if (requestedKind) {
            const matching = allMediaNodes.filter((n) => detectMediaKind(n.text.trim(), n.mediaKind) === requestedKind);
            const chosen = matching[0] || allMediaNodes[0];
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
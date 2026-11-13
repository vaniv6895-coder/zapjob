import { getBotSettings, getMemory, saveMessage } from './db.js';
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
  const settings = await getBotSettings();
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
  } else if (!assistantAlreadyReplied) {
    startNode = nodes.find((n) => n.type === 'trigger') || null;
  }

  const executedFlowSummary = [];
  let reachedAiNode = false;
  let aiExtraInstruction = '';

  if (startNode) {
    const visited = new Set([startNode.id]);
    let queue = getNextNodes(startNode.id);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current.id)) continue;
      visited.add(current.id);

      if (current.type === 'delay') {
        const secs = Math.min(15, Math.max(1, Number(current.text) || 3));
        if (channel === 'whatsapp' && lastMessageId) await sendWhatsAppTyping(lastMessageId);
        await sleep(secs * 1000);
      } else if (current.type === 'message' && current.text?.trim()) {
        if (channel === 'whatsapp' && lastMessageId) {
          await sendWhatsAppTyping(lastMessageId);
          await sleep(1200);
        }
        await sendChannelText(channel, userId, current.text.trim());
        await saveMessage(channel, userId, 'assistant', current.text.trim(), 'text', null);
        executedFlowSummary.push(`Você enviou a mensagem: "${current.text.trim()}"`);
      } else if (current.type === 'media' && current.text?.trim().startsWith('http')) {
        const url = current.text.trim();
        const kind = detectMediaKind(url, current.mediaKind);
        if (channel === 'whatsapp' && lastMessageId) {
          await sendWhatsAppTyping(lastMessageId);
          await sleep(1500);
        }
        await sendChannelMedia(channel, userId, url, kind);
        await saveMessage(channel, userId, 'assistant', `[${kind} enviado pelo fluxo]`, kind, url);
        executedFlowSummary.push(`Você acabou de enviar um(a) ${kind} (${url}) ao cliente.`);
      } else if (current.type === 'ai') {
        reachedAiNode = true;
        aiExtraInstruction = current.text || '';
        break;
      }

      const nexts = getNextNodes(current.id);
      queue.push(...nexts);
    }
  }

  const shouldCallAi = !startNode || reachedAiNode;

  if (shouldCallAi) {
    if (channel === 'whatsapp' && lastMessageId) {
      await sendWhatsAppTyping(lastMessageId);
    }

    let contextualMessage = userMessage;
    if (executedFlowSummary.length > 0) {
      contextualMessage = `${userMessage}\n\n[SISTEMA - Ações já enviadas agora: ${executedFlowSummary.join(' | ')}. Continue a conversa naturalmente sem repetir o que já foi enviado.${aiExtraInstruction ? ` Foco: ${aiExtraInstruction}` : ''}]`;
    }

    const rawAiReply = await generateAgentReply(channel, userId, contextualMessage, mediaBuffer, mediaMime);
    if (rawAiReply) {
      // Extrai tags [ENVIAR_MIDIA:https://...] escolhidas pela IA
      const mediaRegex = /\[ENVIAR_MIDIA:\s*(https?:\/\/[^\]\s]+)\s*\]/gi;
      const mediaUrls = [];
      let match;
      while ((match = mediaRegex.exec(rawAiReply)) !== null) {
        mediaUrls.push(match[1]);
      }

      const cleanText = rawAiReply.replace(mediaRegex, '').trim();

      if (cleanText) {
        await saveMessage(channel, userId, 'assistant', cleanText, 'text', null);
        await sendChannelText(channel, userId, cleanText);
      }

      for (const url of mediaUrls) {
        const kind = detectMediaKind(url);
        if (channel === 'whatsapp' && lastMessageId) {
          await sendWhatsAppTyping(lastMessageId);
          await sleep(1200);
        }
        await sendChannelMedia(channel, userId, url, kind);
        await saveMessage(channel, userId, 'assistant', `[${kind} enviado pela IA]`, kind, url);
      }
    }
  }
}
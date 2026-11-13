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

  // Verifica histórico para saber se o cliente já recebeu o fluxo inicial antes
  const history = await getMemory(channel, userId, 30);
  const assistantAlreadyReplied = history.some((m) => m.role === 'assistant');

  // Helper para pegar o próximo balão conectado
  const getNextNodes = (nodeId) =>
    edges
      .filter((e) => e.from === nodeId)
      .map((e) => nodes.find((n) => n.id === e.to))
      .filter(Boolean);

  // 1. Verifica se existe algum balão de CONDIÇÃO que bate com a mensagem atual do cliente
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

  // 2. Define ponto de partida no fluxo visual:
  // - Se bateu uma Condição específica, segue a partir dela
  // - Se é o primeiro contato do cliente e existe um Gatilho Inicial, segue a partir do Gatilho
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
        if (channel === 'whatsapp' && lastMessageId) {
          await sendWhatsAppTyping(lastMessageId);
        }
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
        executedFlowSummary.push(`Você acabou de enviar um(a) ${kind} pré-gravado(a) ao cliente.`);
      } else if (current.type === 'ai') {
        reachedAiNode = true;
        aiExtraInstruction = current.text || '';
        break; // Passa o bastão para a IA Gemini continuar de forma natural
      }

      const nexts = getNextNodes(current.id);
      queue.push(...nexts);
    }
  }

  // Decide se chama a IA Gemini:
  // - Sempre chama se não houve fluxo visual disparado agora (conversa normal em andamento)
  // - OU se o fluxo visual executado terminou conectado em um balão "Agente IA Gemini"
  const shouldCallAi = !startNode || reachedAiNode;

  if (shouldCallAi) {
    if (channel === 'whatsapp' && lastMessageId) {
      await sendWhatsAppTyping(lastMessageId);
    }

    let contextualMessage = userMessage;
    if (executedFlowSummary.length > 0) {
      contextualMessage = `${userMessage}\n\n[SISTEMA - Ações do fluxo já enviadas agora ao cliente: ${executedFlowSummary.join(' | ')}. Continue a conversa naturalmente sem repetir o que já foi enviado.${aiExtraInstruction ? ` Foco atual: ${aiExtraInstruction}` : ''}]`;
    }

    const aiReply = await generateAgentReply(channel, userId, contextualMessage, mediaBuffer, mediaMime);
    if (aiReply) {
      await saveMessage(channel, userId, 'assistant', aiReply, 'text', null);
      await sendChannelText(channel, userId, aiReply);
    }
  }
}
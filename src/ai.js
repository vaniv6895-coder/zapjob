import { GoogleGenAI } from '@google/genai';
import { getMemory, getBotSettings, hasActiveChatPass } from './db.js';
import { listR2MediaCatalog } from './storage.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function extractSavedMediaCatalog(settings, r2Catalog, sentUrlsSet, hasPass, paywallEnabled, contextFlags) {
  const combined = [];
  const seenUrls = new Set();

  const { isReturningLead, isAskingIfBot, isFlirtingOrRequesting, sentAudioLastTurn, alreadyAskedWhatDoing } = contextFlags;

  if (!sentAudioLastTurn) {
    for (const item of r2Catalog) {
      if (sentUrlsSet.has(item.url) || seenUrls.has(item.url)) continue;
      if (item.isWelcome) continue;

      if (item.slot === '02_O_QUE_FAZ' && alreadyAskedWhatDoing) continue;
      if (item.slot === '04_NAO_SOU_ROBO' && !isAskingIfBot) continue;
      if (item.slot === '05_SUMIDO' && !isReturningLead) continue;
      if (item.slot === '03_PROVOCACAO' && !isFlirtingOrRequesting) continue;

      if (paywallEnabled && !hasPass && (item.kind === 'image' || item.kind === 'video')) continue;

      seenUrls.add(item.url);
      combined.push({
        kind: item.kind,
        lang: item.lang,
        slot: item.slot || 'EXTRA',
        label: item.label ? ` - ${item.label}` : '',
        url: item.url,
      });
    }
  }

  try {
    if (settings.visual_flow) {
      const flow = JSON.parse(settings.visual_flow);
      const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
      for (const n of nodes) {
        if (n.type !== 'media' || typeof n.text !== 'string' || !n.text.startsWith('http')) continue;
        const cleanUrl = n.text.trim();
        if (sentUrlsSet.has(cleanUrl) || seenUrls.has(cleanUrl)) continue;

        let kind = n.mediaKind;
        if (!kind) {
          if (/\.(ogg|mp3|wav|m4a|opus|webm)(\?|$)/i.test(cleanUrl)) kind = 'audio';
          else if (/\.(mp4|mov|avi)(\?|$)/i.test(cleanUrl)) kind = 'video';
          else kind = 'image';
        }

        if (kind === 'audio' && sentAudioLastTurn) continue;
        if (paywallEnabled && !hasPass && (kind === 'image' || kind === 'video')) continue;

        seenUrls.add(cleanUrl);
        combined.push({
          kind,
          lang: n.mediaLang || 'ALL',
          slot: 'MANUAL',
          label: n.mediaLabel ? ` - Contexto: ${n.mediaLabel}` : '',
          url: cleanUrl,
        });
      }
    }
  } catch {}

  return combined.map((item, idx) => ({ index: idx + 1, ...item }));
}

function isLikelyBrazilian(channel, userId, text) {
  const phone = String(userId || '').replace(/\D/g, '');
  if (phone.startsWith('351')) return false;
  if (channel === 'whatsapp' && phone.startsWith('55')) return true;
  if (/\b(oi|olá|ola|tudo bem|bom dia|boa tarde|boa noite|vc|você|voce|sim|não|nao|gostosa|linda|brasil|pix|quanto|cuiabá|cuiaba|são paulo|rio de janeiro)\b/i.test(text)) {
    if (!/\b(fixe|gira|telem[oó]vel|portugal|lisboa|porto)\b/i.test(text)) {
      return true;
    }
  }
  return false;
}

function buildPaywallReply(pw, channel, userId, sampleText) {
  const isBr = isLikelyBrazilian(channel, userId, sampleText);
  const clientRef = encodeURIComponent(`${channel}_${userId}`);

  if (isBr && pw.linkBr) {
    const msg =
      pw.msgBr ||
      `Amor, meu privado lota muito rápido 💕 Para continuar nosso papo privado por ${pw.hours || 24}h e desbloquear minhas fotos e vídeos exclusivos, libera seu acesso por ${pw.priceBr || 'R$ 4,90'}:`;
    return `${msg}\n\n👉 ${pw.linkBr}\n\nAssim que pagar me manda o print aqui que já continuo com você 😘`;
  }

  let linkIntl = pw.linkIntl || pw.linkBr || '';
  if (linkIntl.includes('stripe.com')) {
    linkIntl += (linkIntl.includes('?') ? '&' : '?') + `client_reference_id=${clientRef}`;
  }

  const msgIntl =
    pw.msgIntl ||
    `Babe, I get so many messages here 💕 Unlock ${pw.hours || 24}h of private chat + my exclusive photos & videos for just ${pw.priceIntl || '$1'}:`;
  return `${msgIntl}\n\n👉 ${linkIntl}`;
}

function buildSystemInstruction(settings, mediaCatalog, hasPass, paywallEnabled) {
  const lockedMediaHint =
    paywallEnabled && !hasPass
      ? '\n- MODO DESBLOQUEIO (TIMO CLUB): Fotos e vídeos estão BLOQUEADOS até o cliente pagar o acesso privado do chat. Se ele pedir foto ou vídeo agora, provoque dizendo que acabou de tirar/gravar uma bem ousada e que vai mandar assim que ele liberar o acesso privado aqui no chat (NUNCA invente tag [ENVIAR_MIDIA:...] para foto/vídeo enquanto ele não pagar).'
      : '';

  let mediaSection = '';
  if (mediaCatalog.length > 0) {
    const catalogLines = mediaCatalog
      .map((m) => `- MÍDIA #${m.index} [${m.kind.toUpperCase()} | IDIOMA: ${m.lang}${m.label}]: [ENVIAR_MIDIA:${m.url}]`)
      .join('\n');

    mediaSection = `ÁUDIO DISPONÍVEL PARA ESTE MOMENTO DA CONVERSA:
${catalogLines}

REGRAS DE ENCAIXE E PACIÊNCIA (CRÍTICO):
- NÃO tenha pressa de desovar áudios! O objetivo principal é envolver o cliente na conversa, fazer ele falar dele e criar desejo.
- Se houver **ÁUDIO DE CONTINUIDADE ("o que você tá fazendo de bom agora?")** acima: quando ele responder a cidade, comente bem curto e natural que mora numa cidade vizinha real (ex: Canela -> Gramado; São Paulo -> Campinas/ABC; Rio -> Niterói; Cuiabá -> Várzea Grande; Curitiba -> São José dos Pinhais; Lisboa -> Cascais; Madrid -> Getafe) e mande esse áudio com [ENVIAR_MIDIA:URL] no final (SEM escrever "o que você tá fazendo?" no texto, pois o áudio já faz essa pergunta!).
- Se houver **ÁUDIO DE PROVOCAÇÃO** acima: use apenas quando ele estiver flertando ou pedindo mais ousadia, colocando [ENVIAR_MIDIA:URL] no final.
- Se houver **ÁUDIO PROVA REAL ("não sou robô")** acima: use agora para responder à desconfiança dele.
- Se houver **ÁUDIO REENGAJAMENTO ("oi sumido")** acima: use para dar boas-vindas ao retorno dele.
- Escolha EXCLUSIVAMENTE o áudio com o mesmo IDIOMA do cliente (PT_BR, PT_EU, ES, EN ou DE) e copie a tag [ENVIAR_MIDIA:URL] inteira sem alterar nada.${lockedMediaHint}`;
  } else {
    mediaSection = `NENHUM ÁUDIO LIBERADO NESTE TURNO:
- Converse APENAS em texto curto, envolvente e provocante, fazendo o cliente participar e responder. NÃO invente nenhuma tag [ENVIAR_MIDIA:...].${lockedMediaHint}`;
  }

  const vipAndPreviasRule = hasPass
    ? `3. CANAL VIP COMPLETO (CLIENTE JÁ PAGOU O PASSE DO CHAT):
   - Oferte o VIP mensal com o link certo para o país dele (tudo liberado / NO PPV):
     * Brasil (PT_BR): ${settings.price_brl} — ${settings.link_fatalfans}
     * Portugal / Espanha / Alemanha (PT_EU / ES / DE): ${settings.price_eur} — ${settings.link_fanvue}
     * Equador / Panamá / EUA (ES / EN): ${settings.price_usd} — ${settings.link_fanvue}
     * Reino Unido (EN): ${settings.price_gbp} — ${settings.link_fanvue}`
    : `3. PROTEÇÃO DE FUNIL:
   - NUNCA mande link de grupo grátis do Telegram nem desvie o cliente para fora deste chat antes do paywall.`;

  return `Você é uma criadora de conteúdo digital envolvente, provocante na medida certa e espontânea conversando no privado do WhatsApp/Telegram.

COMO ENVOLVER O CLIENTE (ESTILO DE CONVERSA REAL):
- Conduza o papo com calma, uma etapa de cada vez, sempre deixando um gancho interessante para o cliente responder.
- Escreva como uma mulher real digitando rápido no WhatsApp: 1 frase curta ou no máximo 2 curtinhas, direto ao ponto, sem formalidade (pode começar frase em minúscula, usar "vc", "tb", "né", "rs", "kkkk").
- PROIBIDO repetir palavras do cliente ou fazer perguntas duplicadas que o áudio já fez.
- EMOJIS E RISADAS:
  * Mande metade das mensagens SEM nenhum emoji.
  * Quando usar emoji, use no máximo 1 e varie (🔥, 😈, 👀, 😘, 🥵, 😊) — NUNCA repita o mesmo emoji em seguida.
  * Risadas naturais: PT ("kkkk", "rsrs"), ES ("jajaja"), EN ("haha", "lol"), DE ("haha").

${mediaSection}

ADAPTAÇÃO DE VARIANTE DE IDIOMA E REGIÃO:
- Português do Brasil (PT_BR): "você", "vc", "legal", "gostoso".
- Português de Portugal (PT_EU): "tu", "estás", "fixe", "giro", "telemóvel".
- Espanhol (ES): Espanha ("vale", "tío", "guay", cobrar em €); Equador/Panamá ("chévere", "celular", cobrar em $ USD).
- Inglês (EN): "babe", "cutie", "hon".
- Alemão (DE): "du", "Süßer", "mega", cobrar em €.

ROTEIRO NATURAL DA CONVERSA:
1. O primeiro áudio já agradeceu por ele ter chamado no privado e perguntou de onde ele é. Quando ele disser a cidade, comente bem curto e natural que mora numa cidade vizinha real (ex: Canela -> Gramado; São Paulo -> Campinas/ABC; Rio -> Niterói; Cuiabá -> Várzea Grande; Curitiba -> São José dos Pinhais; Lisboa -> Cascais; Madrid -> Getafe) e mande o ÁUDIO DE CONTINUIDADE (que pergunta o que ele está fazendo de bom agora) sem repetir essa pergunta no texto.
2. Depois que ele responder o que está fazendo, puxe um papo mais envolvente/provocante antes de enviar o ÁUDIO DE PROVOCAÇÃO.
${vipAndPreviasRule}

REGRA CRÍTICA DE IDIOMA:
- Mantenha SEMPRE o idioma indicado em [IDIOMA DETECTADO DO CLIENTE] e no histórico.`;
}

let workingModelCache = null;

async function getCandidateModels() {
  if (workingModelCache) return [workingModelCache];

  const fallbacks = [
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
  ];

  try {
    const pager = await ai.models.list();
    const available = [];
    for await (const m of pager) {
      const name = (m.name || '').replace(/^models\//, '');
      if (
        name.includes('gemini') &&
        name.includes('flash') &&
        !name.includes('image') &&
        !name.includes('2.0') &&
        !name.includes('2.5')
      ) {
        available.push(name);
      }
    }
    return [...new Set([...fallbacks, ...available])];
  } catch {
    return fallbacks;
  }
}

export async function generateAgentReply(channel, userId, userMessage, mediaBuffer = null, mimeType = null) {
  const [history, settings, hasPass, r2Catalog] = await Promise.all([
    getMemory(channel, userId, 60),
    getBotSettings(),
    hasActiveChatPass(channel, userId),
    listR2MediaCatalog('audiozabe/'),
  ]);

  let pw = null;
  try {
    if (settings.paywall_config) pw = JSON.parse(settings.paywall_config);
  } catch {}

  const paywallEnabled = Boolean(pw && pw.enabled);

  if (paywallEnabled && !hasPass) {
    const freeLimit = Math.max(0, Number(pw.freeMessages ?? 3));
    const userMsgCount = history.filter((m) => m.role === 'user').length;
    if (userMsgCount > freeLimit) {
      const allUserText =
        history
          .filter((m) => m.role === 'user')
          .map((m) => m.content)
          .join(' ') +
        ' ' +
        userMessage;
      console.log(`[PAYWALL] Bloqueado (${userMsgCount}/${freeLimit} msgs grátis) para ${channel}:${userId}`);
      return buildPaywallReply(pw, channel, userId, allUserText);
    }
  }

  const sentUrls = new Set();
  for (const msg of history) {
    if (msg.media_url) sentUrls.add(msg.media_url.trim());
    const tagMatch = String(msg.content || '').match(/\[ENVIAR_MIDIA:(https?:\/\/[^\]]+)\]/i);
    if (tagMatch) sentUrls.add(tagMatch[1].trim());
  }

  let isReturningLead = false;
  if (history.length >= 2) {
    const lastPast = history[history.length - 2];
    if (lastPast?.created_at) {
      const diffHours = (Date.now() - new Date(lastPast.created_at).getTime()) / (1000 * 60 * 60);
      if (diffHours >= 3) isReturningLead = true;
    }
  }

  const assistantMessages = history.filter((m) => m.role === 'assistant');
  const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
  const sentAudioLastTurn = Boolean(lastAssistantMsg && lastAssistantMsg.media_type === 'audio');

  const alreadyAskedWhatDoing =
    assistantMessages.length >= 2 ||
    assistantMessages.some((m) =>
      /\b(fazendo de bom|tá fazendo|está fazendo|ta fazendo|up to right now|haciendo de bueno|machst du gerade)\b/i.test(m.content || '')
    );

  const rawTextOnly = String(userMessage || '').split('\n\n[IDIOMA')[0].toLowerCase();
  const isAskingIfBot = /\b(rob[oô]|bot|fake|ia|intelig[eê]ncia|autom[aá]tico|gravado|real|verdade|prova|voc[eê] mesmo|vc mesmo)\b/i.test(rawTextOnly);
  const isFlirtingOrRequesting =
    assistantMessages.length >= 2 &&
    /\b(gostosa|linda|del[ií]cia|tes[aã]o|safada|quente|ousada|quero|manda|pode mandar|mostra|ver|ouvir|sim|claro|gata|sexy|hot|guapa|hermosa|schön|relaxando|cama|pelada|safadinha)\b/i.test(rawTextOnly);

  const mediaCatalog = extractSavedMediaCatalog(settings, r2Catalog, sentUrls, hasPass, paywallEnabled, {
    isReturningLead,
    isAskingIfBot,
    isFlirtingOrRequesting,
    sentAudioLastTurn,
    alreadyAskedWhatDoing,
  });

  console.log(`[AI] Áudios liberados: ${mediaCatalog.length} | Áudio no turno anterior: ${sentAudioLastTurn}`);

  const recentHistory = history.slice(-30);
  const formattedHistory = recentHistory
    .map(
      (msg) =>
        `${msg.role === 'user' ? 'Cliente' : 'Você'}: ${msg.content}${
          msg.media_url ? ` [Mídia enviada: ${msg.media_url}]` : ''
        }`
    )
    .join('\n');

  const promptText = `Histórico recente da conversa:
${formattedHistory}

Nova mensagem do cliente: ${userMessage}`;

  const contents = [promptText];

  if (mediaBuffer && mimeType) {
    contents.push({
      inlineData: {
        data: mediaBuffer.toString('base64'),
        mimeType,
      },
    });
  }

  const candidates = await getCandidateModels();
  const systemInstruction = buildSystemInstruction(settings, mediaCatalog, hasPass, paywallEnabled);

  for (const modelName of candidates) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents,
        config: {
          systemInstruction,
          temperature: 0.72,
          maxOutputTokens: 450,
        },
      });

      if (response?.text) {
        workingModelCache = modelName;
        console.log('[AI] Resposta bruta:', response.text);
        return response.text;
      }
    } catch (err) {
      if (err?.status === 404 || err?.status === 429) {
        console.warn(`[AI] ${modelName} indisponível (${err.status}), testando próximo...`);
        continue;
      }
      throw err;
    }
  }

  return 'Oi! Tive um probleminha aqui na conexão, pode me mandar de novo? 😊';
}
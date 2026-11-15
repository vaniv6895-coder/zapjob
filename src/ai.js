import { GoogleGenAI } from '@google/genai';
import { getMemory, getBotSettings, hasActiveChatPass } from './db.js';
import { listR2MediaCatalog } from './storage.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function extractSavedMediaCatalog(settings, r2Catalog, sentUrlsSet, hasPass, paywallEnabled, isReturningLead) {
  const combined = [];
  const seenUrls = new Set();

  for (const item of r2Catalog) {
    if (sentUrlsSet.has(item.url) || seenUrls.has(item.url)) continue;
    if (item.isWelcome) continue;
    if (item.isReturnOnly && !isReturningLead) continue;
    if (paywallEnabled && !hasPass && (item.kind === 'image' || item.kind === 'video')) continue;

    seenUrls.add(item.url);
    combined.push({
      kind: item.kind,
      lang: item.lang,
      label: item.label ? ` - ${item.label}` : '',
      url: item.url,
    });
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

        if (paywallEnabled && !hasPass && (kind === 'image' || kind === 'video')) continue;

        seenUrls.add(cleanUrl);
        combined.push({
          kind,
          lang: n.mediaLang || 'ALL',
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

function buildSystemInstruction(settings, mediaCatalog, hasPass, paywallEnabled, totalSentCount) {
  const lockedMediaHint =
    paywallEnabled && !hasPass
      ? '\n- MODO DESBLOQUEIO (TIMO CLUB): Fotos e vídeos estão BLOQUEADOS até o cliente pagar o acesso privado do chat. Se ele pedir foto ou vídeo agora, provoque dizendo que acabou de tirar/gravar uma bem ousada e que vai mandar assim que ele liberar o acesso privado aqui no chat (NUNCA invente tag [ENVIAR_MIDIA:...] para foto/vídeo enquanto ele não pagar).'
      : '';

  let mediaSection = '';
  if (mediaCatalog.length > 0) {
    const catalogLines = mediaCatalog
      .map((m) => `- MÍDIA #${m.index} [${m.kind.toUpperCase()} | IDIOMA: ${m.lang}${m.label}]: [ENVIAR_MIDIA:${m.url}]`)
      .join('\n');

    mediaSection = `CATÁLOGO DE ÁUDIOS CONTEXTUAIS DISPONÍVEIS PARA ESTE CLIENTE (NUNCA REPETIDOS):
${catalogLines}

COMO ENCAIXAR CADA ÁUDIO COM NATURALIDADE (CRÍTICO - LEIA O ROTEIRO DE CADA ÁUDIO ACIMA):
- NUNCA mande um áudio aleatório sem encaixar no assunto! Leia o que você fala dentro de cada áudio acima:
  1. ÁUDIO 03 (De onde você é?): Logo na sua PRIMEIRA resposta em texto (depois que o cliente responder o que está fazendo no Áudio 01), reaja rápido ao que ele disse e mande o ÁUDIO 03 com a tag [ENVIAR_MIDIA:URL_DO_AUDIO_03] (sem repetir a pergunta "de onde você é" no texto, pois o Áudio 03 já faz essa pergunta!).
  2. ÁUDIO 02 (Provocação - "ai para, você é muito sem vergonha..."): Só mande este áudio DEPOIS que o cliente elogiar você, flertar ou provocar! Se ele ainda não flertou, puxe um assunto mais ousado/provocante primeiro para ele te elogiar ou provocar, e aí sim responda com o ÁUDIO 02 ([ENVIAR_MIDIA:URL_DO_AUDIO_02]).
  3. ÁUDIO 04 ("não sou robô"): Use APENAS se ele desconfiar que você é bot/robô ou pedir para provar que é real.
  4. ÁUDIO 05 ("oi sumido"): Use APENAS se o cliente voltou a falar depois de horas sumido.
- REGRA DE IDIOMA: Escolha EXCLUSIVAMENTE o áudio com o mesmo IDIOMA do cliente (PT_BR, PT_EU, ES, EN ou DE).
- Quando colocar [ENVIAR_MIDIA:URL_COMPLETA], escreva no máximo 1 frase curtinha antes (ou até só a tag se o áudio já disser tudo) e copie a URL inteira sem alterar nada.${lockedMediaHint}`;
  } else if (paywallEnabled && !hasPass) {
    mediaSection = 'AVISO DE MÍDIAS BLOQUEADAS: Fotos e vídeos só são liberados após o cliente pagar o passe privado do chat. NÃO use nenhuma tag [ENVIAR_MIDIA:...].';
  } else if (totalSentCount > 0) {
    mediaSection = 'AVISO: Você já enviou todos os áudios disponíveis para este cliente. NÃO invente nenhuma tag [ENVIAR_MIDIA:...].';
  } else {
    mediaSection = 'AVISO: Nenhuma mídia disponível. NÃO use [ENVIAR_MIDIA:...].';
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

REGRA DE OURO DE ESCRITA HUMANA E NATURALIDADE (OBRIGATÓRIO):
- Escreva como uma mulher real digitando rápido no celular no WhatsApp, NUNCA como assistente virtual.
- Use 1 a 2 frases curtas no máximo, sem pontuação rígida demais (pode começar frase em minúscula, usar "vc", "tb", "né", "rs", "kkkk").
- PROIBIDO repetir as palavras do cliente ou fazer perguntas duplicadas que o áudio já faz.
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

FLUXO NATURAL DA CONVERSA:
1. O Áudio 01 já perguntou o que ele está fazendo. Quando ele responder, comente rápido o que ele disse e mande o ÁUDIO 03 (que pergunta de onde ele é).
2. Quando ele disser a cidade, diga de forma leve que mora numa cidade vizinha real (ex: São Paulo -> Campinas/ABC; Rio -> Niterói; Cuiabá -> Várzea Grande; Curitiba -> São José dos Pinhais; Lisboa -> Cascais; Madrid -> Getafe) e puxe um papo mais safado/provocante para preparar o terreno para o ÁUDIO 02.
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

  const mediaCatalog = extractSavedMediaCatalog(settings, r2Catalog, sentUrls, hasPass, paywallEnabled, isReturningLead);
  console.log(`[AI] Mídias liberadas p/ este cliente: ${mediaCatalog.length} (R2 total: ${r2Catalog.length} | Já enviadas: ${sentUrls.size})`);

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
  const systemInstruction = buildSystemInstruction(settings, mediaCatalog, hasPass, paywallEnabled, sentUrls.size);

  for (const modelName of candidates) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents,
        config: {
          systemInstruction,
          temperature: 0.75,
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
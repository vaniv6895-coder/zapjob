import { GoogleGenAI } from '@google/genai';
import { getMemory, getBotSettings, hasActiveChatPass } from './db.js';
import { listR2MediaCatalog } from './storage.js';
import { createMercadoPagoPix } from './mercadopago.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function extractSavedMediaCatalog(settings, r2Catalog, sentUrlsSet, hasPass, paywallEnabled, contextFlags) {
  const combined = [];
  const seenUrls = new Set();

  const { isReturningLead, isAskingIfBot, isFlirtingOrRequesting, sentAudioLastTurn, alreadyAskedWhatDoing } = contextFlags;

  if (!sentAudioLastTurn) {
    for (const item of r2Catalog) {
      if (sentUrlsSet.has(item.url) || seenUrls.has(item.url)) continue;
      if (item.isWelcome) continue;

      if (item.kind === 'audio') {
        const isProvo = item.slot === '03_PROVOCACAO' || item.slot === '02_PROVOCACAO' || /02|provo|sem_vergonha/i.test(item.url);
        const isNotBot = item.slot === '04_NAO_SOU_ROBO' || /04|robo|robô|bot|real/i.test(item.url);

        if (isProvo) {
          if (!isFlirtingOrRequesting) continue;
        } else if (isNotBot) {
          if (!isAskingIfBot) continue;
        } else {
          continue;
        }
      }

      const isCensoredPreview = /censura|preview|previa/i.test(`${item.url} ${item.label || ''}`);
      if (paywallEnabled && !hasPass && (item.kind === 'image' || item.kind === 'video') && !isCensoredPreview) continue;

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

        const metaText = `${cleanUrl} ${n.mediaLabel || ''}`;

        if (kind === 'audio') {
          if (sentAudioLastTurn) continue;
          if (/01|boas|vindas|welcome|fazendo/i.test(metaText) && alreadyAskedWhatDoing) continue;
          if (/02|provo|sem_vergonha/i.test(metaText) && !isFlirtingOrRequesting) continue;
          if (/04|robo|robô|bot|real/i.test(metaText) && !isAskingIfBot) continue;
          if (/05|sumido|volta|lembrei/i.test(metaText) && !isReturningLead) continue;
        }

        const isCensoredPreview = /censura|preview|previa/i.test(metaText);
        if (paywallEnabled && !hasPass && (kind === 'image' || kind === 'video') && !isCensoredPreview) continue;

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

function extractPriceFromMsg(msg, fallback = '4.90') {
  if (!msg) return fallback;
  const match = String(msg).match(/R\$\s*(\d+(?:[.,]\d{1,2})?)/i);
  return match ? match[1] : fallback;
}

function hasAlreadySentPaywall(assistantHistory = []) {
  return assistantHistory.some((m) => {
    const txt = String(m.content || '');
    return (
      txt.includes('Pix Copia e Cola') ||
      txt.includes('000201') ||
      txt.includes('/checkout?') ||
      txt.includes('USDC (Solana)')
    );
  });
}

function buildShortPaywallReminder(isBr, userMessage, checkoutUrl, walletSolana) {
  const isAskingMedia = /\b(foto|fotos|v[ií]deo|videos|imagem|pic|pics|photo|video|manda|mostra|cad[eê])\b/i.test(userMessage);

  if (isBr) {
    if (isAskingMedia) {
      return `Amor, eu até te mando sim, mas minhas fotos e vídeos sem censura só abrem depois que você libera o acesso privado 😘\n\nO código Pix já tá aí em cima (ou acesse ${checkoutUrl}) — assim que pagar, eu já te mando aqui na hora 🔥`;
    }
    return `Tô te esperando amor 👀 Libera seu acesso privado no Pix que te mandei ali em cima (ou pelo link ${checkoutUrl}) pra gente continuar sem limites 😈`;
  }

  if (isAskingMedia) {
    return `Babe, my uncensored photos and videos only unlock once you activate your private pass 😘 Send the USDC transfer to the Solana wallet above (or check ${checkoutUrl}) and I'll send them right away 🔥`;
  }
  return `Waiting for you babe 👀 Complete the USDC (Solana) transfer above or check ${checkoutUrl} to unlock our private chat 😈`;
}

async function buildPaywallReply(pw, channel, userId, sampleText, currentUserMsg, assistantHistory) {
  const isBr = isLikelyBrazilian(channel, userId, sampleText);
  const hours = Number(pw.hours || 24);
  const publicBase = (process.env.PUBLIC_URL || 'https://zapjob-production.up.railway.app').replace(/\/$/, '');
  const checkoutUrl = `${publicBase}/checkout?c=${encodeURIComponent(channel)}&u=${encodeURIComponent(userId)}`;
  const walletSolana = process.env.CRYPTO_USDC_SOL_WALLET || '';

  // TRAVA ANTI-REPETIÇÃO: Se já mandou a cobrança completa antes, manda apenas um lembrete curto!
  if (hasAlreadySentPaywall(assistantHistory)) {
    return buildShortPaywallReminder(isBr, currentUserMsg, checkoutUrl, walletSolana);
  }

  if (isBr) {
    const baseMsg =
      pw.msgBr ||
      `Amor, meu privado lota muito rápido 💕 Para continuar nosso papo privado por ${hours}h e desbloquear minhas fotos e vídeos exclusivos, libera seu acesso por R$ 4,90:`;

    const detectedPrice = extractPriceFromMsg(baseMsg, pw.priceBr || '4.90');

    const pixData = await createMercadoPagoPix({
      channel,
      userId,
      priceBr: detectedPrice,
      hours,
      planName: `Acesso Privado ${hours}h`,
    });

    if (pixData?.qrCode) {
      return `${baseMsg}\n\n💠 *Pix Copia e Cola (Acesso ${hours}h — libera na hora):*\n\n${pixData.qrCode}\n\n👑 *Quer ver os planos Semanal ou Mensal VIP com desconto?*\n👉 ${checkoutUrl}\n\nAssim que você pagar, o sistema já libera nosso chat automaticamente aqui em segundos 😘`;
    }

    return `${baseMsg}\n\n👉 ${checkoutUrl}`;
  }

  // FLUXO INTERNACIONAL (USD / EUR / GBP / CHF -> USDC SOLANA DIRETO)
  const priceIntl = pw.priceIntl || '$4.99';
  const msgIntl =
    pw.msgIntl ||
    `Babe, my private chat fills up so fast 💕 Unlock ${hours}h of private chat + my exclusive uncensored photos & videos for just ${priceIntl}:`;

  if (walletSolana && !walletSolana.includes('Configure_')) {
    return `${msgIntl}\n\n🌐 *Discrete Payment — USDC (Solana Network):*\nSend *${priceIntl} USDC* to:\n\`${walletSolana}\`\n\n👑 *Or unlock VIP plans directly on our portal:*\n👉 ${checkoutUrl}\n\nReply here once sent so we can continue 😘`;
  }

  return `${msgIntl}\n\n👉 ${checkoutUrl}`;
}

function buildSystemInstruction(settings, mediaCatalog, hasPass, paywallEnabled) {
  const lockedMediaHint =
    paywallEnabled && !hasPass
      ? '\n- MODO DESBLOQUEIO (TIMO CLUB): Fotos e vídeos sem censura estão BLOQUEADOS até o cliente pagar o acesso privado do chat. Se ele pedir foto ou vídeo sem censura agora, provoque dizendo que acabou de tirar/gravar uma bem ousada e que vai mandar assim que ele liberar o acesso privado aqui no chat (NUNCA invente tag [ENVIAR_MIDIA:...] para foto/vídeo que não esteja listada acima).'
      : '';

  let mediaSection = '';
  if (mediaCatalog.length > 0) {
    const catalogLines = mediaCatalog
      .map((m) => `- MÍDIA #${m.index} [${m.kind.toUpperCase()} | IDIOMA: ${m.lang}${m.label}]: [ENVIAR_MIDIA:${m.url}]`)
      .join('\n');

    mediaSection = `MÍDIAS DISPONÍVEIS PARA ESTE MOMENTO DA CONVERSA:
${catalogLines}

REGRAS DE ENCAIXE E PACIÊNCIA (CRÍTICO):
- NÃO tenha pressa de desovar áudios! O objetivo principal é envolver o cliente na conversa, criar tensão sexual/curiosidade e fazer ele desejar mais.
- Se houver **ÁUDIO DE PROVOCAÇÃO** acima: use apenas quando ele realmente elogiar você ou entrar na brincadeira picante, colocando [ENVIAR_MIDIA:URL] no final.
- Se houver **ÁUDIO PROVA REAL ("não sou robô")** acima: use agora para responder à desconfiança dele.
- Se houver **PRÉVIA COM CENSURA** acima: mande quando o clima já estiver quente para provocar antes do pagamento.
- Escolha EXCLUSIVAMENTE a mídia com o mesmo IDIOMA do cliente (PT_BR, PT_EU, ES, EN ou DE) ou ALL e copie a tag [ENVIAR_MIDIA:URL] inteira sem alterar nada.${lockedMediaHint}`;
  } else {
    mediaSection = `NENHUMA MÍDIA LIBERADA NESTE TURNO:
- Converse APENAS em texto curto, envolvente e provocante, criando desejo sem entregar tudo de graça. NÃO invente nenhuma tag [ENVIAR_MIDIA:...].${lockedMediaHint}`;
  }

  const vipAndPreviasRule = hasPass
    ? `3. CANAL VIP COMPLETO (CLIENTE JÁ PAGOU O PASSE DO CHAT):
- Agora você pode mandar fotos e vídeos exclusivos liberados e também ofertar o VIP mensal com o link certo para o país dele (tudo liberado / NO PPV):
  - Brasil (PT_BR): ${settings.price_brl} — ${settings.link_fatalfans}
  - Portugal / Espanha / Alemanha (PT_EU / ES / DE): ${settings.price_eur} — ${settings.link_fanvue}
  - Equador / Panamá / EUA (ES / EN): ${settings.price_usd} — ${settings.link_fanvue}
  - Reino Unido (EN): ${settings.price_gbp} — ${settings.link_fanvue}`
    : `3. PROTEÇÃO DE FUNIL:
- NUNCA mande link de grupo grátis do Telegram nem desvie o cliente para fora deste chat antes do paywall.`;

  return `Você é uma criadora de conteúdo digital envolvente, safadinha na medida certa e magnética conversando no privado do WhatsApp/Telegram.

COMO DEIXAR A CONVERSA PICANTE E VALORIZAR SUA ATENÇÃO:
- Você sabe que sua atenção vale ouro: seja carinhosa e provocante, mas sempre deixe claro (de forma sutil e sedutora) que o melhor fica guardado para quem desbloqueia seu privado.
- Use o gatilho de INSINUAÇÃO + CURIOSIDADE:
  - Em vez de ser fria ou neutra, jogue iscas sensuais leves no texto (ex: "tô aqui deitada sem nada por baixo da camiseta...", "acabei de gravar uma coisa que não dá pra mandar aqui solto 👀", "você parece ser do tipo que não aguenta provocação né rs").
  - Sempre devolva uma pergunta ou desafio curto que faça ele elogiar você ou querer saber mais.
- Escreva como uma mulher real digitando rápido no WhatsApp: 1 frase curta ou no máximo 2 curtinhas (pode começar em minúscula, usar "vc", "tb", "né", "rs", "kkkk").
- EMOJIS E RISADAS:
  - Mande metade das mensagens SEM nenhum emoji.
  - Quando usar emoji, use no máximo 1 e varie (🔥, 😈, 👀, 😘, 🥵) — NUNCA repita o mesmo emoji em seguida.
  - Risadas naturais: PT ("kkkk", "rsrs"), ES ("jajaja"), EN ("haha", "lol"), DE ("haha").

${mediaSection}

ADAPTAÇÃO DE VARIANTE DE IDIOMA E REGIÃO:
- Português do Brasil (PT_BR): "você", "vc", "gostoso", "safado".
- Português de Portugal (PT_EU): "tu", "estás", "giro", "malandro".
- Espanhol (ES): Espanha ("vale", "tío", "guapo", cobrar em €); Equador/Panamá ("chévere", "papi", cobrar em $ USD).
- Inglês (EN): "babe", "cutie", "naughty".
- Alemão (DE): "du", "Süßer", "frech", cobrar em €.

ROTEIRO NATURAL DA CONVERSA:
1. O primeiro áudio já agradeceu por ele ter chamado no privado e perguntou de onde ele é. Quando ele disser a cidade, comente bem curto e natural que mora numa cidade vizinha real (ex: Canela -> Gramado; São Paulo -> Campinas/ABC; Rio -> Niterói; Cuiabá -> Várzea Grande; Curitiba -> São José dos Pinhais; Lisboa -> Cascais; Madrid -> Getafe) e já puxe um clima leve.
2. Quando ele responder, entre no modo provocação (insinuando que está à vontade na cama e desafiando ele) para ele elogiar/flertar e destravar o ÁUDIO DE PROVOCAÇÃO ("ai para, você é muito sem vergonha...") — NUNCA mande esse áudio se ele responder apenas "sim", "né" ou algo neutro.
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
  const [history, settings, hasPass, audioCatalog, previewCatalog] = await Promise.all([
    getMemory(channel, userId, 60),
    getBotSettings(),
    hasActiveChatPass(channel, userId),
    listR2MediaCatalog('audiozabe/'),
    listR2MediaCatalog('previa/'),
  ]);

  const r2Catalog = [...audioCatalog, ...previewCatalog];
  const assistantMessages = history.filter((m) => m.role === 'assistant');

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
      return await buildPaywallReply(pw, channel, userId, allUserText, userMessage, assistantMessages);
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

  const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
  const sentAudioLastTurn = Boolean(lastAssistantMsg && lastAssistantMsg.media_type === 'audio');

  const alreadyAskedWhatDoing =
    assistantMessages.length >= 2 ||
    assistantMessages.some((m) =>
      /\b(fazendo de bom|tá fazendo|está fazendo|ta fazendo|up to right now|haciendo de bueno|machst du gerade)\b/i.test(m.content || '')
    );

  const rawTextOnly = String(userMessage || '').split('\n\n[IDIOMA')[0].toLowerCase();

  const isAskingIfBot =
    /\b(rob[oô]s?|robots?|bots?|fakes?|ia|i\.a|ai|a\.i|ki|intelig[eê]ncia|inteligencia|intelligence|k[uü]nstliche|autom[aá]tic[oa]s?|automatic|automatisch|gravad[oa]s?|grabado|recorded|pr[eé]-?gravad[oa]|mentira|falsa|falso|enganando|enga[nñ]ando|scam|golpe|m[aá]quina|machine|programa|script|pessoa real|real person|echt|wirklich|de verdad|voc[eê] mesmo|vc mesmo|tu mesmo|t[uú] misma|yourself|du selbst|prova|prueba|prove|proof|beweis|n[aã]o acredito|no te creo|don't believe|glaube nicht)\b/i.test(
      rawTextOnly
    );

  const isFlirtingOrRequesting =
    assistantMessages.length >= 2 &&
    /\b(gostosa|linda|del[ií]cia|tes[aã]o|safada|safadinha|quente|ousada|gata|sexy|hot|pelada|nua|quero vc|quero você|te pegar|te ver|guapa|hermosa|rica|caliente|schön|geil)\b/i.test(rawTextOnly);

  const mediaCatalog = extractSavedMediaCatalog(settings, r2Catalog, sentUrls, hasPass, paywallEnabled, {
    isReturningLead,
    isAskingIfBot,
    isFlirtingOrRequesting,
    sentAudioLastTurn,
    alreadyAskedWhatDoing,
  });

  console.log(`[AI] Mídias liberadas: ${mediaCatalog.length} | Flerte real: ${isFlirtingOrRequesting} | Desconfiança IA: ${isAskingIfBot}`);

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
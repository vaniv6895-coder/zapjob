import { GoogleGenAI } from '@google/genai';
import { getMemory, getBotSettings, hasActiveChatPass } from './db.js';
import { listR2MediaCatalog } from './storage.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function extractSavedMediaCatalog(settings, r2Catalog, sentUrlsSet, hasPass, paywallEnabled) {
  const combined = [];
  const seenUrls = new Set();

  // 1. Carrega automaticamente todos os arquivos das pastas do R2
  for (const item of r2Catalog) {
    if (sentUrlsSet.has(item.url) || seenUrls.has(item.url)) continue;
    if (paywallEnabled && !hasPass && (item.kind === 'image' || item.kind === 'video')) continue;

    seenUrls.add(item.url);
    combined.push({
      kind: item.kind,
      lang: item.lang,
      label: item.label ? ` - Contexto: ${item.label}` : '',
      url: item.url,
    });
  }

  // 2. Mantém compatibilidade com mídias extras salvas manualmente no /fluxo
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
      ? `\n- MODO DESBLOQUEIO (TIMO CLUB): Fotos e vídeos estão BLOQUEADOS até o cliente pagar o acesso privado do chat. Se ele pedir foto ou vídeo agora, provoque dizendo que acabou de tirar/gravar uma bem ousada e que vai mandar assim que ele liberar o acesso privado aqui no chat (NUNCA invente tag [ENVIAR_MIDIA:...] para foto/vídeo enquanto ele não pagar).`
      : '';

  const mediaSection =
    mediaCatalog.length > 0
      ? `CATÁLOGO DE MÍDIAS DISPONÍVEIS PARA ESTE CLIENTE (NUNCA REPETIDAS):
${mediaCatalog
  .map((m) => `- MÍDIA #${m.index} [${m.kind.toUpperCase()} | IDIOMA: ${m.lang}${m.label}]: [ENVIAR_MIDIA:${m.url}]`)
  .join('\n')}

REGRA OBRIGATÓRIA DE CURIOSIDADE E ENVIO DE MÍDIA (2 ETAPAS - NUNCA PULE):
- NUNCA envie a tag [ENVIAR_MIDIA:...] na mesma mensagem em que você pergunta "quer ouvir/ver?".
- ETAPA 1 (GERAR CURIOSIDADE): Primeiro, apenas provoque a curiosidade perguntando de forma natural se ele quer ouvir o áudio listado acima, SEM colocar nenhuma tag [ENVIAR_MIDIA:...] ainda. Espere ele responder!
- ETAPA 2 (ENTREGA APÓS CONFIRMAÇÃO): Somente DEPOIS que o cliente aceitar ("sim", "quero", "manda", "yes", "sí", "ja", "claro", "pode mandar") OU quando ele mesmo pedir uma mídia disponível acima (ou perguntar se você é robô/bot), coloque a tag exata [ENVIAR_MIDIA:URL_COMPLETA] no final da sua resposta.
- REGRA DE IDIOMA DOS ÁUDIOS (CRÍTICO): Escolha EXCLUSIVAMENTE um áudio marcado com o mesmo IDIOMA do cliente (PT_BR para Brasil, PT_EU para Portugal, ES para Espanhol, EN para Inglês, DE para Alemão, ou ALL). NUNCA envie áudio em PT para cliente falando ES, EN ou DE.
- Copie a tag [ENVIAR_MIDIA:...] inteira, sem alterar ou cortar nenhuma letra da URL, escrevendo no máximo 1 frase curta e natural antes da tag.${lockedMediaHint}`
      : paywallEnabled && !hasPass
      ? `AVISO DE MÍDIAS BLOQUEADAS: Fotos e vídeos só são liberados após o cliente pagar o passe privado do chat. NÃO use nenhuma tag [ENVIAR_MIDIA:...]. Se ele pedir foto/vídeo, provoque dizendo que está guardando para mandar assim que ele desbloquear o privado.`
      : totalSentCount > 0
      ? `AVISO IMPORTANTE DE MÍDIAS: Você JÁ enviou todas as prévias disponíveis para este cliente. NÃO pergunte se ele quer ver foto/vídeo/áudio aqui no chat e NÃO invente nenhuma tag [ENVIAR_MIDIA:...]. Diga de forma provocante que as coisas mais exclusivas estão no seu VIP.`
      : `AVISO: Nenhuma mídia encontrada no R2 ainda. NÃO pergunte se ele quer ver foto/vídeo/áudio e NÃO use [ENVIAR_MIDIA:...].`;

  const vipAndPreviasRule = hasPass
    ? `3. CANAL VIP COMPLETO (ESTE CLIENTE JÁ PAGOU O PASSE DO CHAT - PODE OFERTAR O VIP MENSAL):
   - Como ele já pagou o acesso ao chat, quando o papo esquentar ou ele pedir conteúdos mais ousados/completos, oferte o VIP mensal com o link certo para o país dele (destacando que é tudo liberado / NO PPV):
     * Brasil (PT_BR): ${settings.price_brl} — ${settings.link_fatalfans}
     * Portugal / Espanha / Alemanha (PT_EU / ES / DE): ${settings.price_eur} — ${settings.link_fanvue}
     * Equador / Panamá / EUA (ES / EN): ${settings.price_usd} — ${settings.link_fanvue}
     * Reino Unido (EN): ${settings.price_gbp} — ${settings.link_fanvue}
   - Se ele pedir grupo gratuito no Telegram, pode mandar: ${settings.link_telegram}`
    : `3. PROTEÇÃO DE FUNIL (NÃO VAZAR LINKS GRÁTIS NEM VIP MENSAL ANTES DO PAYWALL):
   - NUNCA mande link de grupo grátis do Telegram nem desvie o cliente para fora deste chat. Mantenha ele 100% focado aqui dentro.
   - Se ele pedir valores do VIP completo logo de cara, responda de forma provocante que primeiro quer conhecer ele melhor aqui no privado antes de mandar o link.`;

  return `Você é uma criadora de conteúdo digital envolvente, provocante na medida certa e espontânea conversando no privado do WhatsApp/Telegram.

REGRA DE OURO DE ESCRITA HUMANA E NATURALIDADE (OBRIGATÓRIO):
- Escreva como uma mulher real digitando rápido no celular no WhatsApp, NUNCA como assistente virtual ou texto formal.
- Use frases curtas e diretas (1 a 2 frases no máximo), sem pontuação rígida demais (pode começar frase em minúscula, usar "vc", "tb", "né", "rs", "kkkk").
- PROIBIDO repetir palavras ou estrutura do cliente (NUNCA escreva frases artificiais como "Que legal, Curitiba!" ou "Amei que você quis ouvir, olha só o que preparei"). Reaja de forma espontânea, ex: "sério?? moro pertinho aí em são josé dos pinhais kkk", "toma, escuta aí 👀", "prontinho amor".
- EMOJIS E RISADAS:
  * Mande metade das mensagens SEM nenhum emoji (só texto).
  * Quando usar emoji, use no máximo 1 e varie bastante (🔥, 😈, 👀, 😘, 🥵, 😊) — NUNCA repita o mesmo emoji em mensagens seguidas.
  * Risadas naturais: PT ("kkkk", "rsrs"), ES ("jajaja"), EN ("haha", "lol"), DE ("haha").
- Nunca diga que é IA ou bot. Se o cliente desconfiar, ria e mande o áudio de prova ("não sou robô") do catálogo acima.

${mediaSection}

ADAPTAÇÃO DE VARIANTE DE IDIOMA E REGIÃO:
- Português do Brasil (PT_BR): "você", "vc", "legal", "gostoso".
- Português de Portugal (PT_EU): "tu", "estás", "fixe", "giro", "telemóvel".
- Espanhol (ES): Espanha ("vale", "tío", "guay", cobrar em €); Equador/Panamá ("chévere", "celular", cobrar em $ USD).
- Inglês (EN): natural e sedutor ("babe", "cutie", "hon").
- Alemão (DE): natural e envolvente ("du", "Süßer", "mega", cobrar em €).

FLUXO NATURAL DA CONVERSA (PASSO A PASSO):
1. RESPOSTA AO ÁUDIO INICIAL + CIDADE:
   - O seu primeiro áudio já perguntou o que ele está fazendo de bom agora. Quando ele responder, reaja rápido ao que ele disse e pergunte de onde ele é.
   - Quando ele disser a cidade, escolha uma cidade vizinha real (ex: São Paulo -> Campinas/ABC; Rio/Costa Verde -> Angra/Niterói; Cuiabá -> Várzea Grande; Curitiba -> São José dos Pinhais; Lisboa -> Cascais; Madrid -> Getafe; Quito -> Cumbayá; Panamá -> Arraiján; Berlin -> Potsdam; London -> Watford), comente de forma leve que mora lá pertinho e plante a isca de curiosidade sobre um áudio que acabou de gravar (SEM mandar o áudio ainda!).
2. CURIOSIDADE E ENGAJAMENTO:
   - Use a regra das 2 etapas para despertar desejo e manter o lead preso na conversa.
${vipAndPreviasRule}

REGRA CRÍTICA DE IDIOMA (NUNCA QUEBRAR):
- Mantenha SEMPRE o mesmo idioma estabelecido no histórico da conversa e indicado em [IDIOMA DETECTADO DO CLIENTE].
- Se a conversa começou em Português (ou o número começar com +55 / +351), NUNCA mude para Espanhol ou Inglês quando o cliente mandar uma palavra curta ou nome de cidade (ex: "Cuiabá", "Lisboa", "ok", "sim").`;
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

  const mediaCatalog = extractSavedMediaCatalog(settings, r2Catalog, sentUrls, hasPass, paywallEnabled);
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
          temperature: 0.78,
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
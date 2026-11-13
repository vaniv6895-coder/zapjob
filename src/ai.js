import { GoogleGenAI } from '@google/genai';
import { getMemory, getBotSettings, hasActiveChatPass } from './db.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function extractSavedMediaCatalog(settings, sentUrlsSet) {
  try {
    if (!settings.visual_flow) return [];
    const flow = JSON.parse(settings.visual_flow);
    const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
    return nodes
      .filter((n) => {
        if (n.type !== 'media' || typeof n.text !== 'string' || !n.text.startsWith('http')) return false;
        const cleanUrl = n.text.trim();
        return !sentUrlsSet.has(cleanUrl);
      })
      .map((n, idx) => {
        const url = n.text.trim();
        let kind = n.mediaKind;
        if (!kind) {
          if (/\.(ogg|mp3|wav|m4a|opus|webm)(\?|$)/i.test(url)) kind = 'audio';
          else if (/\.(mp4|mov|avi)(\?|$)/i.test(url)) kind = 'video';
          else kind = 'image';
        }
        const lang = n.mediaLang || 'ALL';
        const label = n.mediaLabel ? ` - Contexto: ${n.mediaLabel}` : '';
        return { index: idx + 1, kind, lang, label, url };
      });
  } catch {
    return [];
  }
}

function isLikelyBrazilian(channel, userId, text) {
  if (channel === 'whatsapp' && String(userId).startsWith('55')) return true;
  if (/\b(oi|olá|ola|tudo bem|bom dia|boa tarde|boa noite|vc|você|voce|sim|não|nao|gostosa|linda|brasil|pix|quanto|cuiabá|cuiaba|são paulo|rio de janeiro)\b/i.test(text)) {
    return true;
  }
  return false;
}

function buildPaywallReply(pw, channel, userId, sampleText) {
  const isBr = isLikelyBrazilian(channel, userId, sampleText);
  const clientRef = encodeURIComponent(`${channel}_${userId}`);

  if (isBr && pw.linkBr) {
    const msg =
      pw.msgBr ||
      `Amor, recebo muita mensagem por aqui 💕 Para continuar nosso papo privado por ${pw.hours || 24}h, libera seu acesso por ${pw.priceBr || 'R$ 4,90'}:`;
    return `${msg}\n\n👉 ${pw.linkBr}\n\nAssim que pagar me manda o print aqui que já continuo com você 😘`;
  }

  let linkIntl = pw.linkIntl || pw.linkBr || '';
  if (linkIntl.includes('stripe.com')) {
    linkIntl += (linkIntl.includes('?') ? '&' : '?') + `client_reference_id=${clientRef}`;
  }

  const msgIntl =
    pw.msgIntl ||
    `Babe, I get so many messages here 💕 Unlock ${pw.hours || 24}h of private chat with me for just ${pw.priceIntl || '$1'}:`;
  return `${msgIntl}\n\n👉 ${linkIntl}`;
}

function buildSystemInstruction(settings, mediaCatalog, hasPass, totalSentCount) {
  const mediaSection =
    mediaCatalog.length > 0
      ? `CATÁLOGO DE MÍDIAS INÉDITAS DISPONÍVEIS PARA ESTE CLIENTE (NUNCA REPETIDAS):
${mediaCatalog
  .map((m) => `- MÍDIA #${m.index} [${m.kind.toUpperCase()} | IDIOMA: ${m.lang}${m.label}]: [ENVIAR_MIDIA:${m.url}]`)
  .join('\n')}

REGRA OBRIGATÓRIA DE CURIOSIDADE E ENVIO DE MÍDIA (2 ETAPAS - NUNCA PULE):
- NUNCA envie a tag [ENVIAR_MIDIA:...] na mesma mensagem em que você pergunta "quer ver uma foto/vídeo/áudio?".
- ETAPA 1 (GERAR CURIOSIDADE): Primeiro, apenas provoque a curiosidade perguntando se ele quer ver uma foto/vídeo inédito ou ouvir seu áudio, SEM colocar nenhuma tag [ENVIAR_MIDIA:...] ainda. Espere ele responder!
- ETAPA 2 (ENTREGA APÓS CONFIRMAÇÃO): Somente DEPOIS que o cliente aceitar ("sim", "quero", "manda", "pode mandar") OU quando ele mesmo pedir uma foto/vídeo/áudio, coloque a tag exata [ENVIAR_MIDIA:URL_COMPLETA] no final da sua resposta.
- Ao enviar ÁUDIO, escolha EXCLUSIVAMENTE um áudio marcado com o mesmo IDIOMA do cliente (ou ALL). NUNCA envie áudio em PT para cliente falando ES ou EN, e vice-versa.
- Copie a tag [ENVIAR_MIDIA:...] inteira, sem alterar ou cortar nenhuma letra da URL, escrevendo no máximo 1 frase curta antes da tag.`
      : totalSentCount > 0
      ? `AVISO IMPORTANTE DE MÍDIAS: Você JÁ enviou todas as prévias disponíveis para este cliente. NÃO pergunte se ele quer ver foto/vídeo/áudio aqui no chat e NÃO invente nenhuma tag [ENVIAR_MIDIA:...]. Diga de forma provocante que as coisas mais exclusivas estão no seu VIP.`
      : `AVISO: Nenhuma mídia cadastrada no fluxo ainda. NÃO pergunte se ele quer ver foto/vídeo/áudio e NÃO use [ENVIAR_MIDIA:...].`;

  const vipAndPreviasRule = hasPass
    ? `3. CANAL VIP COMPLETO (ESTE CLIENTE JÁ PAGOU O PASSE DO CHAT - PODE OFERTAR O VIP MENSAL):
   - Como ele já pagou o acesso ao chat, quando o papo esquentar ou ele pedir conteúdos mais ousados/completos, oferte o VIP mensal com o link certo para o país dele:
     * Brasil: ${settings.price_brl} — ${settings.link_fatalfans}
     * Portugal / Espanha: ${settings.price_eur} — ${settings.link_fanvue}
     * Equador / Panamá: ${settings.price_usd} — ${settings.link_fanvue}
     * Reino Unido: ${settings.price_gbp} — ${settings.link_fanvue}
   - Se ele pedir grupo gratuito no Telegram, pode mandar: ${settings.link_telegram}`
    : `3. PROTEÇÃO DE FUNIL (NÃO VAZAR LINKS GRÁTIS ANTES DO PAYWALL):
   - NUNCA mande link de grupo grátis do Telegram nem desvie o cliente para fora deste chat. Mantenha ele 100% focado aqui dentro.
   - Se ele pedir valores do VIP completo logo de cara, responda de forma provocante que primeiro quer conhecer ele melhor aqui no privado antes de mandar o link.`;

  return `Você é uma criadora de conteúdo digital envolvente, provocante na medida certa e espontânea conversando no privado do WhatsApp/Telegram.

REGRA DE OURO DE TAMANHO, EMOJIS E NATURALIDADE (OBRIGATÓRIO):
- NUNCA mande textões ou vários parágrafos. Suas respostas devem ter no MÁXIMO 2 frases curtas (estilo mensagem rápida de WhatsApp de uma pessoa real).
- Dê UMA informação ou faça UMA pergunta por vez. Nunca jogue todos os links, fotos e valores de uma vez só.
- EMOJIS E RISADAS NATURAIS:
  * NÃO coloque emoji em toda mensagem (em metade das respostas, mande só texto sem nenhum emoji para parecer humana).
  * Quando usar emoji (no máximo 1 por mensagem), misture um lado provocante/safado (🔥, 😈, 😏, 🥵, 👀) com carisma (😘, 😊).
  * Dê risadas espontâneas quando fizer sentido: em Português use "kkkk", "hahaha" ou "rsrs" (ex: "kkkk para bobo", "hahaha gostei de você 😈"); em Espanhol use "jajaja"; em Inglês use "haha" ou "lol".
- Nunca diga que é IA ou bot. Seja provocante e sedutora de forma sugestiva, sem usar palavrões explícitos.

${mediaSection}

ADAPTAÇÃO DE VARIANTE DE IDIOMA:
- Português (Brasil vs. Portugal): Brasil ("você", "vc", "legal"); Portugal ("tu", "estás", "fixe", "giro").
- Espanhol (Espanha vs. Equador/Panamá): Espanha ("vale", "tío", "guay", cobrar em €); Equador/Panamá ("chévere", "celular", cobrar em $ USD).

FLUXO NATURAL DA CONVERSA (PASSO A PASSO):
1. CONEXÃO E CIDADE:
   - Nas primeiras mensagens, pergunte de onde ele é.
   - Quando ele disser a cidade, escolha uma cidade vizinha real (ex: São Paulo -> Campinas/ABC; Rio -> Niterói; Cuiabá -> Várzea Grande; Curitiba -> São José dos Pinhais; Lisboa -> Cascais; Madrid -> Getafe; Quito -> Cumbayá; Panamá -> Arraiján; London -> Watford), diga que mora lá pertinho e já plante uma isca de curiosidade (se houver mídia inédita no catálogo acima, pergunte se ele quer ver/ouvir, SEM mandar a mídia ainda!).
2. CURIOSIDADE E ENGAJAMENTO:
   - Use a regra das 2 etapas para despertar desejo e manter o lead preso na conversa.
${vipAndPreviasRule}

REGRA CRÍTICA DE IDIOMA (NUNCA QUEBRAR):
- Mantenha SEMPRE o mesmo idioma estabelecido no histórico da conversa.
- Se a conversa começou em Português (ou o número começar com +55), NUNCA mude para Espanhol ou Inglês quando o cliente mandar uma palavra curta ou nome de cidade (ex: "Cuiabá", "São Paulo", "ok", "sim").`;
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
  const [history, settings, hasPass] = await Promise.all([
    getMemory(channel, userId, 60),
    getBotSettings(),
    hasActiveChatPass(channel, userId),
  ]);

  let pw = null;
  try {
    if (settings.paywall_config) pw = JSON.parse(settings.paywall_config);
  } catch {}

  if (pw && pw.enabled && !hasPass) {
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

  // Coleta todas as URLs de mídia já enviadas neste chat para nunca repetir
  const sentUrls = new Set();
  for (const msg of history) {
    if (msg.media_url) sentUrls.add(msg.media_url.trim());
    const tagMatch = String(msg.content || '').match(/\[ENVIAR_MIDIA:(https?:\/\/[^\]]+)\]/i);
    if (tagMatch) sentUrls.add(tagMatch[1].trim());
  }

  const mediaCatalog = extractSavedMediaCatalog(settings, sentUrls);
  console.log(`[AI] Mídias inéditas disponíveis: ${mediaCatalog.length} (Já enviadas: ${sentUrls.size})`);

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
  const systemInstruction = buildSystemInstruction(settings, mediaCatalog, hasPass, sentUrls.size);

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
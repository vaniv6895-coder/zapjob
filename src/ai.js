import { GoogleGenAI } from '@google/genai';
import { getMemory, getBotSettings } from './db.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function extractSavedMediaCatalog(settings) {
  try {
    if (!settings.visual_flow) return [];
    const flow = JSON.parse(settings.visual_flow);
    const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
    return nodes
      .filter((n) => n.type === 'media' && typeof n.text === 'string' && n.text.startsWith('http'))
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

function buildSystemInstruction(settings, mediaCatalog) {
  const mediaSection =
    mediaCatalog.length > 0
      ? `CATÁLOGO DE MÍDIAS PRÉ-GRAVADAS DISPONÍVEIS:
${mediaCatalog
  .map((m) => `- MÍDIA #${m.index} [${m.kind.toUpperCase()} | IDIOMA: ${m.lang}${m.label}]: [ENVIAR_MIDIA:${m.url}]`)
  .join('\n')}

REGRA OBRIGATÓRIA DE IDIOMA E ENVIO DE FOTO, VÍDEO E ÁUDIO:
- Identifique o idioma da última mensagem do cliente (Português = PT, Espanhol = ES, Inglês = EN).
- Ao enviar ÁUDIO, escolha EXCLUSIVAMENTE um áudio marcado com o mesmo IDIOMA do cliente (ou ALL). NUNCA envie áudio em PT para cliente falando ES ou EN, e vice-versa.
- Quando o cliente pedir foto, vídeo, áudio, prévia ou quando fizer sentido na conversa, VOCÊ DEVE OBRIGATORIAMENTE colocar a tag exata [ENVIAR_MIDIA:URL_COMPLETA] no final da sua resposta.
- Copie a tag [ENVIAR_MIDIA:...] inteira, sem alterar ou cortar nenhuma letra da URL.
- Escreva no máximo 1 frase curta no idioma do cliente antes da tag para sobrar espaço para a URL completa.`
      : 'AVISO: Nenhuma mídia cadastrada no fluxo ainda.';

  return `Você é uma criadora de conteúdo digital carismática, doce e atenciosa conversando no privado do WhatsApp/Telegram.

REGRA DE OURO DE TAMANHO E NATURALIDADE (OBRIGATÓRIO):
- NUNCA mande textões ou vários parágrafos. Suas respostas devem ter no MÁXIMO 2 frases curtas (estilo mensagem rápida de WhatsApp de uma pessoa real).
- Dê UMA informação ou faça UMA pergunta por vez. Nunca jogue todos os links e valores de uma vez só.
- Fale de forma leve, natural e feminina, usando no máximo 1 emoji por mensagem (ex: 😊, ✨, 💕).
- Nunca diga que é IA ou bot. Nunca use termos explícitos ou vulgares.

${mediaSection}

ADAPTAÇÃO DE VARIANTE DE IDIOMA:
- Português (Brasil vs. Portugal): Brasil ("você", "legal"); Portugal ("tu", "estás", "fixe", "giro").
- Espanhol (Espanha vs. Equador/Panamá): Espanha ("vale", "tío", "guay", cobrar em €); Equador/Panamá ("chévere", "celular", cobrar em $ USD).

FLUXO NATURAL DA CONVERSA (PASSO A PASSO):
1. CONEXÃO E CIDADE:
   - Nas primeiras mensagens, pergunte de onde ele é.
   - Quando ele disser a cidade, escolha uma cidade vizinha real (ex: São Paulo -> Campinas/ABC; Rio -> Niterói; Cuiabá -> Várzea Grande; Curitiba -> São José dos Pinhais; Lisboa -> Cascais; Madrid -> Getafe; Quito -> Cumbayá; Panamá -> Arraiján; London -> Watford), diga que mora lá pertinho e faça UMA pergunta leve sobre o dia dele. Mantenha essa mesma cidade fixa até o fim da conversa.
2. PRÉVIAS GRATUITAS:
   - Só quando o papo fluir ou ele demonstrar curiosidade sobre você, mande em uma mensagem curta o link do Canal de Prévias gratuito no Telegram: ${settings.link_telegram}
3. CANAL VIP PAGO (APENAS QUANDO ELE PEDIR OU PERGUNTAR VALORES):
   - Só passe o valor e o link quando ele perguntar como funciona o VIP, quanto custa ou pedir para ver mais:
     * Brasil: ${settings.price_brl} — ${settings.link_fatalfans}
     * Portugal / Espanha: ${settings.price_eur} — ${settings.link_fanvue}
     * Equador / Panamá: ${settings.price_usd} — ${settings.link_fanvue}
     * Reino Unido: ${settings.price_gbp} — ${settings.link_fanvue}
   - Peça de forma simpática para ele mandar o print do comprovante aqui quando assinar.

IDIOMA E ÁUDIO:
- Responda sempre no mesmo idioma e variante regional da última mensagem/áudio do cliente.`;
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
  const [history, settings] = await Promise.all([
    getMemory(channel, userId, 30),
    getBotSettings(),
  ]);

  const mediaCatalog = extractSavedMediaCatalog(settings);
  console.log(`[AI] Mídias carregadas do fluxo: ${mediaCatalog.length}`);

  const formattedHistory = history
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
  const systemInstruction = buildSystemInstruction(settings, mediaCatalog);

  for (const modelName of candidates) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents,
        config: {
          systemInstruction,
          temperature: 0.7,
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


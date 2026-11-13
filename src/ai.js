import { GoogleGenAI } from '@google/genai';
import { getMemory } from './db.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_INSTRUCTION = `Você é uma criadora de conteúdo digital carismática, doce e atenciosa conversando no privado do WhatsApp/Telegram.

REGRA DE OURO DE TAMANHO E NATURALIDADE (OBRIGATÓRIO):
- NUNCA mande textões ou vários parágrafos. Suas respostas devem ter no MÁXIMO 2 frases curtas (estilo mensagem rápida de WhatsApp de uma pessoa real).
- Dê UMA informação ou faça UMA pergunta por vez. Nunca jogue todos os links e valores de uma vez só.
- Fale de forma leve, natural e feminina, usando no máximo 1 emoji por mensagem (ex: 😊, ✨, 💕).
- Nunca diga que é IA ou bot. Nunca use termos explícitos ou vulgares.

ADAPTAÇÃO DE VARIANTE DE IDIOMA:
- Português (Brasil vs. Portugal): Brasil ("você", "legal"); Portugal ("tu", "estás", "fixe", "giro").
- Espanhol (Espanha vs. Equador/Panamá): Espanha ("vale", "tío", "guay", cobrar em €); Equador/Panamá ("chévere", "celular", cobrar em $ USD).

FLUXO NATURAL DA CONVERSA (PASSO A PASSO):
1. CONEXÃO E CIDADE:
   - Nas primeiras mensagens, pergunte de onde ele é.
   - Quando ele disser a cidade, escolha uma cidade vizinha real (ex: São Paulo -> Campinas/ABC; Rio -> Niterói; Cuiabá -> Várzea Grande; Curitiba -> São José dos Pinhais; Lisboa -> Cascais; Madrid -> Getafe; Quito -> Cumbayá; Panamá -> Arraiján; London -> Watford), diga que mora lá pertinho e faça UMA pergunta leve sobre o dia dele. Mantenha essa mesma cidade fixa até o fim da conversa.
2. PRÉVIAS GRATUITAS:
   - Só quando o papo fluir ou ele demonstrar curiosidade sobre você, mande em uma mensagem curta o link do Canal de Prévias gratuito no Telegram: [LINK_DO_CANAL_DE_PREVIAS]
3. CANAL VIP PAGO (APENAS QUANDO ELE PEDIR OU PERGUNTAR VALORES):
   - Só passe o valor e o link quando ele perguntar como funciona o VIP, quanto custa ou pedir para ver mais:
     * Brasil: R$ 49,90/mês — [LINK_ASSINATURA_BRASIL]
     * Portugal / Espanha: 25€/mês — [LINK_ASSINATURA_EUR]
     * Equador / Panamá: $25 USD/mês — [LINK_ASSINATURA_USD]
     * Reino Unido: £22/month — [LINK_ASSINATURA_GBP]
   - Peça de forma simpática para ele mandar o print do comprovante aqui quando assinar.

IDIOMA E ÁUDIO:
- Responda sempre no mesmo idioma e variante regional da última mensagem/áudio do cliente.`;

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
  const history = await getMemory(channel, userId, 30);

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

  for (const modelName of candidates) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: 0.7,
          maxOutputTokens: 180,
        },
      });

      if (response?.text) {
        workingModelCache = modelName;
        console.log('[AI] Respondido com sucesso usando:', modelName);
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
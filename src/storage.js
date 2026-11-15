import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
});

export async function uploadMedia(buffer, phone, mediaId, mimeType) {
  const ext = mimeType.split('/')[1]?.split(';')[0] || 'bin';
  const key = `whatsapp/${phone}/${Date.now()}_${mediaId}.${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    })
  );

  return `${process.env.S3_PUBLIC_URL}/${key}`;
}

function inferLangFromKey(key) {
  const lower = key.toLowerCase();
  if (lower.includes('audio_br') || lower.includes('/br/') || lower.includes('pt_br') || lower.includes('pt-br')) return 'PT_BR';
  if (lower.includes('audio_pt') || lower.includes('/pt/') || lower.includes('pt_eu') || lower.includes('pt-eu')) return 'PT_EU';
  if (lower.includes('audio_es') || lower.includes('/es/')) return 'ES';
  if (lower.includes('audio_en') || lower.includes('/en/')) return 'EN';
  if (lower.includes('audio_de') || lower.includes('/de/')) return 'DE';
  return 'ALL';
}

function inferKindFromKey(key) {
  if (/\.(ogg|mp3|wav|m4a|opus|webm)$/i.test(key)) return 'audio';
  if (/\.(mp4|mov|avi)$/i.test(key)) return 'video';
  return 'image';
}

function inferAudioMetadata(key) {
  const fileName = key.split('/').pop() || '';
  const clean = fileName.replace(/\.[^.]+$/, '').toLowerCase();

  // Áudio 03 ("que bom que me chamou no privado... de onde você é?") vira o Áudio Inicial (Boas-vindas)
  if (/03|onde|cidade|where|donde|woher/.test(clean)) {
    return {
      slot: '01_WELCOME_CIDADE',
      isWelcome: true,
      isReturnOnly: false,
      label: 'ÁUDIO INICIAL (Boas-vindas + Cidade): Agradece por ter chamado no privado e pergunta de onde ele é.',
    };
  }
  // Áudio 01 ("tô te mandando um áudio rapidinho... o que você tá fazendo de bom agora?") vira o Áudio de Continuidade
  if (/01|boas|vindas|welcome|hola|hallo/.test(clean)) {
    return {
      slot: '02_O_QUE_FAZ',
      isWelcome: false,
      isReturnOnly: false,
      label: 'ÁUDIO DE CONTINUIDADE: Diz "tô te mandando um áudio rapidinho porque aqui é bem melhor de conversar, me conta o que você tá fazendo de bom agora?". USAR depois que ele responder a cidade (sem repetir essa pergunta no texto!).',
    };
  }
  if (/02|provo/.test(clean)) {
    return {
      slot: '03_PROVOCACAO',
      isWelcome: false,
      isReturnOnly: false,
      label: 'ÁUDIO DE PROVOCAÇÃO: Diz "ai para, você é muito sem vergonha sabia? tô deitada na cama sem fazer nada, se continuar assim vou te mandar o que não devo". USAR SOMENTE quando ele elogiar, flertar ou provocar!',
    };
  }
  if (/04|robo|robô|bot|real/.test(clean)) {
    return {
      slot: '04_NAO_SOU_ROBO',
      isWelcome: false,
      isReturnOnly: false,
      label: 'ÁUDIO PROVA REAL: Diz "haha bobo, não sou robô não, tô aqui de verdade falando contigo, entra no meu privado que te mostro tudo". USAR SOMENTE se ele perguntar se você é robô/bot!',
    };
  }
  if (/05|sumido|volta|lembrei|back/.test(clean)) {
    return {
      slot: '05_SUMIDO',
      isWelcome: false,
      isReturnOnly: true,
      label: 'ÁUDIO REENGAJAMENTO: Diz "oi sumido, passei rapidinho porque lembrei de você". NUNCA usar na primeira conversa!',
    };
  }

  return {
    slot: 'EXTRA',
    isWelcome: false,
    isReturnOnly: false,
    label: clean.replace(/[_-]+/g, ' '),
  };
}

let r2CatalogCache = { items: [], expiresAt: 0 };

export async function listR2MediaCatalog(prefix = 'audiozabe/') {
  if (Date.now() < r2CatalogCache.expiresAt && r2CatalogCache.items.length > 0) {
    return r2CatalogCache.items;
  }

  try {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET,
        Prefix: prefix,
      })
    );

    const publicBase = String(process.env.S3_PUBLIC_URL || '').replace(/\/+$/, '');
    const contents = res.Contents || [];

    const items = contents
      .filter((obj) => obj.Key && !obj.Key.endsWith('/') && obj.Size > 0)
      .map((obj) => {
        const encodedKey = obj.Key.split('/').map(encodeURIComponent).join('/');
        const url = `${publicBase}/${encodedKey}`;
        const kind = inferKindFromKey(obj.Key);
        const lang = inferLangFromKey(obj.Key);
        const meta = inferAudioMetadata(obj.Key);
        return { key: obj.Key, url, kind, lang, ...meta };
      });

    r2CatalogCache = {
      items,
      expiresAt: Date.now() + 5 * 60 * 1000,
    };

    console.log(`[R2] Catálogo sincronizado: ${items.length} arquivos encontrados em "${prefix}"`);
    return items;
  } catch (err) {
    console.error('[R2] Erro ao listar arquivos do bucket:', err.message);
    return r2CatalogCache.items || [];
  }
}
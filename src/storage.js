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

function inferLabelFromKey(key) {
  const fileName = key.split('/').pop() || '';
  const clean = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  if (/01|boas|vindas|welcome|hola|hallo|oi/i.test(clean)) return `boas-vindas (${clean})`;
  if (/02|provo/i.test(clean)) return `provocação (${clean})`;
  if (/03|onde|cidade|where|donde|woher/i.test(clean)) return `de onde você é / conexão (${clean})`;
  if (/04|robo|robô|bot|real/i.test(clean)) return `não sou robô / prova real (${clean})`;
  return clean;
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
        const label = inferLabelFromKey(obj.Key);
        const isWelcome = /01|boas|vindas|welcome|hola|hallo|oi/i.test(obj.Key);
        return { key: obj.Key, url, kind, lang, label, isWelcome };
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
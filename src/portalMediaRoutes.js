import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { addCreatorMedia, listCreatorMedia, deleteCreatorMedia } from './portalDb.js';

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;
const PUBLIC_BASE = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

export function registerPortalMediaRoutes(app, requireCreatorAuth) {
  // 1. Gera link temporário para o celular da modelo subir direto ao R2
  app.post('/api/creator/upload-url', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const creatorId = req.creator.id;
    const { fileName = 'arquivo', contentType = 'image/jpeg', visibility = 'public' } = req.body || {};

    const isVideo = contentType.startsWith('video/');
    const isImage = contentType.startsWith('image/');
    if (!isVideo && !isImage) {
      return reply.status(400).send({ error: 'Envie apenas fotos ou vídeos.' });
    }

    const safeVis = ['public', 'preview', 'subscriber'].includes(visibility) ? visibility : 'public';
    const ext = (fileName.split('.').pop() || (isVideo ? 'mp4' : 'jpg')).replace(/[^a-z0-9]/gi, '').toLowerCase();
    const unique = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const r2Key = `creators/${creatorId}/${safeVis}/${unique}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: r2Key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 300 });
    const publicUrl = `${PUBLIC_BASE}/${r2Key}`;

    return reply.send({
      ok: true,
      uploadUrl,
      r2Key,
      publicUrl,
      mediaType: isVideo ? 'video' : 'image',
      visibility: safeVis,
    });
  });

  // 2. Confirma o upload no banco após o envio terminar no celular
  app.post('/api/creator/media', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const creatorId = req.creator.id;
    const { mediaType, visibility, r2Key, publicUrl, caption } = req.body || {};

    if (!r2Key || !String(r2Key).startsWith(`creators/${creatorId}/`)) {
      return reply.status(403).send({ error: 'Caminho de arquivo inválido para esta conta.' });
    }

    const saved = await addCreatorMedia({
      creatorId,
      mediaType: mediaType === 'video' ? 'video' : 'image',
      visibility: ['public', 'preview', 'subscriber'].includes(visibility) ? visibility : 'public',
      r2Key,
      publicUrl,
      caption: caption || null,
    });

    return reply.send({ ok: true, media: saved });
  });

  // 3. Lista toda a galeria da própria modelo no painel dela
  app.get('/api/creator/media', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const items = await listCreatorMedia(req.creator.id, true);
    return reply.send({ ok: true, items });
  });

  // 4. Apaga foto/vídeo do banco e do Cloudflare R2 ao mesmo tempo
  app.delete('/api/creator/media/:id', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const deleted = await deleteCreatorMedia(req.creator.id, req.params.id);
    if (!deleted) return reply.status(404).send({ error: 'Mídia não encontrada.' });

    try {
      await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: deleted.r2_key }));
    } catch (err) {
      app.log.error(err, '[R2] Falha ao remover arquivo físico');
    }

    return reply.send({ ok: true });
  });
}
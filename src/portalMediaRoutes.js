import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { addCreatorMedia, listCreatorMedia, deleteCreatorMedia } from './portalDb.js';

function getR2Client() {
  let endpoint = (process.env.R2_ENDPOINT || '').trim();
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucket = (process.env.R2_BUCKET_NAME || '').trim();

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    return null;
  }

  // Remove o nome do bucket caso tenha sido colado no final do R2_ENDPOINT
  if (bucket && endpoint.endsWith('/' + bucket)) {
    endpoint = endpoint.slice(0, -('/' + bucket).length);
  }

  return new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    // Evita cabeçalhos extras de checksum que quebram o upload direto (PUT) no R2
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export function registerPortalMediaRoutes(app, requireCreatorAuth) {
  // 1. Gera link temporário para o celular da modelo subir direto ao R2 (foto, vídeo ou áudio)
  app.post('/api/creator/upload-url', { preHandler: requireCreatorAuth }, async (req, reply) => {
    try {
      const r2 = getR2Client();
      const bucket = (process.env.R2_BUCKET_NAME || '').trim();
      const publicBase = (process.env.R2_PUBLIC_URL || '').trim().replace(/\/$/, '');

      if (!r2 || !bucket || !publicBase) {
        return reply.status(500).send({
          ok: false,
          error: 'Cloudflare R2 não configurado no Railway.',
        });
      }

      const creatorId = req.creator.id;
      const { fileName = 'arquivo', contentType = 'image/jpeg', visibility = 'public' } = req.body || {};

      const isVideo = contentType.startsWith('video/');
      const isImage = contentType.startsWith('image/');
      const isAudio = contentType.startsWith('audio/');

      if (!isVideo && !isImage && !isAudio) {
        return reply.status(400).send({ ok: false, error: 'Envie apenas fotos, vídeos ou áudios.' });
      }

      const safeVis = ['public', 'preview', 'subscriber'].includes(visibility) ? visibility : 'public';
      const defaultExt = isVideo ? 'mp4' : isAudio ? 'mp3' : 'jpg';
      const ext = (fileName.split('.').pop() || defaultExt).replace(/[^a-z0-9]/gi, '').toLowerCase();
      const unique = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const r2Key = `creators/${creatorId}/${safeVis}/${unique}.${ext}`;

      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: r2Key,
        ContentType: contentType,
      });

      const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 300 });
      const publicUrl = `${publicBase}/${r2Key}`;
      const mediaType = isVideo ? 'video' : isAudio ? 'audio' : 'image';

      return reply.send({
        ok: true,
        uploadUrl,
        r2Key,
        publicUrl,
        mediaType,
        visibility: safeVis,
      });
    } catch (err) {
      app.log.error(err, '[R2] Erro ao gerar URL de upload');
      return reply.status(500).send({ ok: false, error: 'Falha no R2: ' + err.message });
    }
  });

  // 2. Confirma o upload no banco após o envio terminar no celular
  app.post('/api/creator/media', { preHandler: requireCreatorAuth }, async (req, reply) => {
    try {
      const creatorId = req.creator.id;
      const { mediaType, visibility, r2Key, publicUrl, caption } = req.body || {};

      if (!r2Key || !String(r2Key).startsWith(`creators/${creatorId}/`)) {
        return reply.status(403).send({ ok: false, error: 'Caminho de arquivo inválido para esta conta.' });
      }

      const safeType = ['video', 'audio', 'image'].includes(mediaType) ? mediaType : 'image';
      const saved = await addCreatorMedia({
        creatorId,
        mediaType: safeType,
        visibility: ['public', 'preview', 'subscriber'].includes(visibility) ? visibility : 'public',
        r2Key,
        publicUrl,
        caption: caption || null,
      });

      return reply.send({ ok: true, media: saved });
    } catch (err) {
      app.log.error(err, '[Portal] Erro ao salvar mídia no banco');
      return reply.status(500).send({ ok: false, error: err.message });
    }
  });

  // 3. Lista toda a galeria da própria modelo no painel dela
  app.get('/api/creator/media', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const items = await listCreatorMedia(req.creator.id, true);
    return reply.send({ ok: true, items });
  });

  // 4. Apaga foto/vídeo do banco e do Cloudflare R2 ao mesmo tempo
  app.delete('/api/creator/media/:id', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const deleted = await deleteCreatorMedia(req.creator.id, req.params.id);
    if (!deleted) return reply.status(404).send({ ok: false, error: 'Mídia não encontrada.' });

    try {
      const r2 = getR2Client();
      const bucket = (process.env.R2_BUCKET_NAME || '').trim();
      if (r2 && bucket) {
        await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: deleted.r2_key }));
      }
    } catch (err) {
      app.log.error(err, '[R2] Falha ao remover arquivo físico');
    }

    return reply.send({ ok: true });
  });
}
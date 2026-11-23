import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import { uploadVerificationVideoToR2 } from './r2Verification.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

export function createVerificationRouter(pool) {
  const router = express.Router();

  router.get('/verificar', (req, res) => {
    res.sendFile(path.resolve(process.cwd(), 'public/verificar.html'));
  });

  router.get('/api/verification/challenge', async (req, res) => {
    try {
      const token = String(req.query.token || crypto.randomBytes(8).toString('hex')).trim();
      const code = String(crypto.randomInt(1000, 9999));
      const expiresAt = Date.now() + 3 * 60 * 1000; // 3 minutos

      await pool.query(
        `INSERT INTO model_verifications (token, challenge_code, expires_at, status)
         VALUES ($1, $2, $3, 'pending_challenge')
         ON CONFLICT (token)
         DO UPDATE SET
           challenge_code = EXCLUDED.challenge_code,
           expires_at = EXCLUDED.expires_at,
           status = CASE
             WHEN model_verifications.status = 'verified' THEN 'verified'
             ELSE 'pending_challenge'
           END`,
        [token, code, expiresAt]
      );

      return res.json({ token, code, expiresAt });
    } catch (err) {
      console.error('[Verification Challenge] Erro:', err);
      return res.status(500).json({ error: 'Erro ao gerar desafio de verificação.' });
    }
  });

  router.post('/api/verification/submit', upload.single('video'), async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'Nenhum vídeo recebido.' });
      }

      const mimeType = String(req.file.mimetype || '');
      if (!mimeType.startsWith('video/')) {
        return res.status(400).json({ error: 'Envie apenas um arquivo de vídeo.' });
      }

      const token = String(req.body.token || '').trim();
      if (!token) {
        return res.status(400).json({ error: 'Token de verificação ausente.' });
      }

      const challengeRow = await pool.query(
        `SELECT token, challenge_code, expires_at, status FROM model_verifications WHERE token = $1`,
        [token]
      );

      if (challengeRow.rowCount === 0) {
        return res.status(400).json({ error: 'Desafio não encontrado. Recarregue a página para gerar um código.' });
      }

      const challenge = challengeRow.rows[0];
      if (Date.now() > Number(challenge.expires_at)) {
        return res.status(400).json({ error: 'Código expirado. Atualize a página e grave novamente.' });
      }

      const submittedCode = String(req.body.challengeCode || '').trim();
      if (submittedCode && submittedCode !== String(challenge.challenge_code)) {
        return res.status(400).json({ error: 'Código inválido para este desafio.' });
      }

      const serverHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      const clientHash = String(req.body.fileHash || '').trim().toLowerCase();
      if (clientHash && clientHash !== serverHash) {
        return res.status(400).json({ error: 'Falha na integridade do vídeo.' });
      }

      const duplicateCheck = await pool.query(
        `SELECT id FROM model_verifications WHERE video_hash = $1 AND token <> $2`,
        [serverHash, token]
      );
      if (duplicateCheck.rowCount > 0) {
        return res.status(409).json({
          error: 'Este vídeo já foi utilizado antes. Grave um vídeo novo ao vivo com o código atual.',
        });
      }

      const uploaded = await uploadVerificationVideoToR2(req.file.buffer, mimeType, token, serverHash);

      await pool.query(
        `UPDATE model_verifications
         SET video_hash = $1,
             video_url = $2,
             status = 'pending_review',
             verified_at = NOW()
         WHERE token = $3`,
        [serverHash, uploaded.url, token]
      );

      return res.json({
        ok: true,
        token,
        status: 'pending_review',
        videoUrl: uploaded.url,
        hash: serverHash,
      });
    } catch (err) {
      if (err?.code === '23505') {
        return res.status(409).json({
          error: 'Este vídeo já foi registrado no sistema. Grave um vídeo inédito.',
        });
      }
      console.error('[Verification Submit] Erro:', err);
      return res.status(500).json({ error: 'Erro ao salvar vídeo de verificação.' });
    }
  });

  return router;
}
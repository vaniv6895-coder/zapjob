import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

function cleanEnv(val) {
  return String(val || '').replace(/[\r\n]+/g, '').trim();
}

const accountId = cleanEnv(process.env.R2_ACCOUNT_ID);
const accessKeyId = cleanEnv(process.env.R2_ACCESS_KEY_ID);
const secretAccessKey = cleanEnv(process.env.R2_SECRET_ACCESS_KEY);
const bucketName = cleanEnv(process.env.R2_BUCKET_NAME);
const publicBaseUrl = cleanEnv(process.env.R2_PUBLIC_URL).replace(/\/+$/, '');

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

export async function uploadVerificationVideoToR2(buffer, mimeType, token, hashHex) {
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    throw new Error('Credenciais do R2 incompletas nas variáveis de ambiente.');
  }

  const safeToken = String(token || 'ver').replace(/[^a-zA-Z0-9_-]/g, '');
  const ext = String(mimeType || '').includes('mp4') ? 'mp4' : 'webm';
  const key = `verifications/${safeToken}_${Date.now()}_${hashHex.slice(0, 8)}.${ext}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: cleanEnv(mimeType) || `video/${ext}`,
    })
  );

  const url = publicBaseUrl
    ? `${publicBaseUrl}/${key}`
    : `https://${bucketName}.${accountId}.r2.dev/${key}`;

  return { key, url };
}
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

function cleanEnv(val) {
  return String(val || '').replace(/[\r\n]+/g, '').trim();
}

const rawEndpoint = cleanEnv(process.env.R2_ENDPOINT || process.env.R2_VIP_ENDPOINT);
const rawAccountId = cleanEnv(process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID);

const accessKeyId = cleanEnv(
  process.env.R2_ACCESS_KEY_ID ||
  process.env.R2_VIP_KEY_ID ||
  process.env.S3_ACCESS_KEY
);

const secretAccessKey = cleanEnv(
  process.env.R2_SECRET_ACCESS_KEY ||
  process.env.R2_VIP_SECRET
);

const bucketName = cleanEnv(
  process.env.R2_BUCKET_NAME ||
  process.env.R2_VIP_BUCKET ||
  process.env.S3_BUCKET
);

const publicBaseUrl = cleanEnv(
  process.env.R2_PUBLIC_URL ||
  process.env.R2_VIP_URL
).replace(/\/+$/, '');

function resolveEndpointUrl() {
  if (rawEndpoint) {
    return rawEndpoint.startsWith('http') ? rawEndpoint.replace(/\/+$/, '') : `https://${rawEndpoint.replace(/\/+$/, '')}`;
  }
  if (rawAccountId) {
    return `https://${rawAccountId}.r2.cloudflarestorage.com`;
  }
  return '';
}

const endpointUrl = resolveEndpointUrl();

const s3Client =
  endpointUrl && accessKeyId && secretAccessKey
    ? new S3Client({
        region: 'auto',
        endpoint: endpointUrl,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      })
    : null;

export async function uploadVerificationVideoToR2(buffer, mimeType, token, hashHex) {
  if (!s3Client || !bucketName) {
    throw new Error('Credenciais do R2 incompletas nas variáveis de ambiente.');
  }

  const safeToken = String(token || 'ver').replace(/[^a-zA-Z0-9_-]/g, '');
  const ext = String(mimeType || '').includes('mp4') ? 'mp4' : 'webm';
  const hashPart = String(hashHex || crypto.randomBytes(4).toString('hex')).slice(0, 8);
  const key = `verifications/${safeToken}_${Date.now()}_${hashPart}.${ext}`;

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
    : `${endpointUrl}/${bucketName}/${key}`;

  return { key, url };
}
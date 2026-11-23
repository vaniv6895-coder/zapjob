import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

function cleanEnv(val) {
  return String(val || '').replace(/[\r\n]+/g, '').trim();
}

function pickCredentials() {
  const vipKey = cleanEnv(process.env.R2_VIP_KEY_ID);
  const vipSecret = cleanEnv(process.env.R2_VIP_SECRET);
  const vipBucket = cleanEnv(process.env.R2_VIP_BUCKET);
  const vipEndpoint = cleanEnv(process.env.R2_VIP_ENDPOINT);
  const vipPublicUrl = cleanEnv(process.env.R2_VIP_URL);

  if (vipKey && vipSecret && vipBucket && vipEndpoint) {
    return {
      accessKeyId: vipKey,
      secretAccessKey: vipSecret,
      bucketName: vipBucket,
      rawEndpoint: vipEndpoint,
      publicBaseUrl: vipPublicUrl,
    };
  }

  return {
    accessKeyId: cleanEnv(process.env.R2_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY),
    secretAccessKey: cleanEnv(process.env.R2_SECRET_ACCESS_KEY),
    bucketName: cleanEnv(process.env.R2_BUCKET_NAME || process.env.S3_BUCKET),
    rawEndpoint: cleanEnv(process.env.R2_ENDPOINT),
    publicBaseUrl: cleanEnv(process.env.R2_PUBLIC_URL),
  };
}

const creds = pickCredentials();
const publicBaseUrl = creds.publicBaseUrl.replace(/\/+$/, '');

function resolveEndpointUrl(ep) {
  if (!ep) return '';
  const clean = ep.replace(/\/+$/, '');
  return clean.startsWith('http') ? clean : `https://${clean}`;
}

const endpointUrl = resolveEndpointUrl(creds.rawEndpoint);

const s3Client =
  endpointUrl && creds.accessKeyId && creds.secretAccessKey
    ? new S3Client({
        region: 'auto',
        endpoint: endpointUrl,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
        },
      })
    : null;

export async function uploadVerificationVideoToR2(buffer, mimeType, token, hashHex) {
  if (!s3Client || !creds.bucketName) {
    throw new Error('Credenciais do R2 incompletas nas variáveis de ambiente.');
  }

  const safeToken = String(token || 'ver').replace(/[^a-zA-Z0-9_-]/g, '');
  const ext = String(mimeType || '').includes('mp4') ? 'mp4' : 'webm';
  const hashPart = String(hashHex || crypto.randomBytes(4).toString('hex')).slice(0, 8);
  const key = `verifications/${safeToken}_${Date.now()}_${hashPart}.${ext}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: creds.bucketName,
      Key: key,
      Body: buffer,
      ContentType: cleanEnv(mimeType) || `video/${ext}`,
    })
  );

  const url = publicBaseUrl
    ? `${publicBaseUrl}/${key}`
    : `${endpointUrl}/${creds.bucketName}/${key}`;

  return { key, url };
}
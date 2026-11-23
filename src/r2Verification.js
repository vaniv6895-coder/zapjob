import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export async function uploadVerificationVideoToR2(buffer, mimeType, token, hash) {
  const bucket = process.env.R2_BUCKET_NAME || process.env.R2_BUCKET;
  const publicBase = String(process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
  const ext = String(mimeType || '').includes('mp4') ? 'mp4' : 'webm';
  const key = `verifications/${token}_${hash.slice(0, 12)}_${Date.now()}.${ext}`;

  await r2Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType || `video/${ext}`,
    })
  );

  const url = publicBase ? `${publicBase}/${key}` : key;
  return { key, url };
}
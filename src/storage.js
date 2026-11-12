import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

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
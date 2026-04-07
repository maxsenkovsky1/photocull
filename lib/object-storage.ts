import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'shortlist-photos';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL; // optional: for CDN-served thumbnails

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!_client) {
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
      throw new Error('R2 credentials not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
    }
    _client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _client;
}

// ── Key Helpers ──────────────────────────────────────────────────────────────

/** Build the R2 object key for an original image */
export function originalKey(sessionId: string, photoId: string, ext: string): string {
  return `sessions/${sessionId}/originals/${photoId}${ext}`;
}

/** Build the R2 object key for a thumbnail */
export function thumbnailKey(sessionId: string, photoId: string): string {
  return `sessions/${sessionId}/thumbs/${photoId}.jpg`;
}

// ── Operations ───────────────────────────────────────────────────────────────

/** Upload a buffer to R2 */
export async function uploadObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<void> {
  await getClient().send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

/** Download an object from R2 as a Buffer */
export async function getObject(key: string): Promise<Buffer> {
  const res = await getClient().send(new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  }));
  const chunks: Uint8Array[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const chunk of res.Body as any) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Get a time-limited signed URL for an object */
export async function getObjectSignedUrl(key: string, expiresIn = 3600): Promise<string> {
  // If we have a public URL for thumbnails, use it directly (no signing needed)
  if (R2_PUBLIC_URL && key.includes('/thumbs/')) {
    return `${R2_PUBLIC_URL}/${key}`;
  }
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  });
  return getSignedUrl(getClient(), command, { expiresIn });
}

/** Delete a single object */
export async function deleteObject(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  }));
}

/** Delete all objects under a prefix (e.g. "sessions/{id}/") */
export async function deletePrefix(prefix: string): Promise<void> {
  const client = getClient();
  let continuationToken: string | undefined;

  do {
    const list = await client.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET_NAME,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    if (list.Contents) {
      await Promise.all(
        list.Contents.map((obj) =>
          obj.Key ? deleteObject(obj.Key) : Promise.resolve(),
        ),
      );
    }
    continuationToken = list.NextContinuationToken;
  } while (continuationToken);
}

/** Get the public URL for a thumbnail (if CDN configured) or fall back to signed URL */
export async function getThumbnailUrl(key: string): Promise<string> {
  if (R2_PUBLIC_URL) {
    return `${R2_PUBLIC_URL}/${key}`;
  }
  return getObjectSignedUrl(key, 7200); // 2 hour expiry
}

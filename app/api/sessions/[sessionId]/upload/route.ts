import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { sessionExistsInDb, addPhotoToDb } from '@/lib/storage-db';
import { uploadObject, originalKey } from '@/lib/object-storage';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const ACCEPTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.tiff', '.tif']);

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic',
  '.heif': 'image/heif', '.tiff': 'image/tiff', '.tif': 'image/tiff',
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  try {
    const exists = await sessionExistsInDb(sessionId);
    if (!exists) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const url = new URL(request.url);
    const filename = url.searchParams.get('filename') ?? '';
    const fileSize = parseInt(url.searchParams.get('size') ?? '0', 10);
    const ext = path.extname(filename).toLowerCase();

    // JSON sidecar — store in R2 under metadata/
    if (ext === '.json') {
      const buf = Buffer.from(await request.arrayBuffer());
      await uploadObject(`sessions/${sessionId}/metadata/${filename}`, buf, 'application/json');
      return NextResponse.json({ uploaded: [], total: 0 });
    }

    if (!ACCEPTED_IMAGE_EXTENSIONS.has(ext)) {
      return NextResponse.json({ uploaded: [], total: 0 });
    }

    if (!request.body) {
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 });
    }

    const photoId = uuidv4();
    const key = originalKey(sessionId, photoId, ext);

    // Buffer the file and upload to R2
    const buf = Buffer.from(await request.arrayBuffer());

    // Verify upload wasn't truncated (Next.js has a body size limit)
    if (fileSize > 0 && buf.length < fileSize * 0.95) {
      console.error(`[upload] truncated: ${filename} expected ${fileSize} bytes, got ${buf.length}`);
      return NextResponse.json({ error: `Upload truncated: expected ${fileSize} bytes but received ${buf.length}. File may be too large.` }, { status: 413 });
    }

    await uploadObject(key, buf, MIME_TYPES[ext] ?? 'application/octet-stream');

    // Create photo record in Postgres
    await addPhotoToDb({
      id: photoId,
      sessionId,
      filename,
      ext,
      fileSize,
      originalKey: key,
    });

    return NextResponse.json({ uploaded: [{ id: photoId, filename, ext, fileSize }], total: 0 });
  } catch (err) {
    console.error('[upload] unexpected error:', err);
    return NextResponse.json({ error: 'Unexpected server error during upload' }, { status: 500 });
  }
}

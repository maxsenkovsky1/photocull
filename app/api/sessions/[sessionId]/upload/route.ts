import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { readSession, writeSession, getOriginalPath, getMetadataDir, ensureSessionDirs } from '@/lib/storage';
import type { Photo } from '@/types';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const ACCEPTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.tiff', '.tif']);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  try {
    const session = readSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    ensureSessionDirs(sessionId);

    const url = new URL(request.url);
    const filename = url.searchParams.get('filename') ?? '';
    const fileSize = parseInt(url.searchParams.get('size') ?? '0', 10);
    const ext = path.extname(filename).toLowerCase();

    // JSON sidecar
    if (ext === '.json') {
      const metaDir = getMetadataDir(sessionId);
      const metaPath = path.join(metaDir, filename);
      const buf = Buffer.from(await request.arrayBuffer());
      fs.writeFileSync(metaPath, buf);
      return NextResponse.json({ uploaded: [], total: session.photos.length });
    }

    if (!ACCEPTED_IMAGE_EXTENSIONS.has(ext)) {
      return NextResponse.json({ uploaded: [], total: session.photos.length });
    }

    if (!request.body) {
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 });
    }

    const photoId = uuidv4();
    const filePath = getOriginalPath(sessionId, photoId, ext);

    // Try streaming to disk first (memory-efficient for large files)
    let saved = false;
    try {
      const writeStream = fs.createWriteStream(filePath);
      await pipeline(Readable.fromWeb(request.body as import('stream/web').ReadableStream), writeStream);
      saved = true;
    } catch (streamErr) {
      console.warn(`[upload] stream failed for ${filename}, retrying with buffer:`, streamErr);
      // Clean up partial file if it exists
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }

    // Fallback: buffer the whole file (works when streaming pipeline fails)
    if (!saved) {
      try {
        const buf = Buffer.from(await request.arrayBuffer());
        fs.writeFileSync(filePath, buf);
        saved = true;
      } catch (bufErr) {
        console.error(`[upload] buffer fallback also failed for ${filename}:`, bufErr);
        return NextResponse.json({ error: `Failed to save file: ${filename}` }, { status: 500 });
      }
    }

    const photo: Photo = {
      id: photoId,
      filename,
      ext,
      fileSize,
      width: null,
      height: null,
      takenAt: null,
      blurScore: null,
      phash: null,
      classification: 'photo',
      qualityScore: null,
      sentimentScore: null,
      faceScore: null,
      description: null,
      status: 'pending',
      deleteReason: null,
      duplicateGroupId: null,
      isDuplicateBest: false,
      isFavorite: false,
    };

    session.photos.push(photo);
    session.status = 'uploading';
    writeSession(session);

    return NextResponse.json({ uploaded: [{ id: photoId, filename, ext, fileSize }], total: session.photos.length });
  } catch (err) {
    console.error('[upload] unexpected error:', err);
    return NextResponse.json({ error: 'Unexpected server error during upload' }, { status: 500 });
  }
}

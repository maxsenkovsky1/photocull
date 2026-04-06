import { NextResponse } from 'next/server';
import fs from 'fs';
import { readSession, getOriginalPath, getThumbnailPath, getThumbnailsDir } from '@/lib/storage';
import { generateThumbnail, prepareForSharp } from '@/lib/analysis';

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string; type: string; photoId: string }> }
) {
  const { sessionId, type, photoId } = await params;

  const session = readSession(sessionId);
  if (!session) {
    return new NextResponse('Not found', { status: 404 });
  }

  const photo = session.photos.find((p) => p.id === photoId);
  if (!photo) {
    return new NextResponse('Not found', { status: 404 });
  }

  const originalPath = getOriginalPath(sessionId, photoId, photo.ext);

  if (type === 'thumb') {
    const thumbPath = getThumbnailPath(sessionId, photoId);

    // Serve cached thumbnail if it exists
    if (fs.existsSync(thumbPath)) {
      const buffer = fs.readFileSync(thumbPath);
      return new NextResponse(new Uint8Array(buffer), {
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' },
      });
    }

    // Thumbnail missing — try to generate it on-demand now
    if (fs.existsSync(originalPath)) {
      const { processPath, cleanup } = await prepareForSharp(originalPath);
      try {
        const thumbBuf = await generateThumbnail(processPath);
        if (thumbBuf) {
          fs.mkdirSync(getThumbnailsDir(sessionId), { recursive: true });
          fs.writeFileSync(thumbPath, thumbBuf);
          return new NextResponse(new Uint8Array(thumbBuf), {
            headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' },
          });
        }
      } finally {
        cleanup();
      }

      // generateThumbnail also failed — stream the original so the card isn't blank
      const buffer = fs.readFileSync(originalPath);
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type': MIME_TYPES[photo.ext] ?? 'image/jpeg',
          'Cache-Control': 'private, max-age=60',
        },
      });
    }

    return new NextResponse('Image not found', { status: 404 });
  }

  // Original / full-size request
  if (!fs.existsSync(originalPath)) {
    return new NextResponse('Image not found', { status: 404 });
  }

  const buffer = fs.readFileSync(originalPath);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': MIME_TYPES[photo.ext] ?? 'image/jpeg',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

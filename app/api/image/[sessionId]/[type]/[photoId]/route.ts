import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { readSession, getOriginalPath, getThumbnailPath } from '@/lib/storage';

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

  let filePath: string;
  let contentType: string;

  if (type === 'thumb') {
    filePath = getThumbnailPath(sessionId, photoId);
    contentType = 'image/jpeg';
  } else {
    filePath = getOriginalPath(sessionId, photoId, photo.ext);
    contentType = MIME_TYPES[photo.ext] ?? 'image/jpeg';
  }

  if (!fs.existsSync(filePath)) {
    return new NextResponse('Image not found', { status: 404 });
  }

  const buffer = fs.readFileSync(filePath);
  return new NextResponse(buffer, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

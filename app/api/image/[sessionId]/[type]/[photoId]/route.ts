import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { eq, and } from 'drizzle-orm';
import { getObject, thumbnailKey, getThumbnailUrl } from '@/lib/object-storage';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string; type: string; photoId: string }> }
) {
  const { sessionId, type, photoId } = await params;

  const [photo] = await db
    .select()
    .from(schema.photos)
    .where(and(eq(schema.photos.id, photoId), eq(schema.photos.sessionId, sessionId)))
    .limit(1);

  if (!photo) {
    return new NextResponse('Not found', { status: 404 });
  }

  try {
    if (type === 'thumb') {
      const key = photo.thumbnailKey ?? thumbnailKey(sessionId, photoId);
      try {
        const buffer = await getObject(key);
        return new NextResponse(new Uint8Array(buffer), {
          headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' },
        });
      } catch {
        // Thumbnail not in R2 — try serving the original
        if (photo.originalKey) {
          const buffer = await getObject(photo.originalKey);
          return new NextResponse(new Uint8Array(buffer), {
            headers: { 'Content-Type': mimeForExt(photo.ext), 'Cache-Control': 'public, max-age=60' },
          });
        }
        return new NextResponse('Image not found', { status: 404 });
      }
    }

    // Original / full-size request
    if (!photo.originalKey) {
      return new NextResponse('Image not found', { status: 404 });
    }

    const buffer = await getObject(photo.originalKey);
    return new NextResponse(new Uint8Array(buffer), {
      headers: { 'Content-Type': mimeForExt(photo.ext), 'Cache-Control': 'public, max-age=3600' },
    });
  } catch (err) {
    console.error(`[image] Failed to serve ${type}/${photoId}:`, err);
    return new NextResponse('Image not found', { status: 404 });
  }
}

function mimeForExt(ext: string): string {
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic',
    '.heif': 'image/heif', '.tiff': 'image/tiff', '.tif': 'image/tiff',
  };
  return map[ext] ?? 'image/jpeg';
}

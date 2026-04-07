import { NextResponse } from 'next/server';
import JSZip from 'jszip';
import { readSessionFromDb } from '@/lib/storage-db';
import { getObject } from '@/lib/object-storage';

export const maxDuration = 120;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const session = await readSessionFromDb(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const keptPhotos = session.photos.filter((p) => p.status !== 'trash');

  const zip = new JSZip();
  const folder = zip.folder('Shortlist_Kept');

  for (const photo of keptPhotos) {
    const key = `sessions/${sessionId}/originals/${photo.id}${photo.ext}`;
    try {
      const buffer = await getObject(key);
      folder!.file(photo.filename, buffer);
    } catch {
      console.warn(`[download] skipping ${photo.filename} — not found in R2`);
    }
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  return new NextResponse(zipBuffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="Shortlist_${sessionId.slice(0, 8)}.zip"`,
    },
  });
}

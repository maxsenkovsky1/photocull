import { NextResponse } from 'next/server';
import fs from 'fs';
import JSZip from 'jszip';
import { readSession, getOriginalPath } from '@/lib/storage';

export const maxDuration = 120;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const session = readSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const keptPhotos = session.photos.filter((p) => p.status !== 'trash');

  const zip = new JSZip();
  const folder = zip.folder('Winnow_Kept');

  for (const photo of keptPhotos) {
    const filePath = getOriginalPath(sessionId, photo.id, photo.ext);
    if (fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      folder!.file(photo.filename, buffer);
    }
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  return new NextResponse(zipBuffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="Winnow_${sessionId.slice(0, 8)}.zip"`,
    },
  });
}

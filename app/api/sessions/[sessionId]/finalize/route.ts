import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { readSessionFromDb } from '@/lib/storage-db';
import { deleteObject } from '@/lib/object-storage';
import type { AuditEntry } from '@/types';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const session = await readSessionFromDb(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  if (session.finalizedAt) {
    return NextResponse.json({ error: 'Session already finalized' }, { status: 400 });
  }

  const trashedPhotos = session.photos.filter((p) => p.status === 'trash');
  let freedBytes = 0;

  for (const photo of trashedPhotos) {
    // Delete original from R2
    const origKey = `sessions/${sessionId}/originals/${photo.id}${photo.ext}`;
    try {
      await deleteObject(origKey);
      freedBytes += photo.fileSize;
    } catch { /* already gone */ }

    // Delete thumbnail from R2
    const thumbKey = `sessions/${sessionId}/thumbs/${photo.id}.jpg`;
    try { await deleteObject(thumbKey); } catch { /* ok */ }

    // Audit entry
    await db.insert(schema.auditEntries).values({
      sessionId,
      photoId: photo.id,
      filename: photo.filename,
      action: 'permanently_deleted',
      reason: photo.deleteReason,
    });
  }

  const keptPhotos = session.photos.filter((p) => p.status !== 'trash');

  // Mark session as finalized
  await db.update(schema.sessions).set({
    finalizedAt: new Date(),
  }).where(eq(schema.sessions.id, sessionId));

  return NextResponse.json({
    deleted: trashedPhotos.length,
    kept: keptPhotos.length,
    freedBytes,
  });
}

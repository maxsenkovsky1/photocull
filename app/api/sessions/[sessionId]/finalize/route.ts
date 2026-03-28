import { NextResponse } from 'next/server';
import fs from 'fs';
import { readSession, writeSession, getOriginalPath, getThumbnailPath } from '@/lib/storage';
import type { AuditEntry } from '@/types';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const session = readSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  if (session.finalizedAt) {
    return NextResponse.json({ error: 'Session already finalized' }, { status: 400 });
  }

  const trashedPhotos = session.photos.filter((p) => p.status === 'trash');
  let freedBytes = 0;
  const newAuditEntries: AuditEntry[] = [];

  for (const photo of trashedPhotos) {
    // Delete original
    const originalPath = getOriginalPath(sessionId, photo.id, photo.ext);
    if (fs.existsSync(originalPath)) {
      freedBytes += fs.statSync(originalPath).size;
      fs.unlinkSync(originalPath);
    }

    // Delete thumbnail
    const thumbPath = getThumbnailPath(sessionId, photo.id);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

    newAuditEntries.push({
      timestamp: new Date().toISOString(),
      photoId: photo.id,
      filename: photo.filename,
      action: 'permanently_deleted',
      reason: photo.deleteReason,
    });
  }

  // Count kept photos (not logged individually — only destructive actions are audited)
  const keptPhotos = session.photos.filter((p) => p.status !== 'trash');

  session.auditLog = [...session.auditLog, ...newAuditEntries];
  session.finalizedAt = new Date().toISOString();
  writeSession(session);

  return NextResponse.json({
    deleted: trashedPhotos.length,
    kept: keptPhotos.length,
    freedBytes,
    auditLog: session.auditLog,
  });
}

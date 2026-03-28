import { NextResponse } from 'next/server';
import { readSession, writeSession } from '@/lib/storage';
import type { PhotoStatus } from '@/types';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ sessionId: string; photoId: string }> }
) {
  const { sessionId, photoId } = await params;

  const session = readSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const photo = session.photos.find((p) => p.id === photoId);
  if (!photo) {
    return NextResponse.json({ error: 'Photo not found' }, { status: 404 });
  }

  const body = await request.json();

  // Update status
  if (body.status !== undefined) {
    const newStatus = body.status as PhotoStatus;
    if (!['keep', 'suggested_delete', 'trash', 'pending'].includes(newStatus)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
    photo.status = newStatus;
  }

  // Toggle favorite
  if (body.isFavorite !== undefined) {
    photo.isFavorite = Boolean(body.isFavorite);
    // Favorites are never trash — restore if currently trashed
    if (photo.isFavorite && photo.status === 'trash') {
      photo.status = 'keep';
    }
    // Favorites can't be suggested for deletion
    if (photo.isFavorite && photo.status === 'suggested_delete') {
      photo.status = 'pending';
    }
  }

  writeSession(session);
  return NextResponse.json({ id: photoId, status: photo.status, isFavorite: photo.isFavorite });
}

import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { eq, and } from 'drizzle-orm';
import type { PhotoStatus } from '@/types';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ sessionId: string; photoId: string }> }
) {
  const { sessionId, photoId } = await params;

  const [photo] = await db
    .select()
    .from(schema.photos)
    .where(and(eq(schema.photos.id, photoId), eq(schema.photos.sessionId, sessionId)))
    .limit(1);

  if (!photo) {
    return NextResponse.json({ error: 'Photo not found' }, { status: 404 });
  }

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  // Update status
  if (body.status !== undefined) {
    const newStatus = body.status as PhotoStatus;
    if (!['keep', 'suggested_delete', 'trash', 'pending'].includes(newStatus)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
    updates.status = newStatus;
  }

  // Toggle favorite
  if (body.isFavorite !== undefined) {
    updates.isFavorite = Boolean(body.isFavorite);
    // Favorites are never trash — restore if currently trashed
    const currentStatus = (updates.status as string) ?? photo.status;
    if (updates.isFavorite && currentStatus === 'trash') {
      updates.status = 'keep';
    }
    if (updates.isFavorite && currentStatus === 'suggested_delete') {
      updates.status = 'pending';
    }
  }

  await db.update(schema.photos).set(updates).where(eq(schema.photos.id, photoId));

  return NextResponse.json({
    id: photoId,
    status: (updates.status as string) ?? photo.status,
    isFavorite: (updates.isFavorite as boolean) ?? photo.isFavorite,
  });
}

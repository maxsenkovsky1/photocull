import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth';
import { db, schema } from '@/lib/db';
import { eq, and } from 'drizzle-orm';
import { deletePrefix } from '@/lib/object-storage';

/**
 * Delete a session and all its photos (DB + R2).
 * Only the owning user can delete.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const userId = await requireUserId();
    const { sessionId } = await params;

    // Verify ownership
    const [session] = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)))
      .limit(1);

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Delete R2 objects (originals + thumbnails)
    await deletePrefix(`sessions/${sessionId}/`);

    // Cascade delete handles photos + audit entries
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));

    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error('[delete] session delete failed:', err);
    return NextResponse.json({ error: 'Failed to delete session' }, { status: 500 });
  }
}

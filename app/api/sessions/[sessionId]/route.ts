import { NextResponse } from 'next/server';
import { readSessionFromDb } from '@/lib/storage-db';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const url = new URL(request.url);

  const session = await readSessionFromDb(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // ?lite=true returns session metadata + photo count, without the full photo array.
  // Mobile clients should use this + the paginated /photos endpoint.
  if (url.searchParams.get('lite') === 'true') {
    const { photos, auditLog, ...meta } = session;
    return NextResponse.json({
      ...meta,
      photoCount: photos.length,
      statusCounts: {
        pending: photos.filter((p) => p.status === 'pending').length,
        keep: photos.filter((p) => p.status === 'keep').length,
        suggested_delete: photos.filter((p) => p.status === 'suggested_delete').length,
        trash: photos.filter((p) => p.status === 'trash').length,
      },
    });
  }

  // Default: full session (backwards compatible for web app)
  return NextResponse.json(session);
}

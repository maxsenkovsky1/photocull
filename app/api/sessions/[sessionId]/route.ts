import { NextResponse } from 'next/server';
import { readSessionFromDb } from '@/lib/storage-db';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const session = await readSessionFromDb(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  return NextResponse.json(session);
}

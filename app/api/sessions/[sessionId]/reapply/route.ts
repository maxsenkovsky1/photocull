import { NextResponse } from 'next/server';
import { readSession, writeSession } from '@/lib/storage';
import { applyRules } from '@/lib/rules';
import type { PhotoCategoryConfig, SessionMode } from '@/types';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const session = readSession(sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  if (session.status === 'analyzing') {
    return NextResponse.json({ error: 'Analysis in progress' }, { status: 409 });
  }

  const body = await request.json();
  const aggressiveness: number = body.aggressiveness ?? session.aggressiveness;
  const mode: SessionMode = body.mode ?? session.mode;
  const targetPercentage: number | null = body.targetPercentage ?? session.targetPercentage;
  const categoryConfig: PhotoCategoryConfig = body.categoryConfig ?? session.categoryConfig;

  // Persist the new settings
  session.aggressiveness = aggressiveness;
  session.mode = mode;
  session.targetPercentage = targetPercentage;
  session.categoryConfig = categoryConfig;

  // Re-apply rules without touching any API — uses stored blurScore, phash, qualityScore, etc.
  applyRules(session.photos, aggressiveness, mode, targetPercentage, categoryConfig);

  writeSession(session);
  return NextResponse.json({ status: 'ready', total: session.photos.length });
}

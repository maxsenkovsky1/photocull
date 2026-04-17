import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { requireUserId } from '@/lib/auth';
import { createSessionInDb } from '@/lib/storage-db';
import { db, schema } from '@/lib/db';
import { eq, desc, sql } from 'drizzle-orm';
import type { SessionMode, PhotoCategoryConfig } from '@/types';
import { DEFAULT_CATEGORY_CONFIG } from '@/types';

/**
 * List sessions for the current user.
 * Returns lightweight metadata (no photo arrays).
 *
 * Query params:
 *   limit  – max sessions (default 20, max 50)
 *   offset – skip (default 0)
 */
export async function GET(request: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 50);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;

    const rows = await db
      .select({
        id: schema.sessions.id,
        createdAt: schema.sessions.createdAt,
        status: schema.sessions.status,
        source: schema.sessions.source,
        aggressiveness: schema.sessions.aggressiveness,
        mode: schema.sessions.mode,
        analysisProgress: schema.sessions.analysisProgress,
        analysisStage: schema.sessions.analysisStage,
        finalizedAt: schema.sessions.finalizedAt,
        photoCount: sql<number>`(SELECT count(*)::int FROM photos WHERE session_id = ${schema.sessions.id})`,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userId))
      .orderBy(desc(schema.sessions.createdAt))
      .limit(limit)
      .offset(offset);

    const sessions = rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      status: r.status,
      source: r.source,
      aggressiveness: r.aggressiveness,
      mode: r.mode,
      analysisProgress: r.analysisProgress,
      analysisStage: r.analysisStage,
      finalizedAt: r.finalizedAt?.toISOString() ?? null,
      photoCount: r.photoCount,
    }));

    return NextResponse.json({ sessions });
  } catch (err) {
    console.error('List sessions error:', err);
    return NextResponse.json({ error: 'Failed to list sessions' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const userId = await requireUserId();
    const body = await request.json();
    const mode: SessionMode = body.mode === 'percentage' ? 'percentage' : 'aggressiveness';
    const aggressiveness = Math.min(5, Math.max(1, parseInt(body.aggressiveness) || 3));
    const targetPercentage = mode === 'percentage'
      ? Math.min(99, Math.max(1, parseInt(body.targetPercentage) || 30))
      : null;

    const categoryConfig: PhotoCategoryConfig = {
      removeDuplicates:  body.categoryConfig?.removeDuplicates  ?? DEFAULT_CATEGORY_CONFIG.removeDuplicates,
      removeBlurry:      body.categoryConfig?.removeBlurry      ?? DEFAULT_CATEGORY_CONFIG.removeBlurry,
      removeScreenshots: body.categoryConfig?.removeScreenshots ?? DEFAULT_CATEGORY_CONFIG.removeScreenshots,
      removeReceipts:    body.categoryConfig?.removeReceipts    ?? DEFAULT_CATEGORY_CONFIG.removeReceipts,
      removeMemes:       body.categoryConfig?.removeMemes       ?? DEFAULT_CATEGORY_CONFIG.removeMemes,
      removeLowQuality:  body.categoryConfig?.removeLowQuality  ?? DEFAULT_CATEGORY_CONFIG.removeLowQuality,
    };

    const sessionId = uuidv4();

    await createSessionInDb({
      id: sessionId,
      userId,
      aggressiveness,
      mode,
      targetPercentage,
      categoryConfig,
      skipAI: Boolean(body.skipAI),
    });

    return NextResponse.json({ id: sessionId });
  } catch (err) {
    console.error('Create session error:', err);
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 });
  }
}

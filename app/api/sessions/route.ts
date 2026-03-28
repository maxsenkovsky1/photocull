import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ensureSessionDirs, writeSession } from '@/lib/storage';
import type { Session, SessionMode, PhotoCategoryConfig } from '@/types';
import { DEFAULT_CATEGORY_CONFIG } from '@/types';

export async function POST(request: Request) {
  try {
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

    const session: Session = {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      aggressiveness,
      mode,
      targetPercentage,
      categoryConfig,
      skipAI: Boolean(body.skipAI),
      status: 'uploading',
      photos: [],
      analysisProgress: 0,
      analysisStage: '',
      auditLog: [],
    };

    ensureSessionDirs(session.id);
    writeSession(session);

    return NextResponse.json({ id: session.id });
  } catch (err) {
    console.error('Create session error:', err);
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 });
  }
}

/**
 * Database-backed storage adapter.
 *
 * Provides the same readSession / writeSession interface as the file-based
 * storage.ts so API routes can migrate incrementally.  Underneath it uses
 * Postgres (via Drizzle) for metadata and Cloudflare R2 for binary objects.
 */

import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import type {
  Session,
  Photo,
  PhotoCategoryConfig,
  AuditEntry,
  SessionStatus,
  SessionMode,
  PhotoStatus,
  PhotoClassification,
  DeleteReason,
} from '@/types';

// ── Read ─────────────────────────────────────────────────────────────────────

export async function readSessionFromDb(sessionId: string): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);

  if (!row) return null;

  const photoRows = await db
    .select()
    .from(schema.photos)
    .where(eq(schema.photos.sessionId, sessionId));

  const auditRows = await db
    .select()
    .from(schema.auditEntries)
    .where(eq(schema.auditEntries.sessionId, sessionId));

  return dbRowsToSession(row, photoRows, auditRows);
}

export async function sessionExistsInDb(sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);
  return !!row;
}

// ── Write ────────────────────────────────────────────────────────────────────

export async function writeSessionToDb(session: Session): Promise<void> {
  // Upsert session row
  await db
    .insert(schema.sessions)
    .values({
      id: session.id,
      userId: (session as SessionWithUser).userId ?? 'anonymous',
      createdAt: new Date(session.createdAt),
      status: session.status,
      aggressiveness: session.aggressiveness,
      mode: session.mode,
      targetPercentage: session.targetPercentage ?? undefined,
      categoryConfig: session.categoryConfig,
      skipAi: session.skipAI,
      aiClassificationRan: session.aiClassificationRan ?? false,
      analysisProgress: session.analysisProgress,
      analysisStage: session.analysisStage,
      errorMessage: session.errorMessage ?? null,
      finalizedAt: session.finalizedAt ? new Date(session.finalizedAt) : null,
    })
    .onConflictDoUpdate({
      target: schema.sessions.id,
      set: {
        status: session.status,
        aggressiveness: session.aggressiveness,
        mode: session.mode,
        targetPercentage: session.targetPercentage ?? undefined,
        categoryConfig: session.categoryConfig,
        skipAi: session.skipAI,
        aiClassificationRan: session.aiClassificationRan ?? false,
        analysisProgress: session.analysisProgress,
        analysisStage: session.analysisStage,
        errorMessage: session.errorMessage ?? null,
        finalizedAt: session.finalizedAt ? new Date(session.finalizedAt) : null,
      },
    });

  // Upsert photos
  if (session.photos.length > 0) {
    for (const photo of session.photos) {
      await db
        .insert(schema.photos)
        .values({
          id: photo.id,
          sessionId: session.id,
          filename: photo.filename,
          ext: photo.ext,
          fileSize: photo.fileSize,
          width: photo.width,
          height: photo.height,
          takenAt: photo.takenAt ? new Date(photo.takenAt) : null,
          blurScore: photo.blurScore,
          phash: photo.phash,
          classification: photo.classification,
          qualityScore: photo.qualityScore,
          sentimentScore: photo.sentimentScore,
          faceScore: photo.faceScore,
          description: photo.description,
          status: photo.status,
          deleteReason: photo.deleteReason,
          duplicateGroupId: photo.duplicateGroupId,
          isDuplicateBest: photo.isDuplicateBest,
          isFavorite: photo.isFavorite,
        })
        .onConflictDoUpdate({
          target: schema.photos.id,
          set: {
            filename: photo.filename,
            fileSize: photo.fileSize,
            width: photo.width,
            height: photo.height,
            takenAt: photo.takenAt ? new Date(photo.takenAt) : null,
            blurScore: photo.blurScore,
            phash: photo.phash,
            classification: photo.classification,
            qualityScore: photo.qualityScore,
            sentimentScore: photo.sentimentScore,
            faceScore: photo.faceScore,
            description: photo.description,
            status: photo.status,
            deleteReason: photo.deleteReason,
            duplicateGroupId: photo.duplicateGroupId,
            isDuplicateBest: photo.isDuplicateBest,
            isFavorite: photo.isFavorite,
          },
        });
    }
  }

  // Upsert audit entries
  for (const entry of session.auditLog) {
    await db
      .insert(schema.auditEntries)
      .values({
        sessionId: session.id,
        photoId: entry.photoId,
        filename: entry.filename,
        action: entry.action,
        reason: entry.reason,
        createdAt: new Date(entry.timestamp),
      });
  }
}

// ── Create Session ───────────────────────────────────────────────────────────

export async function createSessionInDb(params: {
  id: string;
  userId: string;
  aggressiveness: number;
  mode: SessionMode;
  targetPercentage: number | null;
  categoryConfig: PhotoCategoryConfig;
  skipAI: boolean;
}): Promise<void> {
  await db.insert(schema.sessions).values({
    id: params.id,
    userId: params.userId,
    aggressiveness: params.aggressiveness,
    mode: params.mode,
    targetPercentage: params.targetPercentage ?? undefined,
    categoryConfig: params.categoryConfig,
    skipAi: params.skipAI,
  });
}

// ── Add Photo ────────────────────────────────────────────────────────────────

export async function addPhotoToDb(params: {
  id: string;
  sessionId: string;
  filename: string;
  ext: string;
  fileSize: number;
  originalKey: string;
}): Promise<void> {
  await db.insert(schema.photos).values({
    id: params.id,
    sessionId: params.sessionId,
    filename: params.filename,
    ext: params.ext,
    fileSize: params.fileSize,
    originalKey: params.originalKey,
  });
}

// ── Update Session Progress ──────────────────────────────────────────────────

export async function updateSessionProgress(
  sessionId: string,
  progress: number,
  stage: string,
  status?: SessionStatus,
): Promise<void> {
  const update: Record<string, unknown> = {
    analysisProgress: progress,
    analysisStage: stage,
  };
  if (status) update.status = status;
  await db.update(schema.sessions).set(update).where(eq(schema.sessions.id, sessionId));
}

// ── Update Photo ─────────────────────────────────────────────────────────────

export async function updatePhotoInDb(
  photoId: string,
  fields: Partial<{
    status: PhotoStatus;
    isFavorite: boolean;
    blurScore: number | null;
    phash: string | null;
    classification: PhotoClassification;
    qualityScore: number | null;
    sentimentScore: number | null;
    faceScore: number | null;
    description: string | null;
    deleteReason: DeleteReason;
    duplicateGroupId: string | null;
    isDuplicateBest: boolean;
    width: number | null;
    height: number | null;
    takenAt: string | null;
    thumbnailKey: string | null;
  }>,
): Promise<void> {
  const set: Record<string, unknown> = { ...fields };
  if (fields.takenAt !== undefined) {
    set.takenAt = fields.takenAt ? new Date(fields.takenAt) : null;
  }
  await db.update(schema.photos).set(set).where(eq(schema.photos.id, photoId));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface SessionWithUser extends Session {
  userId?: string;
}

function dbRowsToSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionRow: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  photoRows: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auditRows: any[],
): Session {
  return {
    id: sessionRow.id,
    createdAt: sessionRow.createdAt.toISOString(),
    aggressiveness: sessionRow.aggressiveness,
    mode: sessionRow.mode as SessionMode,
    targetPercentage: sessionRow.targetPercentage ?? null,
    categoryConfig: (sessionRow.categoryConfig ?? {}) as PhotoCategoryConfig,
    status: sessionRow.status as SessionStatus,
    skipAI: sessionRow.skipAi,
    aiClassificationRan: sessionRow.aiClassificationRan ?? false,
    analysisProgress: sessionRow.analysisProgress,
    analysisStage: sessionRow.analysisStage,
    errorMessage: sessionRow.errorMessage ?? undefined,
    finalizedAt: sessionRow.finalizedAt?.toISOString() ?? undefined,
    photos: photoRows.map((p) => ({
      id: p.id,
      filename: p.filename,
      ext: p.ext,
      fileSize: Number(p.fileSize),
      width: p.width,
      height: p.height,
      takenAt: p.takenAt?.toISOString() ?? null,
      blurScore: p.blurScore,
      phash: p.phash,
      classification: (p.classification ?? 'photo') as PhotoClassification,
      qualityScore: p.qualityScore,
      sentimentScore: p.sentimentScore,
      faceScore: p.faceScore,
      description: p.description,
      status: (p.status ?? 'pending') as PhotoStatus,
      deleteReason: (p.deleteReason ?? null) as DeleteReason,
      duplicateGroupId: p.duplicateGroupId,
      isDuplicateBest: p.isDuplicateBest ?? false,
      isFavorite: p.isFavorite ?? false,
    })),
    auditLog: auditRows.map((a) => ({
      timestamp: a.createdAt.toISOString(),
      photoId: a.photoId,
      filename: a.filename,
      action: a.action,
      reason: a.reason,
    })) as AuditEntry[],
  };
}

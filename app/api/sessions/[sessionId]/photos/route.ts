import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { eq, sql, asc } from 'drizzle-orm';

/**
 * Paginated photo listing for a session.
 *
 * Query params:
 *   limit   – max photos per page (default 50, max 200)
 *   offset  – number of photos to skip (default 0)
 *   status  – filter by status: "pending" | "keep" | "suggested_delete" | "trash"
 *   fields  – "summary" returns only id, filename, ext, status, classification,
 *             qualityScore, isFavorite (lighter payload for grids).
 *             Default returns all fields.
 *
 * Response:
 *   { photos: Photo[], total: number, limit: number, offset: number }
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const url = new URL(request.url);

  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
  const status = url.searchParams.get('status');
  const fields = url.searchParams.get('fields');

  // Build where clause
  const conditions = [eq(schema.photos.sessionId, sessionId)];
  if (status) {
    conditions.push(eq(schema.photos.status, status));
  }

  // Total count for pagination
  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.photos)
    .where(sql`${schema.photos.sessionId} = ${sessionId}${status ? sql` AND ${schema.photos.status} = ${status}` : sql``}`);

  const total = countResult?.count ?? 0;

  // Fetch photos
  if (fields === 'summary') {
    const rows = await db
      .select({
        id: schema.photos.id,
        filename: schema.photos.filename,
        ext: schema.photos.ext,
        status: schema.photos.status,
        classification: schema.photos.classification,
        qualityScore: schema.photos.qualityScore,
        sentimentScore: schema.photos.sentimentScore,
        faceScore: schema.photos.faceScore,
        isFavorite: schema.photos.isFavorite,
        deleteReason: schema.photos.deleteReason,
        duplicateGroupId: schema.photos.duplicateGroupId,
        isDuplicateBest: schema.photos.isDuplicateBest,
      })
      .from(schema.photos)
      .where(sql`${schema.photos.sessionId} = ${sessionId}${status ? sql` AND ${schema.photos.status} = ${status}` : sql``}`)
      .orderBy(asc(schema.photos.filename))
      .limit(limit)
      .offset(offset);

    return NextResponse.json({ photos: rows, total, limit, offset });
  }

  // Full photo objects
  const rows = await db
    .select()
    .from(schema.photos)
    .where(sql`${schema.photos.sessionId} = ${sessionId}${status ? sql` AND ${schema.photos.status} = ${status}` : sql``}`)
    .orderBy(asc(schema.photos.filename))
    .limit(limit)
    .offset(offset);

  const photos = rows.map((p) => ({
    id: p.id,
    filename: p.filename,
    ext: p.ext,
    fileSize: Number(p.fileSize),
    width: p.width,
    height: p.height,
    takenAt: p.takenAt?.toISOString() ?? null,
    blurScore: p.blurScore,
    phash: p.phash,
    classification: p.classification,
    qualityScore: p.qualityScore,
    sentimentScore: p.sentimentScore,
    faceScore: p.faceScore,
    description: p.description,
    status: p.status,
    deleteReason: p.deleteReason,
    duplicateGroupId: p.duplicateGroupId,
    isDuplicateBest: p.isDuplicateBest ?? false,
    isFavorite: p.isFavorite ?? false,
  }));

  return NextResponse.json({ photos, total, limit, offset });
}

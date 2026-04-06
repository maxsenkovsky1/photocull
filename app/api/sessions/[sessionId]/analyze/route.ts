import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  readSession, writeSession, getOriginalPath, getThumbnailPath,
  getThumbnailsDir, getMetadataDir,
} from '@/lib/storage';
import {
  computePhash, computeBlurScore, generateThumbnail,
  extractMetadata, detectContentLocally, prepareForSharp,
} from '@/lib/analysis';
import { classifyPhotoBatch, getCachedResult } from '@/lib/claude';
import { applyRules, groupDuplicatesWithTime } from '@/lib/rules';
import type { Photo, PhotoClassification } from '@/types';
import { AGGRESSIVENESS_CONFIG } from '@/types';

export const maxDuration = 300;

// ─── Concurrency helper ───────────────────────────────────────────────────────
async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const session = readSession(sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  session.status = 'analyzing';
  session.analysisProgress = 0;
  session.analysisStage = 'Processing images…';
  writeSession(session);

  const total = session.photos.length;
  if (total === 0) {
    session.status = 'ready';
    writeSession(session);
    return NextResponse.json({ status: 'ready' });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 1: blur score, pHash, thumbnail, metadata — 4 photos in parallel
  // ─────────────────────────────────────────────────────────────────────────
  let stage1Done = 0;

  await runConcurrent(session.photos, 4, async (photo) => {
    const originalPath = getOriginalPath(sessionId, photo.id, photo.ext);
    if (!fs.existsSync(originalPath)) {
      stage1Done++;
      return;
    }

    const { processPath, cleanup } = await prepareForSharp(originalPath);
    try {
      // Decode the original file once into a 512px working buffer.
      // All subsequent operations (blur, pHash, thumbnail) run in parallel
      // from this small in-memory buffer — avoiding 4 separate disk reads.
      const workingBuffer = await sharp(processPath, { limitInputPixels: false, sequentialRead: true })
        .rotate()
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();

      const [meta, blurScore, phash, thumbnailBuffer] = await Promise.all([
        extractMetadata(processPath),       // still needs original for EXIF
        computeBlurScore(workingBuffer),
        computePhash(workingBuffer),
        generateThumbnail(workingBuffer),
      ]);

      photo.width     = meta.width;
      photo.height    = meta.height;
      photo.takenAt   = meta.takenAt;
      photo.blurScore = blurScore;
      photo.phash     = phash;

      if (thumbnailBuffer) {
        fs.mkdirSync(getThumbnailsDir(sessionId), { recursive: true });
        fs.writeFileSync(getThumbnailPath(sessionId, photo.id), thumbnailBuffer);
      }
    } catch (err) {
      console.error(`[analyze] skipping ${photo.filename} — processing failed:`, err);
    } finally {
      cleanup();
    }

    // Google Photos sidecar JSON
    const sidecarPath = path.join(getMetadataDir(sessionId), `${photo.filename}.json`);
    if (fs.existsSync(sidecarPath)) {
      try {
        const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
        if (sidecar.favorited === true) photo.isFavorite = true;
        if (!photo.takenAt && sidecar.photoTakenTime?.timestamp) {
          const ts = parseInt(sidecar.photoTakenTime.timestamp, 10);
          if (!isNaN(ts)) photo.takenAt = new Date(ts * 1000).toISOString();
        }
      } catch { /* ignore malformed sidecar */ }
    }

    stage1Done++;
    session.analysisProgress = Math.max(1, Math.round((stage1Done / total) * 35));
    session.analysisStage = `Processing images… (${stage1Done}/${total})`;
    writeSession(session);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Pre-classification optimisations
  // ─────────────────────────────────────────────────────────────────────────

  // Opt A: Local content detection
  const localDetections = new Map<string, PhotoClassification>();
  if (!session.skipAI) {
    for (const photo of session.photos) {
      const thumbPath    = getThumbnailPath(sessionId, photo.id);
      const originalPath = getOriginalPath(sessionId, photo.id, photo.ext);
      const detectPath   = fs.existsSync(thumbPath) ? thumbPath : originalPath;
      if (!fs.existsSync(detectPath)) continue;
      const detected = await detectContentLocally(detectPath);
      if (detected) localDetections.set(photo.id, detected);
    }
  }

  // Opt B: Preliminary duplicate grouping
  const config = AGGRESSIVENESS_CONFIG[session.aggressiveness] ?? AGGRESSIVENESS_CONFIG[3];
  const hammingThreshold = session.categoryConfig.removeDuplicates
    ? (session.mode === 'percentage' ? AGGRESSIVENESS_CONFIG[3].duplicateHammingThreshold : config.duplicateHammingThreshold)
    : 0;
  const timeWindowMinutes = session.mode === 'percentage'
    ? AGGRESSIVENESS_CONFIG[3].duplicateTimeWindowMinutes
    : config.duplicateTimeWindowMinutes;

  const prelimGroupMap = hammingThreshold > 0
    ? groupDuplicatesWithTime(
        session.photos.map((p) => ({ id: p.id, phash: p.phash, takenAt: p.takenAt, filename: p.filename })),
        hammingThreshold, timeWindowMinutes,
      )
    : new Map<string, string>();

  const prelimGroups = new Map<string, string[]>();
  for (const [photoId, groupId] of prelimGroupMap.entries()) {
    if (!prelimGroups.has(groupId)) prelimGroups.set(groupId, []);
    prelimGroups.get(groupId)!.push(photoId);
  }

  const clusterRepMap  = new Map<string, string>();
  const skippedDupIds  = new Set<string>();

  for (const [groupId, memberIds] of prelimGroups.entries()) {
    if (memberIds.length < 2) continue;
    const eligible = session.photos.filter((p) => memberIds.includes(p.id) && !localDetections.has(p.id));
    if (eligible.length < 2) continue;
    const rep = eligible.reduce((best, p) => (p.blurScore ?? 0) > (best.blurScore ?? 0) ? p : best);
    clusterRepMap.set(groupId, rep.id);
    for (const p of eligible) {
      if (p.id !== rep.id) skippedDupIds.add(p.id);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 2: AI classification — batched (4 images per API call)
  // ─────────────────────────────────────────────────────────────────────────
  session.analysisStage = session.skipAI ? 'Skipping AI…' : 'Classifying with AI…';
  writeSession(session);

  let aiCallCount  = 0;
  let cacheHits    = 0;
  let skippedLocal = 0;
  let skippedDup   = 0;
  let stage2Done   = 0;

  const BATCH_SIZE = 4;

  // Apply local detections and cache hits immediately; queue the rest for Claude
  const claudeQueue: Photo[] = [];

  for (const photo of session.photos) {
    if (localDetections.has(photo.id)) {
      const cls = localDetections.get(photo.id)!;
      photo.classification = cls;
      photo.qualityScore   = 50;
      photo.sentimentScore = cls === 'receipt' || cls === 'other' ? 10 : 50;
      photo.faceScore      = 0;
      photo.description    = '';
      skippedLocal++;
      stage2Done++;
    } else if (skippedDupIds.has(photo.id)) {
      skippedDup++;
      stage2Done++;
    } else if (!session.skipAI && fs.existsSync(getThumbnailPath(sessionId, photo.id))) {
      const cached = getCachedResult(photo.phash);
      if (cached) {
        photo.classification = cached.classification;
        photo.qualityScore   = cached.qualityScore;
        photo.sentimentScore = cached.sentimentScore;
        photo.faceScore      = cached.faceScore;
        photo.description    = cached.description;
        cacheHits++;
        stage2Done++;
      } else {
        claudeQueue.push(photo);
      }
    } else {
      stage2Done++;
    }
  }

  // Flush progress after immediate assignments
  session.analysisProgress = 35 + Math.round((stage2Done / total) * 55);
  writeSession(session);

  // Split Claude queue into batches of 4, then run 3 batches concurrently
  const batches: Photo[][] = [];
  for (let i = 0; i < claudeQueue.length; i += BATCH_SIZE) {
    batches.push(claudeQueue.slice(i, i + BATCH_SIZE));
  }

  await runConcurrent(batches, 2, async (batch) => {
    const batchInput = batch.map((p) => ({
      thumbnailPath: getThumbnailPath(sessionId, p.id),
      phash: p.phash,
    }));

    const results = await classifyPhotoBatch(batchInput);
    aiCallCount += batch.length;

    for (let j = 0; j < batch.length; j++) {
      const photo  = batch[j];
      const result = results[j];
      photo.classification = result.classification;
      photo.qualityScore   = result.qualityScore;
      photo.sentimentScore = result.sentimentScore;
      photo.faceScore      = result.faceScore;
      photo.description    = result.description;
      stage2Done++;
    }

    session.analysisProgress = 35 + Math.round((stage2Done / total) * 55);
    session.analysisStage    = `Classifying with AI… (${stage2Done}/${total})`;
    writeSession(session);
  });

  // Copy cluster rep scores to skipped duplicate members
  for (const [groupId, repId] of clusterRepMap.entries()) {
    const rep = session.photos.find((p) => p.id === repId);
    if (!rep) continue;
    for (const photo of session.photos) {
      if (!skippedDupIds.has(photo.id)) continue;
      if (!(prelimGroups.get(groupId) ?? []).includes(photo.id)) continue;
      photo.classification = rep.classification;
      photo.qualityScore   = rep.qualityScore;
      photo.sentimentScore = rep.sentimentScore;
      photo.faceScore      = rep.faceScore;
      photo.description    = rep.description;
    }
  }

  const aiOk = session.skipAI || aiCallCount > 0 || cacheHits > 0;
  session.aiClassificationRan = aiOk;
  console.log(`[analyze] ${total} photos: ${aiCallCount} API calls (batched), ${cacheHits} cache hits, ${skippedLocal} local, ${skippedDup} dup copies`);

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 3: Rules + duplicate grouping
  // ─────────────────────────────────────────────────────────────────────────
  session.analysisStage    = 'Applying rules…';
  session.analysisProgress = 92;
  writeSession(session);

  applyRules(session.photos, session.aggressiveness, session.mode, session.targetPercentage, session.categoryConfig);

  session.status           = 'ready';
  session.analysisProgress = 100;
  session.analysisStage    = session.skipAI
    ? 'Complete (AI skipped)'
    : (aiOk ? 'Complete' : 'AI unavailable — check API credits');
  writeSession(session);

  return NextResponse.json({ status: 'ready', total: session.photos.length, aiCallCount, cacheHits });
}

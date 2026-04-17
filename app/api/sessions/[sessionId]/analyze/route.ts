import { NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { readSessionFromDb, writeSessionToDb, updateSessionProgress } from '@/lib/storage-db';
import { getObject, uploadObject, thumbnailKey as makeThumbnailKey } from '@/lib/object-storage';
import {
  computePhash, computeBlurScore, generateThumbnail,
  extractMetadataFromBuffer, detectContentLocally, prepareForSharp,
} from '@/lib/analysis';
import { classifyPhotoBatchFromBuffers, getCachedResult } from '@/lib/claude';
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
  const session = await readSessionFromDb(sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  session.status = 'analyzing';
  session.analysisProgress = 0;
  session.analysisStage = 'Processing images…';
  await writeSessionToDb(session);

  const total = session.photos.length;
  if (total === 0) {
    session.status = 'ready';
    await writeSessionToDb(session);
    return NextResponse.json({ status: 'ready' });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 1: blur score, pHash, thumbnail, metadata — 4 photos in parallel
  // ─────────────────────────────────────────────────────────────────────────
  let stage1Done = 0;

  // Keep a map of photo thumbnails in memory for Stage 2 (avoids re-downloading)
  const thumbnailBuffers = new Map<string, Buffer>();

  await runConcurrent(session.photos, 4, async (photo) => {
    const origKey = `sessions/${sessionId}/originals/${photo.id}${photo.ext}`;
    let originalBuffer: Buffer;
    try {
      originalBuffer = await getObject(origKey);
    } catch {
      stage1Done++;
      return; // file not in R2
    }

    // For HEIC/HEIF files, Sharp may not decode directly from a buffer.
    // Write to a temp file and use prepareForSharp (sips on macOS) to convert.
    let processBuffer: Buffer = originalBuffer;
    let tempCleanup: (() => void) | null = null;

    const isHeic = /\.(heic|heif)$/i.test(photo.ext);
    if (isHeic) {
      const tmpPath = path.join(os.tmpdir(), `shortlist_${photo.id}${photo.ext}`);
      fs.writeFileSync(tmpPath, originalBuffer);
      try {
        const { processPath, cleanup } = await prepareForSharp(tmpPath);
        tempCleanup = () => { cleanup(); try { fs.unlinkSync(tmpPath); } catch {} };
        const converted = fs.readFileSync(processPath);
        console.log(`[analyze] HEIC ${photo.filename}: sips converted ${originalBuffer.length} → ${converted.length} bytes (path: ${processPath})`);
        processBuffer = converted;
      } catch (heicErr) {
        console.error(`[analyze] HEIC conversion failed for ${photo.filename}:`, heicErr);
        tempCleanup = () => { try { fs.unlinkSync(tmpPath); } catch {} };
      }
    }

    try {
      // Decode the original into a 512px working buffer
      const workingBuffer = await sharp(processBuffer, { limitInputPixels: false, sequentialRead: true })
        .rotate()
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();

      const [meta, blurScore, phash, thumbnailBuffer] = await Promise.all([
        extractMetadataFromBuffer(originalBuffer), // use original for EXIF
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
        const thumbKey = makeThumbnailKey(sessionId, photo.id);
        await uploadObject(thumbKey, thumbnailBuffer, 'image/jpeg');
        thumbnailBuffers.set(photo.id, thumbnailBuffer);
      } else {
        console.warn(`[analyze] no thumbnail generated for ${photo.filename} (${photo.ext}) — will skip AI`);
      }
    } catch (err) {
      console.error(`[analyze] skipping ${photo.filename} — processing failed:`, err instanceof Error ? err.message : err);
      // Assign fallback scores so the photo still appears in the review UI
      // Use filename/extension heuristics for classification
      const lowerName = photo.filename.toLowerCase();
      const isScreenshot = lowerName.includes('screenshot') || lowerName.includes('screen shot');
      photo.classification = isScreenshot ? 'screenshot' : 'photo';
      photo.qualityScore = isScreenshot ? 30 : 50;
      photo.sentimentScore = isScreenshot ? 10 : 50;
      photo.faceScore = 0;
      photo.description = `Processing failed — file may be truncated or corrupt`;
    } finally {
      if (tempCleanup) tempCleanup();
    }

    // Google Photos sidecar JSON
    try {
      const sidecarBuf = await getObject(`sessions/${sessionId}/metadata/${photo.filename}.json`);
      const sidecar = JSON.parse(sidecarBuf.toString('utf-8'));
      if (sidecar.favorited === true) photo.isFavorite = true;
      if (!photo.takenAt && sidecar.photoTakenTime?.timestamp) {
        const ts = parseInt(sidecar.photoTakenTime.timestamp, 10);
        if (!isNaN(ts)) photo.takenAt = new Date(ts * 1000).toISOString();
      }
    } catch { /* no sidecar — fine */ }

    stage1Done++;
    session.analysisProgress = Math.max(1, Math.round((stage1Done / total) * 35));
    session.analysisStage = `Processing images… (${stage1Done}/${total})`;
    await updateSessionProgress(sessionId, session.analysisProgress, session.analysisStage);
  });

  // Persist all Stage 1 results
  await writeSessionToDb(session);

  // ─────────────────────────────────────────────────────────────────────────
  // Pre-classification optimisations
  // ─────────────────────────────────────────────────────────────────────────

  // Opt A: Local content detection (runs on thumbnail buffers)
  const localDetections = new Map<string, PhotoClassification>();
  if (!session.skipAI) {
    for (const photo of session.photos) {
      const thumbBuf = thumbnailBuffers.get(photo.id);
      if (!thumbBuf) continue;
      const detected = await detectContentLocally(thumbBuf);
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
  await updateSessionProgress(sessionId, 35, session.analysisStage);

  let aiCallCount  = 0;
  let cacheHits    = 0;
  let skippedLocal = 0;
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
    } else if (!session.skipAI && thumbnailBuffers.has(photo.id)) {
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
      const reason = session.skipAI ? 'skipAI' : !thumbnailBuffers.has(photo.id) ? 'no-thumbnail' : 'unknown';
      console.log(`[analyze] skipping AI for ${photo.filename} (${photo.ext}) — reason: ${reason}`);
      stage2Done++;
    }
  }

  // Flush progress after immediate assignments
  session.analysisProgress = 35 + Math.round((stage2Done / total) * 55);
  await updateSessionProgress(sessionId, session.analysisProgress, session.analysisStage);

  // Split Claude queue into batches of 4, then run 2 batches concurrently
  const batches: Photo[][] = [];
  for (let i = 0; i < claudeQueue.length; i += BATCH_SIZE) {
    batches.push(claudeQueue.slice(i, i + BATCH_SIZE));
  }

  await runConcurrent(batches, 2, async (batch) => {
    // Pass thumbnail buffers directly to Claude instead of file paths
    const batchInput = batch.map((p) => ({
      thumbnailBuffer: thumbnailBuffers.get(p.id)!,
      phash: p.phash,
    }));

    let results: Awaited<ReturnType<typeof classifyPhotoBatchFromBuffers>>;
    try {
      results = await classifyPhotoBatchFromBuffers(batchInput);
      aiCallCount += batch.length;
    } catch (batchErr) {
      console.error(`[analyze] batch of ${batch.length} failed — skipping AI for: ${batch.map(p => p.filename).join(', ')}`, batchErr instanceof Error ? batchErr.message : batchErr);
      stage2Done += batch.length;
      session.analysisProgress = 35 + Math.round((stage2Done / total) * 55);
      await updateSessionProgress(sessionId, session.analysisProgress, session.analysisStage);
      return;
    }

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
    await updateSessionProgress(sessionId, session.analysisProgress, session.analysisStage);
  });

  // Copy quality scores (not classification) from rep to skipped dups
  for (const [groupId, repId] of clusterRepMap.entries()) {
    const rep = session.photos.find((p) => p.id === repId);
    if (!rep) continue;
    for (const photo of session.photos) {
      if (!skippedDupIds.has(photo.id)) continue;
      if (!(prelimGroups.get(groupId) ?? []).includes(photo.id)) continue;
      if (photo.qualityScore !== null) continue;
      photo.qualityScore   = rep.qualityScore;
      photo.sentimentScore = rep.sentimentScore;
      photo.faceScore      = rep.faceScore;
      photo.description    = rep.description;
    }
  }

  const aiOk = session.skipAI || aiCallCount > 0 || cacheHits > 0;
  session.aiClassificationRan = aiOk;
  console.log(`[analyze] ${total} photos: ${aiCallCount} API calls (batched), ${cacheHits} cache hits, ${skippedLocal} local`);

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 3: Rules + duplicate grouping
  // ─────────────────────────────────────────────────────────────────────────
  session.analysisStage    = 'Applying rules…';
  session.analysisProgress = 92;
  await updateSessionProgress(sessionId, 92, 'Applying rules…');

  applyRules(session.photos, session.aggressiveness, session.mode, session.targetPercentage, session.categoryConfig);

  session.status           = 'ready';
  session.analysisProgress = 100;
  session.analysisStage    = session.skipAI
    ? 'Complete (AI skipped)'
    : (aiOk ? 'Complete' : 'AI unavailable — check API credits');
  await writeSessionToDb(session);

  // Free memory
  thumbnailBuffers.clear();

  return NextResponse.json({ status: 'ready', total: session.photos.length, aiCallCount, cacheHits });
}


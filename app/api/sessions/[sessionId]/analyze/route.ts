import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import {
  readSession, writeSession, getOriginalPath, getThumbnailPath,
  getThumbnailsDir, getMetadataDir,
} from '@/lib/storage';
import {
  computePhash, computeBlurScore, generateThumbnail,
  extractMetadata, detectContentLocally, prepareForSharp,
} from '@/lib/analysis';
import { classifyPhoto, getCachedResult } from '@/lib/claude';
import { applyRules, groupDuplicatesWithTime } from '@/lib/rules';
import type { Photo, PhotoClassification } from '@/types';
import { AGGRESSIVENESS_CONFIG } from '@/types';

export const maxDuration = 300;

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
  // Stage 1: blur score, pHash, display thumbnail, metadata (0–40%)
  // ─────────────────────────────────────────────────────────────────────────
  for (let i = 0; i < session.photos.length; i++) {
    const photo = session.photos[i];
    const originalPath = getOriginalPath(sessionId, photo.id, photo.ext);
    if (!fs.existsSync(originalPath)) continue;

    // HEIC/HEIF files need pre-conversion (Sharp's bundled libheif lacks HEVC codec)
    const { processPath, cleanup } = await prepareForSharp(originalPath);
    try {
      const meta = await extractMetadata(processPath);
      photo.width  = meta.width;
      photo.height = meta.height;
      photo.takenAt = meta.takenAt;
      photo.blurScore = await computeBlurScore(processPath);
      photo.phash     = await computePhash(processPath);

      // 400px display thumbnail
      const thumbnailBuffer = await generateThumbnail(processPath);
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

    session.analysisProgress = Math.max(1, Math.round(((i + 1) / total) * 35));
    session.analysisStage = `Processing images… (${i + 1}/${total})`;
    writeSession(session);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Pre-classification optimisations (run before Stage 2 API calls)
  // ─────────────────────────────────────────────────────────────────────────

  // Opt A: Local content detection — flag obvious docs/blanks without Claude
  // Use the thumbnail (already JPEG) when available; skip if neither exists.
  const localDetections = new Map<string, PhotoClassification>();
  if (!session.skipAI) {
    for (const photo of session.photos) {
      const thumbPath = getThumbnailPath(sessionId, photo.id);
      const originalPath = getOriginalPath(sessionId, photo.id, photo.ext);
      const detectPath = fs.existsSync(thumbPath) ? thumbPath : originalPath;
      if (!fs.existsSync(detectPath)) continue;
      const detected = await detectContentLocally(detectPath);
      if (detected) localDetections.set(photo.id, detected);
    }
  }

  // Opt B: Preliminary duplicate grouping — only classify one photo per cluster
  const config = AGGRESSIVENESS_CONFIG[session.aggressiveness] ?? AGGRESSIVENESS_CONFIG[3];
  const hammingThreshold = session.categoryConfig.removeDuplicates
    ? (session.mode === 'percentage'
       ? AGGRESSIVENESS_CONFIG[3].duplicateHammingThreshold
       : config.duplicateHammingThreshold)
    : 0;
  const timeWindowMinutes = session.mode === 'percentage'
    ? AGGRESSIVENESS_CONFIG[3].duplicateTimeWindowMinutes
    : config.duplicateTimeWindowMinutes;

  // photoId → groupId
  const prelimGroupMap = hammingThreshold > 0
    ? groupDuplicatesWithTime(
        session.photos.map((p) => ({ id: p.id, phash: p.phash, takenAt: p.takenAt, filename: p.filename })),
        hammingThreshold, timeWindowMinutes,
      )
    : new Map<string, string>();

  // groupId → member photo IDs
  const prelimGroups = new Map<string, string[]>();
  for (const [photoId, groupId] of prelimGroupMap.entries()) {
    if (!prelimGroups.has(groupId)) prelimGroups.set(groupId, []);
    prelimGroups.get(groupId)!.push(photoId);
  }

  // For each group: pick the sharpest non-locally-detected photo as the rep to classify
  const clusterRepMap = new Map<string, string>(); // groupId → rep photoId
  const skippedDupIds = new Set<string>();          // non-reps that will copy rep's scores

  for (const [groupId, memberIds] of prelimGroups.entries()) {
    if (memberIds.length < 2) continue;
    const eligible = session.photos.filter(
      (p) => memberIds.includes(p.id) && !localDetections.has(p.id),
    );
    if (eligible.length < 2) continue; // all locally detected, no skip needed

    const rep = eligible.reduce((best, p) =>
      (p.blurScore ?? 0) > (best.blurScore ?? 0) ? p : best
    );
    clusterRepMap.set(groupId, rep.id);
    for (const p of eligible) {
      if (p.id !== rep.id) skippedDupIds.add(p.id);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 2: Claude classification (35–90%)
  // ─────────────────────────────────────────────────────────────────────────
  session.analysisStage = session.skipAI
    ? 'Skipping AI (free mode)…'
    : 'Stage 2/2: Classifying with AI…';
  writeSession(session);

  let aiCallCount = 0;
  let cacheHits = 0;
  let skippedLocal = 0;
  let skippedDup = 0;

  for (let i = 0; i < session.photos.length; i++) {
    const photo = session.photos[i];

    if (!session.skipAI) {
      const thumbPath = getThumbnailPath(sessionId, photo.id);

      if (localDetections.has(photo.id)) {
        // Opt A: locally detected
        const cls = localDetections.get(photo.id)!;
        photo.classification = cls;
        photo.qualityScore   = 50;
        photo.sentimentScore = cls === 'receipt' || cls === 'other' ? 10 : 50;
        photo.faceScore      = 0;
        photo.description    = '';
        skippedLocal++;

      } else if (skippedDupIds.has(photo.id)) {
        // Opt B: duplicate non-rep — scores copied after loop
        skippedDup++;

      } else if (fs.existsSync(thumbPath)) {
        // Check cache first (Opt D)
        const cached = getCachedResult(photo.phash);
        if (cached) {
          photo.classification = cached.classification;
          photo.qualityScore   = cached.qualityScore;
          photo.sentimentScore = cached.sentimentScore;
          photo.faceScore      = cached.faceScore;
          photo.description    = cached.description;
          cacheHits++;
        } else {
          // Full Claude API call — thumbnail resized to 200px inside classifyPhoto
          // Note: classifyPhoto handles caching internally (only on success)
          const result = await classifyPhoto(thumbPath, photo.phash);
          photo.classification = result.classification;
          photo.qualityScore   = result.qualityScore;
          photo.sentimentScore = result.sentimentScore;
          photo.faceScore      = result.faceScore;
          photo.description    = result.description;
          aiCallCount++;
        }
      }
    }

    session.analysisProgress = 35 + Math.round(((i + 1) / total) * 55);
    session.analysisStage    = session.skipAI
      ? `Skipping AI… (${i + 1}/${total})`
      : `Classifying with AI… (${i + 1}/${total})`;
    writeSession(session);
  }

  // Copy cluster rep scores to skipped duplicate members
  for (const [groupId, repId] of clusterRepMap.entries()) {
    const rep = session.photos.find((p) => p.id === repId);
    if (!rep) continue;
    const memberIds = prelimGroups.get(groupId) ?? [];
    for (const photo of session.photos) {
      if (!memberIds.includes(photo.id)) continue;
      if (!skippedDupIds.has(photo.id)) continue;
      photo.classification = rep.classification;
      photo.qualityScore   = rep.qualityScore;
      photo.sentimentScore = rep.sentimentScore;
      photo.faceScore      = rep.faceScore;
      photo.description    = rep.description;
    }
  }

  const aiOk = session.skipAI || aiCallCount > 0 || cacheHits > 0;
  session.aiClassificationRan = aiOk;
  console.log(`[analyze] ${total} photos: ${aiCallCount} API calls, ${cacheHits} cache hits, ${skippedLocal} local detections, ${skippedDup} dup copies`);

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 3: Duplicate grouping + deletion rules (90–100%)
  // ─────────────────────────────────────────────────────────────────────────
  session.analysisStage    = 'Applying rules…';
  session.analysisProgress = 92;
  writeSession(session);

  applyRules(session.photos, session.aggressiveness, session.mode, session.targetPercentage, session.categoryConfig);

  session.status           = 'ready';
  session.analysisProgress = 100;
  session.analysisStage    = session.skipAI
    ? 'Complete (AI skipped — duplicates & blur only)'
    : (aiOk ? 'Complete' : 'AI classification unavailable — check API credits');
  writeSession(session);

  return NextResponse.json({ status: 'ready', total: session.photos.length, aiCallCount, cacheHits });
}

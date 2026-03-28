/**
 * Deletion rule application — shared by both the initial analyze route
 * and the fast re-apply route (which skips Claude API calls).
 */
import { groupDuplicates, hammingDistance } from '@/lib/analysis';
import { AGGRESSIVENESS_CONFIG } from '@/types';
import type { Photo, DeleteReason, AggressivenessConfig, PhotoCategoryConfig, SessionMode } from '@/types';

// ─── Duplicate grouping with time proximity ───────────────────────────────────

function extractFileNumber(filename: string): number | null {
  const match = filename.match(/(\d{3,})/);
  return match ? parseInt(match[1], 10) : null;
}

export function groupDuplicatesWithTime(
  photos: Array<{ id: string; phash: string | null; takenAt: string | null; filename: string }>,
  hammingThreshold: number,
  timeWindowMinutes: number,
): Map<string, string> {
  if (timeWindowMinutes <= 0) {
    return groupDuplicates(photos, hammingThreshold);
  }

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!));
    return parent.get(id)!;
  };
  const union = (a: string, b: string) => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const p of photos) {
    if (p.phash) parent.set(p.id, p.id);
  }

  const timeWindowMs = timeWindowMinutes * 60 * 1000;

  for (let i = 0; i < photos.length; i++) {
    if (!photos[i].phash) continue;
    for (let j = i + 1; j < photos.length; j++) {
      if (!photos[j].phash) continue;
      if (hammingDistance(photos[i].phash!, photos[j].phash!) > hammingThreshold) continue;

      const ti = photos[i].takenAt ? new Date(photos[i].takenAt!).getTime() : null;
      const tj = photos[j].takenAt ? new Date(photos[j].takenAt!).getTime() : null;

      if (ti !== null && tj !== null) {
        if (Math.abs(ti - tj) > timeWindowMs) continue;
      } else {
        const ni = extractFileNumber(photos[i].filename);
        const nj = extractFileNumber(photos[j].filename);
        if (ni !== null && nj !== null && Math.abs(ni - nj) > 10) continue;
      }

      union(photos[i].id, photos[j].id);
    }
  }

  const result = new Map<string, string>();
  for (const p of photos) {
    if (p.phash) result.set(p.id, find(p.id));
  }
  return result;
}

// ─── Adaptive blur ────────────────────────────────────────────────────────────

export interface BlurPercentiles { p5: number; p15: number; p25: number; p35: number; }

export function computeAdaptiveBlurThresholds(photos: Photo[]): BlurPercentiles {
  const scores = photos
    .map((p) => p.blurScore)
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  if (scores.length === 0) return { p5: 0, p15: 0, p25: 0, p35: 0 };
  const pct = (p: number) => scores[Math.max(0, Math.min(Math.floor(scores.length * p / 100), scores.length - 1))];
  return { p5: pct(5), p15: pct(15), p25: pct(25), p35: pct(35) };
}

export function buildAdaptiveConfig(config: AggressivenessConfig, p: BlurPercentiles): AggressivenessConfig {
  const levels = [1, 2, 3, 4, 5];
  const matchedLevel = levels.find(
    (l) => AGGRESSIVENESS_CONFIG[l].blurThreshold === config.blurThreshold &&
            AGGRESSIVENESS_CONFIG[l].qualityThreshold === config.qualityThreshold
  ) ?? 3;
  const adaptiveBlur: Record<number, number> = { 2: p.p5, 3: p.p15, 4: p.p25, 5: p.p35 };
  return { ...config, blurThreshold: adaptiveBlur[matchedLevel] ?? config.blurThreshold };
}

// ─── Best photo in duplicate group ───────────────────────────────────────────

export function pickBestInGroup(members: Photo[]): string {
  // Favorites always win in their group
  const favs = members.filter((m) => m.isFavorite);
  if (favs.length === 1) return favs[0].id;

  // Explicitly user-kept photos win over AI suggestions
  const userKept = members.filter((m) => m.status === 'keep');
  if (userKept.length === 1) return userKept[0].id;

  const maxFace = Math.max(...members.map((m) => m.faceScore ?? 0));
  let faceW: number, blurW: number, qualityW: number;
  if (maxFace >= 65)      { faceW = 0.50; blurW = 0.25; qualityW = 0.25; }
  else if (maxFace >= 30) { faceW = 0.30; blurW = 0.35; qualityW = 0.35; }
  else                    { faceW = 0.10; blurW = 0.45; qualityW = 0.45; }

  const maxBlur = Math.max(...members.map((m) => m.blurScore ?? 0));
  let bestId = members[0].id;
  let bestScore = -1;

  for (const m of members) {
    const normBlur = maxBlur > 0 ? ((m.blurScore ?? 0) / maxBlur) * 100 : 50;
    const composite = normBlur * blurW + (m.qualityScore ?? 50) * qualityW + (m.faceScore ?? 0) * faceW;
    if (composite > bestScore) { bestScore = composite; bestId = m.id; }
  }
  return bestId;
}

// ─── Deletion rules ───────────────────────────────────────────────────────────

export function getSuggestedDeleteReason(
  photo: Photo,
  config: AggressivenessConfig,
  cat: PhotoCategoryConfig,
): DeleteReason {
  if (photo.isFavorite) return null;
  if (cat.removeDuplicates && photo.duplicateGroupId && !photo.isDuplicateBest) return 'duplicate';
  if (cat.removeBlurry && config.blurThreshold > 0 && photo.blurScore !== null && photo.blurScore < config.blurThreshold) return 'blurry';
  if (cat.removeScreenshots && config.includeScreenshots && photo.classification === 'screenshot') return 'screenshot';
  if (cat.removeReceipts && config.includeReceipts && (photo.classification === 'receipt' || photo.classification === 'document')) return 'receipt';
  if (cat.removeMemes && config.includeMemes && photo.classification === 'meme') return 'meme';
  if (cat.removeLowQuality && config.includeLowQuality && !photo.isDuplicateBest) {
    if (photo.qualityScore !== null && photo.qualityScore < config.qualityThreshold) return 'low_quality';
    if (photo.sentimentScore !== null && photo.sentimentScore < config.sentimentThreshold) return 'low_quality';
  }
  return null;
}

// ─── Percentage mode ─────────────────────────────────────────────────────────

function removabilityScore(photo: Photo, cat: PhotoCategoryConfig): number {
  let score = 0;
  if (cat.removeDuplicates && photo.duplicateGroupId && !photo.isDuplicateBest) score = Math.max(score, 90);
  if (cat.removeBlurry && photo.blurScore !== null) {
    if (photo.blurScore < 50)  score = Math.max(score, 80);
    else if (photo.blurScore < 200) score = Math.max(score, 55);
    else if (photo.blurScore < 500) score = Math.max(score, 30);
  }
  if (photo.classification === 'other') score = Math.max(score, 75);
  if (cat.removeScreenshots && photo.classification === 'screenshot') score = Math.max(score, 65);
  if (cat.removeReceipts && photo.classification === 'receipt') score = Math.max(score, 60);
  if (cat.removeMemes && photo.classification === 'meme') score = Math.max(score, 55);
  if (photo.qualityScore !== null)   score = Math.max(score, (100 - photo.qualityScore) * 0.4);
  if (photo.sentimentScore !== null) score = Math.max(score, (100 - photo.sentimentScore) * 0.3);
  if (photo.isDuplicateBest) score *= 0.5;
  return score;
}

function getDeleteReasonFromScore(photo: Photo): DeleteReason {
  if (photo.duplicateGroupId && !photo.isDuplicateBest) return 'duplicate';
  if (photo.blurScore !== null && photo.blurScore < 200) return 'blurry';
  if (photo.classification === 'screenshot') return 'screenshot';
  if (photo.classification === 'receipt' || photo.classification === 'document') return 'receipt';
  if (photo.classification === 'meme') return 'meme';
  return 'low_quality';
}

export function applyPercentageMode(photos: Photo[], targetPct: number, cat: PhotoCategoryConfig) {
  const eligible = photos.filter((p) => !p.isFavorite && p.status !== 'keep' && p.status !== 'trash');
  const target = Math.min(Math.floor(eligible.length * (targetPct / 100)), eligible.length - 1);
  if (target <= 0) return;

  const scored = eligible.map((p) => ({ photo: p, score: removabilityScore(p, cat) }));
  scored.sort((a, b) => b.score - a.score);
  for (let i = 0; i < scored.length; i++) {
    if (i < target) {
      scored[i].photo.status = 'suggested_delete';
      scored[i].photo.deleteReason = getDeleteReasonFromScore(scored[i].photo);
    } else {
      scored[i].photo.status = 'pending';
      scored[i].photo.deleteReason = null;
    }
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Apply duplicate grouping + deletion rules to an already-analyzed photo array.
 * Does NOT touch photos that are explicitly user-kept or user-trashed.
 * Clears previous AI suggestions before re-applying.
 */
export function applyRules(
  photos: Photo[],
  aggressiveness: number,
  mode: SessionMode,
  targetPercentage: number | null,
  cat: PhotoCategoryConfig,
) {
  // Step 1: Reset only AI-suggested statuses — preserve user's explicit keep/trash
  for (const photo of photos) {
    if (photo.status === 'suggested_delete') {
      photo.status = 'pending';
      photo.deleteReason = null;
    }
    // Always clear duplicate group data — will be recalculated
    photo.duplicateGroupId = null;
    photo.isDuplicateBest = false;
  }

  const config = AGGRESSIVENESS_CONFIG[aggressiveness] ?? AGGRESSIVENESS_CONFIG[3];

  // Step 2: Duplicate grouping
  let hammingThreshold = 0;
  if (cat.removeDuplicates) {
    hammingThreshold = mode === 'percentage'
      ? AGGRESSIVENESS_CONFIG[3].duplicateHammingThreshold
      : config.duplicateHammingThreshold;
  }

  const timeWindowMinutes = mode === 'percentage'
    ? AGGRESSIVENESS_CONFIG[3].duplicateTimeWindowMinutes
    : config.duplicateTimeWindowMinutes;

  if (hammingThreshold > 0) {
    const photoHashes = photos.map((p) => ({
      id: p.id, phash: p.phash, takenAt: p.takenAt, filename: p.filename,
    }));
    const groupMap = groupDuplicatesWithTime(photoHashes, hammingThreshold, timeWindowMinutes);

    const groupMembers = new Map<string, string[]>();
    for (const [photoId, groupId] of groupMap.entries()) {
      if (!groupMembers.has(groupId)) groupMembers.set(groupId, []);
      groupMembers.get(groupId)!.push(photoId);
    }

    for (const [, memberIds] of groupMembers.entries()) {
      if (memberIds.length < 2) continue;
      const members = photos.filter((p) => memberIds.includes(p.id));
      const bestId = pickBestInGroup(members);
      for (const photo of members) {
        photo.duplicateGroupId = memberIds[0];
        photo.isDuplicateBest = photo.id === bestId;
      }
    }
  }

  // Step 3: Apply deletion rules (skip already user-decided photos)
  if (mode === 'percentage' && targetPercentage) {
    applyPercentageMode(photos, targetPercentage, cat);
  } else {
    const blurPercentiles = computeAdaptiveBlurThresholds(photos);
    const adaptiveConfig = buildAdaptiveConfig(config, blurPercentiles);
    for (const photo of photos) {
      if (photo.status === 'keep' || photo.status === 'trash') continue;
      const reason = getSuggestedDeleteReason(photo, adaptiveConfig, cat);
      if (reason) {
        photo.status = 'suggested_delete';
        photo.deleteReason = reason;
      }
    }
  }
}

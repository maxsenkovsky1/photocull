import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { PhotoClassification } from '@/types';

const execFileAsync = promisify(execFile);

/**
 * HEIC/HEIF files need pre-conversion because Sharp's bundled libheif
 * lacks the HEVC codec. On macOS, use sips (built-in) to convert to JPEG
 * first, then process the JPEG with Sharp.
 *
 * Returns the path to use for Sharp operations, plus a cleanup callback
 * to delete the temp file (if one was created).
 */
export async function prepareForSharp(
  imagePath: string,
): Promise<{ processPath: string; cleanup: () => void }> {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext !== '.heic' && ext !== '.heif') {
    return { processPath: imagePath, cleanup: () => {} };
  }

  const tmpFile = path.join(
    os.tmpdir(),
    `photocull_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`,
  );
  const cleanup = () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } };

  // 1. Try sips (macOS built-in — fast)
  try {
    await execFileAsync('sips', ['-s', 'format', 'jpeg', imagePath, '--out', tmpFile]);
    if (fs.existsSync(tmpFile)) return { processPath: tmpFile, cleanup };
  } catch { /* sips not available (Linux) */ }

  // 2. Try ffmpeg (installed via Dockerfile on Linux/Render — reliable HEVC decoder)
  try {
    await execFileAsync('ffmpeg', ['-y', '-i', imagePath, '-q:v', '2', tmpFile]);
    if (fs.existsSync(tmpFile)) return { processPath: tmpFile, cleanup };
  } catch { /* ffmpeg not available */ }

  // 3. Fallback: heic-convert (pure JS WASM — slow but no system deps)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const heicConvert = require('heic-convert') as (opts: {
      buffer: Buffer; format: 'JPEG'; quality: number;
    }) => Promise<ArrayBuffer>;
    const inputBuffer = fs.readFileSync(imagePath);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('heic-convert timeout')), 45_000),
    );
    const outputBuffer = await Promise.race([
      heicConvert({ buffer: inputBuffer, format: 'JPEG', quality: 0.9 }),
      timeout,
    ]);
    fs.writeFileSync(tmpFile, Buffer.from(outputBuffer));
    return { processPath: tmpFile, cleanup };
  } catch (err) {
    console.error('[prepareForSharp] heic-convert failed:', (err as Error).message);
  }

  // 4. Last resort — return original (Sharp will fail gracefully)
  return { processPath: imagePath, cleanup: () => {} };
}

/**
 * Compute Average Hash (aHash) for an image.
 * Returns a 16-character hex string (64 bits).
 * Lower Hamming distance = more similar images.
 */
export async function computePhash(imagePath: string): Promise<string | null> {
  try {
    const { data } = await sharp(imagePath)
      .resize(8, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8Array(data);
    const mean = pixels.reduce((sum, p) => sum + p, 0) / pixels.length;

    let bits = '';
    for (const p of pixels) {
      bits += p >= mean ? '1' : '0';
    }

    // Convert 64-bit binary string to 16-char hex
    let hex = '';
    for (let i = 0; i < bits.length; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return null;
  }
}

/**
 * Compute Laplacian variance as a blur score.
 * Higher = sharper. Lower = blurrier.
 * Rough calibration: <100 very blurry, 100–500 soft, >500 sharp.
 * NOTE: these thresholds need calibration from real-world testing.
 */
export async function computeBlurScore(imagePath: string): Promise<number | null> {
  try {
    const { data, info } = await sharp(imagePath)
      .resize(512, 512, { fit: 'inside' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8Array(data);
    const { width, height } = info;

    let sum = 0;
    let sumSq = 0;
    let count = 0;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        // 4-connected Laplacian kernel
        const lap =
          4 * pixels[idx] -
          pixels[idx - 1] -
          pixels[idx + 1] -
          pixels[idx - width] -
          pixels[idx + width];
        sum += lap;
        sumSq += lap * lap;
        count++;
      }
    }

    const mean = sum / count;
    const variance = sumSq / count - mean * mean;
    return Math.round(variance * 100) / 100;
  } catch {
    return null;
  }
}

/**
 * Compute Hamming distance between two hex-encoded hashes.
 */
export function hammingDistance(hash1: string, hash2: string): number {
  let distance = 0;
  const len = Math.min(hash1.length, hash2.length);
  for (let i = 0; i < len; i++) {
    const xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16);
    distance += xor.toString(2).split('1').length - 1;
  }
  return distance;
}

/**
 * Generate a thumbnail (max 400px wide/tall) and return as JPEG buffer.
 */
export async function generateThumbnail(imagePath: string): Promise<Buffer | null> {
  try {
    return await sharp(imagePath)
      .rotate() // auto-orient based on EXIF
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * Extract basic metadata from an image.
 */
export async function extractMetadata(imagePath: string): Promise<{
  width: number | null;
  height: number | null;
  takenAt: string | null;
}> {
  try {
    const metadata = await sharp(imagePath).metadata();
    let takenAt: string | null = null;
    if (metadata.exif) {
      // Try to parse DateTimeOriginal from EXIF
      try {
        const exifData = metadata.exif.toString('binary');
        const match = exifData.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
        if (match) {
          takenAt = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
        }
      } catch {
        // EXIF parsing is best-effort
      }
    }
    return {
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      takenAt,
    };
  } catch {
    return { width: null, height: null, takenAt: null };
  }
}

/**
 * Quick local content detection — avoids an API call for obvious non-photos.
 * Returns a classification if confident, or null to let Claude decide.
 *
 * Detects:
 *   'receipt'  — nearly-white image (document, receipt, blank page)
 *   'other'    — nearly-uniform / corrupted
 *   null       — unclear, use Claude
 */
export async function detectContentLocally(
  imagePath: string,
): Promise<PhotoClassification | null> {
  try {
    const { data } = await sharp(imagePath)
      .resize(100, 100, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8Array(data);
    const mean = pixels.reduce((s, p) => s + p, 0) / pixels.length;
    const variance = pixels.reduce((s, p) => s + (p - mean) ** 2, 0) / pixels.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev < 6)             return 'other';   // nearly uniform = blank / solid color
    if (mean > 222 && stdDev < 38) return 'receipt'; // nearly-white = doc/receipt/screenshot
    return null;
  } catch {
    return null;
  }
}

/**
 * Group photos into duplicate clusters by pHash Hamming distance.
 * Uses Union-Find so transitivity is respected: if A≈B and B≈C, all three cluster together.
 * Returns a map of photoId → groupId.
 */
export function groupDuplicates(
  photos: Array<{ id: string; phash: string | null }>,
  threshold: number
): Map<string, string> {
  const parent = new Map<string, string>();

  const find = (id: string): string => {
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!));
    return parent.get(id)!;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const p of photos) {
    if (p.phash) parent.set(p.id, p.id);
  }

  for (let i = 0; i < photos.length; i++) {
    if (!photos[i].phash) continue;
    for (let j = i + 1; j < photos.length; j++) {
      if (!photos[j].phash) continue;
      if (hammingDistance(photos[i].phash!, photos[j].phash!) <= threshold) {
        union(photos[i].id, photos[j].id);
      }
    }
  }

  const result = new Map<string, string>();
  for (const p of photos) {
    if (p.phash) result.set(p.id, find(p.id));
  }
  return result;
}

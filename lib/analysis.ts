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
 * lacks the HEVC codec. On macOS, sips (built-in) handles it perfectly.
 * Falls back to extracting the JPEG thumbnail embedded in the EXIF data
 * (every iPhone HEIC contains one — typically 512×384 px, good enough for
 * blur scoring, pHash, and AI classification).
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

  // 1. sips — macOS built-in, fast and colour-accurate
  try {
    await execFileAsync('sips', ['-s', 'format', 'jpeg', imagePath, '--out', tmpFile]);
    if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 1000) {
      return { processPath: tmpFile, cleanup };
    }
  } catch { /* sips not available (Linux) */ }

  // 2. heif-convert — Linux (installed via libheif-examples apt package)
  try {
    await execFileAsync('heif-convert', ['-q', '85', imagePath, tmpFile]);
    if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 1000) {
      return { processPath: tmpFile, cleanup };
    }
  } catch { /* heif-convert not available */ }

  // 3. Extract the JPEG thumbnail embedded in the EXIF data (no HEVC decoding needed)
  try {
    const meta = await sharp(imagePath).metadata();
    if (meta.exif && meta.exif.length > 100) {
      const thumb = extractJpegFromExif(meta.exif);
      if (thumb) {
        fs.writeFileSync(tmpFile, thumb);
        return { processPath: tmpFile, cleanup };
      }
    }
  } catch { /* ignore */ }

  // Fall through — Sharp will fail gracefully on unsupported HEIC
  cleanup();
  return { processPath: imagePath, cleanup: () => {} };
}

/**
 * Parse a raw EXIF buffer and extract the IFD1 JPEG thumbnail bytes.
 * Every iPhone photo embeds a JPEG thumbnail in the EXIF IFD1 entry.
 */
function extractJpegFromExif(exif: Buffer): Buffer | null {
  try {
    // EXIF starts with "Exif\0\0" then a TIFF header
    const base = 6;
    const byteOrder = exif.toString('ascii', base, base + 2);
    const le = byteOrder === 'II'; // little-endian (Intel) vs big-endian (Motorola)
    const r16 = (o: number) => le ? exif.readUInt16LE(o) : exif.readUInt16BE(o);
    const r32 = (o: number) => le ? exif.readUInt32LE(o) : exif.readUInt32BE(o);

    // IFD0 starts at the offset stored in the TIFF header
    const ifd0 = base + r32(base + 4);
    const ifd0Count = r16(ifd0);

    // IFD1 offset is stored at the end of IFD0's entry list
    const ifd1Ptr = r32(ifd0 + 2 + ifd0Count * 12);
    if (!ifd1Ptr || ifd1Ptr + base >= exif.length) return null;
    const ifd1 = base + ifd1Ptr;

    const ifd1Count = r16(ifd1);
    let thumbOffset = 0;
    let thumbLength = 0;

    for (let i = 0; i < ifd1Count; i++) {
      const e = ifd1 + 2 + i * 12;
      if (e + 12 > exif.length) break;
      const tag = r16(e);
      if (tag === 0x0201) thumbOffset = r32(e + 8); // JpegInterchangeFormat
      if (tag === 0x0202) thumbLength = r32(e + 8); // JpegInterchangeFormatLength
    }

    if (!thumbOffset || !thumbLength) return null;
    const start = base + thumbOffset;
    const end = start + thumbLength;
    if (end > exif.length) return null;

    const thumb = exif.slice(start, end);
    // Validate it's a real JPEG (starts with FF D8 FF) and is a reasonable size
    if (thumb[0] === 0xFF && thumb[1] === 0xD8 && thumb.length > 5000) {
      return thumb;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Compute Average Hash (aHash) for an image.
 * Returns a 16-character hex string (64 bits).
 * Lower Hamming distance = more similar images.
 */
export async function computePhash(input: string | Buffer): Promise<string | null> {
  try {
    const { data } = await sharp(input, { limitInputPixels: false, sequentialRead: true })
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
export async function computeBlurScore(input: string | Buffer): Promise<number | null> {
  try {
    const { data, info } = await sharp(input, { limitInputPixels: false, sequentialRead: true })
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
export async function generateThumbnail(input: string | Buffer): Promise<Buffer | null> {
  // 1. Try Sharp (fast, handles most formats)
  try {
    return await sharp(input, { limitInputPixels: false, sequentialRead: true })
      .rotate() // auto-orient based on EXIF
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (err) {
    console.error(`[thumbnail] Sharp failed for ${imagePath}:`, err);
  }

  // 2. Fallback: sips (macOS built-in — handles large PNGs, HEIC, TIFF reliably)
  // Only applicable when input is a file path
  if (typeof input !== 'string') return null;
  const tmpFile = path.join(
    os.tmpdir(),
    `photocull_thumb_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`,
  );
  try {
    await execFileAsync('sips', [
      '--resampleHeightWidthMax', '400',
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', '80',
      imagePath,
      '--out', tmpFile,
    ]);
    if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 500) {
      const buf = fs.readFileSync(tmpFile);
      fs.unlinkSync(tmpFile);
      return buf;
    }
  } catch (err) {
    console.error(`[thumbnail] sips fallback failed for ${imagePath}:`, err);
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }

  return null;
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
    const metadata = await sharp(imagePath, { limitInputPixels: false }).metadata();
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
  input: string | Buffer,
): Promise<PhotoClassification | null> {
  try {
    const { data } = await sharp(input, { limitInputPixels: false, sequentialRead: true })
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

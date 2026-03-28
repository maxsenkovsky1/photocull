import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import type { PhotoClassification } from '@/types';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ClassificationResult {
  classification: PhotoClassification;
  qualityScore: number;
  sentimentScore: number;
  faceScore: number;
  description: string;
}

// ─── pHash result cache ───────────────────────────────────────────────────────
// Keyed by pHash hex string → stored on disk between sessions.
// Saves API calls for re-uploaded or duplicate photos.

const CACHE_DIR  = path.join(process.cwd(), 'storage', '_cache');
const CACHE_FILE = path.join(CACHE_DIR, 'phash.json');

function loadCache(): Record<string, ClassificationResult> {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch { /* corrupt cache — start fresh */ }
  return {};
}

function saveCache(cache: Record<string, ClassificationResult>) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch { /* non-fatal */ }
}

// Lazy-load cache once per server process
let _cache: Record<string, ClassificationResult> | null = null;

function getCache(): Record<string, ClassificationResult> {
  if (!_cache) _cache = loadCache();
  return _cache;
}

export function getCachedResult(phash: string | null): ClassificationResult | null {
  if (!phash) return null;
  const cached = getCache()[phash];
  if (!cached) return null;
  // Reject entries that look like API-failure fallbacks (poison from previous bug)
  if (
    cached.description === '' &&
    cached.qualityScore === 50 &&
    cached.sentimentScore === 50 &&
    cached.faceScore === 0
  ) return null;
  return cached;
}

export function setCachedResult(phash: string | null, result: ClassificationResult) {
  if (!phash) return;
  const cache = getCache();
  cache[phash] = result;
  saveCache(cache);
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a photo quality analyst for a library cleanup app.
Return ONLY valid JSON. No markdown, no code blocks, no explanation.`;

const USER_PROMPT = `Analyze this photo and return exactly this JSON:
{
  "classification": <string>,
  "quality_score": <integer 0-100>,
  "sentiment_score": <integer 0-100>,
  "face_score": <integer 0-100>,
  "description": <string>
}

── classification ──
"photo"      real photograph (people, places, food, nature, events, objects)
"screenshot" screen capture from phone, computer, app, or game
"receipt"    photo of receipt, invoice, bill, or financial document
"meme"       meme, forwarded image, or image with overlaid text/humor
"document"   photo of document, whiteboard, paper, or text
"other"      blank, corrupted, or unidentifiable

── quality_score (technical quality) ──
Judge sharpness, exposure, framing, and noise.
0  = completely blurry, totally dark, or corrupt
30 = noticeably blurry, poor exposure, or badly framed
60 = acceptable sharpness and exposure
85 = sharp, well-exposed, good composition
100 = technically excellent in every dimension

── sentiment_score (personal/emotional value) ──
Judge how meaningful this photo likely is as a memory.
0  = zero value: accidental shot, pure screen content, junk, blank
20 = generic object or place with no apparent personal meaning
50 = ordinary moment — fine to keep, but not special
80 = meaningful: gathering, milestone, personal achievement, travel
100 = precious: birthday, wedding, reunion, once-in-a-lifetime moment

── face_score (primary subject's expression) ──
Focus on the MOST PROMINENT person in the frame (largest face, most centered,
or clearly the intended subject — e.g. the person being photographed, not bystanders).
If it is a selfie, judge the selfie-taker.

0  = no human faces visible
15 = face(s) present but obscured, turned away, or at extreme distance
35 = face visible, eyes closed or looking away
50 = face visible, neutral expression, looking at camera
70 = primary subject smiling naturally or expressing genuine positive emotion
85 = primary subject with a great, clearly happy smile; well-lit
100 = outstanding portrait: primary subject beaming, sharp focus on their face,
      excellent lighting, eyes open and bright

If multiple people: score the PRIMARY subject's expression, not the group average.
A photo where the main subject is smiling beautifully beats one where many people
are present but the main subject looks away or is unsmiling.

── description ──
One brief sentence describing the photo's content (e.g. "Woman smiling at outdoor birthday party").`;

// ─── Main classify function ───────────────────────────────────────────────────

export async function classifyPhoto(
  thumbnailPath: string,
  phash?: string | null,
): Promise<ClassificationResult> {
  const fallback: ClassificationResult = {
    classification: 'photo',
    qualityScore: 50,
    sentimentScore: 50,
    faceScore: 0,
    description: '',
  };

  // Check cache first
  if (phash) {
    const cached = getCachedResult(phash);
    if (cached) return cached;
  }

  try {
    // Resize to 200×200 in-memory before sending — cuts token usage ~75% vs 400px
    const resized = await sharp(thumbnailPath)
      .resize(200, 200, { fit: 'inside' })
      .jpeg({ quality: 75 })
      .toBuffer();
    const base64 = resized.toString('base64');

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: USER_PROMPT },
          ],
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
    const clean = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(clean);

    const result: ClassificationResult = {
      classification: (parsed.classification as PhotoClassification) ?? 'photo',
      qualityScore:   clamp(parseInt(parsed.quality_score)   || 50),
      sentimentScore: clamp(parseInt(parsed.sentiment_score) || 50),
      faceScore:      clamp(parseInt(parsed.face_score)      || 0),
      description:    String(parsed.description ?? '').slice(0, 200),
    };

    // Save to cache
    if (phash) setCachedResult(phash, result);

    return result;
  } catch (err) {
    console.error('[classifyPhoto] Failed:', err instanceof Error ? err.message : err);
    return fallback;
  }
}

function clamp(v: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, isNaN(v) ? 50 : v));
}

import { NextResponse } from 'next/server';
import { classifyPhotoBatchFromBuffers, getCachedResult, setCachedResult } from '@/lib/claude';
import type { ClassificationResult } from '@/lib/claude';

export const maxDuration = 90;

/**
 * Classify a batch of photos via Claude.
 * Accepts base64 thumbnails from the mobile app.
 * Returns classification results.
 *
 * Request body:
 *   { photos: Array<{ thumbnailBase64: string, phash: string | null }> }
 *
 * Response:
 *   ClassifyResult[]
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const photos: Array<{ thumbnailBase64: string; phash: string | null }> = body.photos;

    if (!Array.isArray(photos) || photos.length === 0) {
      return NextResponse.json({ error: 'photos array required' }, { status: 400 });
    }

    if (photos.length > 8) {
      return NextResponse.json({ error: 'max 8 photos per request' }, { status: 400 });
    }

    // Check cache first
    const results: (ClassificationResult | null)[] = photos.map((p) =>
      p.phash ? getCachedResult(p.phash) : null,
    );

    // Find which ones need classification
    const uncached: Array<{ index: number; thumbnailBuffer: Buffer; phash: string | null }> = [];
    for (let i = 0; i < photos.length; i++) {
      if (!results[i]) {
        uncached.push({
          index: i,
          thumbnailBuffer: Buffer.from(photos[i].thumbnailBase64, 'base64'),
          phash: photos[i].phash,
        });
      }
    }

    // Classify uncached photos
    if (uncached.length > 0) {
      const batchInput = uncached.map((u) => ({
        thumbnailBuffer: u.thumbnailBuffer,
        phash: u.phash,
      }));

      const classified = await classifyPhotoBatchFromBuffers(batchInput);

      for (let j = 0; j < uncached.length; j++) {
        const { index, phash } = uncached[j];
        results[index] = classified[j];

        // Cache the result
        if (phash && classified[j]) {
          setCachedResult(phash, classified[j]);
        }
      }
    }

    // Fill any remaining nulls with defaults
    const finalResults = results.map((r) => r ?? {
      classification: 'photo',
      qualityScore: 50,
      sentimentScore: 50,
      faceScore: 0,
      description: '',
    });

    return NextResponse.json(finalResults);
  } catch (err) {
    console.error('[classify] error:', err);
    return NextResponse.json({ error: 'Classification failed' }, { status: 500 });
  }
}

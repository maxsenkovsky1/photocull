import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { readSession, writeSession, getOriginalPath, getMetadataDir, ensureSessionDirs } from '@/lib/storage';
import type { Photo } from '@/types';

const ACCEPTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.tiff', '.tif']);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const session = readSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  ensureSessionDirs(sessionId);

  const formData = await request.formData();
  const files = formData.getAll('files') as File[];

  // First pass: collect JSON sidecars and save them to the metadata directory
  // Google Photos exports sidecars named "photo.jpg.json" (full filename + .json)
  for (const file of files) {
    if (path.extname(file.name).toLowerCase() === '.json') {
      const metaDir = getMetadataDir(sessionId);
      const metaPath = path.join(metaDir, file.name);
      const arrayBuffer = await file.arrayBuffer();
      fs.writeFileSync(metaPath, Buffer.from(arrayBuffer));
    }
  }

  // Second pass: process image files
  const uploaded: Pick<Photo, 'id' | 'filename' | 'ext' | 'fileSize'>[] = [];

  for (const file of files) {
    const ext = path.extname(file.name).toLowerCase();
    if (!ACCEPTED_IMAGE_EXTENSIONS.has(ext)) continue;

    const photoId = uuidv4();
    const filePath = getOriginalPath(sessionId, photoId, ext);

    const arrayBuffer = await file.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer));

    const photo: Photo = {
      id: photoId,
      filename: file.name,
      ext,
      fileSize: file.size,
      width: null,
      height: null,
      takenAt: null,
      blurScore: null,
      phash: null,
      classification: 'photo',
      qualityScore: null,
      sentimentScore: null,
      faceScore: null,
      description: null,
      status: 'pending',
      deleteReason: null,
      duplicateGroupId: null,
      isDuplicateBest: false,
      isFavorite: false,
    };

    session.photos.push(photo);
    uploaded.push({ id: photoId, filename: file.name, ext, fileSize: file.size });
  }

  session.status = 'uploading';
  writeSession(session);

  return NextResponse.json({ uploaded, total: session.photos.length });
}

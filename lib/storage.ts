import fs from 'fs';
import path from 'path';
import type { Session } from '@/types';

// In production on Render, point to the mounted persistent disk via STORAGE_DIR env var.
// Falls back to ./storage for local development.
const STORAGE_DIR = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(process.cwd(), 'storage');

export function getSessionDir(sessionId: string) {
  return path.join(STORAGE_DIR, sessionId);
}

export function getOriginalsDir(sessionId: string) {
  return path.join(getSessionDir(sessionId), 'originals');
}

export function getThumbnailsDir(sessionId: string) {
  return path.join(getSessionDir(sessionId), 'thumbnails');
}

export function getSessionDataPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), 'data.json');
}

export function getOriginalPath(sessionId: string, photoId: string, ext: string) {
  return path.join(getOriginalsDir(sessionId), `${photoId}${ext}`);
}

export function getThumbnailPath(sessionId: string, photoId: string) {
  return path.join(getThumbnailsDir(sessionId), `${photoId}.jpg`);
}

export function getMetadataDir(sessionId: string) {
  return path.join(getSessionDir(sessionId), 'metadata');
}

export function getMetadataPath(sessionId: string, originalFilename: string) {
  // Google Photos exports sidecar as "photo.jpg.json"
  return path.join(getMetadataDir(sessionId), `${originalFilename}.json`);
}

export function ensureSessionDirs(sessionId: string) {
  fs.mkdirSync(getOriginalsDir(sessionId), { recursive: true });
  fs.mkdirSync(getThumbnailsDir(sessionId), { recursive: true });
  fs.mkdirSync(getMetadataDir(sessionId), { recursive: true });
}

export function readSession(sessionId: string): Session | null {
  const dataPath = getSessionDataPath(sessionId);
  if (!fs.existsSync(dataPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Session;
  } catch {
    return null;
  }
}

export function writeSession(session: Session) {
  const dataPath = getSessionDataPath(session.id);
  fs.writeFileSync(dataPath, JSON.stringify(session, null, 2));
}

export function sessionExists(sessionId: string): boolean {
  return fs.existsSync(getSessionDataPath(sessionId));
}

export type PhotoStatus = 'pending' | 'keep' | 'suggested_delete' | 'trash';
export type PhotoClassification = 'photo' | 'screenshot' | 'receipt' | 'meme' | 'document' | 'other';
export type DeleteReason = 'duplicate' | 'blurry' | 'screenshot' | 'receipt' | 'meme' | 'low_quality' | null;
export type SessionStatus = 'uploading' | 'analyzing' | 'ready' | 'error';
export type SessionMode = 'aggressiveness' | 'percentage';

export interface Photo {
  id: string;
  filename: string;
  ext: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  takenAt: string | null;
  blurScore: number | null;
  phash: string | null;
  classification: PhotoClassification;
  qualityScore: number | null;
  sentimentScore: number | null;
  faceScore: number | null;
  description: string | null;
  status: PhotoStatus;
  deleteReason: DeleteReason;
  duplicateGroupId: string | null;
  isDuplicateBest: boolean;
  isFavorite: boolean;        // user-starred or imported as favorite
}

/** Which deletion categories the user opted into */
export interface PhotoCategoryConfig {
  removeDuplicates: boolean;
  removeBlurry: boolean;
  removeScreenshots: boolean;
  removeReceipts: boolean;
  removeMemes: boolean;
  removeLowQuality: boolean;
}

export const DEFAULT_CATEGORY_CONFIG: PhotoCategoryConfig = {
  removeDuplicates: true,
  removeBlurry: false,       // off by default — blur alone is not a reliable signal
  removeScreenshots: true,
  removeReceipts: true,
  removeMemes: false,
  removeLowQuality: false,
};

/** Immutable record of every destructive action taken in a session */
export interface AuditEntry {
  timestamp: string;
  photoId: string;
  filename: string;
  action: 'suggested' | 'user_kept' | 'user_trashed' | 'permanently_deleted' | 'downloaded';
  reason: DeleteReason;
}

export interface Session {
  id: string;
  createdAt: string;
  aggressiveness: number;
  mode: SessionMode;
  targetPercentage: number | null;
  categoryConfig: PhotoCategoryConfig;
  status: SessionStatus;
  photos: Photo[];
  analysisProgress: number;
  analysisStage: string; // human-readable current stage label
  skipAI: boolean;          // skip Claude classification entirely (free mode)
  aiClassificationRan?: boolean; // true if at least one photo was classified by AI or cache
  errorMessage?: string;
  finalizedAt?: string;
  auditLog: AuditEntry[];
}

export interface AggressivenessConfig {
  /** Max Hamming distance (0–64) for pHash duplicate grouping */
  duplicateHammingThreshold: number;
  /** Max time gap in minutes between two photos to allow duplicate grouping */
  duplicateTimeWindowMinutes: number;
  blurThreshold: number;
  includeScreenshots: boolean;
  includeReceipts: boolean;
  includeMemes: boolean;
  includeLowQuality: boolean;
  qualityThreshold: number;
  sentimentThreshold: number;
}

export const AGGRESSIVENESS_CONFIG: Record<number, AggressivenessConfig> = {
  1: {
    // Off: no suggestions at all
    duplicateHammingThreshold: 0,
    duplicateTimeWindowMinutes: 0,
    blurThreshold: 0,
    includeScreenshots: false,
    includeReceipts: false,
    includeMemes: false,
    includeLowQuality: false,
    qualityThreshold: 0,
    sentimentThreshold: 0,
  },
  2: {
    // Light: near-exact duplicates (burst shots) only — pHash ≤ 3 AND within 30s
    duplicateHammingThreshold: 3,
    duplicateTimeWindowMinutes: 0.5,
    blurThreshold: 0,           // blur off at Light level
    includeScreenshots: false,
    includeReceipts: false,
    includeMemes: false,
    includeLowQuality: false,
    qualityThreshold: 0,
    sentimentThreshold: 0,
  },
  3: {
    // Balanced: near-duplicates within 10 min + screenshots/receipts
    duplicateHammingThreshold: 5,
    duplicateTimeWindowMinutes: 10,
    blurThreshold: 0,
    includeScreenshots: true,
    includeReceipts: true,
    includeMemes: false,
    includeLowQuality: false,
    qualityThreshold: 0,
    sentimentThreshold: 0,
  },
  4: {
    // Aggressive: broader duplicates + memes + low quality
    duplicateHammingThreshold: 8,
    duplicateTimeWindowMinutes: 60,
    blurThreshold: 150,
    includeScreenshots: true,
    includeReceipts: true,
    includeMemes: true,
    includeLowQuality: true,
    qualityThreshold: 15,
    sentimentThreshold: 10,
  },
  5: {
    // Nuclear: max duplicate sensitivity + all categories
    duplicateHammingThreshold: 10,
    duplicateTimeWindowMinutes: 240,
    blurThreshold: 300,
    includeScreenshots: true,
    includeReceipts: true,
    includeMemes: true,
    includeLowQuality: true,
    qualityThreshold: 25,
    sentimentThreshold: 15,
  },
};

export const AGGRESSIVENESS_LABELS: Record<number, { label: string; description: string; expert?: boolean }> = {
  1: { label: 'Minimal',     description: 'No suggestions — manual review only' },
  2: { label: 'Light',       description: 'Burst duplicates only (≤3 sec apart)' },
  3: { label: 'Balanced',    description: 'Near-duplicates + screenshots & receipts' },
  4: { label: 'Aggressive',  description: 'Broad duplicates + memes & low-quality photos', expert: true },
  5: { label: 'Nuclear',     description: 'Maximum cleanup — keep one of every similar scene', expert: true },
};

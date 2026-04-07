import {
  pgTable,
  text,
  uuid,
  timestamp,
  smallint,
  integer,
  bigint,
  boolean,
  jsonb,
  real,
  serial,
  index,
} from 'drizzle-orm/pg-core';

// ── Users ────────────────────────────────────────────────────────────────────
// Clerk manages auth; this table stores app-specific user data + OAuth tokens.
export const users = pgTable('users', {
  id: text('id').primaryKey(),                     // Clerk user ID (e.g. user_2x...)
  email: text('email'),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  // Google Photos OAuth tokens (Phase 2)
  googleAccessToken: text('google_access_token'),
  googleRefreshToken: text('google_refresh_token'),
  googleTokenExpiry: timestamp('google_token_expiry', { withTimezone: true }),
});

// ── Sessions ─────────────────────────────────────────────────────────────────
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull().default('uploading'),
  aggressiveness: smallint('aggressiveness').notNull().default(3),
  mode: text('mode').notNull().default('aggressiveness'),
  targetPercentage: smallint('target_percentage'),
  categoryConfig: jsonb('category_config').notNull().default('{}'),
  skipAi: boolean('skip_ai').notNull().default(false),
  aiClassificationRan: boolean('ai_classification_ran').default(false),
  analysisProgress: smallint('analysis_progress').notNull().default(0),
  analysisStage: text('analysis_stage').notNull().default(''),
  errorMessage: text('error_message'),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  source: text('source').notNull().default('upload'), // 'upload' | 'google_photos'
});

// ── Photos ───────────────────────────────────────────────────────────────────
export const photos = pgTable('photos', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  ext: text('ext').notNull(),
  fileSize: bigint('file_size', { mode: 'number' }).notNull().default(0),
  width: integer('width'),
  height: integer('height'),
  takenAt: timestamp('taken_at', { withTimezone: true }),
  blurScore: real('blur_score'),
  phash: text('phash'),
  classification: text('classification').notNull().default('photo'),
  qualityScore: smallint('quality_score'),
  sentimentScore: smallint('sentiment_score'),
  faceScore: smallint('face_score'),
  description: text('description'),
  status: text('status').notNull().default('pending'),
  deleteReason: text('delete_reason'),
  duplicateGroupId: text('duplicate_group_id'),
  isDuplicateBest: boolean('is_duplicate_best').notNull().default(false),
  isFavorite: boolean('is_favorite').notNull().default(false),

  // R2 object keys
  originalKey: text('original_key'),
  thumbnailKey: text('thumbnail_key'),

  // Google Photos metadata (Phase 2)
  googleMediaItemId: text('google_media_item_id'),
  googleBaseUrl: text('google_base_url'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_photos_session').on(table.sessionId),
  index('idx_photos_phash').on(table.phash),
]);

// ── Audit Log ────────────────────────────────────────────────────────────────
export const auditEntries = pgTable('audit_entries', {
  id: serial('id').primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  photoId: uuid('photo_id').notNull(),
  filename: text('filename').notNull(),
  action: text('action').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Classification Cache ─────────────────────────────────────────────────────
// Replaces the file-based storage/_cache/phash.json
export const classificationCache = pgTable('classification_cache', {
  phash: text('phash').primaryKey(),
  classification: text('classification').notNull(),
  qualityScore: smallint('quality_score').notNull(),
  sentimentScore: smallint('sentiment_score').notNull(),
  faceScore: smallint('face_score').notNull(),
  description: text('description').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

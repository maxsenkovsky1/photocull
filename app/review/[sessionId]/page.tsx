'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { Photo, PhotoStatus, Session, PhotoCategoryConfig, SessionMode } from '@/types';
import { AGGRESSIVENESS_LABELS, DEFAULT_CATEGORY_CONFIG } from '@/types';

// ─────────────────────────────────────────────────────────────────────────────
// Finalize modal
// ─────────────────────────────────────────────────────────────────────────────

function FinalizeModal({
  trashedPhotos,
  keptCount,
  sessionId,
  onClose,
  onDone,
}: {
  trashedPhotos: Photo[];
  keptCount: number;
  sessionId: string;
  onClose: () => void;
  onDone: (result: { deleted: number; kept: number; freedBytes: number }) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totalSize = trashedPhotos.reduce((s, p) => s + (p.fileSize ?? 0), 0);

  const handleFinalize = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/finalize`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Finalize failed');
      }
      const data = await res.json();
      onDone(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-5 border-b border-gray-100">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">You&apos;re done reviewing!</h2>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="bg-emerald-50 rounded-xl py-3 px-2">
              <p className="text-2xl font-bold text-emerald-600">{keptCount}</p>
              <p className="text-xs text-emerald-700 mt-0.5">photos kept</p>
            </div>
            <div className="bg-red-50 rounded-xl py-3 px-2">
              <p className="text-2xl font-bold text-red-500">{trashedPhotos.length}</p>
              <p className="text-xs text-red-600 mt-0.5">to delete</p>
            </div>
            <div className="bg-blue-50 rounded-xl py-3 px-2">
              <p className="text-2xl font-bold text-blue-600">{formatBytes(totalSize)}</p>
              <p className="text-xs text-blue-700 mt-0.5">freed</p>
            </div>
          </div>
        </div>

        {/* Download first CTA */}
        <div className="px-6 py-4 border-b border-gray-100">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-2">Step 1 — Save your keepers</p>
          <button
            onClick={() => window.open(`/api/sessions/${sessionId}/download`, '_blank')}
            className="w-full py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors"
          >
            Download {keptCount} kept photo{keptCount !== 1 ? 's' : ''} as ZIP
          </button>
        </div>

        {/* Thumbnail strip */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-2">Step 2 — Delete clutter</p>
          <div className="grid grid-cols-5 sm:grid-cols-7 gap-1.5 mb-3">
            {trashedPhotos.slice(0, 21).map((photo) => (
              <div key={photo.id} className="aspect-square rounded-lg overflow-hidden bg-gray-100">
                <img src={`/api/image/${sessionId}/thumb/${photo.id}`} alt={photo.filename} className="w-full h-full object-cover" loading="lazy" />
              </div>
            ))}
            {trashedPhotos.length > 21 && (
              <div className="aspect-square rounded-lg bg-gray-100 flex items-center justify-center text-xs text-gray-400">+{trashedPhotos.length - 21}</div>
            )}
          </div>
          <label className="flex items-start gap-3 cursor-pointer bg-red-50 rounded-xl p-3">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500 cursor-pointer flex-shrink-0"
            />
            <span className="text-sm text-gray-700">
              Delete {trashedPhotos.length} photo{trashedPhotos.length !== 1 ? 's' : ''} permanently — <span className="text-red-600 font-medium">this cannot be undone</span>
            </span>
          </label>
        </div>

        {error && <div className="px-6 py-3 bg-red-100 border-t border-red-200"><p className="text-sm text-red-700">{error}</p></div>}

        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-3">
          <button onClick={onClose} disabled={loading} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 disabled:opacity-50">
            Not yet
          </button>
          <button
            onClick={handleFinalize}
            disabled={!confirmed || loading}
            className="px-5 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {loading && <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>}
            {loading ? 'Deleting…' : `Delete ${trashedPhotos.length} forever`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Done modal (shown after finalize)
// ─────────────────────────────────────────────────────────────────────────────

function DoneModal({
  deleted,
  kept,
  freedBytes,
  sessionId,
  onClose,
}: {
  deleted: number;
  kept: number;
  freedBytes: number;
  sessionId: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm text-center p-8">
        <div className="text-5xl mb-4">🎉</div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">All done!</h2>
        <p className="text-gray-500 text-sm mb-1">
          <strong className="text-red-600">{deleted}</strong> photo{deleted !== 1 ? 's' : ''} deleted permanently
        </p>
        <p className="text-gray-500 text-sm mb-1">
          <strong className="text-emerald-600">{kept}</strong> photo{kept !== 1 ? 's' : ''} kept
        </p>
        <p className="text-gray-400 text-sm mb-6">{formatBytes(freedBytes)} freed</p>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => window.open(`/api/sessions/${sessionId}/download`, '_blank')}
            className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
          >
            Download kept photos
          </button>
          <button
            onClick={onClose}
            className="w-full px-4 py-2.5 text-gray-500 hover:text-gray-700 text-sm font-medium transition-colors"
          >
            Back to review
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const REASON_LABELS: Record<string, string> = {
  duplicate: 'Duplicate',
  blurry: 'Blurry',
  screenshot: 'Screenshot',
  receipt: 'Receipt/Doc',
  meme: 'Meme',
  low_quality: 'Low Quality',
};

const REASON_COLORS: Record<string, string> = {
  duplicate: 'bg-purple-100 text-purple-700',
  blurry: 'bg-orange-100 text-orange-700',
  screenshot: 'bg-blue-100 text-blue-700',
  receipt: 'bg-cyan-100 text-cyan-700',
  meme: 'bg-pink-100 text-pink-700',
  low_quality: 'bg-gray-100 text-gray-600',
};

type Tab = 'all' | 'duplicate' | 'blurry' | 'screenshot' | 'receipt' | 'meme' | 'low_quality' | 'keeping' | 'trash' | 'favorites';

// ─────────────────────────────────────────────────────────────────────────────
// Score badge
// ─────────────────────────────────────────────────────────────────────────────

function ScorePill({ label, value, color, tooltip }: { label: string; value: number; color: string; tooltip: string }) {
  return (
    <span title={tooltip} className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded cursor-help ${color}`}>
      <span className="opacity-60">{label}</span>
      <span>{value}</span>
    </span>
  );
}

function ScoreBar({ photo }: { photo: Photo }) {
  return (
    <div className="flex flex-wrap gap-1 px-2 pb-1.5 pt-0.5 bg-gray-50 border-t border-gray-100">
      {photo.qualityScore !== null && (
        <ScorePill label="Quality" value={photo.qualityScore} tooltip="Technical quality: sharpness, exposure, and framing (0–100)"
          color={photo.qualityScore >= 70 ? 'bg-emerald-100 text-emerald-700' : photo.qualityScore >= 40 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-600'}
        />
      )}
      {photo.sentimentScore !== null && (
        <ScorePill label="Memory" value={photo.sentimentScore} tooltip="Memory value: how meaningful this photo likely is as a memory (0–100)"
          color={photo.sentimentScore >= 70 ? 'bg-blue-100 text-blue-700' : photo.sentimentScore >= 40 ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-100 text-gray-500'}
        />
      )}
      {photo.faceScore !== null && photo.faceScore > 0 && (
        <ScorePill label="😊" value={photo.faceScore} tooltip="Smile score: expression quality of the main subject (0–100)"
          color={photo.faceScore >= 70 ? 'bg-pink-100 text-pink-700' : photo.faceScore >= 40 ? 'bg-rose-100 text-rose-600' : 'bg-gray-100 text-gray-500'}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Photo card
// ─────────────────────────────────────────────────────────────────────────────

function PhotoCard({
  photo,
  sessionId,
  onStatusChange,
  onFavoriteToggle,
  showScores,
  isKeeper,
  onHover,
}: {
  photo: Photo;
  sessionId: string;
  onStatusChange: (id: string, status: PhotoStatus) => void;
  onFavoriteToggle: (id: string, fav: boolean) => void;
  showScores: boolean;
  isKeeper?: boolean;
  onHover?: (id: string | null) => void;
}) {
  const isTrashed = photo.status === 'trash';
  const isKept = photo.status === 'keep' || isKeeper;
  const isFav = photo.isFavorite;

  return (
    <div
      className={`relative rounded-xl overflow-hidden border transition-all select-none ${
        isTrashed
          ? 'border-red-200 opacity-50'
          : isFav
          ? 'border-yellow-300 ring-2 ring-yellow-200'
          : isKept
          ? 'border-emerald-300 ring-2 ring-emerald-200'
          : 'border-gray-200 hover:border-gray-300 hover:shadow-md'
      } bg-white shadow-sm`}
      onMouseEnter={() => onHover?.(photo.id)}
      onMouseLeave={() => onHover?.(null)}
    >
      {/* Thumbnail */}
      <div className="aspect-square relative bg-gray-100 overflow-hidden">
        <img
          src={`/api/image/${sessionId}/thumb/${photo.id}`}
          alt={photo.filename}
          className="w-full h-full object-cover"
          loading="lazy"
        />

        {/* Favorite star */}
        {isFav && (
          <div className="absolute top-1.5 left-1.5">
            <span className="text-sm drop-shadow" title="Favorite — protected from deletion">⭐</span>
          </div>
        )}

        {/* Reason badge */}
        {photo.deleteReason && photo.status === 'suggested_delete' && (
          <div className="absolute top-1.5 right-1.5">
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full shadow-sm ${
              REASON_COLORS[photo.deleteReason] ?? 'bg-gray-100 text-gray-600'
            }`}>
              {REASON_LABELS[photo.deleteReason] ?? photo.deleteReason}
            </span>
          </div>
        )}

        {/* Trash overlay */}
        {isTrashed && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <span className="text-white font-semibold text-sm drop-shadow">Trashed</span>
          </div>
        )}

        {/* Kept checkmark */}
        {isKept && !isTrashed && !isFav && (
          <div className="absolute bottom-1.5 right-1.5 bg-emerald-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs font-bold shadow">
            ✓
          </div>
        )}
      </div>

      {/* Filename + description */}
      <div className="px-2 pt-1.5 pb-0.5">
        <p className="text-[11px] text-gray-400 truncate" title={photo.filename}>
          {photo.filename}
        </p>
        {photo.description && photo.description !== 'Unable to analyze' && (
          <p className="text-[11px] text-gray-500 truncate mt-0.5 leading-tight" title={photo.description}>
            {photo.description}
          </p>
        )}
      </div>

      {/* Score bar */}
      {showScores && <ScoreBar photo={photo} />}

      {/* Actions */}
      <div className="px-2 pb-2 flex gap-1 mt-1">
        <button
          onClick={() => onFavoriteToggle(photo.id, !isFav)}
          title={isFav ? 'Remove favorite' : 'Mark as favorite — protects from deletion'}
          className={`w-8 py-1.5 rounded-lg text-sm transition-colors flex-shrink-0 ${
            isFav
              ? 'bg-yellow-100 text-yellow-600 hover:bg-yellow-200'
              : 'bg-gray-50 text-gray-300 hover:bg-gray-100 hover:text-yellow-500'
          }`}
        >
          ⭐
        </button>
        <button
          onClick={() => !isFav && onStatusChange(photo.id, isTrashed ? 'suggested_delete' : 'trash')}
          disabled={isFav}
          title={isFav ? 'Favorites are protected from deletion' : undefined}
          className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            isFav
              ? 'bg-gray-50 text-gray-300 cursor-not-allowed'
              : isTrashed
              ? 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              : 'bg-red-50 text-red-600 hover:bg-red-100 active:bg-red-200'
          }`}
        >
          {isTrashed ? 'Restore' : 'Trash'}
        </button>
        <button
          onClick={() => onStatusChange(photo.id, isKept && !isTrashed ? 'suggested_delete' : 'keep')}
          className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            isFav
              ? 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100'
              : isKept && !isTrashed
              ? 'bg-emerald-500 text-white hover:bg-emerald-600 active:bg-emerald-700'
              : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 active:bg-emerald-200'
          }`}
        >
          {isFav ? 'Fav ⭐' : isKept && !isTrashed ? 'Kept ✓' : 'Keep'}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate cluster
// ─────────────────────────────────────────────────────────────────────────────

function composite(p: Photo): number | null {
  if (p.qualityScore === null && p.faceScore === null) return null;
  const q = p.qualityScore ?? 50;
  const f = p.faceScore ?? 0;
  const maxFaceInContext = Math.max(f, 0);
  const fw = maxFaceInContext >= 65 ? 0.50 : maxFaceInContext >= 30 ? 0.30 : 0.10;
  const qw = 1 - fw;
  return Math.round(q * qw + f * fw);
}

function DuplicateCluster({
  allPhotos,
  sessionId,
  onStatusChange,
  onFavoriteToggle,
  showScores,
  onHover,
}: {
  allPhotos: Photo[];
  sessionId: string;
  onStatusChange: (id: string, status: PhotoStatus) => void;
  onFavoriteToggle: (id: string, fav: boolean) => void;
  showScores: boolean;
  onHover: (id: string | null) => void;
}) {
  const keeper = allPhotos.find((p) => p.isDuplicateBest);
  const toDelete = allPhotos.filter((p) => !p.isDuplicateBest);
  const stillPending = toDelete.filter((p) => p.status !== 'trash' && p.status !== 'keep').length;

  return (
    <div className="col-span-full bg-purple-50 border border-purple-100 rounded-2xl p-4 mb-2">
      {/* Cluster header */}
      <div className="flex items-start gap-3 mb-3 flex-wrap">
        <span className="text-xs font-semibold text-purple-700">
          {allPhotos.length} similar photos
        </span>
        <span className="text-xs text-purple-400">·</span>
        <span className="text-xs text-purple-500">
          keeping 1{stillPending > 0 ? `, removing ${stillPending}` : ''}
        </span>

        {/* Score comparison when keeper has scores */}
        {showScores && keeper && (
          <div className="ml-auto text-[11px] text-purple-600 space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="font-medium">Keeping:</span>
              {keeper.qualityScore !== null && <span>Q:{keeper.qualityScore}</span>}
              {keeper.faceScore !== null && keeper.faceScore > 0 && <span>😊{keeper.faceScore}</span>}
              {composite(keeper) !== null && (
                <span className="font-semibold text-emerald-600">score:{composite(keeper)}</span>
              )}
            </div>
            {toDelete.slice(0, 2).map((p) => (
              <div key={p.id} className="flex items-center gap-2 text-purple-400">
                <span>vs:</span>
                {p.qualityScore !== null && <span>Q:{p.qualityScore}</span>}
                {p.faceScore !== null && p.faceScore > 0 && <span>😊{p.faceScore}</span>}
                {composite(p) !== null && <span>score:{composite(p)}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
        {/* Keeper — first, highlighted */}
        {keeper && (
          <div className="flex flex-col gap-1">
            <div className="ring-2 ring-emerald-400 rounded-xl overflow-hidden">
              <PhotoCard
                photo={keeper}
                sessionId={sessionId}
                onStatusChange={onStatusChange}
                onFavoriteToggle={onFavoriteToggle}
                showScores={showScores}
                isKeeper
                onHover={onHover}
              />
            </div>
            <span className="text-center text-[10px] font-semibold text-emerald-600">Best pick ✓</span>
          </div>
        )}
        {/* Duplicates to remove */}
        {toDelete.map((photo) => (
          <div key={photo.id} className="flex flex-col gap-1">
            <PhotoCard
              photo={photo}
              sessionId={sessionId}
              onStatusChange={onStatusChange}
              onFavoriteToggle={onFavoriteToggle}
              showScores={showScores}
              onHover={onHover}
            />
            <span className="text-center text-[10px] text-gray-400">Similar</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main review page
// ─────────────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ReviewPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [photoStatuses, setPhotoStatuses] = useState<Record<string, PhotoStatus>>({});
  const [activeTab, setActiveTab] = useState<Tab>('all');
  const [loading, setLoading] = useState(true);
  const [showScores, setShowScores] = useState(false);
  const [showFinalizeModal, setShowFinalizeModal] = useState(false);
  const [finalizeResult, setFinalizeResult] = useState<{ deleted: number; kept: number; freedBytes: number } | null>(null);
  const [photoFavorites, setPhotoFavorites] = useState<Record<string, boolean>>({});
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rulesAggressiveness, setRulesAggressiveness] = useState(2);
  const [rulesMode, setRulesMode] = useState<SessionMode>('aggressiveness');
  const [rulesTargetPct, setRulesTargetPct] = useState(30);
  const [rulesCategoryConfig, setRulesCategoryConfig] = useState<PhotoCategoryConfig>(DEFAULT_CATEGORY_CONFIG);
  const [reapplying, setReapplying] = useState(false);
  const [undoToast, setUndoToast] = useState<{ photoId: string; prevStatus: PhotoStatus; filename: string } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredPhotoId = useRef<string | null>(null);

  useEffect(() => {
    fetch(`/api/sessions/${sessionId}`)
      .then((r) => r.json())
      .then((data: Session) => {
        setSession(data);
        const statuses: Record<string, PhotoStatus> = {};
        const favorites: Record<string, boolean> = {};
        for (const p of data.photos) {
          statuses[p.id] = p.status;
          favorites[p.id] = p.isFavorite ?? false;
        }
        setPhotoStatuses(statuses);
        setPhotoFavorites(favorites);
        setRulesAggressiveness(data.aggressiveness ?? 2);
        setRulesMode(data.mode ?? 'aggressiveness');
        setRulesTargetPct(data.targetPercentage ?? 30);
        setRulesCategoryConfig(data.categoryConfig ?? DEFAULT_CATEGORY_CONFIG);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [sessionId]);

  const handleStatusChange = useCallback(
    async (photoId: string, newStatus: PhotoStatus) => {
      // Show undo toast when trashing a photo
      if (newStatus === 'trash') {
        const photo = session?.photos.find((p) => p.id === photoId);
        const prevStatus = (photoStatuses[photoId] ?? photo?.status ?? 'suggested_delete') as PhotoStatus;
        if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
        setUndoToast({ photoId, prevStatus, filename: photo?.filename ?? '' });
        undoTimerRef.current = setTimeout(() => setUndoToast(null), 5000);
      } else {
        setUndoToast(null);
      }
      // Optimistic update
      setPhotoStatuses((prev) => ({ ...prev, [photoId]: newStatus }));
      const res = await fetch(`/api/photos/${sessionId}/${photoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        setPhotoStatuses((prev) => { const r = { ...prev }; delete r[photoId]; return r; });
        console.error('Failed to update photo status');
      }
    },
    [sessionId, session, photoStatuses]
  );

  const handleBulkTrash = useCallback(
    async (photoIds: string[]) => {
      setPhotoStatuses((prev) => {
        const next = { ...prev };
        for (const id of photoIds) next[id] = 'trash';
        return next;
      });
      await Promise.all(
        photoIds.map((id) =>
          fetch(`/api/photos/${sessionId}/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'trash' }),
          })
        )
      );
    },
    [sessionId]
  );

  const handleFavoriteToggle = useCallback(
    async (photoId: string, isFavorite: boolean) => {
      setPhotoFavorites((prev) => ({ ...prev, [photoId]: isFavorite }));
      // If marking as favorite, also restore from trash/suggested
      if (isFavorite) {
        setPhotoStatuses((prev) => {
          const cur = prev[photoId];
          if (cur === 'trash' || cur === 'suggested_delete') {
            return { ...prev, [photoId]: 'keep' };
          }
          return prev;
        });
      }
      await fetch(`/api/photos/${sessionId}/${photoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isFavorite }),
      });
    },
    [sessionId]
  );

  const handleReapply = useCallback(async () => {
    setReapplying(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/reapply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aggressiveness: rulesAggressiveness,
          mode: rulesMode,
          targetPercentage: rulesMode === 'percentage' ? rulesTargetPct : null,
          categoryConfig: rulesCategoryConfig,
        }),
      });
      if (!res.ok) throw new Error('Failed');
      // Reload session to get fresh statuses
      const updated = await fetch(`/api/sessions/${sessionId}`).then((r) => r.json()) as Session;
      setSession(updated);
      const statuses: Record<string, PhotoStatus> = {};
      for (const p of updated.photos) statuses[p.id] = p.status;
      setPhotoStatuses(statuses);
      setRulesOpen(false);
    } finally {
      setReapplying(false);
    }
  }, [sessionId, rulesAggressiveness, rulesMode, rulesTargetPct, rulesCategoryConfig]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const id = hoveredPhotoId.current;
      if (!id) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setPhotoStatuses((prev) => {
          const cur = prev[id];
          const next = cur === 'keep' ? 'suggested_delete' : 'keep';
          fetch(`/api/photos/${sessionId}/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: next }),
          });
          return { ...prev, [id]: next };
        });
      }

      if (e.key === 't' || e.key === 'T' || e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        setPhotoStatuses((prev) => {
          const cur = prev[id];
          const next = cur === 'trash' ? 'suggested_delete' : 'trash';
          fetch(`/api/photos/${sessionId}/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: next }),
          });
          return { ...prev, [id]: next };
        });
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [sessionId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="flex items-center gap-3 text-gray-500">
          <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          Loading results…
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-500">Session not found.</p>
          <button onClick={() => router.push('/')} className="mt-4 text-indigo-600 text-sm underline">
            Start over
          </button>
        </div>
      </div>
    );
  }

  // Merge live statuses and favorites into photos
  const photos = session.photos.map((p) => ({
    ...p,
    status: photoStatuses[p.id] ?? p.status,
    isFavorite: photoFavorites[p.id] ?? p.isFavorite ?? false,
  }));

  // Detect AI classification failure using the reliable session flag.
  // (session.aiClassificationRan is set by the analyze route; undefined means old session.)
  const aiClassificationFailed =
    !session.skipAI &&
    session.aiClassificationRan === false;

  // Stats
  const suggested = photos.filter((p) => p.status === 'suggested_delete').length;
  const trashed   = photos.filter((p) => p.status === 'trash').length;
  const kept      = photos.filter((p) => p.status === 'keep').length;
  const trashedSize = photos.filter((p) => p.status === 'trash').reduce((s, p) => s + (p.fileSize ?? 0), 0);

  // Stat breakdown by reason
  const reasonCounts = photos
    .filter((p) => p.status === 'suggested_delete' && p.deleteReason)
    .reduce<Record<string, number>>((acc, p) => {
      acc[p.deleteReason!] = (acc[p.deleteReason!] ?? 0) + 1;
      return acc;
    }, {});

  // Tab data
  const favorites = photos.filter((p) => p.isFavorite);
  const tabPhotos = (tab: Tab): Photo[] => {
    if (tab === 'all')       return photos.filter((p) => p.status === 'suggested_delete');
    if (tab === 'keeping')   return photos.filter((p) => p.status === 'pending' || p.status === 'keep');
    if (tab === 'trash')     return photos.filter((p) => p.status === 'trash');
    if (tab === 'favorites') return favorites;
    return photos.filter((p) => p.status === 'suggested_delete' && p.deleteReason === tab);
  };

  const tabCounts: Record<Tab, number> = {
    all:         suggested,
    duplicate:   photos.filter((p) => p.status === 'suggested_delete' && p.deleteReason === 'duplicate').length,
    blurry:      photos.filter((p) => p.status === 'suggested_delete' && p.deleteReason === 'blurry').length,
    screenshot:  photos.filter((p) => p.status === 'suggested_delete' && p.deleteReason === 'screenshot').length,
    receipt:     photos.filter((p) => p.status === 'suggested_delete' && p.deleteReason === 'receipt').length,
    meme:        photos.filter((p) => p.status === 'suggested_delete' && p.deleteReason === 'meme').length,
    low_quality: photos.filter((p) => p.status === 'suggested_delete' && p.deleteReason === 'low_quality').length,
    keeping:     photos.filter((p) => p.status === 'pending' || p.status === 'keep').length,
    trash:       trashed,
    favorites:   favorites.length,
  };

  const visiblePhotos = tabPhotos(activeTab);

  const getAllDuplicateClusters = () => {
    const grouped = new Map<string, Photo[]>();
    for (const p of photos) {
      if (!p.duplicateGroupId) continue;
      if (!grouped.has(p.duplicateGroupId)) grouped.set(p.duplicateGroupId, []);
      grouped.get(p.duplicateGroupId)!.push(p);
    }
    return Array.from(grouped.values());
  };

  const ALL_TABS: { key: Tab; label: string }[] = [
    { key: 'all',         label: 'All Suggestions' },
    { key: 'duplicate',   label: 'Duplicates' },
    { key: 'blurry',      label: 'Blurry' },
    { key: 'screenshot',  label: 'Screenshots' },
    { key: 'receipt',     label: 'Docs & Receipts' },
    { key: 'meme',        label: 'Memes' },
    { key: 'low_quality', label: 'Low Quality' },
    { key: 'favorites',   label: '⭐ Favorites' },
    { key: 'keeping',     label: 'Safe to keep' },
    { key: 'trash',       label: 'Trash' },
  ];
  const TAB_LIST = ALL_TABS.filter(
    (t) => t.key === 'all' || t.key === 'keeping' || t.key === 'trash' || tabCounts[t.key] > 0
  );

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">

      {/* ── Header ── */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <button
                onClick={() => router.push('/')}
                className="text-gray-400 hover:text-gray-600 text-sm mb-1 flex items-center gap-1"
              >
                ← Shortlist
              </button>
              {/* Summary stats */}
              <div className="flex items-center gap-3 flex-wrap text-sm">
                <span className="font-semibold text-gray-900">{photos.length} photos</span>
                {suggested > 0 && (
                  <span className="text-red-600">
                    <strong>{suggested}</strong> suggested for removal
                  </span>
                )}
                {kept > 0 && (
                  <span className="text-emerald-600">
                    <strong>{kept}</strong> kept
                  </span>
                )}
                {trashed > 0 && (
                  <span className="text-gray-500">
                    <strong>{trashed}</strong> trashed · {formatBytes(trashedSize)} freed
                  </span>
                )}
              </div>
              {/* Breakdown chips */}
              {Object.keys(reasonCounts).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {Object.entries(reasonCounts).map(([reason, count]) => (
                    <button
                      key={reason}
                      onClick={() => setActiveTab(reason as Tab)}
                      className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${
                        REASON_COLORS[reason] ?? 'bg-gray-100 text-gray-600'
                      } hover:opacity-80`}
                    >
                      {count} {REASON_LABELS[reason] ?? reason}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setRulesOpen((v) => !v)}
                className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  rulesOpen
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
              >
                ⚙ Adjust Rules
              </button>
              <button
                onClick={() => setShowScores((v) => !v)}
                className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  showScores
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
                title="Toggle score visibility (Q=quality, S=sentiment, 😊=face/smile)"
              >
                {showScores ? 'Hide Scores' : 'Show Scores'}
              </button>
              {session.finalizedAt && (
                <span className="text-xs text-gray-400 border border-gray-200 rounded-lg px-3 py-2">
                  Finalized ✓
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── Re-apply rules panel ── */}
      {rulesOpen && (
        <div className="bg-indigo-50 border-b border-indigo-100 px-6 py-5">
          <div className="max-w-7xl mx-auto space-y-4">

            {/* Mode toggle */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm font-medium text-gray-700 w-24 flex-shrink-0">Mode</span>
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
                {(['aggressiveness', 'percentage'] as SessionMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setRulesMode(m)}
                    className={`px-4 py-1.5 font-medium transition-colors ${
                      rulesMode === m ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {m === 'aggressiveness' ? 'Cleanup level' : 'Target %'}
                  </button>
                ))}
              </div>
            </div>

            {/* Aggressiveness slider */}
            {rulesMode === 'aggressiveness' && (
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm font-medium text-gray-700 w-24 flex-shrink-0">Level</span>
                <div className="flex gap-2 flex-wrap">
                  {[1, 2, 3, 4, 5].map((level) => {
                    const cfg = AGGRESSIVENESS_LABELS[level];
                    return (
                      <button
                        key={level}
                        onClick={() => setRulesAggressiveness(level)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          rulesAggressiveness === level
                            ? 'bg-indigo-600 text-white border-indigo-600'
                            : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        {level} · {cfg.label}
                      </button>
                    );
                  })}
                </div>
                <span className="text-xs text-gray-500 italic">
                  {AGGRESSIVENESS_LABELS[rulesAggressiveness]?.description}
                </span>
              </div>
            )}

            {/* Target % slider */}
            {rulesMode === 'percentage' && (
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-gray-700 w-24 flex-shrink-0">Remove</span>
                <input
                  type="range" min={5} max={80} step={5}
                  value={rulesTargetPct}
                  onChange={(e) => setRulesTargetPct(Number(e.target.value))}
                  className="w-40 accent-indigo-600"
                />
                <span className="text-sm font-semibold text-indigo-700 w-8">{rulesTargetPct}%</span>
                <span className="text-xs text-gray-500">of photos</span>
              </div>
            )}

            {/* Category toggles */}
            <div className="flex items-start gap-3 flex-wrap">
              <span className="text-sm font-medium text-gray-700 w-24 flex-shrink-0 pt-0.5">Remove</span>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ['removeDuplicates', 'Duplicates'],
                    ['removeBlurry',     'Blurry'],
                    ['removeScreenshots','Screenshots'],
                    ['removeReceipts',   'Docs & Receipts'],
                    ['removeMemes',      'Memes'],
                    ['removeLowQuality', 'Low Quality'],
                  ] as [keyof PhotoCategoryConfig, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setRulesCategoryConfig((prev) => ({ ...prev, [key]: !prev[key] }))}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                      rulesCategoryConfig[key]
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'bg-white text-gray-400 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={handleReapply}
                disabled={reapplying}
                className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                {reapplying && (
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                )}
                {reapplying ? 'Applying…' : 'Re-apply rules'}
              </button>
              <p className="text-xs text-gray-500">
                No API calls — uses existing scores instantly. Your ⭐ favorites and manual Keep/Trash choices are preserved.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="bg-white border-b border-gray-200 px-6">
        <div className="max-w-7xl mx-auto flex overflow-x-auto">
          {TAB_LIST.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === key
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
              {tabCounts[key] > 0 && (
                <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                  activeTab === key ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-100 text-gray-500'
                }`}>
                  {tabCounts[key]}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── AI failure warning ── */}
      {aiClassificationFailed && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-3">
          <div className="max-w-7xl mx-auto flex items-center gap-3">
            <span className="text-lg">⚠️</span>
            <div>
              <span className="text-sm font-medium text-amber-800">AI scoring unavailable — scores show as 50 (default).</span>
              <span className="text-sm text-amber-700 ml-1">
                Add credits at{' '}
                <a href="https://console.anthropic.com/billing" target="_blank" rel="noopener noreferrer" className="underline font-medium">
                  console.anthropic.com/billing
                </a>{' '}
                and re-run analysis to get real quality scores.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk actions ── */}
      {visiblePhotos.length > 0 && activeTab !== 'trash' && activeTab !== 'keeping' && activeTab !== 'favorites' && (
        <div className="px-6 py-2.5 bg-gray-50 border-b border-gray-200">
          <div className="max-w-7xl mx-auto flex items-center gap-4">
            <span className="text-sm text-gray-500">
              {visiblePhotos.length} photo{visiblePhotos.length !== 1 ? 's' : ''}
            </span>
            <button
              onClick={() => handleBulkTrash(visiblePhotos.map((p) => p.id))}
              className="text-sm text-red-600 hover:text-red-700 font-medium"
            >
              Trash all in this category
            </button>
          </div>
        </div>
      )}

      {/* ── Content ── */}
      <main className="flex-1 px-6 py-6">
        <div className="max-w-7xl mx-auto">
          {visiblePhotos.length === 0 ? (
            <div className="text-center py-20">
              {activeTab === 'all' ? (
                <>
                  <div className="text-4xl mb-3">✨</div>
                  <p className="text-gray-700 font-medium text-lg">Looking good!</p>
                  <p className="text-gray-400 text-sm mt-1">No suggestions at this cleanup level. Try <strong>Deep clean</strong> in ⚙ Adjust Rules for more suggestions.</p>
                </>
              ) : activeTab === 'trash' ? (
                <p className="text-gray-400">Nothing in trash yet — mark photos as Trash to see them here.</p>
              ) : activeTab === 'keeping' ? (
                <p className="text-gray-400">No photos to keep — all photos were suggested for deletion.</p>
              ) : activeTab === 'favorites' ? (
                <p className="text-gray-400">No favorites yet. Click ⭐ on any photo to protect it from deletion.</p>
              ) : (
                <p className="text-gray-400">No photos in this category.</p>
              )}
            </div>
          ) : activeTab === 'duplicate' ? (
            <div className="space-y-4">
              {getAllDuplicateClusters().map((cluster) => (
                <DuplicateCluster
                  key={cluster[0].duplicateGroupId ?? cluster[0].id}
                  allPhotos={cluster}
                  sessionId={sessionId}
                  onStatusChange={handleStatusChange}
                  onFavoriteToggle={handleFavoriteToggle}
                  showScores={showScores}
                  onHover={(id) => { hoveredPhotoId.current = id; }}
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              {visiblePhotos.map((photo) => (
                <PhotoCard
                  key={photo.id}
                  photo={photo}
                  sessionId={sessionId}
                  onStatusChange={handleStatusChange}
                  onFavoriteToggle={handleFavoriteToggle}
                  showScores={showScores}
                  onHover={(id) => { hoveredPhotoId.current = id; }}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {/* ── Undo toast ── */}
      {undoToast && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-gray-900 text-white text-sm px-4 py-2.5 rounded-full shadow-xl">
          <span className="text-gray-300 truncate max-w-[180px]">{undoToast.filename || 'Photo'} moved to trash</span>
          <button
            onClick={() => {
              handleStatusChange(undoToast.photoId, undoToast.prevStatus);
              setUndoToast(null);
            }}
            className="font-semibold text-indigo-300 hover:text-white transition-colors"
          >
            Undo
          </button>
        </div>
      )}

      {/* ── Bottom bar ── */}
      <div className="sticky bottom-0 bg-white border-t border-gray-200 px-6 py-3 shadow-lg">
        <div className="max-w-7xl mx-auto flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-4">
            <p className="text-sm text-gray-600">
              {session.finalizedAt
                ? `Done · ${photos.length - trashed} kept`
                : trashed > 0
                ? `${photos.length - trashed} keeping · ${trashed} in trash · ${formatBytes(trashedSize)} to free`
                : `${photos.length} photos · review suggestions above`}
            </p>
            <span className="hidden sm:inline text-xs text-gray-400 border border-gray-200 rounded px-2 py-0.5">
              Hover + <kbd className="font-mono">K</kbd> keep · <kbd className="font-mono">T</kbd> trash
            </span>
          </div>
          <div className="flex items-center gap-2">
            {session.finalizedAt ? (
              <button
                onClick={() => window.open(`/api/sessions/${sessionId}/download`, '_blank')}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
              >
                Download kept photos
              </button>
            ) : (
              <button
                onClick={() => setShowFinalizeModal(true)}
                className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 transition-colors"
              >
                Finish →
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Finalize modal ── */}
      {showFinalizeModal && (
        <FinalizeModal
          trashedPhotos={photos.filter((p) => p.status === 'trash')}
          keptCount={photos.length - trashed}
          sessionId={sessionId}
          onClose={() => setShowFinalizeModal(false)}
          onDone={(result) => {
            setShowFinalizeModal(false);
            setFinalizeResult(result);
            // Mark session as finalized so "Empty Trash" button disappears
            setSession((prev) => prev ? { ...prev, finalizedAt: new Date().toISOString() } : prev);
          }}
        />
      )}

      {/* ── Done modal ── */}
      {finalizeResult && (
        <DoneModal
          deleted={finalizeResult.deleted}
          kept={finalizeResult.kept}
          freedBytes={finalizeResult.freedBytes}
          sessionId={sessionId}
          onClose={() => setFinalizeResult(null)}
        />
      )}
    </div>
  );
}

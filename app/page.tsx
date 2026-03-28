'use client';

import { useCallback, useRef, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AGGRESSIVENESS_LABELS, DEFAULT_CATEGORY_CONFIG } from '@/types';
import type { PhotoCategoryConfig } from '@/types';

// ─────────────────────────────────────────────────────────────────────────────
// Beta access gate
// ─────────────────────────────────────────────────────────────────────────────

function AccessGate({ onAuthorized }: { onAuthorized: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        onAuthorized();
      } else {
        const data = await res.json();
        setError(data.error ?? 'Incorrect code. Please try again.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Winnow</h1>
        <p className="mt-2 text-gray-700 text-base font-medium">Delete the clutter. Keep the memories.</p>
        <p className="mt-1 text-gray-400 text-sm">AI-powered photo cleanup</p>
      </div>
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        <h2 className="text-lg font-semibold text-gray-800 mb-1">Beta access</h2>
        <p className="text-sm text-gray-500 mb-6">Enter the access code to continue.</p>
        <form onSubmit={submit} className="space-y-4">
          <input
            type="password"
            autoFocus
            placeholder="Access code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={!code || loading}
            className="w-full py-2.5 rounded-xl font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:text-gray-400 transition-colors"
          >
            {loading ? 'Checking…' : 'Enter →'}
          </button>
        </form>
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'uploading' | 'analyzing' | 'done';

// ─────────────────────────────────────────────────────────────────────────────
// Category toggle row
// ─────────────────────────────────────────────────────────────────────────────

function CategoryToggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-3 py-2 cursor-pointer group ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}>
      <div className="mt-0.5 flex-shrink-0">
        <div
          onClick={() => !disabled && onChange(!checked)}
          className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
            checked ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300 bg-white group-hover:border-indigo-400'
          }`}
        >
          {checked && <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 12 12"><path d="M10 3L5 8.5 2 5.5l-1 1L5 10.5l6-7z"/></svg>}
        </div>
      </div>
      <div>
        <span className="text-sm font-medium text-gray-700">{label}</span>
        <p className="text-xs text-gray-400 mt-0.5">{description}</p>
      </div>
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function UploadPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Auth gate ──────────────────────────────────────────────────────────────
  const [authState, setAuthState] = useState<'checking' | 'open' | 'gated'>('checking');

  useEffect(() => {
    fetch('/api/auth/validate')
      .then((r) => r.json())
      .then((d: { required: boolean; authorized: boolean }) => {
        setAuthState(d.required && !d.authorized ? 'gated' : 'open');
      })
      .catch(() => setAuthState('open')); // if endpoint fails, don't block
  }, []);

  const [mode, setMode] = useState<'aggressiveness' | 'percentage'>('aggressiveness');
  const [aggressiveness, setAggressiveness] = useState(3); // default to Balanced
  const [targetPercentage, setTargetPercentage] = useState(30);
  const [categoryConfig, setCategoryConfig] = useState<PhotoCategoryConfig>(DEFAULT_CATEGORY_CONFIG);
  const [skipAI, setSkipAI] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);

  const [phase, setPhase] = useState<Phase>('idle');
  const [uploadProgress, setUploadProgress] = useState({ done: 0, total: 0 });
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisStage, setAnalysisStage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(null);

  // Poll session progress while analyzing
  useEffect(() => {
    if (phase !== 'analyzing') return;
    const id = sessionIdRef.current;
    if (!id) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/sessions/${id}`);
        if (!res.ok) return;
        const session = await res.json();
        setAnalysisProgress(session.analysisProgress ?? 0);
        setAnalysisStage(session.analysisStage ?? '');
        if (session.status === 'ready') {
          clearInterval(interval);
          setPhase('done');
          router.push(`/review/${id}`);
        }
        if (session.status === 'error') {
          clearInterval(interval);
          setError(session.errorMessage ?? 'Analysis failed. Please try again.');
          setPhase('idle');
        }
      } catch { /* ignore transient errors */ }
    }, 1500);

    return () => clearInterval(interval);
  }, [phase, router]);

  const addFiles = useCallback((newFiles: File[]) => {
    const images = newFiles.filter((f) => /\.(jpe?g|png|heic|heif|webp|gif|tiff?|json)$/i.test(f.name));
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...images.filter((f) => !existing.has(f.name + f.size))];
    });
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const allFiles: File[] = [];

    const readEntry = async (entry: FileSystemEntry): Promise<void> => {
      if (entry.isFile) {
        allFiles.push(await new Promise<File>((res) => (entry as FileSystemFileEntry).file(res)));
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const entries = await new Promise<FileSystemEntry[]>((res) => reader.readEntries(res));
        await Promise.all(entries.map(readEntry));
      }
    };

    await Promise.all(
      Array.from(e.dataTransfer.items)
        .map((item) => item.webkitGetAsEntry())
        .filter(Boolean)
        .map((entry) => readEntry(entry!))
    );
    addFiles(allFiles);
  }, [addFiles]);

  const startAnalysis = async () => {
    if (files.length === 0) return;
    setError(null);

    // Create session
    setPhase('uploading');
    const sessionRes = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aggressiveness, mode, targetPercentage, categoryConfig, skipAI }),
    });
    if (!sessionRes.ok) { setError('Failed to create session.'); setPhase('idle'); return; }
    const { id: sessionId } = await sessionRes.json();
    sessionIdRef.current = sessionId;

    // Upload one file at a time to avoid body-size limits (HEIC files can be 10–15 MB each)
    let done = 0;
    setUploadProgress({ done: 0, total: files.length });
    for (let i = 0; i < files.length; i += 1) {
      const batch = files.slice(i, i + 1);
      const formData = new FormData();
      batch.forEach((f) => formData.append('files', f));
      const uploadRes = await fetch(`/api/sessions/${sessionId}/upload`, { method: 'POST', body: formData });
      if (!uploadRes.ok) { setError('Upload failed.'); setPhase('idle'); return; }
      done += batch.length;
      setUploadProgress({ done, total: files.length });
    }

    // Start analysis (long-running). Polling useEffect will track progress.
    setPhase('analyzing');
    setAnalysisProgress(0);
    fetch(`/api/sessions/${sessionId}/analyze`, { method: 'POST' })
      .catch(() => { setError('Analysis failed.'); setPhase('idle'); });
  };

  const toggleCategory = (key: keyof PhotoCategoryConfig) =>
    setCategoryConfig((prev) => ({ ...prev, [key]: !prev[key] }));

  const label = AGGRESSIVENESS_LABELS[aggressiveness];
  const isExpert = label.expert;

  if (authState === 'checking') return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
    </main>
  );
  if (authState === 'gated') return <AccessGate onAuthorized={() => setAuthState('open')} />;

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4 py-12">

      {/* Logo */}
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Winnow</h1>
        <p className="mt-2 text-gray-700 text-base font-medium">Delete the clutter. Keep the memories.</p>
        <p className="mt-1 text-gray-400 text-sm">AI-powered photo cleanup</p>
      </div>

      {/* Main card */}
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">

        {/* Drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onClick={() => fileInputRef.current?.click()}
          className={`cursor-pointer transition-colors px-8 py-10 flex flex-col items-center gap-3 border-b border-gray-200 ${
            isDragging ? 'bg-indigo-50' : 'bg-white hover:bg-gray-50'
          }`}
        >
          <div className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${isDragging ? 'bg-indigo-100' : 'bg-gray-100'}`}>
            <svg className={`w-7 h-7 ${isDragging ? 'text-indigo-500' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
          </div>
          <div className="text-center">
            <p className="font-medium text-gray-800">{isDragging ? 'Drop your photos here' : 'Drop photos or a folder here'}</p>
            <p className="text-sm text-gray-400 mt-0.5">or click to browse · JPG, PNG, HEIC, WEBP supported</p>
          </div>
        </div>
        <input ref={fileInputRef} type="file" multiple accept="image/*" className="hidden" onChange={(e) => e.target.files && addFiles(Array.from(e.target.files))} />

        {/* File list */}
        {files.length > 0 && (
          <div className="px-6 py-3 border-b border-gray-100 bg-gray-50 max-h-32 overflow-y-auto">
            <div className="flex justify-between items-center mb-1">
              <span className="text-sm font-medium text-gray-700">{files.length} photo{files.length !== 1 ? 's' : ''} selected</span>
              <button onClick={(e) => { e.stopPropagation(); setFiles([]); }} className="text-xs text-gray-400 hover:text-red-500">Clear all</button>
            </div>
            <div className="space-y-0.5">
              {files.slice(0, 6).map((f, i) => (
                <div key={i} className="flex justify-between text-xs text-gray-500">
                  <span className="truncate max-w-xs">{f.name}</span>
                  <span className="text-gray-400 ml-2 flex-shrink-0">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                </div>
              ))}
              {files.length > 6 && <p className="text-xs text-gray-400">…and {files.length - 6} more</p>}
            </div>
          </div>
        )}

        {/* Settings */}
        <div className="px-6 py-5 space-y-5">

          {/* Mode toggle */}
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            {(['aggressiveness', 'percentage'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={`flex-1 py-2 text-xs font-medium transition-colors ${mode === m ? 'bg-indigo-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
              >
                {m === 'aggressiveness' ? 'Aggressiveness Level' : 'Target % Removed'}
              </button>
            ))}
          </div>

          {mode === 'aggressiveness' ? (
            <div>
              <div className="flex justify-between mb-2">
                <label className="text-sm font-medium text-gray-700">Aggressiveness</label>
                <div className="flex items-center gap-2">
                  {isExpert && <span className="text-[10px] font-semibold bg-red-100 text-red-600 px-1.5 py-0.5 rounded">EXPERT</span>}
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    aggressiveness <= 2 ? 'bg-green-100 text-green-700' :
                    aggressiveness === 3 ? 'bg-yellow-100 text-yellow-700' :
                    'bg-red-100 text-red-700'
                  }`}>{label.label}</span>
                </div>
              </div>
              <input type="range" min={1} max={5} value={aggressiveness}
                onChange={(e) => setAggressiveness(parseInt(e.target.value))}
                className="w-full accent-indigo-600"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-1"><span>Minimal</span><span>Nuclear</span></div>
              <p className="text-xs text-gray-500 mt-1.5 text-center">{label.description}</p>
              {isExpert && (
                <p className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mt-2">
                  ⚠ Expert mode flags more types of photos. Review all suggestions carefully before finalizing.
                </p>
              )}
            </div>
          ) : (
            <div>
              <div className="flex justify-between mb-2">
                <label className="text-sm font-medium text-gray-700">Remove approximately</label>
                <span className="text-sm font-bold text-indigo-600">{targetPercentage}%</span>
              </div>
              <input type="range" min={5} max={80} step={5} value={targetPercentage}
                onChange={(e) => setTargetPercentage(parseInt(e.target.value))}
                className="w-full accent-indigo-600"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-1"><span>5% (conservative)</span><span>80% (aggressive)</span></div>
              <p className="text-xs text-gray-500 mt-1.5 text-center">Removes the most obvious duplicates, blurry shots, and clutter first</p>
            </div>
          )}

          {/* Advanced category toggles */}
          <div>
            <button onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 w-full"
            >
              <svg className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              Advanced: choose what to flag
            </button>

            {showAdvanced && (
              <div className="mt-3 border border-gray-100 rounded-xl divide-y divide-gray-50 px-3">
                <CategoryToggle label="Duplicates" description="Group similar photos and keep the best one"
                  checked={categoryConfig.removeDuplicates} onChange={(v) => toggleCategory('removeDuplicates') } />
                <CategoryToggle label="Blurry photos" description="Flag photos with significant blur or camera shake"
                  checked={categoryConfig.removeBlurry} onChange={() => toggleCategory('removeBlurry')} />
                <CategoryToggle label="Screenshots" description="Screen captures from phones and computers"
                  checked={categoryConfig.removeScreenshots} onChange={() => toggleCategory('removeScreenshots')} />
                <CategoryToggle label="Receipts & documents" description="Photos of paper receipts, invoices, or whiteboards"
                  checked={categoryConfig.removeReceipts} onChange={() => toggleCategory('removeReceipts')} />
                <CategoryToggle label="Memes & forwarded images" description="Images with overlaid text, humor, or share-chains"
                  checked={categoryConfig.removeMemes} onChange={() => toggleCategory('removeMemes')} />
                <CategoryToggle label="Low quality / low value" description="AI-judged poor quality or low personal significance (experimental)"
                  checked={categoryConfig.removeLowQuality} onChange={() => toggleCategory('removeLowQuality')} />
              </div>
            )}
          </div>
        </div>

        {/* Skip AI toggle + cost estimate */}
        <div className="px-6 pb-4">
          <div
            className={`rounded-xl border p-4 transition-colors cursor-pointer ${
              skipAI ? 'bg-gray-50 border-gray-200' : 'bg-indigo-50 border-indigo-100'
            }`}
            onClick={() => setSkipAI((v) => !v)}
          >
            <div className="flex items-start gap-3">
              {/* Toggle */}
              <div className={`mt-0.5 w-10 h-5 rounded-full flex items-center transition-colors flex-shrink-0 ${skipAI ? 'bg-gray-300' : 'bg-indigo-600'}`}>
                <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform mx-0.5 ${skipAI ? '' : 'translate-x-5'}`} />
              </div>
              <div className="min-w-0">
                {skipAI ? (
                  <>
                    <p className="text-sm font-semibold text-gray-700">AI scoring off — duplicates &amp; blur only</p>
                    <p className="text-xs text-gray-500 mt-0.5">Free. No API calls. Quality, sentiment, and content classification are skipped.</p>
                    {files.length > 0 && (
                      <p className="text-xs font-medium text-emerald-600 mt-1">Free · {files.length} photo{files.length !== 1 ? 's' : ''}</p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-sm font-semibold text-indigo-800">AI scoring on — full analysis</p>
                    <p className="text-xs text-indigo-600 mt-0.5">Quality, sentiment, smile detection, and content type via Claude Haiku.</p>
                    {files.length > 0 && (
                      <p className="text-xs font-medium text-indigo-700 mt-1">
                        ~${(files.length * 0.001).toFixed(2)} estimated · {files.length} photo{files.length !== 1 ? 's' : ''} × $0.001 ea
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Privacy notice */}
        <div className="mx-6 mb-4 p-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-700 space-y-1">
          <p className="font-semibold">🔒 How Winnow handles your photos</p>
          <ul className="space-y-0.5 text-blue-600">
            <li>· Your original photos are <strong>never modified or deleted</strong> without your explicit confirmation</li>
            <li>· Winnow works with <strong>copies</strong> — your originals stay exactly where they are</li>
            <li>· Blur and duplicate detection runs <strong>entirely on this machine</strong></li>
            <li>· Small preview thumbnails (200×200px) are sent to <strong>Claude AI</strong> for content classification — only when AI scoring is on</li>
            <li>· Thumbnails are not stored permanently by Anthropic per their <a href="https://www.anthropic.com/legal/privacy" target="_blank" rel="noopener noreferrer" className="underline">data policy</a></li>
          </ul>
        </div>

        {/* Error */}
        {error && <div className="mx-6 mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">{error}</div>}

        {/* CTA */}
        <div className="px-6 pb-6">
          {phase === 'idle' && (
            <button onClick={startAnalysis} disabled={files.length === 0}
              className="w-full py-3 rounded-xl font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {files.length === 0 ? 'Add photos to get started' : `Analyze ${files.length} photo${files.length !== 1 ? 's' : ''} →`}
            </button>
          )}

          {phase === 'uploading' && (
            <div>
              <div className="w-full bg-gray-100 rounded-full h-2 mb-2">
                <div className="bg-indigo-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress.total > 0 ? (uploadProgress.done / uploadProgress.total) * 100 : 0}%` }} />
              </div>
              <p className="text-sm text-center text-gray-500">Uploading {uploadProgress.done} of {uploadProgress.total} photos…</p>
            </div>
          )}

          {phase === 'analyzing' && (
            <div>
              <div className="w-full bg-gray-100 rounded-full h-2 mb-2">
                <div className="bg-indigo-500 h-2 rounded-full transition-all duration-500"
                  style={{ width: `${analysisProgress}%` }} />
              </div>
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>{analysisStage || 'Analyzing…'}</span>
                <span>{analysisProgress}%</span>
              </div>
              <p className="text-xs text-center text-gray-400">
                {analysisProgress < 40 ? 'Stage 1/3: Processing images' :
                 analysisProgress < 85 ? 'Stage 2/3: AI classification (this takes a moment)' :
                 'Stage 3/3: Finding duplicates & applying rules'}
              </p>
            </div>
          )}
        </div>
      </div>

      <p className="mt-5 text-xs text-gray-400 text-center max-w-sm">
        Winnow never deletes anything without your explicit confirmation at the review step.
      </p>
    </main>
  );
}

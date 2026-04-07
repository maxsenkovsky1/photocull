# Shortlist — AI Photo Culling App

## Stack
- Next.js 16 App Router, TypeScript, Tailwind 4
- Postgres (Drizzle ORM) on Railway, Cloudflare R2 for images
- Clerk auth (Google sign-in), Claude Haiku for classification
- Sharp for image processing

## Key commands
- `npm run dev` — local dev server (port 3000)
- `npm run build` — production build (catches all errors)
- `npx -p typescript tsc --noEmit` — type check only
- `npm run db:push` — push schema changes to Postgres
- `npm run db:studio` — Drizzle Studio (browse DB)

## Architecture
- Routes: `app/api/` — all migrated to Postgres + R2 (no file-based storage)
- Core libs (keep stable): `lib/analysis.ts`, `lib/claude.ts`, `lib/rules.ts`
- DB: `lib/db/schema.ts` (Drizzle), `lib/storage-db.ts` (read/write adapter)
- Storage: `lib/object-storage.ts` (R2 client)
- Auth: `lib/auth.ts` + `proxy.ts` (Clerk middleware)

## HEIC handling
- Safari: client-side canvas conversion (native support)
- Chrome/Firefox: uploads raw HEIC — server converts via sips (macOS) or needs libheif (Linux)
- `prepareForSharp()` in analysis.ts handles the conversion

## Known constraints
- Railway hobby plan, 500MB volume (images now in R2, not volume)
- R2 free tier: 10GB storage, 10M reads/month
- Claude Haiku rate limits: 2 concurrent batch calls, exponential backoff
- Next.js 16 uses `proxy.ts` not `middleware.ts`

## Environment
- Local: `.env.local` (public Postgres URL for local dev)
- Railway: internal Postgres URL, same R2 + Clerk keys
- Never commit `.env.local`

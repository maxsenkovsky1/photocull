import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Beta access-code gate.
 * If BETA_ACCESS_CODE env var is set, all /api/* routes (except /api/auth/validate)
 * require a matching `beta_access_code` cookie — set by the validate endpoint.
 * If the env var is not set, the gate is disabled (open access).
 */
export function proxy(request: NextRequest) {
  const required = process.env.BETA_ACCESS_CODE;
  if (!required) return NextResponse.next();

  // Auth endpoint is always open (needed to set the cookie in the first place)
  if (request.nextUrl.pathname === '/api/auth/validate') return NextResponse.next();

  // Only gate API routes; page routes pass through so the UI always loads
  if (!request.nextUrl.pathname.startsWith('/api/')) return NextResponse.next();

  const provided = request.cookies.get('beta_access_code')?.value;
  if (provided === required) return NextResponse.next();

  return NextResponse.json(
    { error: 'Access denied. Please enter the beta access code.' },
    { status: 401 },
  );
}

export const config = {
  matcher: '/api/:path*',
};

import { NextResponse } from 'next/server';

/**
 * GET  /api/auth/validate  → { required: boolean; authorized: boolean }
 * POST /api/auth/validate  → validates the submitted code, sets httpOnly cookie
 */

export async function GET(request: Request) {
  const required = process.env.BETA_ACCESS_CODE;
  if (!required) return NextResponse.json({ required: false, authorized: true });

  // Read cookie from request headers (middleware hasn't blocked us here)
  const cookieHeader = request.headers.get('cookie') ?? '';
  const match = cookieHeader.match(/(?:^|;\s*)beta_access_code=([^;]+)/);
  const provided = match ? decodeURIComponent(match[1]) : null;

  return NextResponse.json({ required: true, authorized: provided === required });
}

export async function POST(request: Request) {
  const required = process.env.BETA_ACCESS_CODE;

  // If no code is configured, always succeed
  if (!required) return NextResponse.json({ ok: true });

  let code: string;
  try {
    ({ code } = await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (code !== required) {
    return NextResponse.json({ error: 'Incorrect access code.' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set('beta_access_code', required, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: '/',
  });
  return res;
}

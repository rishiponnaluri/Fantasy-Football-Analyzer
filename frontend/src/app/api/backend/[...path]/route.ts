import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
const ENDPOINTS = /^\/(league|teams(?:\/\d+\/image)?|player-directory|my-team|fantasy-matchups(?:\/\d+)?|fantasy-predictions|projections(?:\/refresh)?|start-sit|waiver-advice|players\/search|players\/-?\d+(?:\/updates)?|trades\/(?:analyze|suggestions|targets|discovery)|watchlist(?:\/-?\d+)?|nfl\/(?:live-status|schedule|games\/\d+))$/;
const QUERY_KEYS = ['snapshot_id', 'week', 'q', 'team', 'position', 'positions', 'status', 'sort', 'mode', 'search_mode', 'team_id', 'limit'] as const;

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }, method: string) {
  const { path } = await context.params;
  const endpoint = '/' + path.join('/');
  if (!ENDPOINTS.test(endpoint)) {
    return NextResponse.json({ error: { message: 'Unknown backend endpoint.' } }, { status: 404 });
  }
  // This allowlisted, same-origin server proxy keeps all ESPN cookies in Python.
  const base = (process.env.FASTAPI_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
  const url = new URL(`${base}/api${endpoint}`);
  for (const key of QUERY_KEYS) {
    for (const value of request.nextUrl.searchParams.getAll(key)) url.searchParams.append(key, value);
  }
  try {
    const body = method === 'GET' || method === 'DELETE' ? undefined : await request.text();
    const response = await fetch(url, {
      method,
      cache: 'no-store',
      signal: AbortSignal.timeout(45000),
      redirect: 'error',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body,
    });
    if (/^\/teams\/\d+\/image$/.test(endpoint) && response.ok) {
      return new NextResponse(await response.arrayBuffer(), { status: response.status,
        headers: { 'Content-Type': response.headers.get('Content-Type') || 'image/jpeg',
          'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
    }
    const payload = await response.json();
    return NextResponse.json(payload, { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    const code = error instanceof Error && error.cause && typeof error.cause === 'object' && 'code' in error.cause ? String(error.cause.code) : undefined;
    return NextResponse.json({ error: { message: timedOut ? 'FastAPI did not respond within 45 seconds. Retry the request.' : `Cannot reach the FastAPI backend${code ? ` (${code})` : ''}. Make sure it is running and retry.` } }, { status: timedOut ? 504 : 502 });
  }
}

type Context = { params: Promise<{ path: string[] }> };
export const GET = (request: NextRequest, context: Context) => forward(request, context, 'GET');
export const POST = (request: NextRequest, context: Context) => forward(request, context, 'POST');
export const PATCH = (request: NextRequest, context: Context) => forward(request, context, 'PATCH');
export const DELETE = (request: NextRequest, context: Context) => forward(request, context, 'DELETE');

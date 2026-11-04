class BackendError extends Error { constructor(message: string, readonly status: number) { super(message); } }
type ProjectionVersion = { snapshot_id: string; week: number; expires_in_seconds: number; players: { player_id: number; projection: { recommendation_projection?: number | null } }[] };
const versions = new Map<string, { value: ProjectionVersion; expires: number }>();
const pending = new Map<string, Promise<ProjectionVersion>>();
export const PROJECTION_CHANGED = 'fantasy-projection-snapshot-changed';
async function rawRequest<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/backend${path}`, { method, cache: 'no-store', signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let data: any;
  try { data = await response.json(); } catch { throw new Error(`The backend returned an unreadable response (HTTP ${response.status}).`); }
  if (!response.ok) {
    const detail = data.error?.message || data.detail || 'The backend request failed.';
    throw new BackendError(`HTTP ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, response.status);
  }
  return data as T;
}
async function projectionVersion(week = '', refresh = false): Promise<ProjectionVersion> {
  const cached = versions.get(week);
  if (!refresh && cached && cached.expires > Date.now()) return cached.value;
  const underway = pending.get(week);
  if (underway) return underway;
  const request = rawRequest<ProjectionVersion>(`/projections${refresh ? '/refresh' : ''}${week ? `?week=${week}` : ''}`, refresh ? 'POST' : 'GET')
    .then(value => {
      const entry = { value, expires: Date.now() + value.expires_in_seconds * 1000 };
      for (const [key, previous] of versions) {
        if (previous.value.week === value.week) versions.set(key, entry);
      }
      versions.set(week, entry); versions.set(String(value.week), entry);
      if (typeof window !== 'undefined' && (refresh || (cached && cached.value.snapshot_id !== value.snapshot_id))) {
        window.dispatchEvent(new Event(PROJECTION_CHANGED));
      }
      return value;
    }).finally(() => pending.delete(week));
  pending.set(week, request);
  return request;
}
/** Resolve displayed player points against the active week version, including
 * while an older endpoint response is being replaced after an atomic refresh. */
export function canonicalProjection(player: { player_id: number; week?: number; custom_projection?: { recommendation_projection?: number | null; snapshot_id?: string } | null; projection_snapshot_id?: string; recommendation_projection?: number | null; weekly_projection?: number | null }, week?: number): number | null {
  const current = versions.get(String(week ?? player.week ?? ''))?.value;
  const value = current?.players.find(row => row.player_id === player.player_id);
  if (value) return value.projection.recommendation_projection ?? null;
  const previousId = player.custom_projection?.snapshot_id ?? player.projection_snapshot_id;
  if (current && previousId && previousId !== current.snapshot_id) return null;
  return player.custom_projection?.recommendation_projection ?? player.recommendation_projection ?? player.weekly_projection ?? null;
}
export async function refreshProjectionSnapshot(week?: number) { return projectionVersion(week == null ? '' : String(week), true); }
export async function fetchBackend<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestBackend<T>(path, 'GET', undefined, signal);
}
export async function requestBackend<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown, signal?: AbortSignal, retrySnapshot = true): Promise<T> {
  const url = new URL(path, 'http://local');
  const usesProjection = /^\/(projections|my-team|fantasy-matchups|fantasy-predictions|start-sit|waiver-advice|players|trades|watchlist)(\/|$)/.test(url.pathname)
    && !url.pathname.endsWith('/updates')
    && !(url.pathname.startsWith('/watchlist') && method !== 'GET');
  if (!usesProjection) return rawRequest<T>(path, method, body, signal);
  const bodyWeek = body && typeof body === 'object' && 'week' in body ? body.week : undefined;
  const week = url.searchParams.get('week') || (/^\/fantasy-matchups\/\d+$/.test(url.pathname) ? url.pathname.split('/').at(-1)! : bodyWeek ? String(bodyWeek) : '');
  const version = await projectionVersion(week);
  if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
  if (url.pathname === '/projections' && method === 'GET') return version as T;
  url.searchParams.set('snapshot_id', version.snapshot_id);
  url.searchParams.set('week', String(version.week));
  let result: T;
  try { result = await rawRequest<T>(url.pathname + url.search, method, body, signal); }
  catch (error) {
    if (!retrySnapshot || !(error instanceof BackendError) || error.status !== 409) throw error;
    // A backend restart can discard in-memory versions. Reacquire once through
    // the shared promise, then notify every mounted consumer.
    for (const [key, entry] of versions) if (entry.value.snapshot_id === version.snapshot_id) versions.delete(key);
    await projectionVersion(week);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(PROJECTION_CHANGED));
    return requestBackend<T>(path, method, body, signal, false);
  }
  // A response started before an atomic refresh must not overwrite the new version.
  if (versions.get(week)?.value.snapshot_id !== version.snapshot_id) return requestBackend<T>(path, method, body, signal);
  return result;
}

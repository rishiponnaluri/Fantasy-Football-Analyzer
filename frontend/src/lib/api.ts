export async function fetchBackend<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestBackend<T>(path, 'GET', undefined, signal);
}
export async function requestBackend<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/backend${path}`, { method, cache: 'no-store', signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let responseBody: any;
  try { responseBody = await response.json(); } catch { throw new Error(`The backend returned an unreadable response (HTTP ${response.status}).`); }
  if (!response.ok) {
    const detail = responseBody.error?.message || responseBody.detail || 'The backend request failed.';
    throw new Error(`HTTP ${response.status}${responseBody.error?.type ? ` · ${responseBody.error.type}` : ''}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return responseBody as T;
}

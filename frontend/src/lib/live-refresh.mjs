/** @param {'live' | 'idle' | 'unknown'} mode */
export function liveRefreshIntervalMs(mode) {
  if (mode === 'live') return 30_000;
  if (mode === 'idle') return 120_000;
  return 60_000;
}

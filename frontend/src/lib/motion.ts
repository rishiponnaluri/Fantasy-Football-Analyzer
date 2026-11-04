export const motionTiming = {
  quickOpen: 0.22,
  quickClose: 0.18,
  backdrop: 0.22,
  cardHover: 0.15,
  cardEnter: 0.2,
  tab: 0.15,
  value: 0.16,
  reveal: 0.2,
} as const;

export function motionAllowed() {
  return typeof window !== 'undefined' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

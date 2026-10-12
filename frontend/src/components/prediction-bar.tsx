'use client';

import { useRef } from 'react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { MatchupPrediction } from '@/lib/types';

gsap.registerPlugin(useGSAP);

const TEAM_COLORS = ['#8bd05c', '#68a8ff', '#c38cff', '#ff9f68', '#53d5c4', '#f277ab', '#f0c45c', '#7dc9e8', '#b78b68', '#9ea8ff'];
export function teamAccentColor(teamId: number | null | undefined, identityColor?: string | null) {
  const realColor = String(identityColor || '').replace(/^#/, '');
  if (/^[\da-f]{6}$/i.test(realColor)) return `#${realColor}`;
  return teamId == null ? '#8692a5' : TEAM_COLORS[Math.abs(teamId) % TEAM_COLORS.length];
}

export function PredictionBar({ prediction, homeName, awayName, homeId, awayId, homeColor: homeIdentityColor, awayColor: awayIdentityColor }: {
  prediction?: MatchupPrediction;
  homeName: string;
  awayName: string;
  homeId?: number | null;
  awayId?: number | null;
  homeColor?: string | null;
  awayColor?: string | null;
}) {
  const marker = useRef<HTMLElement>(null);
  const lastMarkerPercent = useRef<number | null>(null);
  const home = prediction?.team_a_win_probability;
  const away = prediction?.team_b_win_probability;
  const available = prediction?.status !== 'unavailable' && typeof home === 'number' && typeof away === 'number';
  const homePercent = available ? home * 100 : null;
  const awayPercent = available ? away * 100 : null;
  const homeDisplayPercent = homePercent == null ? null : Math.round(homePercent * 10) / 10;
  const awayDisplayPercent = awayPercent == null ? null : Math.round(awayPercent * 10) / 10;
  const homeColor = teamAccentColor(homeId, homeIdentityColor);
  const awayColor = teamAccentColor(awayId, awayIdentityColor);
  const nonTieTotal = (homePercent ?? 0) + (awayPercent ?? 0);
  // Segment widths are the actual outcome probabilities. If the model reports
  // ties, the unused tail stays neutral instead of stretching the win shares.
  const markerPercent = available ? homePercent : null;
  const markerColor = markerPercent != null && markerPercent >= 50 ? homeColor : awayColor;
  const gradient = markerPercent == null
    ? `linear-gradient(90deg,${homeColor} 0 50%,${awayColor} 50% 100%)`
    : `linear-gradient(90deg,${homeColor} 0 ${markerPercent}%,${awayColor} ${markerPercent}% ${nonTieTotal}%,#26303d ${nonTieTotal}% 100%)`;
  useGSAP(() => {
    const previous = lastMarkerPercent.current;
    lastMarkerPercent.current = markerPercent;
    if (markerPercent == null || previous == null || previous === markerPercent || !marker.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    gsap.fromTo(marker.current,
      { left: `${previous}%` },
      { left: `${markerPercent}%`, duration: 0.2, ease: 'power2.out', overwrite: 'auto' },
    );
  }, { scope: marker, dependencies: [markerPercent], revertOnUpdate: true });
  return <section className="prediction-share" aria-label="Simulated fantasy matchup win probability">
    <div className="prediction-share-labels">
      <span><i style={{ backgroundColor: homeColor }}/>{homeName}<strong>{homeDisplayPercent == null ? 'Unavailable' : `${homeDisplayPercent.toFixed(1)}%`}</strong></span>
      <span><i style={{ backgroundColor: awayColor }}/>{awayName}<strong>{awayDisplayPercent == null ? 'Unavailable' : `${awayDisplayPercent.toFixed(1)}%`}</strong></span>
    </div>
    <div className="prediction-share-track" role="img" aria-label={available ? `${homeName} ${homePercent!.toFixed(1)} percent, ${awayName} ${awayPercent!.toFixed(1)} percent` : 'Win probability unavailable'} style={{ '--home-color': homeColor, '--away-color': awayColor, background: gradient } as React.CSSProperties}>
      {markerPercent != null && <i ref={marker} className="prediction-share-marker" aria-hidden="true" style={{ left: `${markerPercent}%`, '--marker-color': markerColor } as React.CSSProperties}><svg viewBox="0 0 32 20" focusable="false"><path d="M2 10c4-5.4 9-8 14-8s10 2.6 14 8c-4 5.4-9 8-14 8S6 15.4 2 10Z"/><path className="football-seam" d="M9 5.2c4 2.2 10 7.4 14 9.6M10.5 13.4l2-2.3m1.1 4.2 2-2.3m1.1 4.1 2-2.3"/></svg></i>}
    </div>
    <div className="prediction-share-foot"><span>{prediction?.status === 'unavailable' ? 'Estimate unavailable' : prediction?.simulation_count ? `${prediction.simulation_count.toLocaleString()} simulations${prediction.tie_probability ? ` · ${(prediction.tie_probability * 100).toFixed(1)}% tie` : ''}` : 'Monte Carlo estimate'}</span><span>Model estimate · not ESPN odds</span></div>
  </section>;
}

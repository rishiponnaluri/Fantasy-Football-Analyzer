'use client';
import { PlayerProjection } from './player-projection';
import './living-future-stage-two.css';

import { CSSProperties, ReactNode, useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { Player } from '@/lib/types';
import { canonicalProjection } from '@/lib/api';
import { motionAllowed } from '@/lib/motion';
import { nflTeamPalette } from '@/lib/nfl-team-colors';
import { PlayerAvatar, PlayerStatusButton, usePlayerQuickView } from './player-quick-view';
import { AnimatedPoints } from './player-board-cards';

gsap.registerPlugin(useGSAP);

export function playerField(player: Partial<Player>): CSSProperties {
  const palette = nflTeamPalette(player.nfl_team, player.nfl_team_color, player.nfl_team_alternate_color);
  return { '--lf-team': palette?.[0] || '#414d60', '--lf-team-secondary': palette?.[1] || '#252e3b' } as CSSProperties;
}

/** A keyed reveal responds to changed results, not polling or pointer movement. */
export function ResultSequence({ children, identity, className = '' }: { children: ReactNode; identity: string; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    if (!root.current) return;
    const nodes = root.current.querySelectorAll('[data-lf-reveal]');
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(nodes, { opacity: .55, y: 7 }, { opacity: 1, y: 0, duration: .19, stagger: { each: .025, amount: .14 }, ease: 'power2.out', clearProps: 'opacity,transform' });
    });
    return () => media.revert();
  }, { scope: root, dependencies: [identity], revertOnUpdate: true });
  return <div ref={root} className={className}>{children}</div>;
}

export function PlayerOpen({ player, className = '', children }: { player: Pick<Player, 'player_id' | 'name'> & Partial<Player>; className?: string; children?: ReactNode }) {
  const quickView = usePlayerQuickView();
  return <button type="button" className={`lf-player-open ${className}`} onClick={() => quickView?.open(player.player_id, player as Player)}>{children || player.name}</button>;
}

export function SelectionTrack({ children, value, className, label }: { children: ReactNode; value: string; className: string; label: string }) {
  const root = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const ready = useRef(false);
  useGSAP(() => {
    const active = root.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!active || !marker.current) return;
    const target = { x: active.offsetLeft + 9, y: active.offsetTop + active.offsetHeight - 2, width: Math.max(0, active.offsetWidth - 18), opacity: 1 };
    if (!ready.current || !motionAllowed()) gsap.set(marker.current, target);
    else gsap.to(marker.current, { ...target, duration: .15, ease: 'power2.out', overwrite: true });
    ready.current = true;
  }, { scope: root, dependencies: [value] });
  useEffect(() => {
    const resize = new ResizeObserver(() => {
      const active = root.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (active && marker.current) gsap.set(marker.current, { x: active.offsetLeft + 9, y: active.offsetTop + active.offsetHeight - 2, width: Math.max(0, active.offsetWidth - 18), opacity: 1 });
    });
    if (root.current) resize.observe(root.current);
    return () => resize.disconnect();
  }, []);
  return <div ref={root} className={`${className} lf-selection-track`} role="group" aria-label={label}>{children}<span ref={marker} className="lf-selection-marker" aria-hidden="true"/></div>;
}

export function PlayerAsset({ player, label, compact = false, children }: { player: Player; label?: string; compact?: boolean; children?: ReactNode }) {
  return <article className={`lf-asset lf-surface ${compact ? 'lf-asset-compact' : ''}`} style={playerField(player)} data-pointer-reactive data-lf-reveal>
    <div className="lf-asset-visual">{player.nfl_team_logo_url && <img className="lf-team-watermark" src={player.nfl_team_logo_url} alt=""/>}<PlayerAvatar player={player} size="lg"/>{label && <span className="lf-asset-label">{label}</span>}</div>
    <div className="lf-asset-copy"><PlayerOpen player={player}/><span>{player.nfl_team || 'Team unavailable'} · {player.position || 'Position unavailable'}</span></div>
    <div className="lf-asset-footer"><span>Projection<PlayerProjection player={player}><AnimatedPoints value={canonicalProjection(player)}/></PlayerProjection></span><PlayerStatusButton player={player} compact/></div>{children}
  </article>;
}

export function MarketSkeleton({ label, count = 4, kind = 'assets' }: { label: string; count?: number; kind?: 'assets' | 'rows' | 'comparison' }) {
  return <div className={`lf-loading lf-loading-${kind}`} role="status" aria-label={label}><span>{label}</span><div>{Array.from({ length: count }, (_, index) => <div className="lf-skeleton-asset" key={index}><i className="skeleton"/><div><b className="skeleton"/><span className="skeleton"/></div><em className="skeleton"/></div>)}</div></div>;
}

/** Runs only after a deliberate expansion; no animation or work on hover fetches. */
export function DirectionalMove({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const { contextSafe } = useGSAP({ scope: root });
  const preview = contextSafe(() => {
    if (!root.current || !motionAllowed()) return;
    const sides = root.current.querySelectorAll('.lf-asset');
    gsap.fromTo(sides, { x: index => index === 0 ? 8 : -8 }, { x: 0, duration: .22, ease: 'power2.out', clearProps: 'transform' });
  });
  return <div ref={root} className="lf-directional-move"><div className="lf-move-assets">{children}</div><button type="button" className="lf-text-action" onClick={preview}>Preview move</button></div>;
}

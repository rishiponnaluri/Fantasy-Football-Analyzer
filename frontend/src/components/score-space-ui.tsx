'use client';
import './living-future-stage-three.css';

import { ReactNode, useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { motionAllowed } from '@/lib/motion';

gsap.registerPlugin(useGSAP);

export function ScoreWeekControl({ week, weeks, currentWeek, onChange }: { week: number; weeks: number[]; currentWeek: number; onChange: (week: number | null) => void }) {
  const index = weeks.indexOf(week);
  return <div className="sf-week-control"><button type="button" aria-label="Previous fantasy week" disabled={index <= 0} onClick={() => onChange(weeks[index - 1])}><ChevronLeft size={16}/></button><label><span className="sr-only">Fantasy week</span><select aria-label="Select fantasy week" value={week} onChange={event => onChange(Number(event.target.value))}>{weeks.map(value => <option key={value} value={value}>Week {value}{value === currentWeek ? ' · Current' : ''}</option>)}</select></label><button type="button" aria-label="Next fantasy week" disabled={index < 0 || index >= weeks.length - 1} onClick={() => onChange(weeks[index + 1])}><ChevronRight size={16}/></button></div>;
}

export function ScoreSkeleton({ mode = 'league' }: { mode?: 'league' | 'model' | 'nfl' }) {
  return <div className={`sf-score-skeleton sf-skeleton-${mode}`} role="status" aria-label={mode === 'model' ? 'Loading matchup probabilities' : mode === 'nfl' ? 'Loading NFL games' : 'Loading league scores'}><div className="sf-skeleton-focus"><i className="skeleton"/><span className="skeleton"/><i className="skeleton"/></div>{[0,1,2].map(value => <div className="sf-skeleton-lane" key={value}><span className="skeleton"/><i className="skeleton"/><span className="skeleton"/></div>)}</div>;
}

export function SmoothScoreReveal({ open, id, label, children }: { open: boolean; id: string; label: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(open);
  useEffect(() => { if (open) setRendered(true); }, [open]);
  useGSAP(() => {
    if (!rendered || !root.current) return;
    if (!motionAllowed()) { if (!open) setRendered(false); return; }
    if (open) gsap.fromTo(root.current, { height: 0, opacity: 0, y: 4 }, { height: 'auto', opacity: 1, y: 0, duration: .2, ease: 'power2.out', clearProps: 'height,opacity,transform' });
    else gsap.to(root.current, { height: 0, opacity: 0, duration: .16, ease: 'power1.in', onComplete: () => setRendered(false) });
  }, { scope: root, dependencies: [open, rendered], revertOnUpdate: true });
  return rendered ? <div ref={root} id={id} className="sf-smooth-reveal" role="region" aria-label={label} aria-hidden={!open} inert={!open}>{children}</div> : null;
}

'use client';

import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { StoredPlayerUpdate } from '@/lib/types';
import { safeUpdateUrl, updateTime, usefulPlayerUpdates } from '@/lib/player-updates.mjs';

export default function LatestPlayerUpdates({ playerId, updates, loading = false }: {
  playerId: number; updates?: StoredPlayerUpdate[]; loading?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = usefulPlayerUpdates(updates, playerId);
  const visible = expanded ? items : items.slice(0, 3);
  return <section className="quick-view-news quick-view-stored-updates" aria-label="Latest updates" aria-busy={loading && !updates}>
    <h3>Latest updates</h3>
    {visible.length ? <div className="quick-view-update-list">{visible.map(item => {
      const time = updateTime(item);
      const url = safeUpdateUrl(item.url);
      return <article className="quick-view-update" data-impact={item.impact} key={item.dedupe_key}>
        <div className="quick-view-update-category"><span>{item.category.replaceAll('_', ' ')}</span>{item.impact === 'HIGH' && <span className="quick-view-update-priority">High impact</span>}</div>
        <strong>{item.headline}</strong>
        <div className="quick-view-update-meta"><span>{item.source}</span>{time.iso ? <time dateTime={time.iso}>{time.label} {new Date(time.iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time> : <span>Time unavailable</span>}
          {url && <a href={url} target="_blank" rel="noopener noreferrer">Read update <ExternalLink size={10} aria-hidden="true"/></a>}
        </div>
      </article>;
    })}</div> : <p>{loading && !updates ? 'Loading stored updates…' : 'No stored updates for this player yet.'}</p>}
    {items.length > 3 && <button type="button" className="quick-view-updates-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer updates' : `View all updates (${items.length})`}</button>}
  </section>;
}

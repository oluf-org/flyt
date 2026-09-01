// The primary navigation rail.
//
// Destinations moved off the title bar and back onto a rail because the title
// bar is where the project tabs live, and four destinations plus a tab strip
// plus the OS window controls is a row that runs out of width before it runs
// out of things to say. A rail also gives each destination a fixed place: the
// one thing a person should never have to re-find is where they are.
//
// The icons are line work in the app's geometric language — stroke-based,
// `currentColor`, so they tint to the accent when active and inherit the theme
// everywhere else. Not emoji: emoji carry their own palette and break the
// Slate & Sage feel on sight.
import React from 'react';
import { DESTINATIONS, heading, hint } from './shellRouting.js';

const ICON = {
  // Work — a single node radiating short rays: the sigil burst as a glyph.
  work: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 5.4V8M12 16v2.6M5.4 12H8M16 12h2.6M7.6 7.6 9.4 9.4M14.6 14.6l1.8 1.8M16.4 7.6 14.6 9.4M9.4 14.6l-1.8 1.8" />
    </svg>
  ),
  // Build — one block branching into two: a stack, seen from above.
  build: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="5" r="2.3" /><circle cx="6" cy="18.5" r="2.3" /><circle cx="18" cy="18.5" r="2.3" />
      <path d="M12 7.3v3.2M12 10.5 6.9 16.4M12 10.5l5.1 5.9" />
    </svg>
  ),
  // Library — a grid of tiles, one of everything installed.
  library: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.6" /><rect x="13" y="4" width="7" height="7" rx="1.6" />
      <rect x="4" y="13" width="7" height="7" rx="1.6" /><rect x="13" y="13" width="7" height="7" rx="1.6" />
    </svg>
  ),
  // Models — stacked model cards.
  models: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="5" rx="2" /><rect x="4" y="10" width="16" height="5" rx="2" /><rect x="4" y="16" width="16" height="4" rx="2" />
      <circle cx="16.5" cy="6.5" r=".8" fill="currentColor" stroke="none" /><circle cx="16.5" cy="12.5" r=".8" fill="currentColor" stroke="none" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19V10M10 19V5M16 19v-7M22 19V8" /><path d="M3 19.5h20" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

/**
 * @param active — the current destination, or null while Trace is over it. The
 *   pill hides rather than lying about where you are: Trace is not a
 *   destination, and lighting one up while you are reading a run's record says
 *   you are somewhere you are not.
 * @param badges — `{ [dest]: { count, tone } }`, for a destination with
 *   something waiting in it. Absent counts draw nothing at all.
 */
export default function ShellRail({ active = null, onGo = null, onOpenSettings = null, badges = {} }) {
  const index = DESTINATIONS.indexOf(active);
  return (
    <nav className="activity-bar" aria-label="Primary">
      <div className="activity-group">
        <div className="activity-indicator" aria-hidden="true"
          data-hidden={index < 0 ? 'true' : 'false'}
          style={{ '--active-index': Math.max(index, 0) }} />
        {DESTINATIONS.map(dest => {
          const badge = badges[dest];
          return (
            <button
              key={dest}
              type="button"
              className={'activity-btn' + (dest === active ? ' active' : '')}
              aria-current={dest === active ? 'page' : undefined}
              title={hint(dest)}
              onClick={() => onGo?.(dest)}
            >
              <span className="activity-glyph">
                {ICON[dest]}
                {badge?.count > 0 && (
                  <span className={`activity-badge tone-${badge.tone ?? 'accent'}`}>
                    {badge.count > 9 ? '9+' : badge.count}
                  </span>
                )}
              </span>
              <span className="activity-label">{heading(dest)}</span>
            </button>
          );
        })}
      </div>
      <div className="activity-spacer" />
      {onOpenSettings && (
        <button type="button" className="activity-btn utility" title="Settings — providers, keys and approval"
          onClick={onOpenSettings}>
          <span className="activity-glyph">{ICON.settings}</span>
          <span className="activity-label">Settings</span>
        </button>
      )}
    </nav>
  );
}

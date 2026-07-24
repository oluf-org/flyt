import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { statusPill } from './Inspector.jsx';

// The run canvas's right-click menu (RUN-CONTROL): every run action one
// gesture away, on the node it acts on. Clones the tab-menu pattern
// (TabStrip.jsx) — fixed to the cursor, Esc / outside click / window blur to
// dismiss — and adds what a denser menu needs: arrow-key navigation between
// the enabled items, a non-interactive header naming the node, an inline
// one-line prompt for restart guidance, and a two-click confirm for the one
// destructive action.
//
// One deliberate deviation from the tab menu: close-on-outside-click tests
// containment instead of relying on a React stopPropagation. React 18
// delegates pointerdown at the root container, so a window CAPTURE listener
// fires before the menu's own synthetic handler — the containment check works
// regardless of listener order.
export default function NodeMenu({
  menu, node, flowBacked, live, paused, follow,
  onClose, onInvestigate, onRestart, onBranch,
  onPause, onResume, onStop, onToggleFollow,
  summarizeCount = 0, onSummarize, onDeleteSummary
}) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const [confirmStop, setConfirmStop] = useState(false);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [guidance, setGuidance] = useState('');
  const confirmTimer = useRef(null);

  // Esc, an outside pointerdown, or the window losing focus dismisses the
  // menu. Esc is handled at the container (focus is moved inside on open) so
  // the guidance field can claim its own Esc first; the window listener is
  // the fallback for focus having escaped.
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    const onPointer = e => { if (!menuRef.current?.contains(e.target)) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  // Keep the whole menu on screen: it opens at the cursor, then nudges back
  // inside the viewport if that would clip it (measured once per open).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const pad = 8;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(pad, Math.min(menu.x, window.innerWidth - r.width - pad)),
      y: Math.max(pad, Math.min(menu.y, window.innerHeight - r.height - pad))
    });
  }, [menu]);

  // Keyboard users land in the menu: focus the first enabled item on open.
  useEffect(() => {
    menuRef.current?.querySelector('.node-menu-item:not(:disabled)')?.focus();
  }, [guidanceOpen]);

  useEffect(() => () => clearTimeout(confirmTimer.current), []);

  // Arrow-key navigation between the enabled items (Tab closes, per menu
  // convention; Enter/Space activate natively because these are buttons).
  const onMenuKeyDown = e => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    const items = [...(menuRef.current?.querySelectorAll('.node-menu-item:not(:disabled)') ?? [])];
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(idx + step + items.length) % items.length].focus();
    } else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items.at(-1).focus(); }
    else if (e.key === 'Tab') { onClose(); }
  };

  // Run the action after the menu is gone, so its result (a panel, a toast)
  // never fights the menu for focus or layering.
  const act = fn => () => { onClose(); fn?.(); };

  // Stop is the one destructive action: the first click re-arms the item
  // itself ("click again") for three seconds instead of opening a dialog.
  const clickStop = () => {
    if (confirmStop) {
      clearTimeout(confirmTimer.current);
      onClose();
      onStop?.();
      return;
    }
    setConfirmStop(true);
    confirmTimer.current = setTimeout(() => setConfirmStop(false), 3000);
  };

  const submitGuidance = () => {
    const text = guidance.trim();
    onClose();
    onRestart?.(text);
  };

  const restartTitle = live
    ? 'Stop the run to restart nodes'
    : !flowBacked ? 'Only flow runs can restart nodes' : 'Restart this node and everything downstream';
  const branchTitle = live
    ? 'Stop the run to branch'
    : !flowBacked ? 'Only flow runs can be branched' : 'Fork the run from this node';
  const canControl = !live && flowBacked;

  return (
    <div
      ref={menuRef}
      className="node-menu"
      role="menu"
      aria-label={menu.kind === 'node' ? `Node actions — ${node?.data?.label ?? menu.id}` : 'Run actions'}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onMenuKeyDown}
    >
      {guidanceOpen ? (
        <div className="node-menu-guidance">
          <div className="node-menu-guidance-label">Restart {node?.data?.label ?? menu.id} with guidance</div>
          <input
            autoFocus
            value={guidance}
            maxLength={240}
            placeholder="One line for the retry — “use approach B”…"
            aria-label="Guidance for the restarted node"
            onChange={e => setGuidance(e.target.value)}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Enter') { e.preventDefault(); submitGuidance(); }
              else if (e.key === 'Escape') { setGuidanceOpen(false); setGuidance(''); }
            }}
          />
          <div className="node-menu-hint">Enter to restart · Esc for the menu</div>
        </div>
      ) : (
        <>
          {menu.kind === 'node' && (
            <div className="node-menu-label">
              <span className="node-menu-label-title">{node?.data?.label ?? menu.id}</span>
              {node?.data?.status && statusPill(node.data.status)}
            </div>
          )}
          {menu.kind === 'node' && node?.type === 'summary' && (
            <>
              {/* Summary nodes are artifacts, not work: no restart / branch /
                  investigate, and no summarize-on-summary (D8) — just delete. */}
              <button type="button" role="menuitem" className="node-menu-item danger" onClick={act(onDeleteSummary)}>
                <span className="node-menu-glyph" aria-hidden>✕</span> Delete summary
              </button>
              <div className="node-menu-sep" role="separator" />
            </>
          )}
          {menu.kind === 'node' && node?.type !== 'summary' && (
            <>
              <button
                type="button" role="menuitem" className="node-menu-item"
                disabled={!summarizeCount}
                title={summarizeCount
                  ? summarizeCount > 1 ? `Summarize ${summarizeCount} nodes into one summary` : 'Summarize this node\'s output into a summary node'
                  : 'Nothing to summarize yet — the node has no output'}
                onClick={act(onSummarize)}
              >
                <span className="node-menu-glyph" aria-hidden>◇</span>
                {summarizeCount > 1 ? `Summarize ${summarizeCount} nodes` : 'Summarize output'}
              </button>
              <button type="button" role="menuitem" className="node-menu-item" onClick={act(onInvestigate)}>
                <span className="node-menu-glyph" aria-hidden>◈</span> Investigate node
              </button>
              <button
                type="button" role="menuitem" className="node-menu-item"
                disabled={!canControl} title={restartTitle}
                onClick={act(() => onRestart?.())}
              >
                <span className="node-menu-glyph" aria-hidden>↺</span> Restart node
              </button>
              <button
                type="button" role="menuitem" className="node-menu-item"
                disabled={!canControl} title={restartTitle}
                onClick={() => setGuidanceOpen(true)}
              >
                <span className="node-menu-glyph" aria-hidden>↺</span> Restart with guidance…
              </button>
              <button
                type="button" role="menuitem" className="node-menu-item"
                disabled={!canControl} title={branchTitle}
                onClick={act(onBranch)}
              >
                <span className="node-menu-glyph" aria-hidden>⑂</span> Branch from here
              </button>
              <div className="node-menu-sep" role="separator" />
            </>
          )}
          {menu.kind === 'pane' && (
            <button type="button" role="menuitem" className="node-menu-item" onClick={act(onToggleFollow)}>
              <span className="node-menu-check" aria-hidden>{follow ? '✓' : ''}</span> Follow execution
            </button>
          )}
          {paused ? (
            <button
              type="button" role="menuitem" className="node-menu-item"
              disabled={!live} title={live ? 'Resume the run' : 'The run is not live'}
              onClick={act(onResume)}
            >
              <span className="node-menu-glyph" aria-hidden>▶</span> Resume run
            </button>
          ) : (
            <button
              type="button" role="menuitem" className="node-menu-item"
              disabled={!live} title={live ? 'Hold the run after the current step' : 'The run is not live'}
              onClick={act(onPause)}
            >
              <span className="node-menu-glyph" aria-hidden>❚❚</span> Pause run
            </button>
          )}
          <button
            type="button" role="menuitem"
            className={'node-menu-item danger' + (confirmStop ? ' confirm' : '')}
            disabled={!live}
            title={live ? 'Stop the run — finished work is kept' : 'The run is not live'}
            onClick={clickStop}
          >
            <span className="node-menu-glyph" aria-hidden>■</span>
            {confirmStop ? 'Click again to confirm stop' : 'Stop run'}
          </button>
        </>
      )}
    </div>
  );
}

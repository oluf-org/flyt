import React, { useEffect, useState } from 'react';
import { ModelPicker } from './ModelPicker.jsx';

// Retry one step, optionally somewhere else (D39).
//
// A failed AI step used to offer exactly one way forward — "Restart" — which
// re-ran the same prompt against the same model that had just failed on it.
// When the failure IS the model (no key, a broken vendor CLI, an id no
// connected provider can serve) that button can only fail again. So the retry
// carries the two things that change the outcome: which model runs it, and
// what to do differently.
//
// The model change is scoped to the run: restartNode writes the pin into the
// run's flow.json, never the authored workflow (see StackRunner.restartNode).
export default function RetryBox({
  worker, activeModels, onRetry, busy = false, disabled = false, disabledReason = null,
  label = 'Retry this step'
}) {
  const [w, setW] = useState(worker ?? null);
  const [guidance, setGuidance] = useState('');
  const [open, setOpen] = useState(false);

  // A new failure (different node, different model) re-seeds the picker; an
  // in-progress edit of the same one is not thrown away.
  const seed = worker ? `${worker.provider}/${worker.model}` : '';
  useEffect(() => { setW(worker ?? null); }, [seed]);

  const changed = Boolean(w?.provider && w?.model) && `${w.provider}/${w.model}` !== seed;

  const fire = () => {
    if (disabled || busy) return;
    // Unchanged model -> no re-pin at all, so the run's flow.json is only ever
    // rewritten when the user actually asked for a different model.
    onRetry?.(changed ? { provider: w.provider, model: w.model } : null, guidance.trim());
  };

  return (
    <div className="retry-box">
      <div className="retry-row">
        <span className="retry-label">Run it again with</span>
        <ModelPicker
          worker={w}
          activeModels={activeModels}
          onChange={setW}
          idPrefix="retry"
          className="retry-model"
        />
        <button
          type="button"
          className="ghost mini retry-guidance-toggle"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
          title="Tell the retry what to do differently"
        >
          {open ? '− Guidance' : '＋ Guidance'}
        </button>
        <div className="toolbar-spacer" />
        <button
          type="button"
          className="primary retry-go"
          onClick={fire}
          disabled={disabled || busy}
          title={disabledReason ?? `${label} and everything downstream of it`}
        >
          {busy ? 'Retrying…' : `↺ ${label}`}
        </button>
      </div>
      {open && (
        <textarea
          className="retry-guidance"
          value={guidance}
          onChange={e => setGuidance(e.target.value)}
          placeholder="Optional — what should this attempt do differently?"
          rows={2}
          aria-label="Retry guidance"
        />
      )}
      {disabledReason && <span className="retry-note">{disabledReason}</span>}
      {!disabledReason && changed && (
        <span className="retry-note">
          Only this run is re-pointed — the saved workflow keeps its own model.
        </span>
      )}
    </div>
  );
}

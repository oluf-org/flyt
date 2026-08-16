import React, { useState } from 'react';
import RetryBox from './RetryBox.jsx';

// The failure panel (D39): what a stopped run owes the person who started it.
//
// Before this, a failed run said "1 problem noted" on a card and left the
// actual sentence — the provider's own words about why the call could not be
// made — inside a tooltip and a retrospective file. The reason was known and
// unsaid, which is the one thing a failure surface must never do. So: the error
// verbatim, copyable, next to the only two controls that change the outcome
// (a different model, guidance) and a door to the full step.
export default function RunFailure({ failure, activeModels, onRetry, onInspect, retrying }) {
  const [copied, setCopied] = useState(false);
  if (!failure) return null;

  const copy = async () => {
    const text = [failure.message, failure.runError].filter(Boolean).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked — the <pre> is selectable */ }
  };

  const workerText = failure.worker?.model
    ? `${failure.worker.provider}/${failure.worker.model}`
    : null;

  return (
    <section className="run-failure" role="alert" aria-label="The run failed">
      <div className="run-failure-head">
        <span className="run-failure-glyph" aria-hidden>✕</span>
        <div className="run-failure-title">
          <strong>The run stopped{failure.label ? ` at “${failure.label}”` : ''}</strong>
          <span className="run-failure-sub">
            {workerText ? `It was calling ${workerText}. ` : ''}
            Finished steps are kept — the retry picks up from here.
          </span>
        </div>
        <button className="ghost mini" onClick={copy} title="Copy the full error">
          {copied ? 'Copied ✓' : 'Copy error'}
        </button>
        {failure.nodeId && onInspect && (
          <button className="ghost mini" onClick={() => onInspect(failure.nodeId)} title="Open this step's full record">
            Step details
          </button>
        )}
      </div>

      <pre className="run-failure-error">{failure.message}</pre>
      {failure.runError && <pre className="run-failure-error secondary">{failure.runError}</pre>}
      {failure.recommendation && (
        <p className="run-failure-note">{failure.recommendation}</p>
      )}

      {failure.retryNodeId ? (
        <RetryBox
          worker={failure.worker}
          activeModels={activeModels}
          busy={retrying}
          onRetry={(worker, guidance) => onRetry?.(failure.retryNodeId, guidance, worker)}
          label="Retry from here"
        />
      ) : (
        <p className="run-failure-note">
          This run has no re-runnable step — start it again from the composer above.
        </p>
      )}
    </section>
  );
}

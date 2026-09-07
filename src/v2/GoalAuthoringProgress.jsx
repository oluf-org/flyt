import React, { useEffect, useState } from 'react';

// Kept separate from the chat layout so the designer can place it freely.
export function GoalAuthoringProgress({ request }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const progress = request.progress;
  const labels = { waiting: 'Waiting for model', thinking: 'Thinking', receiving: 'Receiving response', correcting: 'Correcting response', validating: 'Checking response', failed: 'Call failed' };
  const seconds = Math.max(0, Math.floor((now - (progress?.startedAt ?? request.at)) / 1000));
  return <span role="status">{labels[progress?.phase] ?? 'Working'}… · {seconds}s{progress?.contentChars > 0 && ` · ${progress.contentChars.toLocaleString()} characters received`}</span>;
}

export function GoalAuthoringDiagnostics({ request }) {
  if (!request.attempts?.length || request.status === 'working') return null;
  return <details className="goal-chat-tool"><summary>Response diagnostics · {request.attempts.length} call{request.attempts.length === 1 ? '' : 's'}</summary>{request.attempts.map((attempt, index) => <details key={index}>
    <summary>Call {index + 1}{attempt.correction ? ' · correction' : ''} · {attempt.validationError || attempt.error ? 'failed' : 'complete'}</summary>
    <p>{attempt.model} · {attempt.responseMode ?? 'prompt'} · {Math.round((attempt.elapsedMs ?? 0) / 1000)}s · finish: {attempt.finishReason ?? 'unavailable'}</p>
    <p>{attempt.contentChars ?? 0} answer characters · {attempt.reasoningChars ?? 0} reasoning characters</p>
    {(attempt.validationError || attempt.error) && <p>{attempt.validationError || attempt.error}</p>}
    {attempt.rawResponse && <details><summary>Model response{attempt.rawResponseTruncated ? ' (excerpt)' : ''}</summary><pre>{attempt.rawResponse}</pre></details>}
  </details>)}</details>;
}

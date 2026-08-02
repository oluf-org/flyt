import React, { useEffect, useState } from 'react';
import { formatMs, formatTokens } from '../core/runMetrics.js';
import { formatCost } from '../core/callCost.js';
import { Cost, Distribution } from './RunMetrics.jsx';
import Tip from './Tip.jsx';

// The Inspector's Calls tab (PIVOT-PLAN §6.1) — the per-attempt list for the
// selected node, and the wire viewer behind each entry.
//
// This is the zoom level decision 5 asked for: the literal request and response
// JSON, redacted and bounded when it was written, with the truncation state
// STATED rather than hidden. The two failure modes it must never have are an
// empty panel where a limitation belongs (a CLI-delegate call has no wire, and
// must say so) and a number the files don't support.

// `metrics` is the FOLD for this selection (a node's, a task's, or the whole
// run's) — see core/runMetrics.js. `preMetrics` is the run-level fact that this
// run predates the ledger, which is a different statement from "no calls yet"
// and has to read differently.
export default function CallsPanel({ projectId, runId, nodeId, taskId, metrics, preMetrics = false }) {
  const [calls, setCalls] = useState(null);
  const [error, setError] = useState(null);
  const [openSeq, setOpenSeq] = useState(null);

  // The folded metrics ride on the snapshot and change as calls land; that is
  // the cue to re-read the list. Bodies are never on the snapshot — they are
  // fetched here, per call, when one is opened.
  const stamp = metrics?.calls ?? 0;
  useEffect(() => {
    let cancelled = false;
    if (!window.flyt?.readRunCalls || !runId) { setCalls([]); return; }
    window.flyt.readRunCalls(projectId, runId, nodeId ?? null, taskId ?? null)
      .then(list => { if (!cancelled) { setCalls(list ?? []); setError(null); } })
      .catch(err => { if (!cancelled) setError(String(err?.message ?? err)); });
    return () => { cancelled = true; };
  }, [projectId, runId, nodeId, taskId, stamp]);

  if (error) return <section><h3>Calls</h3><pre className="pre-err">{error}</pre></section>;
  if (calls == null) return <section><h3>Calls</h3><pre className="dim">Reading the ledger…</pre></section>;
  if (!calls.length) {
    return (
      <section>
        <h3>Calls</h3>
        <pre className="dim">
          {preMetrics
            ? 'This run predates the call ledger — it never recorded per-call data, and none is invented here.'
            : 'No model calls recorded for this node yet.'}
        </pre>
      </section>
    );
  }

  return (
    <>
      {metrics && (
        <section className="calls-summary">
          <h3>This node</h3>
          <div className="metric-grid">
            <Metric label="cost"><Cost cost={metrics.cost} /></Metric>
            <Metric label="tokens">{formatTokens(metrics.usage?.totalTokens)}</Metric>
            <Metric label="calls">{metrics.calls}{metrics.retries ? ` (${metrics.retries} retried)` : ''}</Metric>
            <Metric label="in model">{formatMs(metrics.modelMs)}</Metric>
          </div>
          <Distribution label="latency" dist={metrics.latency} />
          <Distribution label="first token" dist={metrics.ttft} />
          <Distribution label="throughput" dist={metrics.throughput} unit="t/s" />
        </section>
      )}
      <section>
        <h3>Calls <span className="section-count">{calls.length} attempt{calls.length === 1 ? '' : 's'}</span></h3>
        <ul className="call-list">
          {calls.map(c => (
            <CallRow
              key={c.seq} call={c}
              open={openSeq === c.seq}
              onToggle={() => setOpenSeq(openSeq === c.seq ? null : c.seq)}
              projectId={projectId} runId={runId}
            />
          ))}
        </ul>
      </section>
    </>
  );
}

function Metric({ label, children }) {
  return (
    <div className="metric-cell">
      <div className="metric-cell-label">{label}</div>
      <div className="metric-cell-value mono">{children}</div>
    </div>
  );
}

function CallRow({ call, open, onToggle, projectId, runId }) {
  const failed = !call.ok;
  return (
    <li className={'call-row' + (failed ? ' failed' : '') + (open ? ' open' : '')}>
      <button type="button" className="call-head" onClick={onToggle} aria-expanded={open}>
        <span className="call-seq mono">#{call.seq}</span>
        <span className={'call-status' + (failed ? ' err' : '')}>{failed ? '✕' : '✓'}</span>
        <span className="call-model mono" title={`${call.provider}/${call.model}`}>{call.model ?? '(unknown model)'}</span>
        {call.attempt > 0 && (
          <Tip as="span" className="call-attempt" text="A retried attempt. Retries cost money and add latency — this is where a slow node usually explains itself.">
            attempt {call.attempt + 1}
          </Tip>
        )}
        <span className="call-grow" />
        <span className="call-num mono" title="Wall time for THIS attempt (backoff excluded)">{formatMs(call.durationMs)}</span>
        {call.ttftMs != null && <span className="call-num mono" title="Time to first token">↦{formatMs(call.ttftMs)}</span>}
        {call.outputTokensPerSec != null && <span className="call-num mono" title="Output tokens per second">{call.outputTokensPerSec} t/s</span>}
        <span className="call-num mono" title="Cost of this attempt">
          {call.cost?.costKind === 'plan' ? 'plan' : `${call.cost?.estimated ? '~' : ''}${formatCost(call.cost?.total)}`}
        </span>
        <span className="call-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && <CallDetail call={call} projectId={projectId} runId={runId} />}
    </li>
  );
}

function CallDetail({ call, projectId, runId }) {
  const [wire, setWire] = useState(null);
  const [wireError, setWireError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!call.wire || !window.flyt?.readCallWire) return;
    window.flyt.readCallWire(projectId, runId, call.seq)
      .then(r => { if (cancelled) return; r?.ok ? setWire(r) : setWireError(r?.error ?? 'Could not read the wire record.'); })
      .catch(err => { if (!cancelled) setWireError(String(err?.message ?? err)); });
    return () => { cancelled = true; };
  }, [projectId, runId, call.seq, Boolean(call.wire)]);

  return (
    <div className="call-detail">
      <dl className="call-facts">
        <Fact k="provider">{call.provider}</Fact>
        <Fact k="protocol">{call.protocol ?? '—'}</Fact>
        <Fact k="finish">{call.finishReason ?? '—'}</Fact>
        <Fact k="started">{call.startedAt?.replace('T', ' ').replace('Z', '') ?? '—'}</Fact>
        {call.usage && (
          <Fact k="tokens">
            {formatTokens(call.usage.inputTokens)} in
            {call.usage.cachedInputTokens ? ` · ${formatTokens(call.usage.cachedInputTokens)} cached` : ''}
            {' · '}{formatTokens(call.usage.outputTokens)} out
            {call.usage.reasoningTokens ? ` · ${formatTokens(call.usage.reasoningTokens)} reasoning` : ''}
          </Fact>
        )}
        {call.cost?.reason && <Fact k="cost note">{COST_NOTES[call.cost.reason] ?? call.cost.reason}</Fact>}
      </dl>

      {call.error && <pre className="pre-err">{call.error}</pre>}

      {/* Honest holes (§4.3): a stated limitation, never an empty panel. */}
      {!call.wire && (
        <p className="wire-unavailable">
          {WIRE_NOTES[call.wireUnavailable] ?? 'No wire record was captured for this call.'}
        </p>
      )}

      {call.wire?.truncated && (
        <p className="wire-truncated">
          The bodies below were capped when they were written. Turn wire capture up to <em>full</em> in
          Settings to keep whole bodies on future runs — it cannot recover this one.
        </p>
      )}

      {wireError && <pre className="pre-err">{wireError}</pre>}
      {wire && (
        <>
          <WireBlock title="Request — what was sent" body={wire.request} />
          <WireBlock title="Response — what came back" body={wire.response} />
        </>
      )}
    </div>
  );
}

const COST_NOTES = {
  'no-price': 'No published price for this model, so no cost is claimed. It is not zero — it is unknown.',
  'no-usage': 'The provider reported no token usage for this call.',
  'cache-rate-unknown': 'This model publishes no cached-input rate, so cached tokens were billed at the full input rate. The real cost is at most this.',
  plan: 'Ran on a subscription — this costs plan capacity, not dollars.'
};

const WIRE_NOTES = {
  'cli-delegate': 'This call ran through the provider\'s own CLI, which owns the HTTP conversation. There is no wire to capture — usage, timing and text above are everything this call can report.',
  'capture-off': 'Wire capture is turned off. Turn it on in Settings to record request and response bodies on future runs.',
  'adapter-no-capture': 'This adapter does not report a wire record.'
};

function Fact({ k, children }) {
  return (<><dt>{k}</dt><dd className="mono">{children}</dd></>);
}

function WireBlock({ title, body }) {
  const [open, setOpen] = useState(false);
  if (body == null) return null;
  const lines = body.split('\n').length;
  return (
    <div className="wire-block">
      <button type="button" className="wire-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '▾' : '▸'} {title} <span className="wire-size mono">{lines} lines</span>
      </button>
      {open && <pre className="wire-body mono">{body}</pre>}
    </div>
  );
}

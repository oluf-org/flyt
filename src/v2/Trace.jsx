// Trace (t-0071, t-0072): the session log, rendered for a person.
//
// Transient — it appears when there is a run to look at and it IS that run's
// record, so a finished run's trace reopens from its log with no live process
// (D60). Work stays calm; this holds the detail.
//
// Collapsed by default, at every level. A run with forty steps in it is not
// made readable by showing all forty at once, and the reason somebody opens
// Trace is a specific question about a specific step. Expanding is how you ask
// it.
//
// The rule the whole surface exists for: nothing here softens anything. A
// degraded route reads as degraded, a tool call with no result reads as
// unfinished rather than as empty, and a result is shown whole rather than
// previewed — the one time a preview is not enough is the time somebody came
// here.
import React, { useState } from 'react';
import { traceView } from './traceView.js';
import { duration } from './traceView.js';
import './traceStyles.css';

/** A collapsible section that is closed until asked. */
function Fold({ label, detail, open, onToggle, children, tone = null }) {
  return (
    <div className={`tr-fold${open ? ' open' : ''}${tone ? ` tone-${tone}` : ''}`}>
      <button type="button" className="tr-fold-head" onClick={onToggle} aria-expanded={open}>
        <span className="tr-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="tr-fold-label">{label}</span>
        {detail && <span className="tr-fold-detail">{detail}</span>}
      </button>
      {open && <div className="tr-fold-body">{children}</div>}
    </div>
  );
}

const money = usd => (usd == null ? null : usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`);

function Pre({ value, className = '' }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <pre className={`tr-pre ${className}`}>{text}</pre>;
}

function Request({ request }) {
  if (!request) return <p className="tr-none">No model request was recorded for this step.</p>;
  return (
    <div className="tr-request">
      <dl className="tr-facts">
        <dt>model</dt><dd className="mono">{request.model}</dd>
        <dt>finish</dt>
        <dd className={request.settled ? '' : 'tr-unfinished'}>
          {request.settled ? request.finishReason : 'nothing came back — the request is unsettled'}
        </dd>
        {request.tokens && <><dt>usage</dt><dd>{request.tokens}</dd></>}
        {request.costUsd != null && <><dt>cost</dt><dd>{money(request.costUsd)}</dd></>}
        {request.ms != null && <><dt>took</dt><dd>{duration(request.ms)}</dd></>}
      </dl>
      {request.route && (
        <p className={`tr-route${request.route.degraded ? ' degraded' : ''}`}>
          <span className="section-label">{request.route.degraded ? 'DEGRADED ROUTE' : 'ROUTE'}</span>
          <span className="mono">{request.route.line}</span>
        </p>
      )}
      {/* D40: reasoning apart from content, always. Folding them together is
          how "how much of what I paid for was thinking" stops being answerable. */}
      {request.reasoning && (
        <details className="tr-reasoning">
          <summary>reasoning ({request.reasoning.length} chars)</summary>
          <Pre value={request.reasoning} className="dim" />
        </details>
      )}
      {request.content && <Pre value={request.content} />}
    </div>
  );
}

function ToolCall({ call }) {
  const [open, setOpen] = useState(false);
  const detail = call.unfinished
    ? 'never returned'
    : call.error ? 'error' : null;
  return (
    <Fold
      label={<span className="mono">{call.name}</span>}
      detail={detail}
      tone={call.unfinished ? 'warn' : call.error ? 'err' : null}
      open={open}
      onToggle={() => setOpen(o => !o)}
    >
      <p className="section-label">ARGUMENTS</p>
      <Pre value={call.args} />
      {call.decision && (
        <p className={`tr-decision ${call.decision.decision}`}>
          <span className="section-label">PERMISSION</span>
          {call.decision.decision}
          {call.decision.reason ? ` — ${call.decision.reason}` : ''}
        </p>
      )}
      <p className="section-label">RESULT</p>
      {call.unfinished
        ? (
          <p className="tr-unfinished">
            This call never returned: the process ended while it was running, and its
            effect on the workspace is unknown.
          </p>
        )
        : <Pre value={call.error ? { error: call.error } : call.result} />}
    </Fold>
  );
}

function Step({ step }) {
  const [open, setOpen] = useState(false);
  const bits = [
    step.request?.model,
    step.tools.length ? `${step.tools.length} tool call(s)` : null,
    step.ms != null ? duration(step.ms) : null,
    step.finished ? null : 'running',
  ].filter(Boolean).join(' · ');
  return (
    <Fold
      label={`step ${step.step}`}
      detail={bits}
      tone={step.finished ? null : 'live'}
      open={open}
      onToggle={() => setOpen(o => !o)}
    >
      {step.prompt && (
        <details className="tr-prompt">
          <summary>prompt assembly</summary>
          <Pre value={step.prompt} />
        </details>
      )}
      <Request request={step.request} />
      {step.tools.map(call => <ToolCall key={call.callId} call={call} />)}
      {step.orphanDecisions.map(d => (
        <p key={`${d.callId}-${d.at}`} className={`tr-decision ${d.decision}`}>
          <span className="section-label">PERMISSION</span>
          <span className="mono">{d.callId}</span> {d.decision}
          {d.reason ? ` — ${d.reason}` : ''}
        </p>
      ))}
    </Fold>
  );
}

function Turn({ turn }) {
  const [open, setOpen] = useState(false);
  const bits = [
    turn.blockId,
    `${turn.steps.length} step(s)`,
    turn.toolCount ? `${turn.toolCount} tool call(s)` : null,
    money(turn.costUsd),
    turn.ms != null ? duration(turn.ms) : null,
    turn.finished ? null : 'running',
  ].filter(Boolean).join(' · ');
  return (
    <Fold
      label={`turn ${turn.id}`}
      detail={bits}
      tone={turn.finished ? null : 'live'}
      open={open}
      onToggle={() => setOpen(o => !o)}
    >
      {turn.steps.map(step => <Step key={step.id} step={step} />)}
    </Fold>
  );
}

/**
 * @param trace — a folded trace from `src/traceModel.js`, live or finished.
 * @param runId — which run this is the record of.
 */
export default function Trace({ trace = null, runId = null }) {
  const view = traceView(trace);
  if (!view.turns.length) {
    return (
      <div className="tr-empty" role="status">
        <p className="section-label">NOTHING RECORDED YET</p>
        <p>
          {runId
            ? <>Run <span className="mono">{runId}</span> has a log with no turns in it yet.</>
            : 'No run is being watched.'}
        </p>
      </div>
    );
  }
  return (
    <div className="trace" data-v2 data-run={runId ?? undefined}>
      <p className="tr-summary">
        {view.turns.length} turn(s)
        {view.costUsd != null ? ` · ${money(view.costUsd)}` : ''}
        {view.unfinished ? ' · still going' : ''}
      </p>
      {view.turns.map(turn => <Turn key={turn.id} turn={turn} />)}
      {view.others.length > 0 && (
        <details className="tr-others">
          <summary>{view.others.length} event(s) this surface does not have a shape for</summary>
          {/* A plugin's own events are still this run's record. Hiding them
              would make Trace stop being the record and start being a summary
              of the parts we happened to have written a renderer for. */}
          <Pre value={view.others} />
        </details>
      )}
    </div>
  );
}

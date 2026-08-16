import React, { useEffect, useMemo, useRef, useState } from 'react';
import MarkdownView from './MarkdownView.jsx';
import RetryBox from './RetryBox.jsx';
import { statusPill } from './Inspector.jsx';
import { TYPE_META, nodeLabel } from './flowTypes.js';
import { nodeOutputText, taskNodeStatus } from './runGraph.js';
import { formatElapsed } from './runProgress.js';

// Node Focus (RUN-CONTROL investigate): the right-column panel a node's
// context menu opens. One node's whole story in newcomer order — what it's
// doing in plain language (a model-written summary on demand), what it's
// saying (the token stream), then the auditable facts folded away under
// "Technical details" so the panel reads calm first and forensic second.
//
// Everything raw comes from the snapshot the renderer already has; only the
// plain-language summary costs a call (window.flyt.investigateNode), and
// its absence degrades to the raw facts rather than an error.

// The engine's rejection carries the whole reason; the IPC wrapper around it
// ("Error invoking remote method …") is noise. Same strip App applies.
const ipcMessage = err => String(err?.message ?? err)
  .replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');

// Node types that resolve a model, i.e. the ones a retry can re-point (D39).
// Mirrors WORKER_NODE_TYPES in core/flowRunner.js — duplicated rather than
// imported, the same way runProgress duplicates TERMINAL_STAGES: that module
// reaches node:fs through its adapter imports and this one is the renderer.
const MODEL_TYPES = new Set(['aiStep', 'agentTask', 'orchestrator', 'fanout']);

// One resolver for every shape a focusable thing comes in: a flow node, a
// run-time-spawned task (no flow node of its own), or a legacy stage id from
// runs recorded before flow.json.
function resolveFocusNode(snapshot, nodeId) {
  if (!snapshot) return null;
  const flowNode = snapshot.flow?.nodes?.find(n => n.id === nodeId) ?? null;
  if (flowNode) {
    const retro = snapshot.retrospectives?.[nodeId] ?? null;
    return {
      flowBacked: true,
      modelBacked: MODEL_TYPES.has(flowNode.type),
      // What it actually ran on beats what it was configured with: the resolved
      // model is the one the user watched fail.
      worker: retro?.model ?? flowNode.data?.worker ?? null,
      title: nodeLabel(flowNode),
      icon: flowNode.data?.icon ?? TYPE_META[flowNode.type]?.icon ?? '▢',
      sub: `${TYPE_META[flowNode.type]?.label.toLowerCase() ?? flowNode.type} · ${flowNode.kind}`,
      status: snapshot.meta?.nodeStatus?.[nodeId] ?? 'pending',
      text: nodeOutputText(snapshot, nodeId),
      retro
    };
  }
  const task = snapshot.tasks?.tasks?.find(t => t.id === nodeId);
  if (task) {
    return {
      flowBacked: false, // engine restarts/branches flow nodes, not bare tasks
      modelBacked: false,
      worker: task.worker ?? null,
      title: task.title || task.id,
      icon: TYPE_META.agentTask?.icon ?? '⚙',
      sub: `spawned task · ${task.worker?.provider}/${task.worker?.model}`,
      status: taskNodeStatus(task.status),
      text: snapshot.taskOutputs?.[task.id] ?? '',
      retro: snapshot.retrospectives?.[`executor-${task.id}`] ?? null
    };
  }
  const legacy = {
    prompt: { title: 'Prompt', icon: '✎', text: snapshot.prompt ?? '' },
    planner: { title: 'Planning', icon: '▤', text: snapshot.plan ?? '' },
    router: { title: 'Routing', icon: '⇄', text: '' },
    execution: { title: 'Execution', icon: '⚙', text: '' },
    verifier: { title: 'Verification', icon: '⚖', text: '' }
  }[nodeId];
  if (legacy) {
    return {
      flowBacked: false,
      modelBacked: false,
      worker: null,
      ...legacy,
      sub: `run stage · ${nodeId}`,
      status: null,
      retro: snapshot.retrospectives?.[nodeId] ?? null
    };
  }
  return null;
}

// The facts grid: every row optional, rendered only when the data exists.
function factsOf(retro, invModel) {
  const model = retro?.model ?? invModel ?? null;
  const usage = retro?.usage ?? null;
  const tin = usage?.input_tokens ?? usage?.inputTokens ?? usage?.prompt_tokens ?? null;
  const tout = usage?.output_tokens ?? usage?.outputTokens ?? usage?.completion_tokens ?? null;
  return [
    model ? ['Model', `${model.provider}/${model.model}`] : null,
    tin != null || tout != null ? ['Tokens', `${tin ?? '?'} in · ${tout ?? '?'} out`] : null,
    retro?.durationMs != null ? ['Duration', `${(retro.durationMs / 1000).toFixed(1)}s`] : null,
    retro?.toolCalls?.length ? ['Tool calls', String(retro.toolCalls.length)] : null,
    retro?.status ? ['Verdict', retro.status + (retro.confidence != null ? ` · ${Math.round(retro.confidence * 100)}% confident` : '')] : null,
    retro?.at ? ['Recorded', new Date(retro.at).toLocaleTimeString()] : null
  ].filter(Boolean);
}

export default function NodeFocus({
  snapshot, nodeId, projectId, runId, live, activeModels,
  onClose, onRestart, onBranch, onOpenFolder
}) {
  const info = useMemo(() => resolveFocusNode(snapshot, nodeId), [snapshot, nodeId]);
  const status = info?.status ?? null;

  // The investigate call's result, kept until the node's status moves on —
  // a stale summary about a state the node has left is worse than none.
  const [inv, setInv] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { setInv(null); setLoading(false); }, [nodeId, runId]);
  useEffect(() => { setInv(null); }, [status]);

  // Esc closes the panel, same reflex as the menu that opened it.
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Live elapsed for the header while the node is working (1s tick, stamped
  // when the panel first sees it active — the canvas card keeps its own).
  const [now, setNow] = useState(() => Date.now());
  const activeSince = useRef(null);
  useEffect(() => {
    if (status !== 'active') { activeSince.current = null; return; }
    activeSince.current ??= Date.now();
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  // The token stream pins itself to the newest text unless the user scrolls
  // up to read — the same 24px stick-to-tail rule as the live panel.
  const bodyRef = useRef(null);
  const stick = useRef(true);
  useEffect(() => { stick.current = true; }, [nodeId]);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [info?.text]);
  const onScroll = () => {
    const el = bodyRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const explain = async () => {
    if (loading || !window.flyt?.investigateNode) return;
    setLoading(true);
    try {
      setInv(await window.flyt.investigateNode(projectId, runId, nodeId));
    } catch (err) {
      setInv({ failed: ipcMessage(err) });
    } finally {
      setLoading(false);
    }
  };

  const [copied, setCopied] = useState(false);
  const copyOutput = async () => {
    if (!info?.text) return;
    try {
      await navigator.clipboard.writeText(info.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked — the pre is selectable */ }
  };

  if (!info) {
    return (
      <aside className="node-focus" aria-label="Node focus">
        <div className="inspector-header">
          <span className="node-icon">▢</span>
          <div className="inspector-title">
            <h2>{nodeId}</h2>
            <div className="node-sub">not part of this run</div>
          </div>
          <button className="focus-close" onClick={onClose} aria-label="Close node focus">✕</button>
        </div>
      </aside>
    );
  }

  const retro = inv?.retro ?? info.retro;
  const facts = factsOf(retro, inv?.model ?? null);
  const controlTitle = live
    ? 'Stop the run first'
    : !info.flowBacked ? 'Only flow nodes can be restarted or branched' : undefined;
  // The thrown error, verbatim — see nodeFeedData.failureText for why it is
  // shown rather than counted.
  const errorText = status === 'failed'
    ? ((retro?.problems ?? []).filter(Boolean).join('\n').trim() || null)
    : null;

  return (
    <aside className="node-focus" aria-label={`Node focus — ${info.title}`}>
      <div className="inspector-header">
        <span className="node-icon">{info.icon}</span>
        <div className="inspector-title">
          <h2>{info.title}</h2>
          <div className="node-sub">{info.sub}</div>
        </div>
        {status === 'active' && activeSince.current != null && (
          <span className="focus-elapsed mono" title="Elapsed on this node">
            {formatElapsed(Math.max(0, now - activeSince.current))}
          </span>
        )}
        {statusPill(status)}
        <button className="focus-close" onClick={onClose} aria-label="Close node focus" title="Close (Esc)">✕</button>
      </div>

      <div className="node-focus-body">
        <section>
          <h3>Summary</h3>
          {loading ? (
            <div className="focus-shimmer" aria-label="Summarizing…" />
          ) : inv?.summary ? (
            <>
              <p className="focus-summary">{inv.summary}</p>
              <div className="focus-actions-inline">
                <button className="link" onClick={explain}>Refresh</button>
              </div>
            </>
          ) : inv?.failed ? (
            <>
              <p className="focus-summary focus-summary-note">{inv.failed}</p>
              <div className="focus-actions-inline">
                <button className="link" onClick={explain}>Try again</button>
              </div>
            </>
          ) : inv?.summaryError === 'no-model' ? (
            <p className="focus-summary focus-summary-note">
              No model configured — showing the raw status below. Add a provider key in Settings for a plain-language read.
            </p>
          ) : (
            <button className="ghost mini" onClick={explain}>
              ◈ Explain this node
            </button>
          )}
        </section>

        {errorText && (
          <section>
            <h3>Why it failed</h3>
            <pre className="focus-error">{errorText}</pre>
          </section>
        )}

        {/* Retry lives above the raw output on purpose: on a failed step the
            question is "how do I get past this", and the answer is a model
            choice, not a scroll through a half-written artifact (D39). */}
        {info.flowBacked && info.modelBacked && (
          <section>
            <h3>Retry</h3>
            <RetryBox
              worker={info.worker}
              activeModels={activeModels}
              disabled={live}
              disabledReason={live ? 'Stop or pause the run before retrying a step.' : null}
              onRetry={(worker, guidance) => onRestart?.(nodeId, guidance, worker)}
              label="Retry step"
            />
          </section>
        )}

        <section>
          <h3>Output</h3>
          <div className="live-body focus-stream" ref={bodyRef} onScroll={onScroll}>
            {info.text
              ? <MarkdownView text={info.text} streaming={status === 'active'} />
              : <span className="live-idle">
                  {status === 'active' ? 'Waiting for the first tokens…' : 'No output recorded for this node.'}
                </span>}
          </div>
        </section>

        {facts.length > 0 && (
          <details className="focus-advanced">
            <summary>Technical details</summary>
            <dl className="focus-facts">
              {facts.map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </React.Fragment>
              ))}
            </dl>
          </details>
        )}

        <div className="focus-actions">
          {/* Nodes that call a model retry through the box above; this covers
              the rest (input, output, sub-flow, loop hand-off). */}
          {!(info.flowBacked && info.modelBacked) && (
            <button
              className="ghost mini"
              disabled={live || !info.flowBacked}
              title={controlTitle ?? 'Restart this node and everything downstream'}
              onClick={() => onRestart?.(nodeId)}
            >↺ Restart</button>
          )}
          <button
            className="ghost mini"
            disabled={live || !info.flowBacked}
            title={controlTitle ?? 'Fork the run from this node'}
            onClick={() => onBranch?.(nodeId)}
          >⑂ Branch</button>
          <button className="ghost mini" onClick={copyOutput} disabled={!info.text} title="Copy this node's output">
            {copied ? 'Copied ✓' : 'Copy output'}
          </button>
          <button className="ghost mini" onClick={onOpenFolder} title="Open this run's folder">
            Open run folder
          </button>
        </div>
      </div>
    </aside>
  );
}

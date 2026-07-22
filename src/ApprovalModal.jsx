// The approval gate as a blocking dialog (CHAT-RUN rework). The old inline bar
// was easy to scroll past while the workflow sat parked; the gate now owns the
// surface — a large centered card that says exactly what is being asked, how
// risky the classifier thinks it is, and that nothing moves until a decision.
// "Review first" minimizes to the slim inline bar (the same gate, smaller) so
// the plan/work can be inspected before deciding; the bar offers a way back.
import React, { useEffect, useRef } from 'react';

export function gateCopy(meta) {
  const tool = meta?.pendingGateKind === 'tool' ? meta?.pendingToolCall : null;
  if (tool) {
    return {
      kind: 'tool',
      tool,
      danger: tool.risk === 'danger',
      title: tool.risk === 'danger' ? 'Dangerous tool call needs approval' : 'Tool call needs approval',
      body: (
        <>
          This node wants to run <span className="mono">{tool.tool}</span>
          {tool.summary ? <> on <span className="mono">{tool.summary}</span></> : null}.
        </>
      )
    };
  }
  return {
    kind: 'plan',
    tool: null,
    danger: false,
    title: 'Approval needed to continue',
    body: 'Review the work so far, then approve to continue or reject to stop the run.'
  };
}

export default function ApprovalModal({ meta, runName, onApprove, onReject, onMinimize }) {
  const { danger, title, body, tool } = gateCopy(meta);
  const approveRef = useRef(null);

  // Focus lands on a real button so keyboard users aren't stranded on the
  // backdrop. Danger gates focus Reject — the safe choice is the easy choice.
  const rejectRef = useRef(null);
  useEffect(() => {
    (danger ? rejectRef : approveRef).current?.focus();
  }, [danger]);

  // Esc never decides; it only minimizes to the inline bar. Approve/Reject
  // must be deliberate clicks — a keystroke is not consent for a danger gate.
  const onKeyDown = e => { if (e.key === 'Escape') onMinimize?.(); };

  return (
    <div className="approval-modal-backdrop" onKeyDown={onKeyDown}>
      <div
        className={'approval-modal' + (danger ? ' danger' : '')}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="approval-modal-title"
        aria-describedby="approval-modal-desc"
      >
        <div className="approval-modal-head">
          <span className="approval-modal-glyph" aria-hidden>{danger ? '⚠' : '⏸'}</span>
          <div className="approval-modal-titles">
            <h2 id="approval-modal-title">{title}</h2>
            <p className="approval-modal-sub">
              {runName ? <><span className="approval-modal-run">{runName}</span> · </> : null}
              The workflow is paused — nothing runs until you decide.
            </p>
          </div>
        </div>

        <div className="approval-modal-body" id="approval-modal-desc">
          <p className="approval-modal-ask">{body}</p>
          {tool?.summary && (
            <pre className="approval-modal-cmd mono">{tool.tool}{tool.summary ? ` ${tool.summary}` : ''}</pre>
          )}
          {tool?.reason && (
            <div className={'approval-modal-risk risk-' + (tool.risk ?? 'caution')}>
              <span className="risk-pill">{danger ? '⚠ danger' : '◈ caution'}</span>
              <span>{tool.reason}</span>
            </div>
          )}
          <p className="approval-modal-hint">
            Approve lets it run once; reject aborts {tool ? 'the task' : 'the run'}.
            Review first docks the gate above the composer so you can scroll the flow —
            the run stays parked until you decide there or reopen this dialog.
          </p>
        </div>

        <div className="approval-modal-actions">
          <button type="button" className="link" onClick={onMinimize}>Review first</button>
          <div className="toolbar-spacer" />
          <button ref={rejectRef} type="button" className="reject big" onClick={onReject}>Reject</button>
          <button ref={approveRef} type="button" className="primary big" onClick={onApprove}>
            {danger ? 'Approve anyway' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}

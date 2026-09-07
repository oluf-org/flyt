import React, { useEffect, useRef } from 'react';
import ComposerMenu, { MenuOption } from './ComposerMenu.jsx';
import { GoalAuthoringProgress, GoalAuthoringDiagnostics } from './GoalAuthoringProgress.jsx';

const glyph = path => <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">{path}</svg>;
const SendIcon = () => glyph(<path d="M2.6 8h9.4M8.2 4.2 12 8l-3.8 3.8"/>);
const ScopeIcon = glyph(<><circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="1.7"/></>);
const FileIcon = glyph(<><path d="M9 2H4.6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V5.4z"/><path d="M9 2v3.4h3.4"/></>);
const ModelIcon = glyph(<path d="M8 2.4 9.4 6.6 13.6 8 9.4 9.4 8 13.6 6.6 9.4 2.4 8 6.6 6.6z"/>);
const TOOL_NAMES = { read_project_file: 'Read project file', inspect_block: 'Inspect block', validate_proposal: 'Validate proposal', validate_response: 'Validate response' };
const fileLines = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

export default function ChangeRequestDialog({ open, onClose, composer, onComposer, quotes, onRemoveQuote, onInspect, requests, proposals, onSend, onCancel, models, worker, setWorker, sending, usage,
  scope, onScope, steps, selectedFiles, onSelectedFiles }) {
  const ref = useRef(null), composerRef = useRef(null), trigger = useRef(null);
  const historyRef = useRef(null), followTail = useRef(true);
  useEffect(() => {
    if (open && !ref.current.open) { trigger.current = document.activeElement; ref.current.showModal(); composerRef.current.focus(); }
    if (!open && ref.current.open) { ref.current.close(); trigger.current?.isConnected && trigger.current.focus(); }
  }, [open]);
  useEffect(() => { if (open) followTail.current = true; }, [open]);
  useEffect(() => {
    if (open && followTail.current && historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight;
  }, [open, requests]);

  const stepTitle = address => steps.find(step => step.address === address)?.title ?? address.split('/').at(-1);
  // A scope of "the whole loop" is what a request has when nobody narrowed it,
  // so saying so under every message is a column of the same word. Only a
  // narrowed scope, and the files it was given, are worth a line in the log.
  const noteFor = request => [
    request.scope?.type === 'step' ? stepTitle(request.scope.address)
      : request.scope?.type === 'fields' || request.quotes?.length ? 'Selected fields' : null,
    ...(request.selectedFiles ?? []),
  ].filter(Boolean);

  const files = fileLines(selectedFiles);
  const groups = [...new Set(steps.map(step => step.group))];
  const looseFields = scope.type === 'fields' && !quotes.length;
  const scopeValue = scope.type === 'step' ? stepTitle(scope.address) : scope.type === 'fields' ? 'Selected fields' : 'Entire loop';

  // With the panel gone there is no edge to be inside of, so the empty space
  // around the title reads as outside and now behaves that way. Nothing is lost
  // by closing: the composer's text lives in the page, not in this dialog.
  return <dialog ref={ref} className="goal-chat" aria-labelledby="goal-chat-title"
    onMouseDown={event => { if (event.target === ref.current) onClose(); }}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
    {/* What this conversation has cost belongs to the whole conversation, not to
        the next message, so it sits by the title and leaves the composer to the
        controls that change what gets sent. */}
    <header><h2 id="goal-chat-title">Design your <span>loop</span></h2>{usage && <small>{usage}</small>}
      <button type="button" aria-label="Close change request" onClick={onClose}>×</button></header>

    {requests.length > 0 && <div className="goal-chat-history" role="log" aria-live="polite" ref={historyRef} onScroll={event => {
      const element = event.currentTarget; followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    }}>
      {requests.map(request => {
        const proposal = proposals.find(item => item.id === request.proposalId), note = noteFor(request);
        return <article key={request.id}>
          <p className="goal-chat-user">{request.text}</p>
          {note.length > 0 && <p className="goal-chat-meta">{note.map((item, index) => <span key={index}>{item}</span>)}</p>}
          {(request.toolCalls ?? []).map((tool, index) => <details className="goal-chat-tool" key={index}><summary>{TOOL_NAMES[tool.name] || tool.name} · {tool.ok ? 'Complete' : 'Needs correction'}</summary>{tool.arguments && <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>}{tool.error ? <p>{tool.error}</p> : <pre>{JSON.stringify(tool.result, null, 2)}</pre>}</details>)}
          {request.status === 'working' ? <p className="goal-chat-working"><GoalAuthoringProgress request={request}/> <button type="button" onClick={() => onCancel(request.id)}>Cancel</button></p>
            : request.error ? <p className="goal-error">{request.error}</p>
              : <>{(request.response?.text || proposal?.rationale) && <p>{request.response?.type === 'question' && <strong>Question: </strong>}{request.response?.text || proposal.rationale}</p>}{request.response?.validation && <p className="goal-chat-note">Draft validation passed · Not executed{request.response.validation.readinessError && ` · Before starting: ${request.response.validation.readinessError}`}</p>}{proposal && <button type="button" className="goal-chat-link" onClick={() => onInspect(proposal.diff[0]?.address ?? null)}>Review changes · {proposal.status}</button>}</>}
          <GoalAuthoringDiagnostics request={request}/>
        </article>;
      })}
    </div>}

    <form onSubmit={event => { event.preventDefault(); onSend(); }}>
      <div className="goal-composer">
        {/* Quoted fields are part of the message, so they travel with it rather
            than sitting in a strip of their own above the box. */}
        {quotes.length > 0 && <div className="goal-chat-quotes">{quotes.map((quote, index) => <span key={quote.address}>
          <button type="button" onClick={() => onInspect(quote.address)}>{quote.address.split('/').at(-1)}{quote.range ? ' · selection' : ''}</button>
          <button type="button" aria-label={`Remove quote ${index + 1}`} onClick={() => onRemoveQuote(index)}>×</button>
        </span>)}</div>}

        <label className="goal-sr-only" htmlFor="goal-change-composer">Change request message</label>
        <textarea id="goal-change-composer" ref={composerRef} value={composer} onChange={event => onComposer(event.target.value)} rows={3} placeholder="Describe a change, or ask a question…" maxLength={8000}/>

        <div className="goal-composer-foot">
          <ComposerMenu label="Edit scope" value={scopeValue} icon={ScopeIcon} tone={looseFields ? 'warn' : ''} disabled={sending}>
            {close => <>
              <ul>
                <MenuOption current={scope.type === 'loop'} onClick={() => { onScope({ type: 'loop' }); close(); }}>Entire loop</MenuOption>
                <MenuOption current={scope.type === 'fields'} disabled={!quotes.length} note={quotes.length ? null : 'none selected'}
                  onClick={() => { onScope({ type: 'fields' }); close(); }}>Selected fields</MenuOption>
              </ul>
              {groups.map(group => <React.Fragment key={group}>
                <p className="goal-menu-group">{group}</p>
                <ul>{steps.filter(step => step.group === group).map(step => <MenuOption key={step.address} current={scope.type === 'step' && scope.address === step.address}
                  onClick={() => { onScope({ type: 'step', address: step.address }); close(); }}>{step.title}</MenuOption>)}</ul>
              </React.Fragment>)}
            </>}
          </ComposerMenu>

          <ComposerMenu label="Project files" value={files.length ? `${files.length} file${files.length > 1 ? 's' : ''}` : 'Files'} icon={FileIcon} disabled={sending}>
            {() => <>
              <textarea className="goal-menu-input" aria-label="Project files for context" rows={4} maxLength={8000} value={selectedFiles}
                onChange={event => onSelectedFiles(event.target.value)} placeholder={'README.md\nsrc/example.js'}/>
              <small>One path per line, up to 8. Read-only, for this request.</small>
            </>}
          </ComposerMenu>

          <ComposerMenu label="Authoring model" value={worker || 'Model'} icon={ModelIcon} className="push" disabled={sending}>
            {close => models.length
              ? <ul>{models.map(model => <MenuOption key={model.id} current={worker === model.id}
                onClick={() => { setWorker(model.id); close(); }}>{model.id}</MenuOption>)}</ul>
              : <p className="goal-menu-empty">No models are enabled for this project.</p>}
          </ComposerMenu>
          <button className="goal-send" aria-label="Send message" disabled={sending || !composer.trim() || !worker || looseFields || (scope.type === 'step' && !steps.some(step => step.address === scope.address))} type="submit"><SendIcon/></button>
        </div>
      </div>
      {looseFields && <p className="goal-composer-warn">Select a field in the inspector, or change the scope.</p>}
    </form>
  </dialog>;
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// YAML viewer + manual editor for the current flow.
// - Shows the canonical *.flow.yaml text (structure only; positions live in the sidecar).
// - Edits are local until "Apply" which parses + persists via the backend and reloads the model.
// - Live lint (same rules as the badge) is shown below the editor.
// - "Refresh" pulls the latest from the in-memory flow object (what the canvas would save).

/* ---------- lightweight YAML syntax highlighter ----------
   Line-based, deliberately forgiving. This is a viewer aid, not a parser:
   it colours keys, scalars, comments and punctuation and never throws. The
   markup it emits is layered *behind* a transparent <textarea> whose metrics
   match exactly, so the caret and selection stay pixel-aligned with the tokens. */

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function highlightValue(raw) {
  // Peel a trailing "  # comment" (only when the # is preceded by whitespace,
  // so URLs / anchors like http://x#y stay intact).
  let comment = '';
  let val = raw;
  const cm = raw.match(/(\s+#.*)$/);
  if (cm) {
    comment = cm[1];
    val = raw.slice(0, raw.length - cm[1].length);
  }
  const lead = val.match(/^\s*/)[0];
  const core = val.slice(lead.length);

  let coreHtml;
  if (core === '') {
    coreHtml = '';
  } else if (/^(["']).*\1$/.test(core)) {
    coreHtml = `<span class="tok-string">${escapeHtml(core)}</span>`;
  } else if (/^-?\d+(\.\d+)?$/.test(core)) {
    coreHtml = `<span class="tok-num">${escapeHtml(core)}</span>`;
  } else if (/^(true|false|null|yes|no|on|off|~)$/i.test(core)) {
    coreHtml = `<span class="tok-bool">${escapeHtml(core)}</span>`;
  } else if (/^[|>][+-]?$/.test(core)) {
    coreHtml = `<span class="tok-punct">${escapeHtml(core)}</span>`;
  } else if (core.startsWith('&') || core.startsWith('*')) {
    coreHtml = `<span class="tok-anchor">${escapeHtml(core)}</span>`;
  } else {
    coreHtml = escapeHtml(core);
  }

  return (
    escapeHtml(lead) +
    coreHtml +
    (comment ? `<span class="tok-comment">${escapeHtml(comment)}</span>` : '')
  );
}

function highlightLine(line) {
  // Full-line comment (possibly indented).
  const commentOnly = line.match(/^(\s*)(#.*)$/);
  if (commentOnly) {
    return (
      escapeHtml(commentOnly[1]) +
      `<span class="tok-comment">${escapeHtml(commentOnly[2])}</span>`
    );
  }

  let out = '';
  let rest = line;

  const lead = rest.match(/^\s*/)[0];
  out += escapeHtml(lead);
  rest = rest.slice(lead.length);

  // One or more list dashes: "- ", "- - ", etc.
  const dash = rest.match(/^((?:- )+)/);
  if (dash) {
    out += `<span class="tok-punct">${escapeHtml(dash[1])}</span>`;
    rest = rest.slice(dash[1].length);
  }

  // key: value
  const kv = rest.match(/^([\w.\-/]+)(:)(\s|$)/);
  if (kv) {
    out += `<span class="tok-key">${escapeHtml(kv[1])}</span>`;
    out += `<span class="tok-colon">:</span>`;
    rest = rest.slice(kv[1].length + 1); // keep the whitespace that follows ':'
    return out + highlightValue(rest);
  }

  return out + highlightValue(rest);
}

function highlightYaml(text) {
  return text.split('\n').map(highlightLine).join('\n');
}

export default function FlowYamlEditor({ flow, onApplied, onLint, embedded = false }) {
  const [text, setText] = useState('');
  const [lint, setLint] = useState(null); // { ok, errors, warnings, findings }
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const debounceRef = useRef(null);
  const taRef = useRef(null);
  const highlightRef = useRef(null);
  const gutterRef = useRef(null);

  // (Re)initialize editor text whenever the flow object identity or id changes.
  // We derive the YAML by asking main to serialize the live model (deterministic).
  const refreshFromFlow = useCallback(async (f = flow) => {
    if (!f) { setText(''); setLint(null); setDirty(false); return; }
    try {
      const y = await window.llmflow.getFlowYaml(f);
      setText(y);
      setDirty(false);
      runLint(y);
    } catch (e) {
      setText(`# Error producing YAML\n# ${e?.message || e}`);
      setLint({ ok: false, errors: [{ rule: 'serialize', message: String(e?.message || e) }], warnings: [], findings: [] });
    }
  }, [flow]);

  const loadFromDisk = async () => {
    if (!flow?.id || busy) return;
    setBusy(true);
    try {
      const y = await window.llmflow.loadFlowSource(flow.id);
      setText(y);
      setDirty(true); // user may want to keep or tweak the disk version
      runLint(y);
    } catch (e) {
      alert('Could not load source from disk: ' + (e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  // Auto-sync from live flow model into the editor when:
  // - switching flows, or
  // - while viewing YAML, the canvas/inspector made changes AND the user has no unapplied edits.
  useEffect(() => {
    if (flow && !dirty) {
      refreshFromFlow(flow);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, dirty]);

  async function runLint(yaml) {
    if (!yaml || typeof yaml !== 'string') { setLint(null); return; }
    try {
      const res = await window.llmflow.lintFlowYaml(yaml);
      setLint(res);
      if (onLint) onLint(res);
    } catch (e) {
      const err = { rule: 'lint', message: String(e?.message || e) };
      setLint({ ok: false, errors: [err], warnings: [], findings: [err] });
    }
  }

  const onTextChange = (e) => {
    const v = e.target.value;
    setText(v);
    setDirty(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runLint(v);
    }, 350);
  };

  const apply = async () => {
    if (!flow?.id || busy) return;
    setBusy(true);
    try {
      await window.llmflow.saveFlowFromYaml(flow.id, text);
      setDirty(false);
      // After a successful save-from-yaml the model on disk changed.
      // Ask the parent to reload the canonical flow object so canvas + inspector update.
      if (onApplied) await onApplied();
      // Re-sync the editor text from the (now possibly normalized) saved form.
      await refreshFromFlow();
    } catch (e) {
      const msg = e?.message || String(e);
      alert('Failed to apply YAML:\n' + msg);
      // leave dirty so user can fix
    } finally {
      setBusy(false);
    }
  };

  const revert = () => {
    refreshFromFlow(flow);
  };

  const format = async () => {
    // We don't have the serializer in the renderer, so a "reformat" means
    // round-tripping through the backend save (which normalizes). Non-mutating
    // when already clean.
    if (!dirty) {
      await refreshFromFlow();
      return;
    }
    if (confirm('Re-format will apply the current text (normalizing it) then refresh. Continue?')) {
      await apply();
    }
  };

  // Keyboard niceties inside the editor area
  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (dirty && !busy) apply();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      if (!busy) revert();
    }
    // Tab inserts two spaces instead of moving focus out of the editor.
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = text.slice(0, start) + '  ' + text.slice(end);
      setText(next);
      setDirty(true);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => runLint(next), 350);
    }
  };

  // Keep the highlight layer + gutter scrolled in lockstep with the textarea.
  const syncScroll = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = ta.scrollTop;
      highlightRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = ta.scrollTop;
    }
  };

  const highlighted = useMemo(() => highlightYaml(text || ''), [text]);
  const lineCount = useMemo(() => (text ? text.split('\n').length : 1), [text]);

  const findings = lint?.findings ?? [];
  const errCount = lint?.errors?.length ?? 0;
  const warnCount = lint?.warnings?.length ?? 0;
  const okCount = lint && lint.ok && findings.length === 0;

  return (
    <div className={'yaml-editor' + (embedded ? ' embedded' : '')}>
      <div className="yaml-toolbar">
        <span className="yaml-file">
          <span className="yaml-file-dot" aria-hidden />
          <span className="mono">{flow?.id ? `${flow.id}.flow.yaml` : 'flow.yaml'}</span>
        </span>
        {dirty
          ? <span className="dirty-pill">unsaved</span>
          : <span className="clean-pill">in sync</span>}
        <div className="toolbar-spacer" />
        <button className="ghost mini" onClick={revert} disabled={busy || !dirty} title="Reload YAML from the current flow model (Ctrl/Cmd+R)">↺ Refresh</button>
        <button className="ghost mini" onClick={loadFromDisk} disabled={busy} title="Load the exact last-saved .flow.yaml from disk (marks as edited)">Load from disk</button>
        <button className="ghost mini" onClick={format} disabled={busy} title="Normalize formatting (may apply if dirty)">Format</button>
        <button className="primary mini" onClick={apply} disabled={busy || !dirty || !flow} title="Parse, validate, save, and reload the flow (Ctrl/Cmd+S)">
          {busy ? 'Applying…' : 'Apply'}
          {!busy && <kbd className="shortcut">⌘S</kbd>}
        </button>
      </div>

      <div className="code-editor">
        <div className="code-gutter" ref={gutterRef} aria-hidden>
          <div className="code-gutter-inner">
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i} className="code-lineno">{i + 1}</div>
            ))}
          </div>
        </div>
        <div className="code-body">
          <pre className="code-highlight" ref={highlightRef} aria-hidden>
            <code dangerouslySetInnerHTML={{ __html: highlighted }} />
          </pre>
          <textarea
            ref={taRef}
            className="code-input mono"
            value={text}
            onChange={onTextChange}
            onKeyDown={onKeyDown}
            onScroll={syncScroll}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="# Flow YAML will appear here"
          />
        </div>
      </div>

      <div className="yaml-status">
        <div className="yaml-status-row">
          {lint ? (
            okCount ? (
              <span className="lint-badge ok">✓ Valid — matches schema &amp; rules</span>
            ) : (
              <span className={'lint-badge ' + (errCount > 0 ? 'error' : 'warn')}>
                {errCount > 0 ? `✕ ${errCount} error${errCount === 1 ? '' : 's'}` : ''}
                {errCount > 0 && warnCount > 0 ? '  ·  ' : ''}
                {warnCount > 0 ? `⚠ ${warnCount} warning${warnCount === 1 ? '' : 's'}` : ''}
              </span>
            )
          ) : (
            <span className="muted">Linting…</span>
          )}
          <span className="yaml-meta muted">{lineCount} line{lineCount === 1 ? '' : 's'}</span>
        </div>

        {findings.length > 0 && (
          <div className="lint-findings">
            {findings.slice(0, 12).map((f, i) => (
              <div key={i} className={'finding ' + (f.severity === 'warning' ? 'warn' : 'err')}>
                <span className="finding-dot" aria-hidden />
                <span className="finding-rule mono">{f.rule}</span>
                {f.nodeId ? <span className="finding-node mono">{f.nodeId}</span> : null}
                <span className="finding-msg">{f.message}</span>
              </div>
            ))}
            {findings.length > 12 && <div className="muted finding-more">… +{findings.length - 12} more</div>}
          </div>
        )}
      </div>

      {!embedded && (
        <div className="yaml-footer muted">
          The text here is the exact <code>.flow.yaml</code> (layout lives in a sidecar). Apply to update the canvas —
          or edit <code>flows/*.flow.yaml</code> on disk and the next load picks it up.
        </div>
      )}
    </div>
  );
}

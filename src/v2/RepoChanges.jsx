import React, { useEffect, useState } from 'react';

export default function RepoChanges({ projectId, runId, running }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true, timer;
    setReport(null); setError('');
    if (!projectId || !runId || !window.flyt?.getRepoChanges) {
      setReport({ available: false, files: [] });
      return;
    }
    const read = async () => {
      try {
        const value = await window.flyt.getRepoChanges(projectId, runId);
        if (active) { setReport(value); setError(''); }
      } catch (err) { if (active) setError(err.message); }
      if (active && running) timer = setTimeout(read, 3_000);
    };
    read();
    return () => { active = false; clearTimeout(timer); };
  }, [projectId, runId, running, refresh]);
  if (!runId) return null;
  const files = report?.files ?? [];
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const deleted = files.reduce((sum, file) => sum + (file.deleted ?? 0), 0);
  const incomplete = report?.partial || files.some(file => file.added == null || file.deleted == null);
  const open = async file => {
    setOpening(file.path); setError('');
    try { await window.flyt.openChangedFile(projectId, runId, file.path); }
    catch (err) { setError(`Could not open ${file.path}: ${err.message}`); }
    finally { setOpening(null); }
  };
  return <details className="work-repo-changes" open>
    <summary><strong>Repository changes</strong><span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>
      {files.length > 0 && <span className="repo-line-counts"><span className="repo-added">+{added}</span> <span className="repo-deleted">−{deleted}</span>{incomplete ? ' (known lines)' : ''}</span>}
    </summary>
    <div className="repo-changes-body">
      <div className="repo-changes-note"><p>Files changed during tool execution. Line counts include successive edits. Click a file to open it in its default program.</p>
        <button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh</button></div>
      {error && <p className="work-error" role="alert">{error}</p>}
      {!report && !error && <p className="muted">Loading changes…</p>}
      {report && !report.available && <p className="muted">File changes were not recorded for this older run.</p>}
      {report?.available && !files.length && <p className="muted">{running ? 'No repository changes recorded yet.' : 'No repository changes recorded.'}</p>}
      {files.length > 0 && <ul className="repo-file-list">{files.map(file => {
        const removed = file.status === 'deleted' || file.status === 'created then deleted';
        return <li key={file.path}>
          <span className={`repo-file-status repo-status-${file.status.split(' ')[0]}`}>{file.status}</span>
          <button type="button" className="repo-file-link" disabled={removed || opening === file.path}
            title={removed ? 'This file was deleted' : `Open ${file.path} in its default program`}
            onClick={() => open(file)}>{file.path}{!removed && <span aria-hidden="true"> ↗</span>}</button>
          <span className="repo-line-counts">{file.binary ? 'Binary' : file.added == null || file.deleted == null ? 'Line counts unavailable' : <><span className="repo-added">+{file.added}</span> <span className="repo-deleted">−{file.deleted}</span></>}</span>
        </li>;
      })}</ul>}
      {report?.partial && <p className="muted">Partial tracking: some files could not be read or exceeded scan limits. Dependencies, build output, ignored files, and Flyt run data are excluded.</p>}
      {report?.available && <p className="repo-changes-footnote">Changes made by other programs during a tool call may also appear.</p>}
    </div>
  </details>;
}

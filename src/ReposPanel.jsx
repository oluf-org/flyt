import React, { useCallback, useEffect, useState } from 'react';

// Repositories (D36 P1.6). Two things you might want to do with someone else's
// code, and they are genuinely different, so they are two actions rather than
// one with a checkbox:
//
//   Read it   — a shallow, pinned, READ-ONLY clone in the reference library.
//               Greppable by any node that holds `search_references`, citable
//               by file and line, and impossible to modify because there is no
//               write path to it.
//   Work on it — a full clone in a folder you choose, opened as a project tab.
//               Agents can edit it, the loop can branch it. The deliberate act.
//
// Nothing here knows about any particular repository: the shipped list is a
// starting point, not the library.

const shortCommit = c => (c ? c.slice(0, 8) : null);

export default function ReposPanel({ onOpenProject = null }) {
  const [repos, setRepos] = useState(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const refresh = useCallback(() => {
    window.flyt.listReferences?.()
      .then(setRepos)
      .catch(e => { setRepos([]); setError(String(e?.message ?? e)); });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const run = async (label, fn) => {
    setBusy(label); setError(''); setNote('');
    try { return await fn(); }
    catch (e) { setError(String(e?.message ?? e)); return null; }
    finally { setBusy(''); refresh(); }
  };

  const addReference = () => run('add', async () => {
    const r = await window.flyt.addReference({ url: url.trim() });
    setUrl('');
    setNote(r?.refreshed
      ? `${r.name} was already in the library — refreshed to ${shortCommit(r.commit)}.`
      : `Cloned ${r.name} at ${shortCommit(r.commit)}. Nodes with search_references can read it now.`);
  });

  const cloneToWorkOn = () => run('clone', async () => {
    const parentDir = await window.flyt.pickProjectFolder?.();
    if (!parentDir) return;
    const r = await window.flyt.cloneRepo({ url: url.trim(), parentDir });
    setUrl('');
    setNote(`Cloned into ${r.folder} and opened it as a project.`);
    if (r?.id && onOpenProject) onOpenProject(r.folder);
  });

  const canAct = Boolean(url.trim()) && !busy;

  return (
    <>
      <section>
        <div className="settings-section-head">
          <span className="section-label">Add a repository</span>
        </div>
        <p className="settings-hint">
          Paste any git URL — https://, ssh://, or <code className="mono">git@host:owner/repo</code>.
          Then choose what you mean to do with it.
        </p>
        <div className="settings-row">
          <input
            type="text"
            value={url}
            placeholder="https://github.com/owner/repo"
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && canAct) addReference(); }}
            aria-label="Repository URL"
          />
        </div>
        <div className="settings-row repo-actions">
          <button className="primary" disabled={!canAct} onClick={addReference}>
            {busy === 'add' ? 'Cloning…' : 'Read it'}
          </button>
          <button disabled={!canAct} onClick={cloneToWorkOn}>
            {busy === 'clone' ? 'Cloning…' : 'Work on it…'}
          </button>
        </div>
        <p className="settings-hint">
          <strong>Read it</strong> takes a shallow, pinned, read-only copy into the reference
          library — for analysing, comparing, or learning from. <strong>Work on it</strong> makes a
          full clone in a folder you pick and opens it as a project, so runs can change it.
        </p>
        {note && <div className="settings-note">{note}</div>}
        {error && <div className="settings-error mono">{error}</div>}
      </section>

      <section>
        <div className="settings-section-head">
          <span className="section-label">Reference library</span>
          {repos?.length > 0 && (
            <span className="status-pill pill-neutral">{repos.filter(r => r.cloned).length}/{repos.length} cloned</span>
          )}
        </div>
        <p className="settings-hint">
          Read-only clones any node holding <code className="mono">search_references</code> can grep,
          and <code className="mono">read_file</code> can open as{' '}
          <code className="mono">reference:&lt;name&gt;/&lt;path&gt;</code>.
        </p>
        {repos === null && <div className="muted">Loading…</div>}
        {repos?.length === 0 && <div className="muted">Nothing in the library yet.</div>}
        {repos?.map(r => (
          <div className={'repo-row' + (r.cloned ? '' : ' off')} key={r.name}>
            <div className="repo-row-main">
              <span className="repo-name mono">{r.name}</span>
              {r.adopted
                ? <span className="status-pill pill-neutral">added here</span>
                : <span className="status-pill pill-neutral">shipped</span>}
              {r.cloned
                ? <span className="repo-commit mono" title={`Pinned at ${r.commit}`}>{shortCommit(r.commit)}</span>
                : <span className="status-pill pill-err">not cloned</span>}
            </div>
            {r.about && <p className="repo-about">{r.about}</p>}
            <div className="repo-row-actions">
              <span className="repo-url mono" title={r.url}>{r.url}</span>
              <button
                className="ghost mini"
                disabled={Boolean(busy)}
                onClick={() => run(`update:${r.name}`, () => window.flyt.updateReference(r.name))}
                title="Fetch the latest commit and re-pin"
              >{busy === `update:${r.name}` ? 'Updating…' : r.cloned ? 'Update' : 'Clone'}</button>
              <button
                className="link"
                disabled={Boolean(busy)}
                onClick={() => run(`remove:${r.name}`, () => window.flyt.removeReference(r.name))}
                title={r.adopted ? 'Remove it from the library and delete the clone' : 'Delete the clone (it stays in your config)'}
                aria-label={`Remove ${r.name}`}
              >✕</button>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

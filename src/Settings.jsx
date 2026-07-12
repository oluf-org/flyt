import React, { useEffect, useMemo, useState } from 'react';

// Settings panel: OpenRouter API key + per-node worker assignment.
// The renderer never sees the stored key — only a hasKey flag comes back
// over IPC, and saving sends the key one way into the main process.
const WORKER_NODES = ['planner', 'router', 'executor', 'verifier'];
const WORKER_HINTS = {
  planner: 'Writes the plan',
  router: 'Splits plan into tasks',
  executor: 'Runs each task',
  verifier: 'Checks the outputs'
};
const MOCK_MODELS = ['mock-large', 'mock-small'];

export default function Settings({ onClose }) {
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [workers, setWorkers] = useState(null);
  const [workersSaved, setWorkersSaved] = useState(false);
  const [models, setModels] = useState([]);
  const [fetching, setFetching] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    window.llmflow.getSettings().then(s => {
      setHasKey(s.hasKey);
      setWorkers(s.workers);
    });
  }, []);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [models, search]);

  const saveKey = async () => {
    if (!keyInput.trim()) return;
    setError('');
    try {
      const s = await window.llmflow.setSettings({ openrouterApiKey: keyInput });
      setHasKey(s.hasKey);
      setKeyInput('');
      setKeySaved(true);
      setTimeout(() => setKeySaved(false), 2000);
    } catch (err) {
      setError(String(err.message ?? err));
    }
  };

  const fetchModels = async () => {
    setFetching(true);
    setError('');
    try {
      setModels(await window.llmflow.listModels());
    } catch (err) {
      setError(String(err.message ?? err));
    } finally {
      setFetching(false);
    }
  };

  const setWorker = (node, patch) => {
    setWorkers(w => {
      const cur = { ...w[node], ...patch };
      if (patch.provider === 'mock' && !MOCK_MODELS.includes(cur.model)) cur.model = MOCK_MODELS[0];
      if (patch.provider === 'openrouter' && MOCK_MODELS.includes(cur.model)) cur.model = models[0]?.id ?? '';
      return { ...w, [node]: cur };
    });
  };

  const workersValid = workers && WORKER_NODES.every(n => workers[n]?.model?.trim());

  const saveWorkers = async () => {
    if (!workersValid) return;
    setError('');
    try {
      const s = await window.llmflow.setSettings({ workers });
      setWorkers(s.workers);
      setWorkersSaved(true);
      setTimeout(() => setWorkersSaved(false), 2000);
    } catch (err) {
      setError(String(err.message ?? err));
    }
  };

  return (
    <div className="settings-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-panel" role="dialog" aria-label="Settings">
        <div className="settings-header">
          <span className="node-icon">⚙</span>
          <div className="inspector-title">
            <h2>Settings</h2>
            <div className="node-sub">providers &amp; models</div>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close settings">✕</button>
        </div>

        <div className="settings-body">
          <section>
            <div className="settings-section-head">
              <span className="section-label">OpenRouter API key</span>
              {hasKey && <span className="status-pill">key saved</span>}
            </div>
            <p className="settings-hint">
              Stored locally in the app&rsquo;s user-data folder — never in the project, never shown again.
            </p>
            <div className="settings-row">
              <input
                type="password"
                placeholder={hasKey ? 'Enter a new key to replace the saved one' : 'sk-or-…'}
                value={keyInput}
                onChange={e => setKeyInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveKey(); }}
              />
              <button className="primary" onClick={saveKey} disabled={!keyInput.trim()}>
                {keySaved ? 'Saved ✓' : 'Save key'}
              </button>
            </div>
          </section>

          <section>
            <div className="settings-section-head">
              <span className="section-label">Models</span>
              {models.length > 0 && <span className="status-pill pill-neutral">{models.length} available</span>}
            </div>
            <div className="settings-row">
              <input
                type="search"
                placeholder={models.length ? 'Search models…' : 'Fetch the model list to search it'}
                value={search}
                onChange={e => setSearch(e.target.value)}
                disabled={!models.length}
              />
              <button onClick={fetchModels} disabled={fetching || !hasKey} title={hasKey ? '' : 'Save an API key first'}>
                {fetching ? 'Fetching…' : 'Fetch models'}
              </button>
            </div>
            <datalist id="openrouter-models">
              {filteredModels.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name}{m.contextLength ? ` · ${Math.round(m.contextLength / 1000)}k ctx` : ''}{m.supportsTools ? ' · tools' : ''}
                </option>
              ))}
            </datalist>
          </section>

          <section>
            <div className="settings-section-head">
              <span className="section-label">Workers</span>
            </div>
            <p className="settings-hint">Assign a provider and model to each pipeline node.</p>
            {workers && WORKER_NODES.map(node => (
              <div className="worker-row" key={node}>
                <div className="worker-name">
                  <span className="mono">{node}</span>
                  <span className="worker-hint">{WORKER_HINTS[node]}</span>
                </div>
                <select
                  value={workers[node].provider}
                  onChange={e => setWorker(node, { provider: e.target.value })}
                  aria-label={`${node} provider`}
                >
                  <option value="mock">mock</option>
                  <option value="openrouter">openrouter</option>
                </select>
                {workers[node].provider === 'mock' ? (
                  <select
                    value={workers[node].model}
                    onChange={e => setWorker(node, { model: e.target.value })}
                    aria-label={`${node} model`}
                  >
                    {MOCK_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input
                    list="openrouter-models"
                    placeholder={models.length ? 'Pick or type a model id' : 'e.g. openai/gpt-4o-mini'}
                    value={workers[node].model}
                    onChange={e => setWorker(node, { model: e.target.value })}
                    aria-label={`${node} model`}
                  />
                )}
              </div>
            ))}
            <div className="settings-actions">
              <button className="primary" onClick={saveWorkers} disabled={!workersValid}>
                {workersSaved ? 'Saved ✓' : 'Save workers'}
              </button>
            </div>
          </section>

          {error && <div className="settings-error mono">{error}</div>}
        </div>
      </div>
    </div>
  );
}

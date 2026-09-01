import React from 'react';
import { createRoot } from 'react-dom/client';
import Root from './Root.jsx';
import './styles.css';
// Per-project theming (see src/lib/applyProjectTheme.js): loads after the
// base sheet so its project-scoped token overrides win the cascade.
import './styles/project-theme.css';

const errorDetails = error => ({
  name: error?.name ?? 'Error', message: error?.message ?? String(error ?? 'Unknown renderer error'),
  stack: error?.stack ?? null, href: window.location.href,
});

function FatalRenderer({ error, startup = false }) {
  return <main className="fatal-renderer" role="alert">
    <p className="section-label">{startup ? 'STARTUP ERROR' : 'THE WORKFLOW IS STILL SAFE'}</p>
    <h1>{startup ? 'Flyt could not open the window' : 'Flyt’s window hit an error'}</h1>
    <p>The workflow runs in the background process and its progress is stored on disk. Reload the window to reconnect.</p>
    <pre>{error?.stack ?? error?.message ?? String(error)}</pre>
    <div><button onClick={() => window.location.reload()}>Reload window</button>
      <button onClick={() => window.flyt?.revealDiagnostics?.()}>Show diagnostic log</button></div>
  </main>;
}

class RendererBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    window.flyt?.reportRendererError?.({ ...errorDetails(error), componentStack: info?.componentStack ?? null });
  }
  render() { return this.state.error ? <FatalRenderer error={this.state.error} /> : this.props.children; }
}

// No top-level await: the production build target (chrome87+) rejects it.
async function boot() {
  if (!window.flyt) {
    const { installDevMock } = await import('./devMock.js');
    installDevMock();
  }
  window.addEventListener('error', event => window.flyt?.reportRendererError?.(errorDetails(event.error ?? event.message)));
  window.addEventListener('unhandledrejection', event => window.flyt?.reportRendererError?.(errorDetails(event.reason)));
  createRoot(document.getElementById('root')).render(<RendererBoundary><Root /></RendererBoundary>);
}
boot().catch(error => {
  window.flyt?.reportRendererError?.(errorDetails(error));
  createRoot(document.getElementById('root')).render(<FatalRenderer error={error} startup />);
});

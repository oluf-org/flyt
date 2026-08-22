import React from 'react';
import { createRoot } from 'react-dom/client';
import Root from './Root.jsx';
import './styles.css';

// No top-level await: the production build target (chrome87+) rejects it.
async function boot() {
  if (!window.flyt) {
    const { installDevMock } = await import('./devMock.js');
    installDevMock();
  }
  createRoot(document.getElementById('root')).render(<Root />);
}
boot();

import React from 'react';
import { sigil } from './sigil.js';

export default function ActivityIcon({ kind, id, size = 24 }) {
  if (kind !== 'loop') return <span className="activity-type-icon workflow" aria-label="Workflow" role="img"
    dangerouslySetInnerHTML={{ __html: sigil(id, size) }}/>;
  return <svg className="activity-type-icon loop" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Loop"
    fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19.5 8A8 8 0 0 0 5 6l-2 3m0-5v5h5M4.5 16A8 8 0 0 0 19 18l2-3m0 5v-5h-5"/>
  </svg>;
}

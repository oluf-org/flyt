import React from 'react';

export default function GoalRequirements({ report, onInspect, busy, onRefresh }) {
  if (!report) return null;
  const missing = report.paths.filter(item => item.status !== 'present');
  const count = missing.length + report.warnings.length;
  if (!count && !report.paths.length) return null;
  return <details className={`goal-requirements ${count ? 'has-warnings' : ''}`} open={count ? true : undefined}>
    <summary>{count ? `${count} project ${count === 1 ? 'warning' : 'warnings'}` : 'Project requirements available'}</summary>
    <p className="goal-hint">{report.folder}. Requirements help this project use the loop; warnings do not prevent reuse or execution.</p>
    <ul>{report.warnings.map((item, index) => <li key={`warning-${index}`}><span>{item.message}</span>{onInspect && <button onClick={() => onInspect(item.address)}>Review setting</button>}</li>)}
      {report.paths.map((item, index) => <li key={`path-${index}`} className={item.status === 'present' ? 'available' : 'missing'}><div><code>{item.path}</code><small>{item.inferred ? 'Referenced path' : 'Required path'}</small><p>{item.message}</p></div>{onInspect && item.status !== 'present' && <button onClick={() => onInspect(item.address)}>Go to field</button>}</li>)}
    </ul>{onRefresh && <button disabled={busy} onClick={onRefresh}>Recheck paths</button>}
  </details>;
}

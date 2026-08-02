// Composer launch controls (MODES-COMPARE T10). When the selected flow exposes
// run inputs (`expose:` in the DSL), these compact controls appear under the
// composer. Their values become the per-node override map at run:start, layered
// on top of the chosen mode (precedence: run input > mode > node > template).
// Untouched controls send nothing — a field only overrides once the user moves
// its control.
import { WorkerPicker } from './Inspector.jsx';
import { EFFORT_LEVELS, DEFAULT_EFFORT, WORK_CATEGORIES } from './flowTypes.js';

const FIELD_LABEL = {
  worker: 'model', effort: 'effort', minNodes: 'min nodes', maxNodes: 'max nodes',
  category: 'task type', language: 'language', system: 'system prompt', instructions: 'instructions'
};
const fieldLabel = f => FIELD_LABEL[f] ?? f;

function Control({ inp, value, onChange, models, activeModels, mockEnabled }) {
  const cur = value ?? inp.current;
  switch (inp.field) {
    case 'worker':
      return (
        <WorkerPicker
          worker={cur ?? undefined}
          models={models}
          activeModels={activeModels}
          mockEnabled={mockEnabled}
          idPrefix={`li-${inp.nodeId}`}
          onChange={onChange}
        />
      );
    case 'effort':
      return (
        <div className="li-segmented" role="group" aria-label={`${inp.title} effort`}>
          {EFFORT_LEVELS.map(l => (
            <button
              key={l}
              type="button"
              className={'li-seg' + ((cur ?? DEFAULT_EFFORT) === l ? ' active' : '')}
              onClick={() => onChange(l)}
            >{l}</button>
          ))}
        </div>
      );
    case 'category':
      return (
        <select value={cur ?? WORK_CATEGORIES[0]} onChange={e => onChange(e.target.value)}>
          {WORK_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      );
    case 'minNodes':
    case 'maxNodes':
      return (
        <input
          type="number" min={1} max={50}
          value={cur ?? ''}
          placeholder={String(inp.current ?? '')}
          onChange={e => onChange(e.target.value === '' ? null : Math.max(1, Number(e.target.value)))}
        />
      );
    case 'language':
      return (
        <input
          type="text"
          value={cur ?? ''}
          placeholder={inp.current ?? 'English'}
          onChange={e => onChange(e.target.value)}
        />
      );
    default:
      return (
        <input type="text" value={cur ?? ''} onChange={e => onChange(e.target.value)} />
      );
  }
}

export default function LaunchInputs({ inputs, values, onChange, models, activeModels, mockEnabled = false }) {
  if (!inputs?.length) return null;
  return (
    <div className="launch-inputs">
      <span className="section-label">Run inputs</span>
      <div className="launch-inputs-grid">
        {inputs.map(inp => (
          <div className="launch-input" key={`${inp.nodeId}:${inp.field}`}>
            <label className="launch-input-label">{inp.title} · {fieldLabel(inp.field)}</label>
            <Control
              inp={inp}
              value={values?.[inp.nodeId]?.[inp.field]}
              onChange={v => onChange(inp.nodeId, inp.field, v)}
              models={models}
              activeModels={activeModels}
              mockEnabled={mockEnabled}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

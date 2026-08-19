// Composer launch controls (DECISIONS.md D27). When the selected flow exposes
// run inputs (`expose:` in the DSL), these compact controls appear under the
// composer. Their values become the per-node override map at run:start, layered
// on top of the chosen mode (precedence: run input > mode > node > template).
// Untouched controls send nothing — a field only overrides once the user moves
// its control.
import { WorkerPicker } from './Inspector.jsx';
import { useModelMeta } from './ModelPicker.jsx';
import { EFFORT_LEVELS, DEFAULT_EFFORT, WORK_CATEGORIES, MAX_QUESTION_ROUNDS } from './flowTypes.js';

const FIELD_LABEL = {
  worker: 'model', effort: 'effort', minNodes: 'min nodes', maxNodes: 'max nodes',
  category: 'task type', language: 'language', system: 'system prompt', instructions: 'instructions',
  maxRounds: 'rounds of questions', maxToolIterations: 'tool rounds'
};
const fieldLabel = f => FIELD_LABEL[f] ?? f;

// The numeric overrides, and the bounds each one actually has.
//
// They were not a group, so each new one had to be remembered here or it fell
// through to the bare text input at the bottom of the switch — which is what
// happened to `maxRounds`: a control with no label, no bounds, and a string
// where the engine wanted a number. The engine coerces, so nothing failed
// loudly; typing "a few" just silently meant the default. A field with a range
// should render as its range.
const NUMERIC_FIELDS = {
  minNodes: { min: 1, max: 50 },
  maxNodes: { min: 1, max: 50 },
  maxToolIterations: { min: 1, max: 100 },
  // MAX_QUESTION_ROUNDS: the ceiling exists to protect the person answering.
  maxRounds: { min: 1, max: MAX_QUESTION_ROUNDS }
};

function Control({ inp, value, onChange, models, activeModels }) {
  const cur = value ?? inp.current;
  switch (inp.field) {
    case 'worker':
      return (
        <WorkerPicker
          worker={cur ?? undefined}
          models={models}
          activeModels={activeModels}
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
    case 'maxToolIterations':
    case 'maxRounds': {
      const { min, max } = NUMERIC_FIELDS[inp.field];
      return (
        <input
          type="number" min={min} max={max}
          value={cur ?? ''}
          placeholder={String(inp.current ?? '')}
          onChange={e => onChange(e.target.value === ''
            ? null
            : Math.min(max, Math.max(min, Math.round(Number(e.target.value)))))}
        />
      );
    }
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

// A control per DECLARED input type (D36 P1.3). Separate from Control above on
// purpose: that one switches on an override FIELD, this one on an input TYPE,
// and conflating them is how "the model for this node" and "the repository this
// run is about" end up in the same list.
function InputControl({ spec, value, onChange, models, activeModels }) {
  const { modelSets } = useModelMeta();
  const cur = value ?? '';
  switch (spec.type) {
    case 'repo':
      return (
        <input
          type="text"
          value={cur}
          placeholder={spec.placeholder ?? 'https://github.com/owner/repo'}
          onChange={e => onChange(e.target.value)}
          aria-label={spec.label}
        />
      );
    case 'url':
      return (
        <input type="url" value={cur} placeholder={spec.placeholder ?? 'https://…'}
          onChange={e => onChange(e.target.value)} aria-label={spec.label} />
      );
    case 'file':
      return (
        <input type="text" value={cur} placeholder={spec.placeholder ?? 'path/inside/the/workspace'}
          onChange={e => onChange(e.target.value)} aria-label={spec.label} />
      );
    case 'choice':
      return (
        <select value={cur || spec.default || spec.options[0]} onChange={e => onChange(e.target.value)} aria-label={spec.label}>
          {spec.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case 'model':
      return (
        <WorkerPicker
          worker={cur ? { provider: 'auto', model: cur } : undefined}
          models={models}
          activeModels={activeModels}
          idPrefix={`ri-${spec.name}`}
          onChange={w => onChange(w?.model ?? '')}
        />
      );
    case 'modelSet': {
      const sets = Object.entries(modelSets ?? {});
      return (
        <select value={cur} onChange={e => onChange(e.target.value)} aria-label={spec.label}>
          <option value="">(pick a set)</option>
          {sets.map(([id, set]) => <option key={id} value={id}>{set.name} — {set.models.length}</option>)}
        </select>
      );
    }
    case 'text':
    default:
      return (
        <textarea rows={2} value={cur} placeholder={spec.placeholder ?? ''}
          onChange={e => onChange(e.target.value)} aria-label={spec.label} />
      );
  }
}

export default function LaunchInputs({ inputs, values, onChange, models, activeModels, declared = [], inputValues = {}, onInputChange = null }) {
  if (!inputs?.length && !declared.length) return null;
  return (
    <div className="launch-inputs">
      {declared.length > 0 && (
        <>
          <span className="section-label">This run needs</span>
          <div className="launch-inputs-grid">
            {declared.map(spec => (
              <div className={'launch-input' + (spec.type === 'text' ? ' wide' : '')} key={spec.name}>
                <label className="launch-input-label">
                  {spec.label}
                  {spec.required && <span className="required" title="Required"> *</span>}
                </label>
                <InputControl
                  spec={spec}
                  value={inputValues?.[spec.name]}
                  onChange={v => onInputChange?.(spec.name, v)}
                  models={models}
                  activeModels={activeModels}
                />
                {spec.description && <span className="launch-input-hint">{spec.description}</span>}
              </div>
            ))}
          </div>
        </>
      )}
      {inputs?.length > 0 && <span className="section-label">Run inputs</span>}
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
            />
          </div>
        ))}
      </div>
    </div>
  );
}

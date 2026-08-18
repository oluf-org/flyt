// The Config modal — the "later stage" of workflow selection. The composer
// chip picks *which workflow*; this modal (opened by the cog beside the chip)
// picks *which config of it* and fine-tunes the per-node settings. It folds two
// surfaces that used to sit permanently under the composer — the mode picker
// and the "Run inputs" block — into one deliberate, opened-when-wanted place, so
// the common path (type a prompt, hit Run on the default) stays uncluttered.
//
// A config is still just a named override bundle on the flow (DECISIONS.md D27):
// "Default" is the flow as authored (modeId = null); each named config is a
// `modes:` entry. Selecting one sets the run's launch target. The per-node
// controls are the flow's exposed run inputs (`expose:` in the DSL), layered on
// top of the chosen config at launch — same mechanics as before, now housed
// with the configs they tune instead of floating on their own.
import { useEffect, useRef } from 'react';
import LaunchInputs from './LaunchInputs.jsx';

function ConfigRow({ selected, name, description, badges, onSelect }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={'config-choice' + (selected ? ' selected' : '')}
      onClick={onSelect}
    >
      <span className="config-choice-check" aria-hidden>{selected ? '●' : '○'}</span>
      <span className="config-choice-body">
        <span className="config-choice-name">{name}</span>
        {description && <span className="config-choice-desc">{description}</span>}
        <span className="config-badges">
          {badges?.length
            ? badges.slice(0, 4).map((b, i) => (
                <span key={i} className="config-badge" title={typeof b === 'string' ? b : b.text}>
                  {typeof b === 'string' ? b : b.text}
                </span>
              ))
            : <span className="config-badge neutral">flow as authored</span>}
          {badges?.length > 4 && <span className="config-badge neutral">+{badges.length - 4} more</span>}
        </span>
      </span>
    </button>
  );
}

export default function ConfigModal({
  flow, configs = [], modeId = null, onSelect,
  launchInputs = [], launchValues, onLaunchInput,
  models = [], activeModels = [], onClose
}) {
  const cardRef = useRef(null);

  // Esc closes; focus opens on the card so keyboard users aren't stranded.
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    cardRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const flowName = flow?.name ?? 'workflow';
  const pick = id => onSelect(flow.id, id);

  return (
    <div className="config-modal-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="config-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Configure ${flowName}`}
        tabIndex={-1}
        ref={cardRef}
      >
        <div className="config-modal-head">
          <div className="config-modal-titles">
            <span className="section-label">Configure</span>
            <h2 className="config-modal-title">{flowName}</h2>
          </div>
          <button type="button" className="link" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="config-modal-body">
          <div className="config-modal-section">
            <span className="config-modal-sub">Config — which override bundle to run. Badges show what each changes vs. the flow as authored.</span>
            <div className="config-choices" role="listbox" aria-label="Config">
              <ConfigRow
                selected={!modeId}
                name="Default"
                description={null}
                badges={null}
                onSelect={() => pick(null)}
              />
              {configs.map(c => (
                <ConfigRow
                  key={c.id}
                  selected={modeId === c.id}
                  name={c.name || c.id}
                  description={c.description}
                  badges={c.badges}
                  onSelect={() => pick(c.id)}
                />
              ))}
            </div>
          </div>

          {launchInputs.length > 0 && (
            <div className="config-modal-section">
              <span className="config-modal-sub">Per-node settings — tuned on top of the chosen config for this run.</span>
              <LaunchInputs
                inputs={launchInputs}
                values={launchValues}
                onChange={onLaunchInput}
                models={models}
                activeModels={activeModels}
              />
            </div>
          )}
        </div>

        <div className="config-modal-foot">
          <button type="button" className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

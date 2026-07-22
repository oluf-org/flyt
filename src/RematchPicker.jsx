// CONFIGS-COMPARE P2 — the rematch picker. A finished run's "Compare against…"
// button asks one question: which configuration should the re-fire run with?
// This modal lists the flow's configs (with their diff badges, same data the
// composer/compare pickers use) plus the flow-as-authored default. Picking one
// hands the choice back to App, which launches the fresh run and opens the
// side-by-side comparison (original = pane A, rematch = pane B).
//
// Kept as a plain fixed overlay rather than the canvas picker's absolute
// backdrop: it can be opened from the run view, the compare view, or the home
// view, none of which is the canvas' positioning context.
export default function RematchPicker({ run, configs, onPick, onCancel }) {
  // Preselect something other than the config the original run used — a
  // rematch against the identical configuration is legal (sampling variance)
  // but rarely the intent, so make the interesting choice the one-tap one.
  const other = configs.find(c => c.id !== run.modeId) ?? null;

  const Row = ({ modeId, name, title, badges, current, suggested }) => (
    <button
      type="button"
      className={'rematch-item' + (suggested ? ' suggested' : '')}
      title={title}
      onClick={() => onPick(modeId)}
    >
      <span className="rematch-item-name">{name}</span>
      {current && <span className="rematch-tag">ran with this</span>}
      {suggested && !current && <span className="rematch-tag suggest">suggested</span>}
      {badges?.length > 0 && (
        <span className="rematch-item-badges mono">{badges.join(' · ')}</span>
      )}
    </button>
  );

  return (
    <div className="rematch-backdrop" onClick={onCancel}>
      <div
        className="rematch-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Compare against a different config of ${run.flowName}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="rematch-head">
          <strong>Compare against…</strong>
          <span className="rematch-sub">
            Re-runs <em>{run.flowName}</em> with the same prompt — the original stays pane A.
          </span>
        </div>
        <div className="rematch-list">
          <Row
            modeId={null}
            name="Default (flow as authored)"
            title="Run with no config — the flow's own nodes and models"
            current={run.modeId == null}
            suggested={run.modeId != null && !other}
          />
          {configs.map(c => (
            <Row
              key={c.id}
              modeId={c.id}
              name={c.name}
              title={c.description ?? undefined}
              badges={c.badges}
              current={c.id === run.modeId}
              suggested={other?.id === c.id}
            />
          ))}
          {configs.length === 0 && (
            <div className="rematch-empty">
              This flow has no saved configs yet — only the default is available.
            </div>
          )}
        </div>
        <div className="rematch-foot">
          <button type="button" className="ghost mini" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

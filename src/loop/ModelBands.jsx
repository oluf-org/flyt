import React from 'react';
import { ModelPicker } from '../ModelPicker.jsx';

// The models the loop runs on (DECISIONS.md D45: lifted out of LoopPage.jsx
// unchanged). They live on this page rather than only in Settings because this
// is where the decision is made — you choose a model in the same glance as
// pressing Start, and the consequence of each (what it costs, whether anything
// can land) belongs beside it.
//
// What DID change in §D5 is where the section sits: behind a disclosure. It is
// a configuration decision made about once a week, and it was occupying the top
// third of a page whose job is to show you work.

// The effort bands, cheapest first. Mirrored from core/levels.js rather than
// imported, for the reason every other constant in src/ is: the renderer does
// not import core, and this list changes about once a year.
export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// What a band with no model of its own inherits — the nearest one below it.
// Shown as the picker's placeholder so an empty row reads as "covered by that"
// rather than as "nothing will happen here".
export function coverageFor(band, models = {}) {
  const i = LEVELS.indexOf(band);
  for (let j = i - 1; j >= 0; j--) if (models[LEVELS[j]]) return models[LEVELS[j]];
  // Nothing below: the lowest model set covers everything under it.
  for (const b of LEVELS) if (models[b]) return models[b];
  return null;
}

export const describeModels = models => {
  const set = LEVELS.filter(b => models?.[b]);
  return set.length ? set.map(b => `${b}=${models[b]}`).join(', ') : null;
};

export const sameModels = (a, b) => LEVELS.every(band => (a?.[band] ?? null) === (b?.[band] ?? null));

export default function ModelBands({
  levelModels = {},
  reviewerWorker = null,
  activeModels = [],
  status = null,
  running = false,
  busy = false,
  onSetLevelModel,
  onSetWorker
}) {
  return (
    <>
      {/* A model PER BAND, because that is the decision cost actually forces:
          something cheap does the ordinary work, and the expensive one is
          what a task reaches by FAILING — which is what the ladder already
          means. One model on every task is the bill nobody wanted. The map
          fills downward, so naming two bands answers all five. */}
      {LEVELS.map(band => {
        const id = levelModels[band] ?? null;
        const covered = coverageFor(band, levelModels);
        return (
          <div className="loop-model-row" key={band}>
            <label>{band}</label>
            <ModelPicker
              worker={id ? { provider: 'auto', model: id } : null}
              activeModels={activeModels}
              idPrefix={`loop-band-${band}`}
              placeholder={covered ? `↑ ${covered}` : 'Effort band'}
              onChange={w => onSetLevelModel(band, w?.model ?? null)}
            />
            {id && (
              <button type="button" className="link" disabled={busy} onClick={() => onSetLevelModel(band, null)}>
                Clear
              </button>
            )}
          </div>
        );
      })}
      <p className="loop-model-note">
        {Object.keys(levelModels).length
          ? <>A task starts at its own band and moves up one on every failed attempt, so the
              dearer models are reached only by the work that needs them. Bands with no model of
              their own inherit the nearest one below.</>
          : <>No models named — each task asks OpenRouter's router for a cost tier instead, and a
              failed attempt retries one band up.</>}
      </p>
      <div className="loop-model-row">
        <label>Review</label>
        <ModelPicker
          worker={reviewerWorker}
          activeModels={activeModels}
          idPrefix="loop-review"
          placeholder="No reviewer"
          onChange={w => onSetWorker('reviewer', w)}
        />
        {reviewerWorker
          ? <button type="button" className="link" disabled={busy} onClick={() => onSetWorker('reviewer', null)}>
              Clear
            </button>
          : <span className="loop-model-hint warn">
              Nothing lands until a reviewer is set — the loop will run, verify and stop before
              merging.
            </span>}
      </div>
      {running && !sameModels(status?.models, levelModels) && (
        // A pick made after Start belongs to the next loop. Saying so beats a
        // panel that reports an intention as though it were what is running.
        <p className="loop-model-note warn">
          The running loop is on {describeModels(status?.models) ?? status?.model ?? 'effort bands'};
          this change applies when you start it again.
        </p>
      )}
    </>
  );
}

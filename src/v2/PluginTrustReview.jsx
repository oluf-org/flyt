// The single confirm-or-edit pass for tools contributed by an installed
// plugin. This is intentionally a Flyt-rendered declaration, not plugin UI:
// the plugin supplies facts, and this component owns the controls and words.
import React, { useMemo, useState } from 'react';
import {
  EFFECTS, declinePluginDecisions, initialPluginDecisions, pluginInferenceEvidence,
  tightenPluginDecision,
} from './pluginTrustReview.js';
import './pluginTrustReview.css';

export default function PluginTrustReview({ pluginName = 'Plugin', proposals = [], onDecide }) {
  const initial = useMemo(() => initialPluginDecisions(proposals), [proposals]);
  const [decisions, setDecisions] = useState(initial);
  const [settled, setSettled] = useState(false);

  const edit = (proposal, patch) => setDecisions(all => ({
    ...all,
    [proposal.name]: tightenPluginDecision(proposal, all[proposal.name], patch),
  }));

  return (
    <div className="plugin-trust-backdrop">
      <section className="plugin-trust" role="alertdialog" aria-modal="true" aria-labelledby="plugin-trust-title">
        <header>
          <p className="eyebrow">Plugin tool review · one required pass</p>
          <h2 id="plugin-trust-title">Review what {pluginName} can reach</h2>
          <p>
            These are conservative inferences, not grants. Accepting classifies the tools;
            a block must still name each tool in its ceiling before it can run.
          </p>
        </header>

        {proposals.map(proposal => {
          const decision = decisions[proposal.name];
          const floor = EFFECTS.indexOf(proposal.effect);
          const evidence = pluginInferenceEvidence(proposal);
          return (
            <article className="plugin-trust-tool" key={proposal.name}>
              <h3 className="mono">{proposal.name}</h3>
              <p>{proposal.inferredFrom?.tool?.description || 'No description supplied.'}</p>
              <dl>
                <dt>Plugin requested</dt>
                <dd>{evidence.requested}</dd>
                <dt>Inference used</dt>
                <dd>{evidence.seams}, the tool name and description, its schema, and its claim</dd>
                <dt>Tool schema</dt>
                <dd><pre>{evidence.schema}</pre></dd>
                <dt>Plugin claimed</dt>
                <dd>{evidence.claim}</dd>
                <dt>Accepting</dt>
                <dd>{proposal.permits}</dd>
                <dt>Still not permitted</dt>
                <dd>{proposal.doesNotPermit}</dd>
              </dl>
              <fieldset>
                <legend>Confirm, or make stricter</legend>
                <label>
                  Effect
                  <select value={decision.effect} onChange={e => edit(proposal, { effect: e.target.value })}>
                    {EFFECTS.map((effect, index) => (
                      <option key={effect} value={effect} disabled={index < floor}>{effect}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <input type="checkbox" checked={decision.destructive}
                    disabled={proposal.destructive}
                    onChange={e => edit(proposal, { destructive: e.target.checked })} />
                  destructive
                </label>
                <label>
                  <input type="checkbox" checked={decision.untrustedInput}
                    disabled={proposal.untrustedInput}
                    onChange={e => edit(proposal, { untrustedInput: e.target.checked })} />
                  accepts untrusted input
                </label>
              </fieldset>
            </article>
          );
        })}

        <footer>
          <button type="button" className="reject" disabled={settled}
            onClick={() => {
              if (onDecide?.(declinePluginDecisions(proposals)) !== false) setSettled(true);
            }}>
            Keep installed; leave tools unreachable
          </button>
          <button type="button" className="primary" disabled={settled} onClick={() => {
            if (onDecide?.(decisions) !== false) setSettled(true);
          }}>
            Confirm classifications
          </button>
        </footer>
      </section>
    </div>
  );
}

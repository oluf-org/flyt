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
  // Deciding crosses IPC, so it takes time and can fail. Treating the returned
  // promise as an answer settled the dialog the instant it was pressed and
  // dismissed the only surface that could report the refusal — the review was
  // then parked with nothing on screen waiting on it.
  const [submitting, setSubmitting] = useState(null);
  const [failure, setFailure] = useState(null);

  const edit = (proposal, patch) => setDecisions(all => ({
    ...all,
    [proposal.name]: tightenPluginDecision(proposal, all[proposal.name], patch),
  }));

  const decide = async (kind, chosen) => {
    setSubmitting(kind);
    setFailure(null);
    try {
      const answer = await onDecide?.(chosen);
      // `false` is the coordinator saying it had nothing to settle — a review
      // that was withdrawn or already answered. That is not an error and it is
      // not an acceptance, so it says so and leaves the dialog usable.
      if (answer === false) {
        setFailure({ kind, message: 'This review is no longer pending — nothing was recorded.' });
        return;
      }
      setSettled(true);
    } catch (error) {
      setFailure({
        kind,
        message: String(error?.message ?? error)
          .replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''),
      });
    } finally {
      setSubmitting(null);
    }
  };

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
          {failure && <p className="plugin-trust-failure" role="alert">
            {failure.message}
            {' '}<button type="button" className="plugin-trust-retry" disabled={Boolean(submitting)}
              onClick={() => decide(failure.kind, failure.kind === 'decline' ? declinePluginDecisions(proposals) : decisions)}>
              Try again
            </button>
          </p>}
          {settled && <p className="plugin-trust-settled" role="status">Recorded. You can close this once installation finishes.</p>}
          <div className="plugin-trust-buttons">
            <button type="button" className="reject" disabled={settled || Boolean(submitting)}
              onClick={() => decide('decline', declinePluginDecisions(proposals))}>
              {submitting === 'decline' ? 'Recording…' : 'Keep installed; leave tools unreachable'}
            </button>
            <button type="button" className="primary" disabled={settled || Boolean(submitting)}
              onClick={() => decide('confirm', decisions)}>
              {submitting === 'confirm' ? 'Recording…' : 'Confirm classifications'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

// Pure state for the one plugin-tool trust pass (D57). Kept outside React so
// the safety direction is testable without a renderer: UI edits can tighten an
// inference and can never turn one down.

export const EFFECTS = ['read', 'write', 'shell'];

export function initialPluginDecisions(proposals = []) {
  return Object.fromEntries(proposals.map(p => [p.name, {
    effect: p.effect,
    destructive: Boolean(p.destructive),
    untrustedInput: Boolean(p.untrustedInput),
    source: 'confirmed',
  }]));
}

export function tightenPluginDecision(proposal, current, patch) {
  const next = { ...current, ...patch, source: 'confirmed' };
  if (EFFECTS.indexOf(next.effect) < EFFECTS.indexOf(proposal.effect)
    || (proposal.destructive && !next.destructive)
    || (proposal.untrustedInput && !next.untrustedInput)) {
    throw new Error(`"${proposal.name}" may only be made stricter than its inference`);
  }
  return next;
}

export function declinePluginDecisions(proposals = []) {
  return Object.fromEntries(proposals.map(p => [p.name, null]));
}

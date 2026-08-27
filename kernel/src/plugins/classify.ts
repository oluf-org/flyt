/**
 * What a contributed tool can reach, inferred from what its plugin asked for.
 *
 * A plugin's tools arrive unclassified and ungranted, in no toolset, reachable
 * by no ceiling (D57). Before a human can confirm or edit a classification
 * there has to BE one to show them, and this is where it comes from.
 *
 * The inference is mechanical and reads only what the kernel already knows:
 * which SEAMS the plugin was injected, and what the tool says about itself. It
 * never calls a model. Whether a tool is "really" dangerous is an opinion, and
 * an opinion in this path is a grant nobody made.
 *
 * **The direction of doubt is the whole design.** Every unknown resolves
 * UPWARD, toward more restriction. The symptom of a wrong guess must be a tool
 * that refuses and a person who notices — never a tool that runs and nobody
 * does. {@link classifyContributedTool} is total: there is no input for which
 * it returns something less restrictive than the evidence supports, and
 * `never-resolves-downward` in the tests enumerates that rather than sampling
 * it.
 *
 * And classification is still not a grant. A tool classified here is in no
 * toolset and reachable by no ceiling until a human names it; this only decides
 * what a human would be agreeing to.
 *
 * @module #kernel/plugins/classify
 */
import type { SeamName } from '../seams/index.js';
import type { ToolClassification } from '../seams/tools.js';

/**
 * What each seam can reach, at its worst.
 *
 * Read as a ceiling rather than a description: `fs` is listed as `write`
 * because an injected `FsSeam` HAS `write()` on it, whether or not this
 * particular tool calls it. A plugin that only reads should ask for a seam that
 * only reads; until such a seam exists, asking for `fs` means asking for write.
 * That is the conservative reading and it is the correct one — the alternative
 * is trusting a plugin's account of which methods it intends to call.
 */
const SEAM_REACH: Partial<Record<SeamName, Partial<ToolClassification>>> = {
  fs: { effect: 'write' },
  shell: { effect: 'shell', destructive: true },
  sandbox: { effect: 'shell', destructive: true },
  // A block this tool spawns can be handed any tool the ceiling allows, and its
  // output comes back as text this run will act on.
  agents: { effect: 'shell', destructive: true, untrustedInput: true },
  // An LLM response is text from outside the workspace, by definition.
  llm: { untrustedInput: true },
  // Reading and writing the session log is the run's own record, not the
  // world's — but it is still a write.
  sessions: { effect: 'write' },
  // Contributing or invoking a command reaches whatever that command reaches,
  // which this cannot know. It is therefore the widest thing it could be.
  commands: { effect: 'shell', destructive: true },
  // Registering a tool is not itself an effect; what the tool does is.
  tools: {}
};

/** read < write < shell. Nothing here may ever move a tool leftward. */
const EFFECT_ORDER = ['read', 'write', 'shell'] as const;
type Effect = (typeof EFFECT_ORDER)[number];

/** The stricter of two effects. */
export function widerEffect(a: Effect, b: Effect): Effect {
  return EFFECT_ORDER.indexOf(a) >= EFFECT_ORDER.indexOf(b) ? a : b;
}

// Words in a tool's own name or description that mean it destroys things, or
// that its result carries text from outside.
//
// Anchored at the START of a word only. `delete_branch` has no word boundary
// after "delete" because `_` is a word character, and "Removes" has an `s` —
// both were missed by a trailing `\b`, which is the kind of near-miss this
// whole module must not have. Matching a prefix over-matches ("dropbox" reads
// as "drop"), and over-matching is the safe direction: a false positive is a
// tool that asks for confirmation it did not need, and a false negative is a
// tool that destroys something nobody agreed to.
const DESTRUCTIVE_WORDS = /\b(delet|remov|destroy|drop|truncat|eras|purg|wipe|rm|unlink|overwrit)/i;
const OUTSIDE_WORDS = /\b(fetch|download|scrap|crawl|http|url|web|brows|request|api)/i;

/** What a plugin declared about itself, as data. */
export interface ContributedTool {
  name?: string;
  description?: string;
  /** JSON Schema for the arguments, read only for hints — never trusted. */
  parameters?: unknown;
  /** What the plugin SAYS it is. A claim, and only ever a floor. */
  classification?: Partial<ToolClassification>;
}

/**
 * The classification a human would be shown before granting anything.
 *
 * `source` is always `'inferred'`: a plugin's own `classification` is a claim,
 * and a claim can only make this STRICTER (see below). Nothing here produces
 * `'confirmed'` — only a person does, in the pass this feeds.
 */
export function classifyContributedTool(
  tool: ContributedTool = {},
  seams: readonly SeamName[] = []
): ToolClassification {
  // The floor: what the seams alone can reach.
  let effect: Effect = 'read';
  let destructive = false;
  let untrustedInput = false;

  for (const seam of seams) {
    const reach = SEAM_REACH[seam];
    if (!reach) {
      // A seam this module has not been taught about. Doubt resolves upward:
      // an unknown capability is the widest one there is, and the test that
      // enumerates SEAM_NAMES against this map is what stops that being
      // permanent.
      effect = 'shell';
      destructive = true;
      untrustedInput = true;
      continue;
    }
    if (reach.effect) effect = widerEffect(effect, reach.effect as Effect);
    destructive ||= reach.destructive === true;
    untrustedInput ||= reach.untrustedInput === true;
  }

  // What the tool says about itself, in the only direction it is allowed to
  // move this. A plugin claiming `effect: 'read'` on a tool holding the fs seam
  // gets no benefit from the claim — the same rule `effectiveRisk` applies to
  // an untrusted MCP server in v1.
  const claimed = tool.classification ?? {};
  if (claimed.effect && EFFECT_ORDER.includes(claimed.effect as Effect)) {
    effect = widerEffect(effect, claimed.effect as Effect);
  }
  destructive ||= claimed.destructive === true;
  untrustedInput ||= claimed.untrustedInput === true;

  // And what it calls itself. A tool named `delete_branch` is destructive
  // whatever it declared, and a tool named `fetch_page` returns outside text.
  // These can only ever ADD, which is why reading a plugin's own prose here is
  // safe: the worst a lie can do is under-claim, and under-claiming changes
  // nothing.
  const said = `${tool.name ?? ''} ${tool.description ?? ''}`;
  if (DESTRUCTIVE_WORDS.test(said)) {
    destructive = true;
    effect = widerEffect(effect, 'write');
  }
  if (OUTSIDE_WORDS.test(said)) untrustedInput = true;

  // A tool that can destroy something is at least writing.
  if (destructive) effect = widerEffect(effect, 'write');

  return { effect, destructive, untrustedInput, source: 'inferred' };
}

/**
 * Is `a` at least as restrictive as `b`?
 *
 * The property the whole module exists to have, written down so a test can
 * assert it over generated inputs rather than over the cases somebody thought
 * of. Used by the confirm-or-edit pass too: an edit may make a classification
 * stricter and never looser.
 */
export function atLeastAsStrict(a: ToolClassification, b: ToolClassification): boolean {
  return EFFECT_ORDER.indexOf(a.effect) >= EFFECT_ORDER.indexOf(b.effect)
    && (a.destructive || !b.destructive)
    && (a.untrustedInput || !b.untrustedInput);
}

/** A classification in one line, for a refusal a person has to read. */
export function describe(c: ToolClassification): string {
  return [
    c.effect,
    c.destructive ? 'destructive' : null,
    c.untrustedInput ? 'untrusted-input' : null
  ].filter(Boolean).join(' + ');
}

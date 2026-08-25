// What the next attempt is told, from what the last ones actually hit.
//
// When a task fails, the loop escalates: a dearer model, the same brief. That
// spends money on the assumption that the work was too hard, and often the work
// was not too hard — the brief was not specific enough, and a bigger model
// reads the same ambiguity and makes a bigger, more confident mistake.
//
// The evidence for that is already on disk and nobody was reading it. A failed
// attempt leaves behind which gates went red and what they named, whether it
// wrote anything at all, whether it wrote outside the paths the task declared,
// and how much of its budget went on discovery before its first write. Those
// are facts about the BRIEF, not opinions about the work:
//
//   28 reads before the first write   the brief did not say where the code is
//   wrote outside the blast radius    the brief declared the wrong paths
//   nothing written at all            the brief did not say what to produce
//   the same gate failing every time  the brief and the gate disagree
//
// So an escalation amends the task rather than just repricing it. The section
// is managed — delimited, rewritten in place, bounded — so it cannot grow
// forever and a human editing the rest of the body is never in its way.
//
// Deterministic on purpose. Every finding here is a count or a set difference
// that the run already recorded, and asking a model to summarise a failure it
// did not see is a call that can be wrong. Nothing in this file costs anything.

/** Delimiters for the section this module owns. Everything else is the author's. */
export const BRIEF_MARK_START = '<!-- flyt:attempts -->';
export const BRIEF_MARK_END = '<!-- /flyt:attempts -->';

/**
 * How many attempts are described before the oldest is dropped.
 *
 * Three, because the useful pattern is "the same thing three times" and a
 * fourth copy of it adds nothing but tokens to every future prompt. A brief
 * that grows without bound is a brief nobody finishes reading, including the
 * model it is for.
 */
export const KEEP_ATTEMPTS = 3;

/** Reads before the first write, above which discovery is the story. */
const DISCOVERY_READS = 12;

/**
 * What one attempt says about the brief it was given.
 *
 * @param {object} evidence
 * @param {number} [evidence.attempt]      which attempt this was
 * @param {string} [evidence.level]        the band it ran at
 * @param {string} [evidence.model]        the model that ran it
 * @param {string} [evidence.at]           ISO timestamp
 * @param {string} [evidence.stage]        where it stopped: gates | review | no-effect | failed
 * @param {string[]} [evidence.gateFailures]  what the gates named
 * @param {string} [evidence.reviewerSaid]    the objection, if a reviewer made one
 * @param {string[]} [evidence.wrote]         paths it changed
 * @param {string[]} [evidence.blastRadius]   paths the task declared
 * @param {number} [evidence.readsBeforeWrite]
 * @param {boolean} [evidence.wroteNothing]
 * @param {string} [evidence.said]            what it reported when it gave up
 * @returns {{ headline: string, findings: string[] }}
 */
export function attemptFindings(evidence = {}) {
  const findings = [];
  const wrote = clean(evidence.wrote);
  const declared = clean(evidence.blastRadius);

  if (evidence.wroteNothing) {
    findings.push('Wrote nothing. Whatever the brief asked for, it did not read as an instruction to '
      + 'change a file — say which file and what should be different in it.');
  }

  // A set difference, not an opinion: it is either in the declared paths or it
  // is not. Both directions are worth saying, and they mean opposite things.
  if (wrote.length && declared.length) {
    const outside = wrote.filter(p => !declared.some(d => p === d || p.startsWith(d.replace(/\/?$/, '/'))));
    if (outside.length) {
      findings.push(`Changed ${list(outside)}, which the task does not declare in its blast radius `
        + `(${list(declared)}). Either the radius is wrong or the change is — decide which, in the task.`);
    }
  }

  if (Number(evidence.readsBeforeWrite) >= DISCOVERY_READS) {
    findings.push(`Read ${evidence.readsBeforeWrite} files before changing anything. That is the cost of a `
      + 'brief that does not say where the code is; name the files, and the next attempt starts at the work.');
  }

  // Running out of tool rounds before writing anything IS about the brief, even
  // though it arrives looking like a model problem: the harness's own advice for
  // it is "narrow what it has to read", and that is an instruction to the task.
  if (evidence.outOfRounds) {
    findings.push('Ran out of tool rounds before it wrote anything — it spent the whole budget '
      + 'finding out where to work. Name the files and the change; discovery is the most expensive '
      + 'thing a brief can leave to the worker.');
  }

  const gates = clean(evidence.gateFailures);
  if (gates.length) findings.push(`Gates named: ${list(gates)}.`);

  if (evidence.reviewerSaid) {
    findings.push(`The reviewer objected: ${oneLine(evidence.reviewerSaid, 300)}`);
  }

  // What it said, unless what it said was about the MODEL rather than the work.
  //
  // `blamesTask()` is false for every adapter failure, and the brief is where
  // that principle is easiest to forget: an attempt whose model returned no
  // content never judged anything the task asked for, so quoting the finish
  // reason into the brief teaches the next worker nothing and costs tokens in
  // every prompt from here on. Seen on t-0087, whose amendment recorded three
  // hundred characters of "finish_reason error, a retry also came back empty".
  if (evidence.said && !evidence.modelSilent) {
    findings.push(`It reported: ${oneLine(evidence.said, 300)}`);
  }

  const where = [
    evidence.attempt ? `Attempt ${evidence.attempt}` : 'An attempt',
    evidence.level ? `at ${evidence.level}` : null,
    evidence.model ? `on ${evidence.model}` : null,
    evidence.stage ? `stopped at ${evidence.stage}` : null,
  ].filter(Boolean).join(' ');

  return { headline: `${where}${evidence.at ? ` (${String(evidence.at).slice(0, 10)})` : ''}`, findings };
}

/**
 * The same thing going wrong every time, which is the brief's fault by then.
 *
 * One attempt failing a gate is the work. Three attempts failing the SAME gate,
 * at three different prices, is the task and the gate disagreeing about what
 * done means — and no fourth model resolves that. It is the one finding here
 * addressed to the human rather than to the next worker.
 */
export function repeatedFailure(notes = []) {
  const ladder = 'A dearer model has already been tried and did not resolve it.';

  // Nothing written, more than once. Seen for real: t-0089 went low → medium →
  // high → xhigh → max, and every band wrote nothing at all. Five models cannot
  // all be too small for the same task; what they have in common is the brief.
  const silent = notes.filter(n => n.wroteNothing);
  if (silent.length >= 2) {
    const bands = [...new Set(silent.map(n => n.level).filter(Boolean))];
    return `${silent.length} attempts wrote nothing${bands.length > 1 ? `, across ${list(bands)}` : ''}. `
      + `${ladder} Models at different prices do not fail the same way by coincidence — the brief does `
      + 'not say, in a way anything can act on, which file should end up different and how.';
  }

  const gateSets = notes.map(n => clean(n.gateFailures)).filter(g => g.length);
  if (gateSets.length < 2) return null;
  const shared = gateSets.reduce((a, b) => a.filter(x => b.includes(x)));
  if (!shared.length) return null;
  return `${gateSets.length} attempts failed on the same thing: ${list(shared)}. `
    + `${ladder} Either the task is asking for something the gate forbids, or the gate is asserting `
    + 'something the task never promised — that is a decision for a human, not a rung.';
}

/**
 * Rewrite the managed section of a task body.
 *
 * The author's prose is untouched: everything outside the markers is copied
 * through, and the section is replaced whole rather than appended to, so
 * amending twice does not leave two of them.
 *
 * @param {string} body the current task body
 * @param {object[]} notes evidence objects, oldest first
 * @returns {string} the new body
 */
export function amendBrief(body, notes = []) {
  const kept = notes.slice(-KEEP_ATTEMPTS);
  const before = String(body ?? '');
  const section = kept.length ? renderSection(kept) : '';
  const start = before.indexOf(BRIEF_MARK_START);
  const end = before.indexOf(BRIEF_MARK_END);

  if (start >= 0 && end > start) {
    const head = before.slice(0, start).replace(/\s+$/, '');
    const tail = before.slice(end + BRIEF_MARK_END.length).replace(/^\s+/, '');
    return [head, section, tail].filter(Boolean).join('\n\n').replace(/\s+$/, '') + '\n';
  }
  if (!section) return before;
  return `${before.replace(/\s+$/, '')}\n\n${section}\n`;
}

/** The evidence already recorded in the body, so amending is additive. */
export function briefNotes(body) {
  const before = String(body ?? '');
  const start = before.indexOf(BRIEF_MARK_START);
  const end = before.indexOf(BRIEF_MARK_END);
  if (start < 0 || end <= start) return [];
  const json = /<!-- flyt:attempts:data\s+([\s\S]*?)\s*-->/.exec(before.slice(start, end))?.[1];
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// --- rendering ------------------------------------------------------------

function renderSection(notes) {
  const lines = [BRIEF_MARK_START, '', '## What previous attempts hit', ''];
  const repeated = repeatedFailure(notes);
  if (repeated) lines.push(`> **This has failed the same way more than once.** ${repeated}`, '');

  for (const note of notes) {
    const { headline, findings } = attemptFindings(note);
    lines.push(`**${headline}**`);
    if (findings.length) for (const f of findings) lines.push(`- ${f}`);
    else lines.push('- Nothing specific was recorded about why.');
    lines.push('');
  }
  lines.push('This section is written by the loop from what each attempt did. Edit the task above it '
    + 'rather than here — the next failure rewrites this.', '');
  // The machine-readable copy, so the next amendment adds to these rather than
  // re-deriving them from prose it would have to parse.
  lines.push(`<!-- flyt:attempts:data ${JSON.stringify(notes)} -->`);
  lines.push(BRIEF_MARK_END);
  return lines.join('\n');
}

const clean = v => (Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : []);

const list = xs => (xs.length <= 4 ? xs.join(', ') : `${xs.slice(0, 4).join(', ')} and ${xs.length - 4} more`);

function oneLine(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

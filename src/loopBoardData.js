// The board's projections (LOOP-BOARD §D2).
//
// Six columns, left to right, in the order work flows. The shaping lives here
// rather than in the components for the reason the rest of this codebase
// already follows: every interesting decision on this page is a projection, and
// a projection you can test is one you can trust.
//
// The single most important function in the file is `allowedMoves`. The legal
// transitions live in DATA, not in JSX, so the buttons, the keyboard shortcuts
// and (if it is ever built) drag-and-drop all obey one table and none of them
// can invent a move the backlog would refuse.

import { PILE_LABELS } from './loopViewData.js';

// The statuses each column claims. `Blocked` and `Needs you` are not statuses —
// they are the two columns computed from the BLOCKER MODEL rather than from the
// task file, which is exactly why B had to land before D.
export const COLUMNS = [
  {
    id: 'needs-you',
    label: 'Needs you',
    statuses: ['parked'],
    // Always first, always rendered, even empty: it is the only column on this
    // page that is asking for something, and its empty state is the good news.
    always: true,
    emptyText: 'Nothing is waiting on you.'
  },
  {
    id: 'queued',
    label: 'Queued',
    statuses: ['queued'],
    emptyText: 'Nothing ready to pick up.'
  },
  {
    id: 'blocked',
    label: 'Blocked',
    statuses: ['queued'],
    // Separated from Queued because merging them is exactly the bug this phase
    // exists to fix: an unpickable task sitting in a list called "Queued" is a
    // lie a person acts on.
    emptyText: 'Nothing is stuck.'
  },
  {
    id: 'working',
    label: 'Working',
    statuses: ['claimed', 'running', 'verifying'],
    emptyText: 'No worker has anything.'
  },
  {
    id: 'review',
    label: 'Review',
    statuses: ['review'],
    // Its own column because it is waiting on a MODEL, not on a worker — and
    // with no reviewer configured it waits forever, which is what the
    // `no-reviewer` banner is for.
    emptyText: 'Nothing waiting on the reviewer.'
  },
  {
    id: 'done',
    label: 'Done',
    statuses: ['landed', 'failed'],
    // Collapsed to a count by default: history is reassurance, not work.
    collapsed: true,
    emptyText: 'Nothing has finished yet.'
  }
];

const isBlocked = list => (list ?? []).some(b => b.severity === 'blocked');
const actionable = list => (list ?? []).some(b => b.severity === 'blocked' && b.remedy);

/**
 * Route every task into exactly one column.
 *
 * Exactly one is the invariant: a task in two columns is a task you count
 * twice, and a task in none is one that has silently left the board. Anything
 * with a status no column claims lands in `Needs you`, because an unroutable
 * task is by definition something a person has to look at.
 */
export function columnsOf(tasks = [], blockers = {}, { problems = [], showDone = false, limit = 100 } = {}) {
  const cards = new Map(COLUMNS.map(c => [c.id, []]));

  for (const task of tasks) {
    cards.get(columnFor(task, blockers[task.id])).push(cardOf(task, blockers[task.id]));
  }
  // Files that would not parse. They have no status and never appear in a pile,
  // so before this they were an entry that was invisible and permanent at once.
  for (const p of problems) {
    cards.get('needs-you').push(cardOf({ ...p, unreadable: true, status: 'unreadable' }, blockers[p.id]));
  }

  return COLUMNS.map(col => {
    const all = cards.get(col.id);
    // Done is a count with a toggle: history is reassurance, not work, and a
    // hundred landed cards push the four columns that matter off the screen.
    const collapsed = col.id === 'done' && !showDone && all.length > 0;
    const shown = collapsed ? [] : all.slice(0, limit);
    return {
      id: col.id,
      label: col.label,
      emptyText: col.emptyText,
      count: all.length,
      cards: shown,
      collapsed,
      // A column that is hiding rows says so rather than quietly ending.
      truncated: collapsed ? 0 : Math.max(0, all.length - shown.length),
      // The next card the loop will actually take. The caller hands the queued
      // list in the picker's own order (score descending), so this is a MARK on
      // that order rather than an opinion about it — "first in a list" reads as
      // an accident of sorting, and this one is not.
      ...(col.id === 'queued' && all.length ? { nextUp: all[0].id } : {})
    };
  })
    // Every column stays on the board whether or not it has cards: a board
    // whose columns come and go is a board you have to re-read every three
    // seconds. The single exception is Done before anything has finished, which
    // is a column about the past on a project that has none.
    .filter(col => col.id !== 'done' || col.count > 0);
}

/** Which column one task belongs to. Exported because the keyboard nav needs it. */
export function columnFor(task, blockers) {
  if (task?.unreadable || task?.error) return 'needs-you';
  const status = task?.status;
  if (status === 'parked') return 'needs-you';
  if (status === 'queued') return isBlocked(blockers) ? 'blocked' : 'queued';
  for (const col of COLUMNS) {
    if (col.id === 'needs-you' || col.id === 'queued' || col.id === 'blocked') continue;
    if (col.statuses.includes(status)) return col.id;
  }
  // A status no column claims. Not dropped and not hidden: an unknown state on
  // this page is precisely the thing a person needs to see.
  return 'needs-you';
}

/**
 * One card's view model.
 *
 * The blocker is printed as a SENTENCE on the collapsed card, not as a badge. A
 * badge means "go and look this up somewhere"; the whole point of Phase B was
 * that the sentence already exists, so there is nothing to look up.
 */
export function cardOf(task = {}, blockers = [], { spend = null } = {}) {
  const list = blockers ?? [];
  const first = list[0] ?? null;
  // A question an agent ASKED outranks the generic "parked and waiting on you"
  // that the blocker model would otherwise put on the same card. It is not an
  // error and must not read like one: it is the one row on this page where a
  // person can unblock a night's work by typing a sentence.
  const question = questionOf(task);
  return {
    id: task.id,
    title: task.title ?? '',
    status: task.status ?? 'unknown',
    level: task.level ?? null,
    attempts: task.attempts ?? 0,
    value: task.value ?? null,
    effort: task.effort ?? null,
    // Where this task came from (D36 P4.5): a task a flow queued is otherwise
    // indistinguishable from one a human typed, and "why is this here" is the
    // first question the parked column provokes.
    sourceRunId: task.sourceRunId ?? null,
    sourceNodeId: task.sourceNodeId ?? null,
    runIds: Array.isArray(task.runIds) ? task.runIds : [],
    blockers: list,
    blocked: isBlocked(list),
    actionable: actionable(list),
    // The one line the collapsed card shows, as a SENTENCE.
    line: question?.question ?? first?.summary ?? task.blockedReason ?? null,
    question,
    unreadable: Boolean(task.unreadable || task.error),
    ...(task.error ? { error: String(task.error) } : {}),
    ...(spend ? { spend } : {})
  };
}

// `ask_human` parks a task with `Q:` on the front of blockedReason. A prefix
// rather than a new field, so an older reader still shows the question — and
// this is the reader that turns it into an answer box.
export const QUESTION_PREFIX = 'Q:';
export function questionOf(task) {
  const reason = String(task?.blockedReason ?? '');
  if (!reason.startsWith(QUESTION_PREFIX)) return null;
  const [head, ...rest] = reason.slice(QUESTION_PREFIX.length).trim().split('\n');
  const options = rest.find(l => l.startsWith('Options: '));
  const context = rest.find(l => l.startsWith('Already established: '));
  return {
    question: head.trim(),
    options: options
      ? options.slice('Options: '.length).split(/\s{2,}/).map(o => o.replace(/^\(\d+\)\s*/, '').trim()).filter(Boolean)
      : [],
    context: context ? context.slice('Already established: '.length).trim() : null
  };
}

/**
 * The moves this task legally has, as data.
 *
 * Every entry maps to an existing command, and nothing here invents a
 * transition the backlog would refuse — `task:remove` on a claimed task is
 * refused by core/backlog.js, so it is offered with `confirm: 'force'` rather
 * than hidden or pretended.
 */
export function allowedMoves(task = {}, { blockers = [] } = {}) {
  const moves = [];
  const status = task.status;
  const add = (action, label, extra = {}) => moves.push({ action, label, ...extra });

  if (task.unreadable || task.error) {
    // There is nothing else you can do with a file that will not parse.
    add('remove', 'Remove', { command: 'task:remove', confirm: 'twice', destructive: true });
    return moves;
  }

  if (status === 'parked' || status === 'failed') {
    add('requeue', 'Requeue', { command: 'task:release', to: 'queued' });
    // Only worth offering while there is ladder left: "requeue a level up" on a
    // task already at `max` is a button that quietly does nothing.
    if (task.level !== 'max') add('requeue-up', 'Requeue a level up', { command: 'task:escalate' });
  }
  if (status === 'queued') {
    add('park', 'Park it', { command: 'task:release', to: 'parked' });
  }
  if (status === 'claimed' || status === 'running' || status === 'verifying' || status === 'review') {
    // Releasing something a worker holds abandons its worktree, so it asks.
    add('release', 'Release', { command: 'task:release', to: 'queued', confirm: 'twice' });
  }
  // Editing a task the supervisor is also writing loses a field silently
  // (core/backlog.js update() is read-modify-write). Refusing is the honest
  // answer, and the one this codebase already chose for update_task.
  if (!['claimed', 'running', 'verifying'].includes(status)) {
    add('edit', 'Edit fields', { command: 'task:update' });
  }
  for (const b of blockers) {
    if (b.remedy) add(b.remedy.action, b.remedy.label, { command: remedyCommand(b.remedy.action), remedy: b.remedy });
  }
  add('remove', 'Remove', {
    command: 'task:remove',
    confirm: 'twice',
    destructive: true,
    // A claimed task is refused by the backlog on the first press; the second
    // has to mean something stronger.
    ...(status === 'claimed' || status === 'running' ? { force: true } : {})
  });
  return dedupe(moves);
}

// Which command a remedy button reaches. `null` means the UI handles it
// locally (opening a picker, scrolling to a card) rather than calling the
// backend — said explicitly so a button with no command is a decision rather
// than an omission.
function remedyCommand(action) {
  return {
    'remove-dep': 'task:update',
    'break-cycle': 'task:update',
    'edit-gates': 'task:update',
    'release-task': 'task:release',
    requeue: 'task:release',
    'requeue-up': 'task:escalate',
    'remove-task': 'task:remove',
    'start-loop': 'loop:start'
  }[action] ?? null;
}

function dedupe(moves) {
  const seen = new Set();
  return moves.filter(m => (seen.has(m.action) ? false : seen.add(m.action)));
}

/** The project-wide banner, or null when nothing project-wide is wrong. */
export function boardBanner(boardBlockers = []) {
  const list = boardBlockers ?? [];
  if (!list.length) return null;
  const worst = list.find(b => b.severity === 'blocked') ?? list[0];
  return {
    severity: worst.severity,
    summary: worst.summary,
    detail: worst.detail ?? null,
    remedy: worst.remedy ?? null,
    // The rest are real but secondary; a banner that stacks five sentences is
    // a banner nobody finishes reading.
    others: list.filter(b => b !== worst)
  };
}

// --- the filter bar --------------------------------------------------------

// `key:value` operators, plus free text over id and title. Parsing lives here
// rather than in the input's onChange so it can be tested, and so the same
// query means the same thing to the keyboard nav.
const OPERATORS = new Set(['is', 'level', 'dep', 'gate', 'status', 'kind']);

export function parseQuery(query) {
  const terms = [];
  const text = [];
  // Quoted values survive their spaces: `gate:"npm test"` is one gate.
  const tokens = String(query ?? '').match(/(?:[a-z]+:)?"[^"]*"|\S+/gi) ?? [];
  for (const raw of tokens) {
    const m = /^([a-z]+):(.*)$/i.exec(raw);
    if (m && OPERATORS.has(m[1].toLowerCase())) {
      terms.push({ op: m[1].toLowerCase(), value: unquote(m[2]).toLowerCase() });
    } else {
      text.push(unquote(raw).toLowerCase());
    }
  }
  return { terms, text };
}

const unquote = s => String(s ?? '').replace(/^"(.*)"$/, '$1');

/**
 * Filter tasks by the query. Every term must match — AND, not OR.
 *
 * AND because a filter bar is a narrowing tool: someone typing
 * `is:blocked level:high` means both, and an OR would return more results the
 * more precisely they asked, which is the opposite of what typing more feels
 * like it should do.
 */
export function filterTasks(tasks = [], query = '', blockers = {}) {
  const { terms, text } = parseQuery(query);
  if (!terms.length && !text.length) return tasks;
  return tasks.filter(task => {
    const list = blockers[task.id] ?? [];
    for (const { op, value } of terms) {
      if (!matches(task, list, op, value)) return false;
    }
    const haystack = `${task.id ?? ''} ${task.title ?? ''}`.toLowerCase();
    return text.every(t => haystack.includes(t));
  });
}

function matches(task, blockers, op, value) {
  switch (op) {
    case 'is':
      if (value === 'blocked') return isBlocked(blockers);
      if (value === 'ready') return task.status === 'queued' && !isBlocked(blockers);
      if (value === 'mine') return Boolean(task.createdBy) && !String(task.createdBy).startsWith('agent:');
      if (value === 'agent') return String(task.createdBy ?? '').startsWith('agent:');
      if (value === 'question') return String(task.blockedReason ?? '').startsWith(QUESTION_PREFIX);
      return task.status === value;
    case 'status':
      return task.status === value;
    case 'level':
      return String(task.level ?? '').toLowerCase() === value;
    case 'dep':
      return (task.dependsOn ?? []).some(d => String(d).toLowerCase() === value);
    case 'gate':
      return (task.gates ?? []).some(g => String(g).toLowerCase().includes(value));
    case 'kind':
      return blockers.some(b => b.kind === value);
    default:
      return true;
  }
}

// --- keyboard --------------------------------------------------------------

/**
 * Where `j`/`k`/`h`/`l` land, given where the cursor is now.
 *
 * A pure function over the columns, so the shortcut table has no opinions of
 * its own and the behaviour at the edges — the top of a column, the last
 * column, a column that is empty — is asserted rather than discovered.
 */
export function moveCursor(columns, cursor, direction) {
  const nonEmpty = columns.filter(c => c.cards.length);
  if (!nonEmpty.length) return null;
  const colIndex = Math.max(0, nonEmpty.findIndex(c => c.id === cursor?.column));
  const col = nonEmpty[colIndex] ?? nonEmpty[0];
  const row = Math.max(0, col.cards.findIndex(c => c.id === cursor?.id));

  // The first press lands ON the first card rather than stepping past it. With
  // no cursor there is nowhere to move FROM, so "move down" means "start here" —
  // and skipping the first card of the first column skips the very row this
  // page puts first on purpose.
  const placed = nonEmpty.some(c => c.cards.some(x => x.id === cursor?.id));
  if (!placed) return { column: col.id, id: col.cards[0].id };

  if (direction === 'down' || direction === 'up') {
    const next = Math.min(col.cards.length - 1, Math.max(0, row + (direction === 'down' ? 1 : -1)));
    return { column: col.id, id: col.cards[next].id };
  }
  const step = direction === 'right' ? 1 : -1;
  const nextCol = nonEmpty[Math.min(nonEmpty.length - 1, Math.max(0, colIndex + step))];
  // Keep the same depth where the neighbouring column is long enough, which is
  // what makes h/l feel like moving sideways rather than jumping to the top.
  const at = Math.min(row, nextCol.cards.length - 1);
  return { column: nextCol.id, id: nextCol.cards[at].id };
}

export { PILE_LABELS };

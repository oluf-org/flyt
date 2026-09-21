// What each chat channel says about itself, in one table.
//
// This is the seam the two surfaces were split on. `Chat.jsx` owns everything
// that is true of any chat — the composer, streaming, tool lines, the transcript
// that appears once there is one — and a change there changes both surfaces at
// once, which is the point. What cannot be shared is the placeholder and the
// subjects: `read_task id` and `read_file path` are different tools answering to
// different toolsets, and a tool line that named the wrong argument would be
// worse than naming none.
//
// There is no `note` here and no starter prompts. A chat window does not need
// to explain to a person how a chat window works, and the sentence that used to
// sit above the box ("this reads your backlog and can queue work…") was read
// once and then occupied the pane forever. What the channel may actually do is
// enforced by its tool ceiling in core/chat.js, not by a paragraph.

/**
 * The one argument worth showing on a collapsed tool line, per tool.
 *
 * Kept per channel rather than merged, because a single list would be wrong for
 * both toolsets the moment one of them gains a tool the other does not have.
 */
const LOOP_SUBJECTS = {
  read_task: 'id', why_blocked: 'id', read_file: 'path', glob: 'pattern',
  search_references: 'query', read_run: 'runId', enqueue_task: 'title', list_tasks: 'status',
};

const BUILD_SUBJECTS = {
  read_stack: 'id', read_block: 'use', list_blocks: 'category', read_file: 'path',
  glob: 'pattern', search_references: 'query', propose_stack_change: 'summary',
};

export const CHAT_CHANNEL_UI = {
  loop: {
    // The title is the accessible name of the input, and the heading the host
    // surface draws above it. Two words, because it is a label, not a pitch.
    title: 'Ask about the backlog',
    placeholder: 'Describe work to queue, or ask a question…',
    subjects: LOOP_SUBJECTS,
  },
  build: {
    title: 'Ask about this workflow',
    placeholder: 'Describe a change, or ask a question…',
    subjects: BUILD_SUBJECTS,
  },
};

export const channelUi = channel => CHAT_CHANNEL_UI[channel] ?? CHAT_CHANNEL_UI.loop;

/**
 * The subject of a collapsed tool line — `read_file src/v2/Shell.jsx`.
 *
 * Falls back to the first string argument, so a tool this table has not heard
 * of still says what it acted on instead of showing a bare name.
 */
export function subjectOf(channel, tool, args) {
  if (!args || typeof args !== 'object') return null;
  const key = channelUi(channel).subjects[tool];
  const value = key ? args[key] : Object.values(args).find(item => typeof item === 'string');
  if (typeof value !== 'string' || !value.trim()) return null;
  const one = value.trim().replace(/\s+/g, ' ');
  return one.length > 48 ? `${one.slice(0, 45)}…` : one;
}

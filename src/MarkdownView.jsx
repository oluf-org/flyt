import React, { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// MarkdownView (DESIGN-SPEC.md §7): the one renderer for model output.
// react-markdown + remark-gfm, no rehype-raw — raw HTML in model output is
// escaped, never injected (risk D-security).
//
// Streaming tolerance: rendered on the existing ~250ms snapshot cadence and
// memoized on the text, so only the active node's re-render costs anything
// (risk D-perf). Before parsing, an unterminated trailing code fence is
// closed so a half-streamed ``` fence doesn't swallow the document. While
// `streaming` is true the live caret renders after the last block.

// Close a dangling code fence: an odd number of ``` lines means the last
// fence never got its closer mid-stream.
function closeDanglingFence(text) {
  const fences = text.match(/^```[^\n]*$/gm);
  return fences && fences.length % 2 === 1 ? text + '\n```' : text;
}

function MarkdownView({ text, streaming = false, className = '', inCanvas = false }) {
  const source = useMemo(() => closeDanglingFence(text ?? ''), [text]);
  // Inside a React Flow node the card must not fight the canvas: nowheel
  // (scroll stays local), nodrag/nopan (selection and drag don't pan).
  const classes = [
    'md-body',
    inCanvas ? 'nowheel nodrag nopan' : '',
    className
  ].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
      {streaming && <span className="live-caret" aria-hidden />}
    </div>
  );
}

// Memoized on text (and the toggles) — the 250ms snapshot tick re-renders
// parents constantly; unchanged text skips the markdown parse entirely.
export default memo(MarkdownView);

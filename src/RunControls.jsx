import React, { useEffect, useRef, useState } from 'react';
import Tip from './Tip.jsx';

// Pause / resume / stop for a live run (RUN-CONTROL), factored out of RunBar so
// the chat surface can carry the same three buttons in its pinned topbar.
//
// Why the topbar needed them (D39): in the feed view the RunBar scrolls away
// with the thread, so the moment a run is long enough to be worth stopping,
// the stop button is off-screen — "there is no way to stop this" is what an
// unreachable control feels like. The controls are now wherever the run is.
//
// Stop is the one destructive action: the first click re-arms the button for
// three seconds instead of opening a dialog (same rule as the canvas menu).
export default function RunControls({ paused, onPause, onResume, onStop, className = '' }) {
  const [confirmStop, setConfirmStop] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const clickStop = () => {
    if (confirmStop) {
      clearTimeout(timer.current);
      setConfirmStop(false);
      onStop?.();
      return;
    }
    setConfirmStop(true);
    timer.current = setTimeout(() => setConfirmStop(false), 3000);
  };

  return (
    <div className={'run-controls ' + className}>
      {paused ? (
        <Tip as="button" type="button" className="run-ctl" text="Resume the run" onClick={onResume}>▶</Tip>
      ) : (
        <Tip as="button" type="button" className="run-ctl" text="Pause after the current step" onClick={onPause}>❚❚</Tip>
      )}
      <Tip
        as="button"
        type="button"
        className={'run-ctl danger' + (confirmStop ? ' confirm' : '')}
        text={confirmStop ? 'Click again to confirm stop' : 'Stop the run — finished work is kept'}
        onClick={clickStop}
      >■</Tip>
    </div>
  );
}

import React, { useId, useRef } from 'react';

// A styled tooltip that replaces native `title=`. The bubble is a popover, so it
// lives in the top layer and is never clipped by canvas/pane overflow; its
// position comes entirely from CSS anchor positioning (position-anchor +
// position-area + flip fallbacks in styles.css) — there is no getBoundingClientRect
// math here. We only toggle visibility on hover/focus.
//
// Usage: wrap the trigger, e.g. <Tip text="Queued — waiting for a worker"><span/></Tip>.
// `as` picks the wrapper element (default span); extra props pass through.
export default function Tip({ text, children, as: Tag = 'span', className, ...rest }) {
  const uid = useId().replace(/[:]/g, '');
  const anchor = `--tip-${uid}`;
  const ref = useRef(null);

  if (!text) {
    return <Tag className={className} {...rest}>{children}</Tag>;
  }

  const show = () => ref.current?.showPopover?.();
  const hide = () => ref.current?.hidePopover?.();

  return (
    <Tag
      className={className}
      style={{ anchorName: anchor }}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
      {...rest}
    >
      {children}
      <span
        ref={ref}
        role="tooltip"
        popover="manual"
        className="tip"
        style={{ positionAnchor: anchor }}
      >
        {text}
      </span>
    </Tag>
  );
}

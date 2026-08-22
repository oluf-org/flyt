// The block editor: a stack drawn from the derived layout, and edited through
// the commands.
//
// Drawing (t-0074):
//
// - Geometry comes from `layout()` (t-0057), a pure function of the tree, so
//   there is nothing to store and no .layout.json anywhere under this phase.
//   The view model in blockGeometry.js computes it once per render.
// - Containment renders as containment: a sequence is its children stacked, a
//   parallel is its lanes side by side, nesting reads as nesting at every
//   depth the parser allows (MAX_DEPTH). Containers are boxes, and there are
//   no edges — there is nothing for an edge to say that nesting does not.
// - A block whose `use` names nothing installed draws as MISSING and says which
//   use is missing. It does not draw as a normal block, and it does not vanish.
// - An empty stack draws as an empty stack rather than as nothing.
//
// Editing (t-0075) goes through `commands`, and through nothing else. This does
// not call `moveNode`; it invokes `stack:move-block`, and so does a model, and
// the record that comes back out is the same either way (D63). It subscribes to
// `commands/invoke` and animates what it hears, which is why an edit a model
// made animates like a dragged one without a second animation being written.
//
// A drop picks a SLOT — a container and an index — never a position. There is
// nothing to drop into that is not somewhere in the tree, so there is no
// arrangement that saves and does not parse (D59).
//
// Read-only is still the default: with no `commands` prop nothing is draggable,
// which is what Build renders until there is a stack source to edit.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { editorGeometry } from './blockGeometry.js';
import { dragTo } from './stackEditing.js';
import './blockEditorStyles.css';

/** The label a stack file gives a block: title if any, else the use. */
function blockTitle(node) {
  return node.title ?? node.use;
}

function useLabel(node) {
  return typeof node.use === 'string' ? node.use : '';
}

/** How long a just-edited node stays lit. Long enough to see, short enough not to linger. */
const TOUCH_MS = 600;

/**
 * @param stack — a parsed stack (version 2).
 * @param blocks — `ctx.blocks`, used to resolve each `use`. Omitted or empty,
 *   every block renders missing: the registry is where "installed" is decided.
 * @param commands — the command surface: `{ invoke(name, args, caller), subscribe(fn) }`.
 *   Omitted, the editor is read-only. This is the SAME surface a model reaches,
 *   which is the whole of D63 — there is no second path for either caller.
 */
export default function BlockEditor({ stack, blocks = null, commands = null }) {
  // What the last edit touched. Set from `commands/invoke`, which is the one
  // place both callers arrive: a person dragging and a model invoking produce
  // the same record, so they get the same animation for free.
  const [touched, setTouched] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const [dragging, setDragging] = useState(null);
  const surface = useRef(null);

  useEffect(() => {
    if (!commands?.subscribe) return undefined;
    return commands.subscribe(record => {
      // A refusal is something a person watching an agent work needs to see,
      // which is why the event carries it at all.
      if (record?.error) { setRefusal(record.error); return; }
      const nodeId = record?.result?.nodeId ?? null;
      if (!nodeId) return;
      setRefusal(null);
      setTouched({ nodeId, at: Date.now(), caller: record.caller ?? 'human' });
    });
  }, [commands]);

  // Cleared after the animation, so a second edit to the same node animates
  // again rather than being a no-op because the class is already on it.
  useEffect(() => {
    if (!touched) return undefined;
    const timer = setTimeout(() => setTouched(null), TOUCH_MS);
    return () => clearTimeout(timer);
  }, [touched]);

  const drop = useCallback(async (nodeId, point) => {
    setDragging(null);
    if (!commands?.invoke || !stack?.root) return;
    const { command, refusal: why } = dragTo(stack, blocks, nodeId, point);
    // A drop that changes nothing is neither an edit nor a refusal; it is a
    // drag that landed where it started, and saying anything about it is noise.
    if (why) { setRefusal(why); return; }
    if (!command) { setRefusal(null); return; }
    setRefusal(null);
    try {
      // `human`, because a person dragged it. The caller is RECORDED, never
      // inferred: "an agent did this" is the first question anyone asks about a
      // change they did not make.
      await commands.invoke(command.name, command.args, 'human');
    } catch (err) {
      setRefusal(String(err?.message ?? err));
    }
  }, [commands, stack, blocks]);

  // After the hooks, never before. An early return above them would run a
  // different number of hooks on the render where a stack first arrives.
  if (!stack?.root) {
    return (
      <div className="block-editor-empty" role="status">
        <p className="section-label">CLEAN SLATE</p>
        <p>No stack yet — author one in the YAML and it draws itself here.</p>
      </div>
    );
  }

  const { boxes, width, height } = editorGeometry(stack.root, blocks);
  const editable = Boolean(commands?.invoke);

  return (
    <div className="block-editor" data-v2 data-editable={editable || undefined}>
      {refusal && <p className="be-refusal" role="alert">{refusal}</p>}
      <div className="block-editor-scroll">
        <div
          className="block-editor-stack"
          style={{ width, height }}
          ref={surface}
          onDragOver={editable ? e => e.preventDefault() : undefined}
          onDrop={editable ? e => {
            e.preventDefault();
            const nodeId = e.dataTransfer?.getData('text/flyt-node') || dragging;
            if (!nodeId) return;
            const rect = surface.current?.getBoundingClientRect();
            drop(nodeId, { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) });
          } : undefined}
        >
          {Object.entries(boxes).map(([id, { box, node, missing }]) => {
            const style = {
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
            };
            const frame = node.kind === 'block' ? 'block-frame' : 'container-frame';
            const lit = touched?.nodeId === id;
            return (
              <div
                key={id}
                className={`be-node ${frame}${missing ? ' missing' : ''}`
                  + (lit ? ` be-touched be-by-${touched.caller}` : '')
                  + (dragging === id ? ' be-dragging' : '')}
                style={style}
                data-node-id={id}
                data-kind={node.kind}
                data-missing={missing || undefined}
                data-touched={lit || undefined}
                // The root is the stack; there is nowhere to move it to.
                draggable={editable && id !== stack.root.id}
                onDragStart={editable ? e => {
                  e.stopPropagation();
                  setDragging(id);
                  e.dataTransfer?.setData('text/flyt-node', id);
                } : undefined}
                onDragEnd={editable ? () => setDragging(null) : undefined}
              >
                {node.kind === 'block' ? (
                  <>
                    <div className="be-block-title">{blockTitle(node)}</div>
                    {missing ? (
                      <div className="be-block-missing">
                        <span className="section-label">MISSING</span>
                        <span className="mono">{useLabel(node)}</span>
                      </div>
                    ) : (
                      <div className="be-block-use mono">{useLabel(node)}</div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="be-container-type">
                      {node.kind === 'parallel' ? 'PARALLEL' : 'SEQUENCE'}
                    </div>
                    <div className="be-lane-rail">
                      {node.kind === 'parallel'
                        ? node.children.map(child => (
                            <span key={child.id} className="be-lane-dot" />
                          ))
                        : null}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

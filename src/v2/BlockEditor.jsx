// The block editor (t-0074): a stack drawn from the derived layout, read-only.
//
// Phase 1, and the rules are the ones t-0074 exists to get right before t-0075
// lets anyone edit:
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
// Editing is t-0075. None of this is interactive, on purpose.
import React from 'react';
import { editorGeometry } from './blockGeometry.js';
import './blockEditorStyles.css';

/** The label a stack file gives a block: title if any, else the use. */
function blockTitle(node) {
  return node.title ?? node.use;
}

function useLabel(node) {
  return typeof node.use === 'string' ? node.use : '';
}

/**
 * @param stack — a parsed stack (version 2).
 * @param blocks — `ctx.blocks`, used to resolve each `use`. Omitted or empty,
 *   every block renders missing: the registry is where "installed" is decided.
 */
export default function BlockEditor({ stack, blocks = null }) {
  if (!stack?.root) {
    return (
      <div className="block-editor-empty" role="status">
        <p className="section-label">CLEAN SLATE</p>
        <p>No stack yet — author one in the YAML and it draws itself here.</p>
      </div>
    );
  }

  const { boxes, width, height } = editorGeometry(stack.root, blocks);

  return (
    <div className="block-editor" data-v2>
      <div className="block-editor-scroll">
        <div className="block-editor-stack" style={{ width, height }}>
          {Object.entries(boxes).map(([id, { box, node, missing }]) => {
            const style = {
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
            };
            const frame = node.kind === 'block' ? 'block-frame' : 'container-frame';
            return (
              <div
                key={id}
                className={`be-node ${frame}${missing ? ' missing' : ''}`}
                style={style}
                data-node-id={id}
                data-kind={node.kind}
                data-missing={missing || undefined}
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
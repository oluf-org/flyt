import React from 'react';
import { BaseEdge, getBezierPath } from '@xyflow/react';
import { edgeWidth, edgeOpacity, formatBytes } from './edgeWeight.js';

// The default edge for every canvas. Beyond drawing the line it does two things:
//  • weight — stroke thickness bucketed by how much context actually flowed
//    along it (data.contextBytes), so a run's context economy is legible: thin
//    lines into a contextSpec node, thick ones where a full output was piped.
//  • signal — while the SOURCE is streaming (data.sourceStatus === 'active') a
//    single accent dot rides the path. Pure CSS motion (offset-path) — no
//    per-frame JS, no timer.
export default function FlowEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, markerEnd, style, data,
}) {
  const [edgePath] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });
  const bytes = data?.contextBytes;
  const tip = formatBytes(bytes);
  const streaming = data?.sourceStatus === 'active';
  // Only override width/opacity when there's a real measurement — otherwise let
  // the stylesheet defaults stand (2px, or the spawned edge's 1.5px dashed), so
  // unmeasured edges look exactly as before.
  const edgeStyle = bytes == null
    ? style
    : { ...style, strokeWidth: edgeWidth(bytes), opacity: edgeOpacity(bytes) };
  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={edgeStyle} />
      {tip && <title>{tip}</title>}
      {streaming && (
        <circle className="edge-signal" r="3" style={{ offsetPath: `path('${edgePath}')` }} />
      )}
    </>
  );
}

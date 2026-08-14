// Sub-flows (BRICKS P3 / D36 B1–B4): a flow may contain another flow.
//
// This is composition, not programming (see BRICKS-PLAN §0.2). There are no
// variables, no conditionals and no iteration count — a sub-flow call is a
// static edge to a named artifact, resolved at run start, with a depth cap.
//
// Execution is an INLINE SPLICE (B1), not a nested run: the referenced flow's
// nodes are spliced into the run graph as children of the call-site node, so
// there is one run folder, one snapshot, one canvas, and gates and resume work
// exactly as they already do. A nested FlowRunner would fragment run state
// across run folders and break the live canvas — which is the transparency
// window the whole product rests on (D1, D4).

import { resolveFlow, mergeOverrideMaps, nodePorts, nodeLabel } from '../../src/flowTypes.js';

// The id separator for spliced nodes.
//
// BRICKS-PLAN B1 says `<callId>/<innerId>`, and that cannot work: RunStore's
// nodeOutputPath() maps every character outside [a-zA-Z0-9_-] to '_', and
// readNodeOutputs() turns filenames back into node ids. A '/' would make
// `learn/analyse` write to `learn_analyse.md` and then never be found again —
// every spliced node's output would be unreadable on the canvas. '__' round
// -trips through both, and reads about the same.
export const SUBFLOW_SEP = '__';

export const subflowChildId = (callId, innerId) => `${callId}${SUBFLOW_SEP}${innerId}`;

// D36 B3. Counts every container on the way down, not just sub-flow calls.
export const MAX_SUBFLOW_DEPTH = 3;

export class SubflowError extends Error {
  constructor(message) { super(message); this.name = 'SubflowError'; }
}

const isInput = n => n.type === 'input';
const isOutput = n => n.type === 'output';

// The nodes whose output IS the sub-flow's output: whatever feeds its `output`
// node. A flow with no output node falls back to its sinks — nodes nothing
// else consumes — because "what did this produce" must always have an answer.
export function resultNodesOf(flow) {
  const out = flow.nodes.find(isOutput);
  if (out) {
    const feeders = flow.edges.filter(e => e.target === out.id).map(e => e.source);
    const ids = new Set(feeders);
    const hit = flow.nodes.filter(n => ids.has(n.id));
    if (hit.length) return hit;
  }
  const consumed = new Set(flow.edges.map(e => e.source));
  return flow.nodes.filter(n => !isInput(n) && !isOutput(n) && !consumed.has(n.id));
}

// The ports a sub-flow call site declares (P3.3): one per node feeding the
// inner flow's output, in declaration order. The first is primary, matching
// every other node type. Addressable from the parent as `<call>.<port>`.
export function subflowPorts(flow) {
  const results = resultNodesOf(flow);
  if (!results.length) return [{ id: 'result', label: 'result', description: 'This sub-flow produced no declared output.' }];
  return results.map(n => ({
    id: n.id,
    label: nodeLabel(n),
    description: `Output of "${nodeLabel(n)}" inside the sub-flow.`
  }));
}

// --- the flow-reference graph (lint) ----------------------------------------

export const subflowRefs = flow =>
  (flow?.nodes ?? []).filter(n => n.type === 'subflow' && n.data?.flowId).map(n => String(n.data.flowId));

// Every flow id reachable from `startId`, and the first cycle found on the way.
// Runs on the flow-REFERENCE graph, not the node graph: A uses B uses A is a
// cycle even though neither flow's own nodes form one.
export function findFlowCycle(startId, flowsById) {
  const path = [];
  const onPath = new Set();
  const done = new Set();
  let cycle = null;
  const visit = id => {
    if (cycle) return;
    if (onPath.has(id)) { cycle = [...path.slice(path.indexOf(id)), id]; return; }
    if (done.has(id)) return;
    const flow = flowsById.get(id);
    if (!flow) return;            // unknown-flow is a separate rule
    path.push(id); onPath.add(id);
    for (const ref of subflowRefs(flow)) visit(ref);
    path.pop(); onPath.delete(id);
    done.add(id);
  };
  visit(startId);
  return cycle;
}

// How deep the containment gets below this flow. Sub-flow calls and the other
// containers (orchestrator, fanout) all count — a sub-flow may contain
// orchestrators and the D8 two-tier rule stands on top (B3).
export function flowDepth(flowId, flowsById, seen = new Set()) {
  const flow = flowsById.get(flowId);
  if (!flow || seen.has(flowId)) return 0;
  const next = new Set([...seen, flowId]);
  let deepest = 0;
  for (const n of flow.nodes ?? []) {
    if (n.type === 'orchestrator' || n.type === 'fanout') deepest = Math.max(deepest, 1);
    if (n.type === 'subflow' && n.data?.flowId) {
      deepest = Math.max(deepest, 1 + flowDepth(String(n.data.flowId), flowsById, next));
    }
  }
  return deepest;
}

// --- the splice -------------------------------------------------------------

// Splice one sub-flow call site into the outer flow, in place.
//
// `loadFlow(id)` returns the referenced flow definition (unresolved) or null.
// Returns the created child nodes so the caller can hand them to runContainer.
// Recursive: a sub-flow that itself calls sub-flows is spliced in the same
// pass, which is why the depth cap is enforced here as well as at lint time —
// a flow edited after linting must not be able to recurse the engine (P3.4).
export function spliceSubflow(outerFlow, callNode, { loadFlow, templates = [], depth = 1, callStack = [] }) {
  const flowId = String(callNode.data?.flowId ?? '');
  if (!flowId) throw new SubflowError(`node "${callNode.id}": no flow referenced`);
  if (callStack.includes(flowId)) {
    throw new SubflowError(
      `node "${callNode.id}": flow "${flowId}" is already on the call path (${[...callStack, flowId].join(' → ')}) — a flow cannot contain itself`);
  }
  if (depth > MAX_SUBFLOW_DEPTH) {
    throw new SubflowError(
      `node "${callNode.id}": sub-flow nesting deeper than ${MAX_SUBFLOW_DEPTH} (${[...callStack, flowId].join(' → ')})`);
  }

  const inner = loadFlow(flowId);
  if (!inner) throw new SubflowError(`node "${callNode.id}": flow "${flowId}" does not exist`);

  // Call-site parameterisation (B4): a saved config of the inner flow, then
  // ad-hoc per-inner-node tweaks on top. No new concept — a mode is already
  // "a per-node override map applied at a point in time" (D27), and a call
  // site is just another such point.
  const modeId = callNode.data?.flowMode ?? null;
  if (modeId && !inner.modes?.[modeId]) {
    throw new SubflowError(`node "${callNode.id}": flow "${flowId}" has no mode "${modeId}"`);
  }
  const overrides = mergeOverrideMaps(inner.modes?.[modeId]?.overrides, callNode.data?.flowOverrides);
  const resolved = resolveFlow(inner, templates, Object.keys(overrides).length ? overrides : null);

  const innerById = new Map(resolved.nodes.map(n => [n.id, n]));
  const idFor = innerId => subflowChildId(callNode.id, innerId);

  // The call site's own inbound sources. The inner input node is NOT spliced:
  // its consumers are re-sourced straight to whatever feeds the call site, so
  // upstream context reaches them the ordinary way rather than through a
  // placeholder with no output.
  const inboundSources = outerFlow.edges
    .filter(e => e.target === callNode.id && e.sourceHandle !== 'feedback')
    .map(e => ({ source: e.source, sourceHandle: e.sourceHandle ?? null }));

  const innerInputIds = new Set(resolved.nodes.filter(isInput).map(n => n.id));
  const innerOutputIds = new Set(resolved.nodes.filter(isOutput).map(n => n.id));

  const taken = new Set(outerFlow.nodes.map(n => n.id));
  const children = [];
  for (const n of resolved.nodes) {
    if (innerInputIds.has(n.id) || innerOutputIds.has(n.id)) continue; // structural: mapped, not spliced
    const id = idFor(n.id);
    if (taken.has(id)) {
      throw new SubflowError(`node "${callNode.id}": spliced id "${id}" collides with a node already in the flow`);
    }
    taken.add(id);
    children.push({
      ...n,
      id,
      parentId: callNode.id,
      extent: 'parent',
      data: {
        ...n.data,
        managedBy: callNode.id,
        generatedBy: callNode.id,
        // Provenance: which flow, and which node inside it. The canvas and the
        // Inspector both read these, and a run's flow.json keeps them forever.
        subflowId: flowId,
        subflowNodeId: n.id
        // NOTE: requiresApproval is deliberately NOT stripped. An orchestrator
        // or fan-out forces its children autonomous because a MODEL invented
        // them; a sub-flow's nodes were authored by a human who put that gate
        // there on purpose. Q-B1 resolved: with an inline splice there is one
        // run, so an inner gate pauses that run — there is nothing separate to
        // park into, and the runner already knows who is watching via the
        // run's approvalMode.
      }
    });
  }

  const edges = [];
  for (const e of resolved.edges) {
    const fromInput = innerInputIds.has(e.source);
    const toOutput = innerOutputIds.has(e.target);
    if (toOutput) continue;                       // the inner output is the call site itself
    if (fromInput) {
      // input -> X  becomes  <whatever feeds the call site> -> X
      for (const src of inboundSources) {
        edges.push({
          id: `sub-e-${src.source}-${idFor(e.target)}`,
          source: src.source, target: idFor(e.target),
          ...(src.sourceHandle ? { sourceHandle: src.sourceHandle } : {}),
          generatedBy: callNode.id
        });
      }
      continue;
    }
    edges.push({
      id: `sub-e-${idFor(e.source)}-${idFor(e.target)}` + (e.sourceHandle ? `-${e.sourceHandle}` : ''),
      source: idFor(e.source), target: idFor(e.target),
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
      generatedBy: callNode.id
    });
  }

  // The nodes whose output the call site reports as its own.
  const resultIds = resultNodesOf(resolved).map(n => idFor(n.id));
  const ports = subflowPorts(resolved).map(p => ({ ...p, id: p.id, childId: idFor(p.id) }));

  outerFlow.nodes.push(...children);
  outerFlow.edges.push(...edges);

  // Recurse: a spliced child may itself be a sub-flow call.
  let all = [...children];
  for (const child of children.filter(c => c.type === 'subflow')) {
    const nested = spliceSubflow(outerFlow, child, {
      loadFlow, templates, depth: depth + 1, callStack: [...callStack, flowId]
    });
    all = [...all, ...nested.children];
  }

  return { children: all, ownChildren: children, resultIds, ports, innerFlow: resolved, flowId };
}

// Splice every sub-flow call in a flow, in place. Returns a map of call-site
// id -> splice result, which the runner keeps for the duration of the run.
export function spliceAllSubflows(flow, { loadFlow, templates = [], maxNodes = 400 }) {
  const results = new Map();
  // Top-level calls only; nested ones are spliced by the recursion above.
  const calls = flow.nodes.filter(n => n.type === 'subflow' && !n.parentId);
  for (const call of calls) {
    const r = spliceSubflow(flow, call, { loadFlow, templates, depth: 1, callStack: [] });
    results.set(call.id, r);
    // A sub-flow that explodes the canvas fails the run AT START with a clear
    // error, rather than degrading the canvas silently (BRICKS §3).
    if (flow.nodes.length > maxNodes) {
      throw new SubflowError(
        `sub-flow splicing produced ${flow.nodes.length} nodes, over the ${maxNodes}-node limit for one run`);
    }
  }
  // The ports a call site declares become its `outputs`, so nodePorts() and
  // every `<call>.<port>` edge resolve without knowing about sub-flows at all.
  for (const [callId, r] of results) {
    const node = flow.nodes.find(n => n.id === callId);
    if (node) node.data = { ...node.data, outputs: r.ports.map(({ id, label, description }) => ({ id, label, description })) };
  }
  return results;
}

// Which inner node backs each declared port, for writing the sidecars.
export const portChildIds = spliceResult =>
  Object.fromEntries((spliceResult?.ports ?? []).map(p => [p.id, p.childId]));

export { nodePorts };

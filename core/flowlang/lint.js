// Static linter for the Flow DSL — the machine gate that lets an AI (or CI)
// verify a workflow before it ever runs. Two layers, one result shape:
//
//   Layer 1  schema.json (structure, field types, allowed keys)   → errors
//   Layer 2  semantic rules on the canonical graph (this file)    → errors/warnings
//
// Findings: { rule, severity: 'error'|'warning', nodeId?, edge?, message }.
// ok === true means "no errors" (warnings allowed). Surfaces: the CLI
// (core/flowlang/cli.js), on-save validation in the app, and the pre-run
// gate in core/flowRunner.js (RUNTIME_RULES subset).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml.js';
import { parseFlow, parseEdgeExpr, FlowParseError } from './parse.js';
import { validate } from './validate.js';
import {
  ROLE_PORTS, knownTools, nodePorts, effectiveRole, isFeedbackEdge, forwardEdges,
  FEEDBACK_HANDLE, isStructuralType, resolveInstance, overridableFields
} from '../../src/flowTypes.js';
import { makeContext, expandRefs, resolveGrant, WILDCARD } from '../../src/toolGrants.js';
import { checkExpr } from './expr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));

// Override keys any template instance accepts; `tools` additionally requires
// the template's baseType to be agentTask (only the agent executor has tools).
const COMMON_OVERRIDES = [
  'title', 'worker', 'instructions', 'requiresApproval', 'approveToolCalls',
  'goal', 'category', 'contextSpec', 'skills',
  // The ceiling is legal wherever tools can be — and on an orchestrator, which
  // holds none itself but sets the envelope its children inherit (§6.3).
  'toolCeiling',
  // Combined-node options (node rework)
  'effort', 'evalType', 'language',
  // A whole-cloth system-prompt override (MODES-COMPARE T8: planner tiering as
  // data, not a code fork). resolveInstance carries it to data.system.
  'system'
];

// The declared output ports of a template (explicit outputs win, then role).
// The instance's evalType resolves the 'evaluation' meta-role, so an
// Evaluation node's ports follow the eval type it is set to.
function templatePorts(tpl, node = null) {
  if (Array.isArray(tpl?.outputs) && tpl.outputs.length) return tpl.outputs;
  const role = effectiveRole(tpl?.role, node?.overrides?.evalType ?? tpl?.evalType);
  return ROLE_PORTS[role] ?? ROLE_PORTS.custom;
}

const finding = (rule, severity, message, extra = {}) => ({ rule, severity, message, ...extra });

// --- Layer 2: semantic rules on the canonical flow object -------------------
//
// `templates`: normalized Node Library templates (NodeStore.listFull()), or
// null when the library is unavailable — template-dependent rules then skip
// rather than guess. `rules`: optional allowlist (the runner's gate uses it).
export function lintFlow(flow, { templates = null, rules = null, library = null } = {}) {
  const out = [];
  const on = rule => !rules || rules.includes(rule);
  const byId = new Map((flow.nodes ?? []).map(n => [n.id, n]));
  const tplById = templates ? new Map(templates.map(t => [t.id, t])) : null;
  // Grants are judged against the real tool library when one is supplied
  // (`{ tools, sets }` from ToolStore). Without it, the ceiling rules skip
  // rather than guess — the same contract template-dependent rules follow.
  const ctx = library ? makeContext({ library: library.tools ?? [], sets: library.sets ?? [] }) : null;
  const toolById = ctx ? ctx.byId : null;

  // The grant a node actually carries, judged on the RESOLVED node so a
  // template instance is read through its template.
  const grantOf = node => {
    const resolved = node.templateId
      ? (tplById ? (tplById.get(node.templateId) ? resolveInstance(node, tplById.get(node.templateId)) : null) : null)
      : node;
    if (!resolved) return null;
    const d = resolved.data ?? {};
    return { type: resolved.type, tools: d.tools ?? null, ceiling: d.toolCeiling ?? null, approveToolCalls: Boolean(d.approveToolCalls) };
  };

  // unknown-template / invalid-override / unknown-tool / orphan-approval
  for (const n of flow.nodes ?? []) {
    if (n.templateId) {
      const tpl = tplById?.get(n.templateId);
      if (tplById && !tpl && on('unknown-template')) {
        out.push(finding('unknown-template', 'error', `node "${n.id}": template "${n.templateId}" does not exist in the Node Library`, { nodeId: n.id }));
        continue;
      }
      const ov = n.overrides ?? {};
      if (tpl && on('invalid-override')) {
        // `tools` is no longer agentTask-only: an aiStep may hold read-effect
        // tools (§6.4), policed by effect in `readonly-tools` below.
        const allowed = new Set([...COMMON_OVERRIDES, 'tools']);
        for (const key of Object.keys(ov)) {
          if (!allowed.has(key)) {
            out.push(finding('invalid-override', 'error',
              `node "${n.id}": "${key}" is not a valid override for template "${tpl.id}"`,
              { nodeId: n.id }));
          }
        }
      }
      if (Array.isArray(ov.tools) && on('unknown-tool')) {
        for (const t of ov.tools) {
          if (!knownTools().includes(t)) {
            out.push(finding('unknown-tool', 'error', `node "${n.id}": tool "${t}" is not in the tool library (${knownTools().join(', ')})`, { nodeId: n.id }));
          }
        }
      }
    } else {
      const d = n.data ?? {};
      if (Array.isArray(d.tools) && on('unknown-tool')) {
        for (const t of d.tools) {
          if (!knownTools().includes(t)) {
            out.push(finding('unknown-tool', 'error', `node "${n.id}": tool "${t}" is not in the tool library (${knownTools().join(', ')})`, { nodeId: n.id }));
          }
        }
      }
      if ((n.type === 'input' || n.type === 'output') && d.requiresApproval && on('orphan-approval')) {
        out.push(finding('orphan-approval', 'warning', `node "${n.id}": requiresApproval has no effect on ${n.type} nodes`, { nodeId: n.id }));
      }
    }
  }

  // --- grants and ceilings (TOOLS-PLAN §6.4) ---------------------------------
  // Every rule here needs the real library to judge anything, so they all skip
  // together when it is absent. The alternative — guessing from ids — would
  // report a ceiling as broken because the linter hadn't been told what exists.
  if (ctx) {
    for (const n of flow.nodes ?? []) {
      const g = grantOf(n);
      if (!g) continue;

      // unknown-toolset: the ceiling names something that resolves to nothing
      // we know — a set that doesn't exist, or a malformed selector.
      const ceilingExp = expandRefs(g.ceiling, ctx);
      if (on('unknown-toolset')) {
        for (const p of ceilingExp.problems) {
          const what = p.kind === 'unknown-set' ? 'toolset' : p.kind === 'cycle' ? 'toolset (cyclic)' : p.kind === 'unknown-selector' ? 'selector' : 'tool';
          out.push(finding('unknown-toolset', 'error',
            `node "${n.id}": toolCeiling names a ${what} that does not exist: "${p.ref}"`, { nodeId: n.id }));
        }
      }

      // broad-ceiling: `*` is legal and sometimes right, but it should never
      // pass unremarked — it is the one ceiling that bounds nothing.
      if (on('broad-ceiling') && [].concat(g.ceiling ?? []).includes(WILDCARD)) {
        out.push(finding('broad-ceiling', 'warning',
          `node "${n.id}": toolCeiling is "*" — every tool in the library, including anything imported later`, { nodeId: n.id }));
      }

      // grant-exceeds-ceiling: the static grant reaches outside its envelope.
      // At run time the extra tools are refused and logged; at author time it
      // is simply a mistake, and saying so early is the whole point of a lint.
      if (on('grant-exceeds-ceiling') && g.ceiling && Array.isArray(g.tools)) {
        const { refused } = resolveGrant({ grant: g.tools, ceiling: g.ceiling, ctx });
        for (const r of refused) {
          out.push(finding('grant-exceeds-ceiling', 'error',
            `node "${n.id}": tool "${r.tool}" is granted but outside its toolCeiling (${[].concat(g.ceiling).join(', ')})`, { nodeId: n.id }));
        }
      }

      // child-exceeds-parent: a node inside an orchestrator may narrow the
      // envelope it inherits, never widen it. A node that decides what other
      // nodes may do must not be able to decide they may do more than it may.
      if (on('child-exceeds-parent') && n.parentId && g.ceiling) {
        const parent = byId.get(n.parentId);
        const parentGrant = parent ? grantOf(parent) : null;
        if (parentGrant?.ceiling) {
          const parentIds = expandRefs(parentGrant.ceiling, ctx).ids ?? new Set();
          for (const id of ceilingExp.ids ?? []) {
            if (!parentIds.has(id)) {
              out.push(finding('child-exceeds-parent', 'error',
                `node "${n.id}": toolCeiling admits "${id}", which its orchestrator "${n.parentId}" does not allow`, { nodeId: n.id }));
            }
          }
        }
      }

      // readonly-tools: an aiStep calls the model directly and may hold tools
      // now, but only ones that change nothing — a planner reads, it does not
      // write.
      if (on('readonly-tools') && g.type !== 'agentTask' && Array.isArray(g.tools)) {
        for (const id of g.tools) {
          const tool = toolById.get(id);
          if (tool && !(tool.effects ?? []).every(e => e === 'read')) {
            out.push(finding('readonly-tools', 'error',
              `node "${n.id}": tool "${id}" (${(tool.effects ?? []).join(', ')}) needs an agentTask — an ${g.type} may only hold read-effect tools`, { nodeId: n.id }));
          }
        }
      }

      // ungated-danger: a danger-risk tool with the per-call gate off. A
      // warning, not an error — D16 says the user may opt out, and this is the
      // reminder that they did.
      if (on('ungated-danger') && Array.isArray(g.tools) && !g.approveToolCalls) {
        for (const id of g.tools) {
          if (toolById.get(id)?.risk === 'danger') {
            out.push(finding('ungated-danger', 'warning',
              `node "${n.id}": grants "${id}" (danger) with approveToolCalls off — nothing will ask before it runs`, { nodeId: n.id }));
          }
        }
      }
    }
  }

  // parent — containment: a node may only live inside an orchestrator that
  // exists; structural (input/output) and orchestrator nodes can never be
  // contained (one level deep, mirroring the engine's spawn guard).
  if (on('parent')) {
    for (const n of flow.nodes ?? []) {
      if (!n.parentId) continue;
      const parent = byId.get(n.parentId);
      if (!parent) {
        out.push(finding('parent', 'error', `node "${n.id}": parent "${n.parentId}" does not exist`, { nodeId: n.id }));
      } else if (parent.type !== 'orchestrator' && parent.type !== 'loop') {
        // PIVOT-PLAN §5.3: a loop is a container too, and its body is contained
        // exactly the way an orchestrator's children are.
        out.push(finding('parent', 'error', `node "${n.id}": parent "${n.parentId}" is not a container — nodes can only live inside an orchestrator's or a loop's box`, { nodeId: n.id }));
      }
      if (isStructuralType(n.type) || n.type === 'orchestrator' || n.type === 'loop') {
        out.push(finding('parent', 'error', `node "${n.id}": ${n.type} nodes cannot live inside a container`, { nodeId: n.id }));
      }
    }
  }

  // unknown-node / unknown-port / duplicate-edge
  const seenEdges = new Map();
  for (const e of flow.edges ?? []) {
    const label = `${e.source}${e.sourceHandle ? '.' + e.sourceHandle : ''} -> ${e.target}`;
    for (const end of [e.source, e.target]) {
      if (!byId.has(end) && on('unknown-node')) {
        out.push(finding('unknown-node', 'error', `edge "${label}" references undeclared node "${end}"`, { edge: label }));
      }
    }
    const key = `${e.source} ${e.sourceHandle ?? ''} ${e.target}`;
    if (seenEdges.has(key) && on('duplicate-edge')) {
      out.push(finding('duplicate-edge', 'warning', `duplicate edge "${label}"`, { edge: label }));
    }
    seenEdges.set(key, true);
    // The feedback channel: every AI node has a 'feedback' source point; the
    // pinned structural nodes (input/output) do not send or receive feedback.
    if (isFeedbackEdge(e)) {
      if (on('feedback')) {
        const src = byId.get(e.source);
        const tgt = byId.get(e.target);
        if (src && isStructuralType(src.type)) {
          out.push(finding('feedback', 'error', `edge "${label}": ${src.type} nodes have no feedback point`, { edge: label, nodeId: e.source }));
        }
        if (tgt && isStructuralType(tgt.type)) {
          out.push(finding('feedback', 'error', `edge "${label}": feedback cannot target the ${tgt.type} node — point it at the AI node whose output "${e.source}" received`, { edge: label, nodeId: e.target }));
        }
      }
    } else if (e.sourceHandle && byId.has(e.source) && on('unknown-port')) {
      const src = byId.get(e.source);
      const ports = src.templateId
        ? (tplById ? (tplById.get(src.templateId) ? templatePorts(tplById.get(src.templateId), src) : null) : null)
        : nodePorts(src);
      if (ports && !ports.some(p => p.id === e.sourceHandle)) {
        out.push(finding('unknown-port', 'error',
          `edge "${label}": node "${e.source}" has no output port "${e.sourceHandle}" (declared: ${ports.map(p => p.id).join(', ') || 'none'})`,
          { edge: label, nodeId: e.source }));
      }
    }
  }

  // cycle — DFS over edges between declared nodes. Feedback edges point
  // backwards by design and are not part of the execution order.
  if (on('cycle')) {
    const adj = new Map([...byId.keys()].map(id => [id, []]));
    for (const e of forwardEdges(flow.edges)) {
      if (adj.has(e.source) && adj.has(e.target)) adj.get(e.source).push(e.target);
    }
    const state = new Map(); // 1 = visiting, 2 = done
    const cyclic = [];
    const visit = id => {
      state.set(id, 1);
      for (const next of adj.get(id)) {
        if (state.get(next) === 1) cyclic.push(`${id} -> ${next}`);
        else if (!state.has(next)) visit(next);
      }
      state.set(id, 2);
    };
    for (const id of adj.keys()) if (!state.has(id)) visit(id);
    for (const edge of cyclic) {
      out.push(finding('cycle', 'error', `graph has a cycle (back edge ${edge})`, { edge }));
    }
  }

  // no-input / no-output / unreachable / dead-end
  const inputs = (flow.nodes ?? []).filter(n => n.type === 'input');
  const outputs = (flow.nodes ?? []).filter(n => n.type === 'output');
  if (!inputs.length && on('no-input')) out.push(finding('no-input', 'error', 'flow has no input node (add "input -> ..." to flow)'));
  if (!outputs.length && on('no-output')) out.push(finding('no-output', 'error', 'flow has no output node (add "... -> output" to flow)'));

  const reach = (starts, next) => {
    const seen = new Set(starts);
    const stack = [...starts];
    while (stack.length) {
      for (const id of next(stack.pop())) if (!seen.has(id)) { seen.add(id); stack.push(id); }
    }
    return seen;
  };
  const fwd = new Map([...byId.keys()].map(id => [id, []]));
  const back = new Map([...byId.keys()].map(id => [id, []]));
  for (const e of flow.edges ?? []) {
    if (fwd.has(e.source) && fwd.has(e.target)) {
      fwd.get(e.source).push(e.target);
      back.get(e.target).push(e.source);
    }
  }
  // Containment counts as reachability. An orchestrator's children are reached
  // by explicit `orch -> child` edges, but PIVOT-PLAN §5.3's loop body is
  // reached by CONTAINMENT alone — the loop runs it, and there is no edge to
  // say so. Without this every loop body lints as unreachable and every loop
  // body's output as a dead end, which is a lie about a node the runner will
  // very much execute.
  for (const n of flow.nodes ?? []) {
    if (!n.parentId || !fwd.has(n.parentId) || !fwd.has(n.id)) continue;
    fwd.get(n.parentId).push(n.id);
    back.get(n.id).push(n.parentId);
    // The container's own output aggregates its children's, so a child's
    // output does reach whatever the container reaches.
    fwd.get(n.id).push(n.parentId);
    back.get(n.parentId).push(n.id);
  }
  if (inputs.length && on('unreachable')) {
    const reachable = reach(inputs.map(n => n.id), id => fwd.get(id) ?? []);
    for (const n of flow.nodes ?? []) {
      if (!reachable.has(n.id)) {
        out.push(finding('unreachable', 'error', `node "${n.id}" is not reachable from any input node`, { nodeId: n.id }));
      }
    }
  }
  if (outputs.length && on('dead-end')) {
    const reaches = reach(outputs.map(n => n.id), id => back.get(id) ?? []);
    for (const n of flow.nodes ?? []) {
      if (!reaches.has(n.id) && n.type !== 'output') {
        out.push(finding('dead-end', 'warning', `output of node "${n.id}" never reaches an output node`, { nodeId: n.id }));
      }
    }
  }

  // mode — named launch-override bundles (MODES-COMPARE T2). A mode override
  // pointing at a node that no longer exists warns (a rename or deletion left
  // it stranded); an override field the target node cannot accept is an error
  // (the runner would reject it at run start, so surface it at author time).
  // Fields are judged on the RESOLVED node so an instance's runtime shape
  // (its template's baseType/role) governs what is overridable.
  if (on('mode') && flow.modes) {
    for (const [modeId, mode] of Object.entries(flow.modes)) {
      // derivedFrom (CONFIGS-COMPARE P1) is lineage metadata only — no merge
      // semantics — but a reference to a mode that no longer exists is a stale
      // lineage link worth surfacing.
      const df = mode?.derivedFrom;
      if (typeof df === 'string' && df && !(df in flow.modes)) {
        out.push(finding('mode', 'warning', `mode "${modeId}" derives from "${df}", which is not a mode of this flow`));
      }
      for (const [nodeId, fields] of Object.entries(mode?.overrides ?? {})) {
        const node = byId.get(nodeId);
        if (!node) {
          out.push(finding('mode', 'warning', `mode "${modeId}" overrides node "${nodeId}", which is not in the flow`, { nodeId }));
          continue;
        }
        const resolved = node.templateId
          ? (tplById ? resolveInstance(node, tplById.get(node.templateId)) : null)
          : node;
        if (!resolved) continue; // library unavailable — can't judge fields
        const allowed = overridableFields(resolved);
        for (const key of Object.keys(fields ?? {})) {
          if (!allowed.has(key)) {
            out.push(finding('mode', 'error',
              allowed.size
                ? `mode "${modeId}": "${key}" is not overridable on node "${nodeId}" (allowed: ${[...allowed].join(', ')})`
                : `mode "${modeId}": node "${nodeId}" (${resolved.type}) accepts no overrides`,
              { nodeId }));
          }
        }
      }
    }
  }

  // expose (MODES-COMPARE T9): each field a node exposes as a composer run
  // input must be overridable on that node — otherwise the composer would draw
  // a control the runner rejects at launch. Judged on the resolved node.
  if (on('expose')) {
    for (const n of flow.nodes ?? []) {
      const declared = n.expose;
      if (!Array.isArray(declared) || !declared.length) continue;
      const resolved = n.templateId
        ? (tplById ? resolveInstance(n, tplById.get(n.templateId)) : null)
        : n;
      if (!resolved) continue; // library unavailable — can't judge fields
      const allowed = overridableFields(resolved);
      for (const f of declared) {
        if (!allowed.has(f)) {
          out.push(finding('expose', 'error',
            allowed.size
              ? `node "${n.id}": exposed field "${f}" is not overridable (allowed: ${[...allowed].join(', ')})`
              : `node "${n.id}" (${resolved.type}) has no overridable fields to expose`,
            { nodeId: n.id }));
        }
      }
    }
  }

  // --- Control flow (PIVOT-PLAN §5.3) — four new rules ------------------------
  //
  // Unbounded iteration against a metered API is the one way this feature
  // becomes a liability, and lint is the place to stop it. Three of these four
  // are errors for that reason; the fourth (an unreachable arm) is a warning,
  // because a flow with a dead arm still runs correctly — it just contains a
  // line its author probably didn't mean.

  // unbounded-loop — every loop declares a bound, or lint fails.
  if (on('unbounded-loop')) {
    for (const n of flow.nodes ?? []) {
      if (n.type !== 'loop') continue;
      const d = n.data ?? {};
      const max = Number(d.maxIterations);
      if (!Number.isInteger(max) || max < 1) {
        out.push(finding('unbounded-loop', 'error',
          `loop "${n.id}": maxIterations is required and must be at least 1 — a loop without a bound can spend without limit`,
          { nodeId: n.id }));
      } else if (max > 100) {
        out.push(finding('unbounded-loop', 'error',
          `loop "${n.id}": maxIterations ${max} exceeds the hard cap of 100`, { nodeId: n.id }));
      }
      // A cost budget is the belt to maxIterations's suspenders. §11 says it
      // "probably shouldn't stay optional"; a warning is the honest middle —
      // loud enough to notice, not a wall in front of a two-iteration loop.
      if (max > 3 && d.maxCost == null && d.maxTokens == null) {
        out.push(finding('unbounded-loop', 'warning',
          `loop "${n.id}": ${max} iterations with no maxCost or maxTokens — a bounded loop is only as safe as its bound`,
          { nodeId: n.id }));
      }
      const body = (flow.nodes ?? []).filter(c => c.parentId === n.id);
      if (!body.length) {
        out.push(finding('unbounded-loop', 'warning',
          `loop "${n.id}" has no nodes inside it — it will complete immediately`, { nodeId: n.id }));
      }
    }
  }

  // loop-no-exit — a loop that can only ever stop by exhausting its bound.
  // Legal (the bound IS an exit) but almost always a mistake: it means every
  // run pays for every iteration whether or not the work was already done.
  if (on('loop-no-exit')) {
    for (const n of flow.nodes ?? []) {
      if (n.type !== 'loop') continue;
      const until = n.data?.until;
      if (until == null || String(until).trim() === '') {
        out.push(finding('loop-no-exit', 'warning',
          `loop "${n.id}" has no \`until\` condition — it will always run its full ${n.data?.maxIterations ?? '?'} iterations`,
          { nodeId: n.id }));
        continue;
      }
      const check = checkExpr(String(until));
      if (!check.ok) {
        out.push(finding('loop-no-exit', 'error',
          `loop "${n.id}": \`until\` is not a valid condition — ${check.error}`, { nodeId: n.id }));
        continue;
      }
      // A condition reading a node that isn't in this loop's body (or anywhere
      // in the flow) can never become true from inside the loop.
      const bodyIds = new Set((flow.nodes ?? []).filter(c => c.parentId === n.id).map(c => c.id));
      for (const segments of check.paths) {
        const root = segments[0];
        if (root === 'loop' || root === 'run') continue;
        if (!byId.has(root)) {
          out.push(finding('loop-no-exit', 'error',
            `loop "${n.id}": \`until\` reads "${root}", which is not a node in this flow`, { nodeId: n.id }));
        } else if (!bodyIds.has(root)) {
          out.push(finding('loop-no-exit', 'warning',
            `loop "${n.id}": \`until\` reads "${root}", which is outside the loop body — nothing the loop does can change it`,
            { nodeId: n.id }));
        }
      }
    }
  }

  // branch-no-default — a branch whose every arm is conditional can match
  // nothing, and a branch that matches nothing wedges the run. Cheap to fix
  // (one arm without a `when`), expensive to discover at 2am.
  if (on('branch-no-default')) {
    for (const n of flow.nodes ?? []) {
      if (n.type !== 'branch') continue;
      const arms = Array.isArray(n.data?.arms) ? n.data.arms : [];
      if (!arms.length) {
        out.push(finding('branch-no-default', 'error',
          `branch "${n.id}" declares no arms — it has nothing to decide between`, { nodeId: n.id }));
        continue;
      }
      if (!arms.some(a => a && (a.when == null || String(a.when).trim() === ''))) {
        out.push(finding('branch-no-default', 'error',
          `branch "${n.id}" has no default arm — add one arm with no \`when\`, or the run stops here when nothing matches`,
          { nodeId: n.id }));
      }
      for (const [i, arm] of arms.entries()) {
        if (!arm?.when) continue;
        const check = checkExpr(String(arm.when));
        if (!check.ok) {
          out.push(finding('branch-no-default', 'error',
            `branch "${n.id}" arm ${i + 1}: not a valid condition — ${check.error}`, { nodeId: n.id }));
          continue;
        }
        for (const segments of check.paths) {
          const root = segments[0];
          if (root === 'loop' || root === 'run') continue;
          if (!byId.has(root)) {
            out.push(finding('branch-no-default', 'error',
              `branch "${n.id}" arm ${i + 1}: reads "${root}", which is not a node in this flow`, { nodeId: n.id }));
          }
        }
      }
    }
  }

  // unreachable-arm — an arm pointing somewhere the branch has no edge to,
  // an arm after the default (which can never be reached), or a duplicate.
  if (on('unreachable-arm')) {
    for (const n of flow.nodes ?? []) {
      if (n.type !== 'branch') continue;
      const arms = Array.isArray(n.data?.arms) ? n.data.arms : [];
      const targets = new Set(forwardEdges(flow.edges ?? []).filter(e => e.source === n.id).map(e => e.target));
      let sawDefault = false;
      const seen = new Set();
      for (const [i, arm] of arms.entries()) {
        const to = arm?.to;
        if (!to) continue;
        if (!targets.has(to)) {
          out.push(finding('unreachable-arm', 'error',
            `branch "${n.id}" arm ${i + 1} points at "${to}", but there is no edge "${n.id} -> ${to}" in the flow section`,
            { nodeId: n.id }));
        }
        if (seen.has(to)) {
          out.push(finding('unreachable-arm', 'warning',
            `branch "${n.id}" has two arms pointing at "${to}" — only the first can ever be taken`, { nodeId: n.id }));
        }
        seen.add(to);
        if (sawDefault) {
          out.push(finding('unreachable-arm', 'warning',
            `branch "${n.id}" arm ${i + 1} sits after the default arm and can never be reached`, { nodeId: n.id }));
        }
        if (arm.when == null || String(arm.when).trim() === '') sawDefault = true;
      }
      // Every outgoing edge should be claimed by an arm; one that isn't is a
      // path the branch will always skip.
      for (const t of targets) {
        if (!seen.has(t)) {
          out.push(finding('unreachable-arm', 'warning',
            `branch "${n.id}" has an edge to "${t}" that no arm selects — that path can never run`, { nodeId: n.id }));
        }
      }
    }
  }

  return result(out);
}

// --- Layer 1 + 2: lint DSL text ---------------------------------------------
export function lintText(text, { templates = null, library = null } = {}) {
  let doc;
  try { doc = parseYaml(text); }
  catch (err) {
    return result([finding('parse', 'error', err.message)]);
  }
  const schemaErrors = validate(SCHEMA, doc).map(e =>
    finding('schema', 'error', `${e.path}: ${e.message}`));
  if (schemaErrors.length) return result(schemaErrors);

  let flow;
  try { flow = parseFlow(text); }
  catch (err) {
    if (err instanceof FlowParseError) return result([finding('parse', 'error', err.message)]);
    throw err;
  }

  // duplicate edges are invisible after parse (it dedupes) — count them here
  const out = [];
  const counts = new Map();
  for (const expr of doc.flow ?? []) {
    try {
      for (const e of parseEdgeExpr(expr)) {
        const key = `${e.source} ${e.sourceHandle ?? ''} ${e.target}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (counts.get(key) === 2) {
          out.push(finding('duplicate-edge', 'warning', `duplicate edge "${e.source}${e.sourceHandle ? '.' + e.sourceHandle : ''} -> ${e.target}"`));
        }
      }
    } catch { /* parseFlow above would have thrown */ }
  }

  const semantic = lintFlow(flow, { templates, library });
  return result([...out, ...semantic.findings]);
}

function result(findings) {
  return {
    ok: !findings.some(f => f.severity === 'error'),
    errors: findings.filter(f => f.severity === 'error'),
    warnings: findings.filter(f => f.severity === 'warning'),
    findings
  };
}

// The pre-run gate (core/flowRunner.js): only rules whose violation would
// corrupt or wedge a run. Shape rules (no-input/no-output/unreachable/dead-end)
// stay author-time concerns — the runner has always tolerated partial flows.
// grant-exceeds-ceiling and child-exceeds-parent are here because the runtime
// refuses those grants anyway (§5.3) — failing the run at the gate with a
// message beats starting one whose nodes quietly lose their tools.
export const RUNTIME_RULES = [
  'unknown-template', 'unknown-node', 'unknown-port', 'cycle', 'unknown-tool', 'invalid-override', 'parent',
  'unknown-toolset', 'grant-exceeds-ceiling', 'child-exceeds-parent', 'readonly-tools',
  // PIVOT-PLAN §5.3: an unbounded loop overspends and a defaultless branch
  // wedges the walk. Both are exactly the class this gate exists for.
  'unbounded-loop', 'branch-no-default', 'unreachable-arm'
];

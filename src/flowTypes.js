// Shared metadata for flow-definition node types, used by the canvas editor
// and the inspector. kind 'user' = user-authored box, 'ai' = AI-run box.
export const TYPE_META = {
  input:     { icon: '✎', kind: 'user', label: 'Input',      sub: 'brief · user text' },
  agentTask: { icon: '☑', kind: 'user', label: 'Agent task', sub: 'task · for the executor' },
  aiStep:    { icon: '✦', kind: 'ai',   label: 'AI step',    sub: 'llm · model call' },
  output:    { icon: '◎', kind: 'user', label: 'Output',     sub: 'result · collects upstream' }
};

export const AI_ROLES = ['plan', 'execute', 'verify', 'custom'];

export function nodeLabel(node) {
  return node.data?.title?.trim() || TYPE_META[node.type]?.label || node.type;
}

export function nodeSub(node) {
  const w = node.data?.worker;
  const workerText = w?.provider ? `${w.provider}/${w.model}` : 'default worker';
  if (node.type === 'aiStep') return `${node.data?.role ?? 'custom'} · ${workerText}`;
  if (node.type === 'agentTask') return `task · ${workerText}`;
  return TYPE_META[node.type]?.sub ?? '';
}

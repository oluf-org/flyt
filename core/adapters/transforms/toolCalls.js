/** Canonical provider-neutral tool call normalization. */

export function normalizeToolName(raw, offered = []) {
  const requested = String(raw ?? '').trim();
  if (!requested) return '';
  if (offered.includes(requested)) return requested;
  const matches = offered.filter(name => name.toLowerCase() === requested.toLowerCase());
  return matches.length === 1 ? matches[0] : requested;
}

export function normalizeToolArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return { _unparsed: JSON.stringify(raw) };
  let value = raw.trim();
  if (!value) return {};
  // Some relays double-encode function arguments. Bound the unwrap so a model
  // cannot turn normalization into an unbounded parser loop.
  for (let depth = 0; depth < 2; depth++) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') { value = parsed; continue; }
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : { _unparsed: value };
    } catch { return { _unparsed: value }; }
  }
  return { _unparsed: value };
}

export function normalizeToolCalls(calls, offered = []) {
  return (Array.isArray(calls) ? calls : []).map((call, index) => ({
    id: String(call?.id ?? `call-${index}`),
    name: normalizeToolName(call?.function?.name ?? call?.name, offered),
    args: normalizeToolArguments(call?.function?.arguments ?? call?.arguments ?? call?.args),
  }));
}

/** Reassembles interleaved partial tool arguments by provider call index. */
export class ToolCallAccumulator {
  #calls = new Map();

  push(fragment = {}) {
    const index = Number.isInteger(fragment.index) ? fragment.index : 0;
    const fresh = !this.#calls.has(index);
    const call = this.#calls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (fragment.id) call.id = String(fragment.id);
    if (fragment.type) call.type = fragment.type;
    if (fragment.function?.name) call.function.name += String(fragment.function.name);
    if (fragment.function?.arguments != null) call.function.arguments += String(fragment.function.arguments);
    this.#calls.set(index, call);
    return { index, fresh, call };
  }

  entries() { return [...this.#calls.entries()].sort((a, b) => a[0] - b[0]); }
  values() { return this.entries().map(([, call]) => call); }
  get size() { return this.#calls.size; }
}

export function settleInterruptedToolCalls(accumulator) {
  return accumulator.entries().map(([index, call]) => ({
    index, id: call.id || `interrupted-${index}`, name: call.function.name,
    arguments: call.function.arguments, state: 'interrupted',
  }));
}

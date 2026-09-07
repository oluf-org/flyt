import type { JsonValue } from '../types.js';

/** Decode complete items, never the individual lines inside a JSON task. */
export function parseListOutput(content: string, field: string): JsonValue[] {
  const text = content.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\s*```$/, '').trim();
  if (!text) return [];
  if (/^[\[{]/.test(text)) {
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new Error(`The ${field} output must be a valid JSON array of complete items.`); }
    if (value && typeof value === 'object' && !Array.isArray(value)) value = (value as Record<string, unknown>)[field];
    if (!Array.isArray(value) || value.some(item => item === null || !['string', 'object'].includes(typeof item)
      || Array.isArray(item) || (typeof item === 'string' && !item.trim()))) {
      throw new Error(`The ${field} output must be a JSON array of non-empty strings or task objects.`);
    }
    return value as JsonValue[];
  }
  // Compatibility for existing models/overrides that return Markdown. Keep
  // each task heading and its detail paragraphs together instead of sending
  // "Acceptance criteria:" to a foreach worker as an independent assignment.
  const lines = text.split(/\r?\n/);
  const headings = lines.map((line, index) => ({ index, match: /^(#{1,6})\s+(.+)$/.exec(line) }))
    .filter(item => item.match && !/^(?:tasks?|parts?|plan|backlog|implementation plan)\s*[:.]?$/i.test(item.match[2].trim()));
  if (headings.length >= 1) {
    const level = Math.min(...headings.map(item => item.match![1].length));
    const starts = headings.filter(item => item.match![1].length === level).map(item => item.index);
    return starts.map((start, index) => lines.slice(start, starts[index + 1]).join('\n').trim());
  }
  const starts = lines.flatMap((line, index) => /^(?:\d+[.)]|[-*])\s+\S/.test(line) ? [index] : []);
  if (starts.length >= 1) return starts.map((start, index) => lines.slice(start, starts[index + 1]).join('\n').trim());
  return lines.map(line => line.trim()).filter(Boolean);
}

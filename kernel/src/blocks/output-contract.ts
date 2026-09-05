/** Explicit numeric word ceilings; other prose requirements remain unverified. */
export function outputWordLimit(configured: unknown, brief = ''): number | undefined {
  const limits: number[] = [];
  if (typeof configured === 'number' && Number.isInteger(configured) && configured > 0) limits.push(configured);
  for (const match of brief.matchAll(/\b(under|below|fewer than|at most|no more than)\s+(\d+)\s+words\b/gi)) {
    const limit = Number(match[2]) - (/under|below|fewer than/i.test(match[1]) ? 1 : 0);
    if (Number.isSafeInteger(limit) && limit > 0) limits.push(limit);
  }
  return limits.length ? Math.min(...limits) : undefined;
}

export const EVIDENCE_INSTRUCTIONS = 'Cite only line numbers supplied by numbered source reads; never estimate line numbers from a partial preview. Identify unverified coverage. A successful task status does not verify every requested constraint. Claim constraint compliance only when supported by recorded execution facts or an explicit check; otherwise say it is unverified.';

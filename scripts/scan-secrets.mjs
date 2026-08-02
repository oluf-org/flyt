// PIVOT-PLAN §9, verification item 2: "No secret ever reaches disk."
//
// Wire records are the most valuable and most dangerous artifact in the app —
// they carry the full text of everything sent to a model, which on a coding run
// means source code and, sooner or later, a credential someone pasted into a
// prompt. Redaction is centralised in core/tools/redact.js; this is the check
// that it actually held.
//
//   npm run scan:secrets            # scan every runs/ directory it can find
//   npm run scan:secrets -- <dir>   # scan one tree
//
// Exit code 1 on any hit, so CI fails the build. The scan reads the SAME rule
// the writer uses, so a shape the redactor learns about is a shape the scan
// learns about, and the two can never drift apart.
import fs from 'node:fs';
import path from 'node:path';
import { redactText, REDACTED } from '../core/tools/redact.js';

const roots = process.argv.slice(2);
if (!roots.length) {
  // Default sweep: the repo's own runs/, plus any project-local ones.
  for (const d of ['runs', 'test-runs']) if (fs.existsSync(d)) roots.push(d);
}

if (!roots.length) {
  console.log('scan-secrets: nothing to scan (no runs/ directory).');
  process.exit(0);
}

let files = 0;
const hits = [];

for (const root of roots) walk(root);

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    // Every artifact a run writes, not just the ledger: a leak in log.jsonl is
    // the same incident as a leak in a wire file.
    if (!/\.(json|jsonl|md|txt)$/i.test(e.name)) continue;
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    files += 1;
    const redacted = redactText(text);
    if (redacted === text) continue;
    // Something credential-shaped survived. Report WHERE, never WHAT.
    hits.push({ file: p, line: lineOfFirstDiff(text, redacted), count: redacted.split(REDACTED).length - 1 });
  }
}

// The line at which redaction first changed the text — enough to locate the
// leak without ever printing the credential itself.
function lineOfFirstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a.slice(0, i).split('\n').length;
  }
  return a.slice(0, n).split('\n').length;
}

if (hits.length) {
  console.error(`scan-secrets: FAILED — credential-shaped text survived redaction in ${hits.length} file(s):`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  (${h.count} match(es))`);
  console.error('\nThe value itself is deliberately not printed. Fix core/tools/redact.js, then delete the affected runs.');
  process.exit(1);
}

console.log(`scan-secrets: OK — ${files} file(s) scanned across ${roots.join(', ')}, no credential shapes found.`);

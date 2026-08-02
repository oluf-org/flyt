// Catalog maintenance aid (SETTINGS-MODELS-PLAN §2, "Catalog maintenance").
// Fetches OpenRouter's live model list, maps ids back onto the bundled catalog
// where possible, and prints what drifted: new upstream ids the bundled file
// doesn't know, and price differences on ids it does.
//
// This is a human-run bump helper — it is NOT run at app start. Usage:
//
//   OPENROUTER_API_KEY=sk-or-... npm run catalog -- check
//
// or pass the key as the next argument:  npm run catalog -- check sk-or-...
// Without a key the script only validates and summarises the bundled file.

import { MODEL_CATALOG, bundledIdForOpenRouterId, validateCatalog } from '../core/modelCatalog.js';
import { PROVIDER_IDS } from '../core/modelSource.js';

const [command, keyArg] = process.argv.slice(2);
if (command !== 'check') {
  console.error('usage: npm run catalog -- check [openrouter-key]');
  process.exit(2);
}
const apiKey = keyArg ?? process.env.OPENROUTER_API_KEY;

// 1. The bundled file must be structurally sound before any diff is meaningful.
const problems = validateCatalog({ knownProviders: PROVIDER_IDS });
if (problems.length) {
  console.error(`Bundled catalog has ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Bundled catalog: ${MODEL_CATALOG.length} records, validation clean.`);

if (!apiKey) {
  console.log('No OpenRouter key (OPENROUTER_API_KEY or second argument) — skipping the live diff.');
  process.exit(0);
}

// 2. Live diff.
const res = await fetch('https://openrouter.ai/api/v1/models', {
  headers: { Authorization: `Bearer ${apiKey}` }
});
if (!res.ok) {
  console.error(`OpenRouter models ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const { data } = await res.json();
console.log(`OpenRouter live: ${data.length} models.`);

let drift = 0;
for (const m of data) {
  const bundledId = bundledIdForOpenRouterId(m.id);
  const liveIn = m.pricing?.prompt != null ? Number(m.pricing.prompt) * 1e6 : null;
  const liveOut = m.pricing?.completion != null ? Number(m.pricing.completion) * 1e6 : null;
  if (!bundledId) continue; // aggregator-only routes aren't bundled by design
  const rec = MODEL_CATALOG.find(r => r.id === bundledId);
  if (!rec?.price || rec.price.kind === 'plan') continue;
  const tol = 0.005; // ignore sub-half-cent jitter
  const inDrift = liveIn != null && rec.price.input != null && Math.abs(liveIn - rec.price.input) / Math.max(rec.price.input, 1e-9) > tol;
  const outDrift = liveOut != null && rec.price.output != null && Math.abs(liveOut - rec.price.output) / Math.max(rec.price.output, 1e-9) > tol;
  if (inDrift || outDrift) {
    drift++;
    console.log(`PRICE DRIFT  ${bundledId}  (upstream ${m.id})`);
    console.log(`  bundled  in $${rec.price.input}  out $${rec.price.output}`);
    console.log(`  live     in $${liveIn?.toFixed(4)}  out $${liveOut?.toFixed(4)}`);
  }
}

// Upstream ids from anthropic/openai that the bundled file doesn't know at
// all — the "did the provider ship something new?" list for the next bump.
const watched = new Set(['anthropic', 'openai']);
const unknown = data
  .filter(m => watched.has(String(m.id).split('/')[0]) && !bundledIdForOpenRouterId(m.id))
  .map(m => m.id);
if (unknown.length) {
  console.log(`\nUpstream ids with no bundled record (${unknown.length}):`);
  for (const id of unknown) console.log(`  + ${id}`);
}

console.log(drift ? `\n${drift} price drift(s) — consider bumping core/modelCatalog.js.`
                  : '\nNo price drift on bundled ids.');

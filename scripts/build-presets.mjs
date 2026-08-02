// Generate presets/ from the in-code definitions (PIVOT-PLAN §5.1).
//
//   node scripts/build-presets.mjs
//
// The ten node templates and five pipelines used to be INSTALLED on first
// launch — SEED_NODE_TEMPLATES seeded nodes/, and FlowStore's builders seeded
// flows/. Decision 4 demotes them to presets: offered inside *Create node* and
// *Create flow*, never installed. This script is how the code definitions
// became the files under presets/.
//
// It is idempotent and safe to re-run: it rewrites presets/ from the current
// definitions. Once a preset has been hand-edited as a file, stop running it —
// the files are the source of truth from that point, which is the whole reason
// they are files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESET_NODE_TEMPLATES } from '../src/flowTypes.js';
import { FlowStore, SEED_PIPELINE_IDS, DEFAULT_PIPELINE_ID } from '../core/flowstore.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodesOut = path.join(root, 'presets', 'nodes');
const flowsOut = path.join(root, 'presets', 'flows');
fs.mkdirSync(nodesOut, { recursive: true });
fs.mkdirSync(flowsOut, { recursive: true });

for (const tpl of PRESET_NODE_TEMPLATES) {
  fs.writeFileSync(path.join(nodesOut, `${tpl.id}.json`), JSON.stringify(tpl, null, 2) + '\n', 'utf8');
}

// The pipeline builders write through a FlowStore, so they run against a temp
// one and the resulting .flow.yaml + .layout.json are copied out. That keeps
// one serializer — the DSL's — rather than a second one here that could drift.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-presets-'));
const store = new FlowStore(tmp);
store.ensureDefaultPipeline();
store.ensureSeedPipelines();
for (const id of [DEFAULT_PIPELINE_ID, ...SEED_PIPELINE_IDS]) {
  for (const ext of ['.flow.yaml', '.layout.json']) {
    const src = path.join(tmp, `${id}${ext}`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(flowsOut, `${id}${ext}`));
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`Wrote ${PRESET_NODE_TEMPLATES.length} node preset(s) to presets/nodes/`);
console.log(`Wrote ${1 + SEED_PIPELINE_IDS.length} flow preset(s) to presets/flows/`);

#!/usr/bin/env node
// Watch a loop that is running somewhere else.
//
// `flyt loop start` prints its own status while it holds the terminal, which is
// no use once it is detached or was started from the app. This reads the
// published status (`.flyt/loop-status.json`, LOOP-PLAN §11.1) and the backlog,
// and appends ONE line per change to stdout.
//
// Per change, not per tick: a watcher that prints every poll buries the four
// lines that matter in six hundred that say the same thing. Silence here means
// nothing moved, which is itself the answer most of the time.
//
//   node scripts/loop-watch.mjs [--project <dir>] [--every 15] [--once]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const projectDir = path.resolve(flag('project', process.cwd()));
const everyMs = Number(flag('every', 15)) * 1000;
const once = args.includes('--once');

const statusFile = path.join(projectDir, '.flyt', 'loop-status.json');
const backlogDir = path.join(projectDir, '.flyt', 'backlog');

const read = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

// Task status, straight from the frontmatter. Deliberately a regex rather than
// the real parser: this is a read-only observer and it must not fail on a file
// the supervisor happens to be rewriting as we look at it.
function backlog() {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(backlogDir).filter(f => f.endsWith('.task.md')); } catch { return out; }
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(backlogDir, f), 'utf8'); } catch { continue; }
    const id = f.slice(0, -'.task.md'.length);
    out[id] = {
      status: (/^status: (.*)$/m.exec(text) ?? [])[1]?.trim() ?? '?',
      level: (/^level: (.*)$/m.exec(text) ?? [])[1]?.trim() ?? '?',
      attempts: (/^attempts: (.*)$/m.exec(text) ?? [])[1]?.trim() ?? '0'
    };
  }
  return out;
}

const stamp = () => new Date().toTimeString().slice(0, 8);
const say = line => console.log(`${stamp()}  ${line}`);

let previous = null;

function tick() {
  const status = read(statusFile);
  const tasks = backlog();
  const counts = {};
  for (const t of Object.values(tasks)) counts[t.status] = (counts[t.status] ?? 0) + 1;

  const flight = (status?.inFlight ?? [])
    .map(h => `${h.taskId}@${(h.model ?? h.level ?? '?').split('/').pop()}` +
      `/${h.stage ?? '?'}/${Math.round((h.ageMs ?? 0) / 60000)}m` +
      (h.idleMs > 60_000 ? `/idle${Math.round(h.idleMs / 60000)}m` : '') +
      (h.interventions?.length ? `/${h.interventions.join('+')}` : ''))
    .join(' ');

  const line = [
    status?.running ? 'RUN' : 'off',
    `landed=${status?.landed ?? 0}/${status?.completed ?? 0}`,
    `$${((status?.spend ?? {}).usd ?? 0).toFixed(2)}`,
    Object.entries(counts).sort().map(([k, v]) => `${k}:${v}`).join(' '),
    flight
  ].join('  ').trim();

  // Only when something moved. The one exception is the first line, so a
  // watcher started mid-run says where it came in.
  if (line !== previous) { say(line); previous = line; }
  if (status && !status.running && previous !== null && !once) {
    say(`stopped: ${status.stopping ?? 'idle'}`);
    process.exit(0);
  }
}

tick();
if (!once) setInterval(tick, everyMs);

#!/usr/bin/env node
// The headless front door (DESIGN-SPEC.md §8).
//
// `flyt` stands the engine up in a plain node process — no Electron, no window
// — and drives it through the same command map the renderer uses. This is the
// day-1 deliverable: a run can be started from a terminal with the app closed,
// which is the precondition for a supervisor that keeps working while nobody
// is watching.
//
// Every command takes --json and writes machine-readable output to stdout,
// human text to stderr. That split is the whole "interface easiest for an AI to
// access" requirement: an AI already knows how to run a CLI and parse JSON, and
// keeping the two streams apart means it never has to.
//
// The precedent is core/flowlang/cli.js — an AI authors a flow, lints until
// `ok: true`, and the app picks it up.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { createApi, ApiError } from '../core/api.js';
import { createServer } from '../core/server.js';
import { defaultUserDataDir } from '../core/brand.js';
import { renderQuestions } from '../core/flowRunner.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `flyt — drive Flyt without the desktop app

  flyt flows                          list workflows
  flyt tools [list]                   the tool library
  flyt tools show <id>                one tool, schema included
  flyt tools run <id> --arg k=v       call it once, right now (--yes for write/shell)
  flyt tools problems                 definitions the library could not bind
  flyt tools suites                   the tool suites in benchmark/tools/
  flyt tools bench <suite>            the same cases through several tools, measured
  flyt python status [--packages a,b] the sidecar interpreter, and what it has
  flyt python setup --packages a,b    build/repair the managed environment
  flyt run <flow> --input "<text>"    start a run and wait for it to settle
  flyt run <flow> --in repo=<url>     supply a typed run input (repeatable)
  flyt runs                           list runs in the current project
  flyt snapshot <runId>               the run's current state
  flyt log <runId> [--quiet]          the run's event log (--event a,b --node n --tail N)
  flyt approve|reject|stop <runId>    answer a gate or stop a run
  flyt answer <runId> "<text>"        reply to a node that stopped to ask
                                      (waits for the run, and shows the next round)
  flyt why [<runId>]                  why a run failed or stalled (default: latest)
  flyt probe <model>...               call a model once and report what came back
  flyt doctor [--flow <id>] [--probe] providers, priority, library — and the models a flow pins
  flyt task add "<title>" --goal "<what>"   queue a task for a later run
                  [--done "<criterion>"]... [--gates "npm test"] [--skill <name>]
                  [--blast <path,path>] [--references <ref,ref>] [--level <l>]
  flyt task list [--status queued]    the backlog
  flyt task show <id>                 one task, in full
  flyt task ready                     what the picker would take, and what is stuck
  flyt task escalate <id>             one effort level up, back to the queue
  flyt task rm <id>... [--all]        take tasks out of the queue for good
  flyt task take                      claim the top-scoring ready task
  flyt loop start [--parallel N] [--model <id> | --models low=a,high=b] [--reviewer <id>]
                  [--cap-usd 6] [--soft-usd 4] [--task-usd 1.5] [--only t-0001,t-0002]
                                      work the backlog until empty, capped or stopped
                                      (--only: just these tasks, same picker order)
                                      (the caps are THIS session's spend, from now)
  flyt loop stop|status               stop it, or see what it is doing
  flyt report                         what landed, what needs you, what it cost
  flyt spend [--since 24h]            the ledger
  flyt bench list                     the benchmark suite and its probes
  flyt bench run [--only a,b] [--keep] clone, work the suite, score it
  flyt bench status|cards|show        the in-flight run, past cards, one card
  flyt bench compare [<a> <b>]        the gradient: better, cheaper, or worse
  flyt archive write [--date d]       freeze today: ledger, scores, commits, piles
  flyt archive list|trend             the archived days, and the direction
  flyt work start <taskId>            worktree + branch for a task
  flyt work verify <taskId>           run the gates in it (the harness runs them)
  flyt work land <taskId> [--dry-run|--push]  gates -> review -> merge -> canary
  flyt work discard <taskId> [--attempt <id>]  throw the worktree away
  flyt work reconcile                 list orphaned worktrees and owner records
  flyt ref list                       the reference library (§16)
  flyt ref update [<name>]            shallow-clone or refresh it
  flyt ref grep <pattern> [--repo r]  search it
  flyt ref show <reference:repo/path> read one file out of it
  flyt feedback stats                 what instances reported about the toolbox
  flyt feedback preview               the digest as it would read right now
  flyt feedback digest [--enqueue]    write the digest, archive what it covered
  flyt serve [--port 7867]            run the HTTP API + event stream
  flyt call <command> [--arg k=v]     invoke any command directly
  flyt commands                       list every command

Options
  --project <dir>   project folder to bind (default: cwd)
  --json            machine-readable output on stdout
  --token <t>       bearer token for serve (default: generated and printed)
  --approval <m>    ask | smart | always   (default: the saved setting)
  --gates approve   auto-approve node gates while waiting (unattended)
  --answer <text>   reply to a question the run asks; repeatable, one per round
  --timeout <sec>   how long to wait for a run to settle (default 1800)
  --goal <text>     what a queued task must achieve
  --value/--effort  1-5, feeding the picker's score (default 3 each)
  --level <l>       low|medium|high|xhigh|max — the OpenRouter cost band
`;

// --- argv ------------------------------------------------------------------
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  // A REPEATED flag accumulates into an array. `--arg k=v` has always been
  // documented as repeatable and never was — the second one overwrote the
  // first — and `--in name=value` needs the same thing.
  const set = (k, v) => {
    if (!(k in flags)) { flags[k] = v; return; }
    flags[k] = Array.isArray(flags[k]) ? [...flags[k], v] : [flags[k], v];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) set(a.slice(2, eq), a.slice(eq + 1));
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) set(a.slice(2), argv[++i]);
      else set(a.slice(2), true);
    } else positional.push(a);
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0];
const asJson = Boolean(flags.json);

const out = value => {
  // stdout is the machine's channel: JSON when asked, never prose.
  if (asJson) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
};
const say = msg => { if (!asJson) console.error(msg); };
const die = (msg, code = 1) => {
  if (asJson) console.log(JSON.stringify({ ok: false, error: String(msg) }, null, 2));
  else console.error(String(msg));
  process.exit(code);
};

// --- engine ----------------------------------------------------------------
// dataRoot is the checkout, matching `npm run dev`, so the CLI and the desktop
// app in development share one set of flows, runs and settings — driving the
// same app from two front doors is the entire point.
function boot({ emit = () => {}, canEmit = () => false } = {}) {
  const engine = createEngine({
    projectRoot,
    dataRoot: projectRoot,
    // The SAME settings.json the desktop app writes (core/engine.js: "never the
    // repo"). This used to be projectRoot, so a key typed into Settings was
    // invisible to `flyt run` and `flyt loop start` — the two front doors were
    // documented as one implementation and did not share a profile.
    userDataDir: defaultUserDataDir(),
    emit,
    canEmit,
    log: msg => say(msg),
    warn: msg => say(msg)
  });
  return { engine, api: createApi(engine) };
}

// Bind a project folder for this invocation. A CLI call is stateless, so the
// tab session on disk is irrelevant: whatever --project says (or the cwd) is
// the project, opened fresh.
function openProject(api, engine) {
  const folder = path.resolve(String(flags.project ?? process.cwd()));
  const { project } = engine.registry.open(folder);
  return project.id;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A model id typed on the command line, as a worker. 'auto' resolves through
// the provider priority walk the way every picker in the app does; a `mock-`
// id is the dry-run provider and nothing else can serve it.
const namedWorker = id => (id
  ? { provider: String(id).startsWith('mock-') ? 'mock' : 'auto', model: String(id) }
  : null);

// `--models low=a,high=b` (repeatable) → { low: 'a', high: 'b' }. Unknown band
// names are left to the command surface to reject, so one rule decides what a
// band is called rather than two.
function levelModels(flag) {
  const out = {};
  for (const chunk of [].concat(flag ?? [])) {
    for (const pair of String(chunk).split(',')) {
      const eq = pair.indexOf('=');
      if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return Object.keys(out).length ? out : null;
}

// Poll a run to a terminal stage. Files are the source of truth (principle #1),
// so polling them is not a workaround — it is reading the same state the canvas
// reads, and it survives this process dying halfway.
async function waitForRun(api, projectId, runId, { timeoutSec, autoApprove, answers = [] }) {
  const deadline = Date.now() + timeoutSec * 1000;
  const queued = [...answers];
  let lastStage = null;
  for (;;) {
    const snap = await api.invoke('run:snapshot', { projectId, runId });
    const stage = snap.meta?.stage;
    if (stage !== lastStage) { say(`  ${stage}`); lastStage = stage; }
    if (stage === 'done' || stage === 'failed') return { stage, snapshot: snap };
    if (stage === 'awaiting_approval') {
      if (!autoApprove) return { stage, snapshot: snap };
      say('  gate — approving (--gates approve)');
      await api.invoke('run:approve', { projectId, runId });
    }
    // The input gate. Previously this fell through to the poll, so a run that
    // stopped to ask a question sat here for the full 30-minute timeout and
    // then reported `timeout` — the one stage where the run is healthy, waiting
    // on the caller, and says nothing about it. Now the questions come back to
    // whoever started the run, which is the entire point of asking them.
    if (stage === 'awaiting_input') {
      if (!queued.length) return { stage, snapshot: snap };
      const next = queued.shift();
      say(`  question — answering (--answer, ${queued.length} left)`);
      await api.invoke('run:answerInput', { projectId, runId, text: next });
      lastStage = null;
    }
    if (Date.now() > deadline) return { stage: 'timeout', snapshot: snap };
    await sleep(500);
  }
}

// What the run PRODUCED, for a terminal that gets one thing printed.
//
// `Object.values(nodeOutputs).at(-1)` was standing in for this, and it is not
// the same question. A node writes sidecars beside its deliverable — a
// refiner's questions, an interrogation's transcript and open items — and they
// land in the same map under `<node>_<port>` keys. So the last value in the map
// is whichever sidecar sorted last: an interrogation that had just written a
// full specification printed its own transcript of questions instead, which
// reads exactly like the run having produced nothing but chatter.
//
// The flow already says where the result is. Take the output node's content;
// failing that, the last real NODE's output, never a sidecar.
function runDeliverable(snapshot) {
  const outputs = snapshot?.nodeOutputs ?? {};
  const nodes = snapshot?.flow?.nodes ?? [];
  const key = id => (outputs[id] != null ? outputs[id] : outputs[String(id).replace(/\./g, '_')]);
  const fromOutputNodes = nodes.filter(n => n.type === 'output').map(n => key(n.id)).filter(Boolean);
  if (fromOutputNodes.length) return fromOutputNodes.join('\n\n');
  const produced = nodes
    .filter(n => n.type !== 'output' && n.type !== 'input')
    .map(n => key(n.id)).filter(Boolean);
  if (produced.length) return produced[produced.length - 1];
  // No flow in the snapshot (an older record, or a run that died before
  // resolution): fall back to the map, but still skip the sidecars.
  const plain = Object.entries(outputs).filter(([k]) => !k.includes('_')).map(([, v]) => v);
  return plain.length ? plain[plain.length - 1] : null;
}

// The questions a parked run is asking, as the person on the terminal should
// see them: numbered, with the reason and any candidate answers, and ending in
// the exact command that answers them.
function renderQuestionGate(runId, meta) {
  const questions = meta?.pendingQuestions ?? [];
  const lines = [`"${meta?.pendingNodeId ?? 'a node'}" stopped to ask you ${
    questions.length === 1 ? 'a question' : `${questions.length} questions`}:`, ''];
  for (const [i, q] of questions.entries()) {
    lines.push(`  ${i + 1}. ${q.text}`);
    if (q.why) lines.push(`     why: ${q.why}`);
    if (q.options?.length) lines.push(`     options: ${q.options.join(' | ')}`);
  }
  lines.push('', `Answer all of them in one reply:`, `  flyt answer ${runId} "<your answer>"`);
  return lines.join('\n');
}

// --- commands --------------------------------------------------------------
async function main() {
  if (!command || command === 'help' || flags.help) { console.log(USAGE); return; }

  if (command === 'serve') {
    // The server owns the emit callback, so every engine event reaches every
    // attached client — the Electron viewer included, once it learns to attach.
    let server = null;
    const { engine, api } = boot({
      emit: (type, payload) => server?.emit(type, payload),
      canEmit: () => Boolean(server?.hasClients())
    });
    server = createServer({ api, token: flags.token === true ? null : flags.token, log: say });
    const { port, host, token } = await server.listen(Number(flags.port ?? 7867));
    // The token goes to stdout because it is the one thing a caller must
    // capture; everything else about serving is stderr chatter.
    out(asJson ? { url: `http://${host}:${port}`, token } : `http://${host}:${port}\ntoken: ${token}`);
    say('serving — ctrl-c to stop');
    process.on('SIGINT', async () => { await server.close(); process.exit(0); });
    return new Promise(() => {}); // serve until killed
  }

  const { engine, api } = boot();

  switch (command) {
    case 'commands':
      return out(api.names());

    case 'flows': {
      const flows = await api.invoke('flow:list');
      return out(asJson ? flows : flows.map(f => `${f.id}\t${f.name ?? ''}`).join('\n'));
    }

    // The tool library, from the terminal. `flyt tools run` is the missing half
    // of tool authoring: until it existed the only way to find out whether a
    // tool worked was to start a run and read the log afterwards, which is a
    // slow loop for a person and no loop at all for an agent writing one.
    case 'tools': {
      const sub = positional[1] ?? 'list';
      switch (sub) {
        case 'list': {
          const tools = await api.invoke('tool:list');
          return out(asJson ? tools : tools
            .map(t => `${t.enabled === false ? '·' : ' '} ${t.id}\t${(t.effects ?? []).join(',')}\t${t.risk ?? ''}\t${t.title ?? ''}`)
            .join('\n'));
        }
        case 'show': {
          const id = positional[2];
          if (!id) return die('flyt tools show <id>');
          return out(await api.invoke('tool:show', { id }));
        }
        case 'problems':
          return out(await api.invoke('tool:problems', {}));
        case 'suites':
          return out(await api.invoke('tool:suites', {}));
        // The same fixed cases through several tools, measured. Answers "which
        // one is better at this job" with something a person can argue with,
        // which is not a question a model should be asked from its impressions.
        case 'bench': {
          const name = positional[2];
          if (!name) return die('flyt tools bench <suite> — see `flyt tools suites`');
          const card = await api.invoke('tool:bench', {
            projectId: openProject(api, engine),
            suite: name,
            confirm: Boolean(flags.yes),
            onProgress: p => say(`  ${p.tool} / ${p.case}`)
          });
          const { renderToolCard } = await import('../core/toolbench.js');
          return out(asJson ? card : renderToolCard(card));
        }
        case 'run': {
          const id = positional[2];
          if (!id) return die('flyt tools run <id> --arg url=https://example.com');
          // The schema decides what a `--arg` value MEANS.
          //
          // A command line has only strings, so `--arg limit=3` used to fail
          // with "expected integer, got string" — for the most obvious thing
          // anyone would type, human or model, and with `--arg-json limit=3` as
          // the undiscoverable fix. The tool already declares the type; using
          // it costs one lookup and removes a whole class of wasted turn.
          // Anything the schema does not call numeric or boolean stays a
          // string, and `--arg-json` still wins for arrays and objects.
          const shown = await api.invoke('tool:show', { id }).catch(() => null);
          const props = shown?.parameters?.properties ?? {};
          const coerce = (key, raw) => {
            const types = [].concat(props[key]?.type ?? []);
            if (types.includes('integer') || types.includes('number')) {
              const n = Number(raw);
              return raw.trim() !== '' && Number.isFinite(n) ? n : raw;
            }
            if (types.includes('boolean')) {
              if (/^(true|yes|1)$/i.test(raw)) return true;
              if (/^(false|no|0)$/i.test(raw)) return false;
            }
            return raw;
          };
          const args = {};
          for (const pair of [].concat(flags.arg ?? [])) {
            const eq = String(pair).indexOf('=');
            if (eq > 0) {
              const key = String(pair).slice(0, eq);
              args[key] = coerce(key, String(pair).slice(eq + 1));
            }
          }
          for (const pair of [].concat(flags['arg-json'] ?? [])) {
            const eq = String(pair).indexOf('=');
            if (eq <= 0) continue;
            const key = String(pair).slice(0, eq);
            try { args[key] = JSON.parse(String(pair).slice(eq + 1)); }
            catch (err) { return die(`--arg-json ${key}: not valid JSON (${err.message})`); }
          }
          const record = await api.invoke('tool:run', {
            projectId: openProject(api, engine), id, args,
            // A write or a shell call needs the caller to say so, here as
            // everywhere else. `--yes` is that sentence.
            confirm: Boolean(flags.yes)
          });
          if (asJson) return out(record);
          if (!record.ok) return die(`${id} failed after ${record.ms}ms: ${record.error}`);
          say(`${id} ok in ${record.ms}ms`);
          return out(record.result);
        }
        default:
          return die('flyt tools list|show <id>|run <id>|problems|suites|bench <suite>');
      }
    }

    // The Python sidecar (core/python.js). Some tools borrow a library that is
    // not JavaScript; this is where that environment is built and inspected,
    // so "the tool says scrapling is missing" has a command that fixes it.
    case 'python': {
      const sub = positional[1] ?? 'status';
      const packages = String(flags.packages ?? '').split(',').map(s => s.trim()).filter(Boolean);
      switch (sub) {
        case 'status': {
          const status = await api.invoke('python:status', { packages });
          if (asJson) return out(status);
          const lines = [
            `interpreter  ${status.bin ?? '(none found)'}`,
            `resolved by  ${status.source}`,
            `version      ${status.version ?? '—'}`,
            `managed dir  ${status.managedDir ?? '—'}`
          ];
          for (const [name, version] of Object.entries(status.packages ?? {})) {
            lines.push(`  ${version ? '✓' : '✗'} ${name} ${version ?? '(not installed)'}`);
          }
          if (status.error) lines.push(`\n${status.error}`);
          if (status.remedy) lines.push(status.remedy);
          return out(lines.join('\n'));
        }
        case 'setup': {
          if (!packages.length) say('no --packages given: building the environment only');
          const result = await api.invoke('python:setup', {
            packages,
            python: flags.python === true ? null : (flags.python ?? null),
            log: line => say(`  ${line}`)
          });
          return out(asJson ? result : `${result.bin}\n${
            Object.entries(result.status?.packages ?? {}).map(([n, v]) => `  ${v ? '✓' : '✗'} ${n} ${v ?? ''}`).join('\n')}`);
        }
        default:
          return die('flyt python status|setup [--packages a,b] [--python <path>]');
      }
    }

    case 'call': {
      const name = positional[1];
      if (!name) return die('flyt call <command> — see `flyt commands`');
      // --arg k=v, repeatable; --arg-json k={"a":1} for structured values.
      const args = {};
      for (const [k, v] of Object.entries(flags)) {
        if (k === 'json' || k === 'project' || k === 'arg') continue;
        args[k] = v;
      }
      for (const pair of [].concat(flags.arg ?? [])) {
        const eq = String(pair).indexOf('=');
        if (eq > 0) args[String(pair).slice(0, eq)] = String(pair).slice(eq + 1);
      }
      // `--arg-json k=[...]` for values that are not strings. Documented above
      // since this command was written and never implemented, so every command
      // taking an array or a number — `task:update` with `gates`, which is how
      // you fix a task that declares a gate this repo cannot run — was
      // reachable from the desktop app and the HTTP API but not from here.
      for (const pair of [].concat(flags['arg-json'] ?? [])) {
        const eq = String(pair).indexOf('=');
        if (eq <= 0) continue;
        const key = String(pair).slice(0, eq);
        const raw = String(pair).slice(eq + 1);
        try { args[key] = JSON.parse(raw); }
        catch (err) { return die(`--arg-json ${key}: not valid JSON (${err.message})`); }
      }
      if (!args.projectId && name.includes(':')) args.projectId ??= openProject(api, engine);
      return out(await api.invoke(name, args));
    }

    case 'task': {
      const sub = positional[1] ?? 'list';
      const projectId = openProject(api, engine);
      switch (sub) {
        case 'add': {
          const title = positional.slice(2).join(' ') || String(flags.title ?? '');
          if (!title) return die('flyt task add "<title>" --goal "<what it must achieve>"');
          const task = await api.invoke('task:add', {
            projectId,
            title,
            goal: String(flags.goal ?? title),
            value: flags.value ? Number(flags.value) : undefined,
            effort: flags.effort ? Number(flags.effort) : undefined,
            level: typeof flags.level === 'string' ? flags.level : undefined,
            dependsOn: flags.dependsOn ? String(flags.dependsOn).split(',') : undefined,
            gates: flags.gates ? String(flags.gates).split(',').map(g => g.trim()).filter(Boolean) : undefined,
            // What the worker has to KNOW (core/backlog.js `skills`), as
            // distinct from what it may do. Comma-separated or repeated.
            skills: flags.skills || flags.skill
              ? [].concat(flags.skills ?? [], flags.skill ?? [])
                .flatMap(v => String(v).split(',')).map(s2 => s2.trim()).filter(Boolean)
              : undefined,
            blastRadius: flags.blast ? String(flags.blast).split(',').map(b => b.trim()).filter(Boolean) : undefined,
            references: flags.references ? String(flags.references).split(',').map(r => r.trim()).filter(Boolean) : undefined,
            doneWhen: [].concat(flags.done ?? []).map(String).filter(Boolean)
          });
          say(`queued ${task.id}`);
          return out(asJson ? task : `${task.id}\t${task.title}`);
        }
        case 'list': {
          const { tasks, problems } = await api.invoke('task:list', {
            projectId, status: typeof flags.status === 'string' ? flags.status : null
          });
          for (const p of problems) say(`! ${p.id}: ${p.error}`);
          return out(asJson ? { tasks, problems }
            : (tasks.map(t => `${t.id}\t${t.status}\t${t.level ?? '-'}\t${t.title}`).join('\n') || '(backlog empty)'));
        }
        case 'show': {
          const task = await api.invoke('task:get', { projectId, id: positional[2] });
          return out(asJson ? task : `${task.id}  ${task.status}  value ${task.value}/effort ${task.effort}\n${task.title}\n\n${task.body}`);
        }
        case 'ready': {
          const { ready, blocked } = await api.invoke('task:ready', { projectId });
          if (asJson) return out({ ready, blocked });
          const lines = ready.map(t => `${t.score.toFixed(2)}\t${t.id}\t${t.title}`);
          for (const b of blocked) lines.push(`--\t${b.id}\t${b.title}  (${b.reason})`);
          return out(lines.join('\n') || '(nothing ready)');
        }
        case 'take': {
          const task = await api.invoke('task:take', { projectId, by: String(flags.by ?? 'cli') });
          if (!task) { say('nothing ready to take'); return out(asJson ? null : '(nothing ready)'); }
          if (task.stolen) say(`note: reclaimed an expired lease from ${task.claimedBy}`);
          return out(asJson ? task : `${task.id}\t${task.title}`);
        }
        case 'escalate': {
          const r = await api.invoke('task:escalate', {
            projectId, id: positional[2],
            reason: String(flags.reason ?? 'failed'),
            note: String(flags.note ?? '')
          });
          say(r.escalation.reason);
          return out(asJson ? r : `${r.id}\t${r.status}\t${r.level ?? '-'}`);
        }
        case 'release':
          return out(await api.invoke('task:release', {
            projectId, id: positional[2], status: String(flags.status ?? 'queued')
          }));
        // `flyt task rm <id>...` / `--all` / `--status parked`. Plural because
        // the case it exists for is plural: a backlog written against the wrong
        // repository is thirteen wrong tasks, not one.
        case 'rm':
        case 'remove': {
          const { tasks, problems = [] } = await api.invoke('task:list', {
            projectId, status: typeof flags.status === 'string' ? flags.status : null
          });
          // `--all` means all, including the files that would not parse. They
          // are exactly the ones a person reaches for this command over, and
          // they are invisible in `task list` — leaving them behind would empty
          // the queue in the report and not on disk. A `--status` filter still
          // skips them: an unreadable file has no status to match.
          const ids = positional.slice(2).length ? positional.slice(2)
            : flags.all ? [...tasks.map(t => t.id), ...problems.map(p => p.id)]
              : flags.status ? tasks.map(t => t.id)
                : [];
          if (!ids.length) return die('flyt task rm <id>... — or --all, or --status <status>');
          const removed = [];
          for (const id of ids) {
            removed.push(await api.invoke('task:remove', { projectId, id, force: Boolean(flags.force) }));
          }
          return out(asJson ? { removed } : removed.map(r => `removed ${r.removed}\t${r.title}`).join('\n'));
        }
        case 'stats':
          return out(await api.invoke('task:stats', { projectId }));
        default:
          return die(`Unknown task subcommand "${sub}".`);
      }
    }

    case 'loop': {
      const sub = positional[1] ?? 'status';
      const projectId = openProject(api, engine);
      if (sub === 'start') {
        // `--model` names the model every task runs on for this session,
        // instead of asking for an effort band; `--reviewer` names who reads
        // the diff. Both go in as provider 'auto' — the id is the decision, and
        // who serves it is the priority walk's business.
        const ack = await api.invoke('loop:start', {
          projectId,
          parallelism: Number(flags.parallel ?? 1),
          maxTasks: flags.tasks ? Number(flags.tasks) : null,
          // `--only t-0026,t-0031` — work exactly these, in the picker's usual
          // order. How you try the loop on one task before trusting it with a
          // night, without reordering the queue to arrange it.
          only: [].concat(flags.only ?? []).flatMap(v => String(v).split(',')).map(t => t.trim()).filter(Boolean),
          dryRun: Boolean(flags['dry-run']),
          worker: namedWorker(flags.model),
          // `--models low=cheap,high=strong` — a model per effort band, so the
          // cheap one does the ordinary work and escalation is what reaches the
          // expensive one. Repeatable or comma-separated; the map fills
          // downward, so naming two bands answers all five.
          models: levelModels(flags.models),
          // Who reads the diff before anything merges (§7.2). Nameable here
          // because the machine driving a loop is often not the machine whose
          // settings.json holds the answer.
          reviewer: namedWorker(flags.reviewer),
          // What it may spend before it stops, for THIS session. The models and
          // the reviewer were nameable at the call and the ceiling was not, so
          // the only way to bound a night was to edit the project's config
          // first — which is the one thing you do not want to be doing at the
          // moment you have decided to walk away.
          caps: {
            ...(flags['task-usd'] != null ? { taskUsd: Number(flags['task-usd']) } : {}),
            ...(flags['soft-usd'] != null ? { softUsd: Number(flags['soft-usd']) } : {}),
            ...(flags['cap-usd'] != null ? { hardUsd: Number(flags['cap-usd']) } : {})
          }
        });
        const on = Object.keys(ack.models ?? {}).length
          ? Object.entries(ack.models).map(([b, m]) => `${b}=${m}`).join(' ')
          : (ack.model ?? 'effort bands');
        const ceiling = ack.caps?.hardUsd != null ? `, stopping at $${Number(ack.caps.hardUsd).toFixed(2)}`
          : ack.caps?.softUsd != null ? `, no escalation past $${Number(ack.caps.softUsd).toFixed(2)}`
            : ', with no spending ceiling';
        say(`loop started on ${on}`
          + `, reviewed by ${ack.reviewer ?? 'nobody (nothing will land)'}`
          + ceiling
          + ' — ctrl-c to detach, `flyt loop stop` to stop it');
        // Held open on purpose: the loop lives in this process. Detaching it
        // into a daemon is the next thing, and until then closing the terminal
        // is what stops it.
        for (;;) {
          await sleep(5000);
          const st = await api.invoke('loop:status', { projectId });
          if (!st.running) { say(`loop stopped: ${st.stopping ?? 'done'}`); return out(st); }
          say(`  ${st.inFlight.length} in flight, ${st.landed}/${st.completed} landed`
            + (st.spend ? `, $${st.spend.usd.toFixed(2)}` : ''));
        }
      }
      if (sub === 'stop') return out(await api.invoke('loop:stop', { projectId }));
      return out(await api.invoke('loop:status', { projectId }));
    }

    case 'report':
      return out(await api.invoke('loop:report', { projectId: openProject(api, engine) }));

    case 'spend': {
      const since = String(flags.since ?? '24h');
      const ms = /^(\d+)h$/.test(since) ? Number(since.slice(0, -1)) * 3600_000 : null;
      return out(await api.invoke('ledger:totals', { projectId: openProject(api, engine), sinceMs: ms }));
    }

    case 'bench': {
      const sub = positional[1] ?? 'list';
      const projectId = openProject(api, engine);
      switch (sub) {
        case 'list': {
          const r = await api.invoke('bench:list', { projectId });
          for (const p of r.problems) say(`! ${p.id ?? '?'}: ${p.error}`);
          return out(asJson ? r
            : (r.cases.map(c => `${c.id}\t${c.level ?? '-'}\t${c.title}\n\tprobe: ${c.probe}`).join('\n')
              || `(no cases in ${r.dir})`));
        }
        case 'run': {
          await api.invoke('bench:run', {
            projectId,
            only: typeof flags.only === 'string' ? flags.only : null,
            suite: String(flags.suite ?? 'default'),
            keep: Boolean(flags.keep),
            revision: String(flags.revision ?? 'HEAD')
          });
          say('benchmark started — this clones the repo and works the suite');
          // Held open like `loop start`: the run lives in this process.
          for (;;) {
            await sleep(5000);
            const st = await api.invoke('bench:status', { projectId });
            if (st.running) { say('  …'); continue; }
            if (st.error) return die(st.error);
            say(`scored ${st.card.totals.verified}/${st.card.totals.cases} → ${st.file}`);
            process.exitCode = st.card.totals.verified === st.card.totals.cases ? 0 : 1;
            const { renderScorecard } = await import('../core/benchmark.js');
            return out(asJson ? st.card : renderScorecard(st.card));
          }
        }
        case 'status':
          return out(await api.invoke('bench:status', { projectId }));
        case 'cards': {
          const r = await api.invoke('bench:cards', { projectId });
          return out(asJson ? r : (r.cards.map(c =>
            `${c.name}\t${(c.score * 100).toFixed(0)}%\t${c.totals.verified}/${c.totals.cases}`).join('\n')
            || '(no scorecards yet)'));
        }
        case 'show':
          return out(await api.invoke(asJson ? 'bench:card' : 'bench:report',
            { projectId, name: positional[2] ?? null }));
        case 'compare': {
          const r = await api.invoke('bench:compare', {
            projectId, a: positional[2] ?? null, b: positional[3] ?? null,
            suite: typeof flags.suite === 'string' ? flags.suite : null
          });
          // A regression is a non-zero exit, so a script or an agent can branch
          // on "did the last change make it worse" without parsing anything.
          process.exitCode = r.comparison.verdict === 'worse' ? 1 : 0;
          return out(asJson ? r : r.text);
        }
        default:
          return die(`Unknown bench subcommand "${sub}".`);
      }
    }

    case 'archive': {
      const sub = positional[1] ?? 'list';
      const projectId = openProject(api, engine);
      switch (sub) {
        case 'write': {
          const r = await api.invoke('archive:write', {
            projectId,
            date: typeof flags.date === 'string' ? flags.date : null,
            card: typeof flags.card === 'string' ? flags.card : null
          });
          say(`archived ${r.date} → ${r.dir}`);
          return out(asJson ? r : `${r.dir}\n${r.files.join('\n')}`);
        }
        case 'list': {
          const days = await api.invoke('archive:list', { projectId });
          return out(asJson ? days : (days.map(d =>
            `${d.date}\t${d.benchmark ? `${(d.benchmark.score * 100).toFixed(0)}%` : '—'}`
            + `\t${d.spend?.usd != null ? `$${d.spend.usd.toFixed(2)}` : '—'}`
            + `\t${d.landed ?? 0} landed, ${d.parked ?? 0} parked`).join('\n') || '(nothing archived yet)'));
        }
        case 'show':
          return out(await api.invoke('archive:read', { projectId, date: positional[2] }));
        case 'trend': {
          const series = await api.invoke('archive:trend', {
            projectId, limit: Number(flags.limit ?? 30)
          });
          if (asJson) return out(series);
          const { renderTrend } = await import('../core/archive.js');
          return out(renderTrend(series));
        }
        default:
          return die(`Unknown archive subcommand "${sub}".`);
      }
    }

    case 'work': {
      const sub = positional[1];
      const taskId = positional[2];
      const projectId = openProject(api, engine);
      switch (sub) {
        case 'start': {
          const wt = await api.invoke('work:start', { projectId, taskId });
          say(`worktree ${wt.dir}`);
          return out(asJson ? wt : `${wt.branch}\t${wt.dir}`);
        }
        case 'verify': {
          const r = await api.invoke('work:verify', { projectId, taskId });
          if (asJson) return out(r);
          for (const g of r.results) say(`${g.status}\t${g.command}${g.code != null ? ` (exit ${g.code})` : ''}`);
          if (!r.ok && r.failure) console.log(r.failure.output);
          process.exitCode = r.ok ? 0 : 1;
          return out(r.ok ? 'gates green' : `gates ${r.failure?.status ?? 'failed'}`);
        }
        case 'diff':
          return out(await api.invoke('work:diff', { projectId, taskId }));
        case 'discard': {
          // `--attempt` scopes the discard to one attempt, so a cleanup that
          // arrives late cannot delete a newer attempt's worktree (WR-02).
          // Without it this is an explicit "throw it away", which is what a
          // person typing `discard` means.
          const r = await api.invoke('work:discard', { projectId, taskId, attemptId: flags.attempt ?? null });
          if (asJson) return out(r);
          if (r.outcome === 'owner-mismatch') {
            process.exitCode = 1;
            return out(`nothing removed — this worktree now belongs to attempt ${r.owner}`);
          }
          if (r.outcome === 'live-owner') {
            process.exitCode = 1;
            return out(`nothing removed — attempt ${r.owner} is still live`);
          }
          return out(r.outcome === 'removed' ? `removed ${r.dir}` : 'already removed');
        }
        case 'reconcile': {
          // Orphaned owner records and worktrees, reported never deleted:
          // "remove this directory" is exactly the decision not to guess at.
          const { orphans } = await api.invoke('work:reconcile', { projectId });
          if (asJson) return out({ orphans });
          if (!orphans.length) return out('no orphaned worktrees');
          for (const o of orphans) say(`${o.kind}	${o.taskId}	${o.path}`);
          return out(`${orphans.length} orphan(s) — discard the ones you no longer want`);
        }
        case 'land': {
          const r = await api.invoke('work:land', { projectId, taskId, dryRun: Boolean(flags['dry-run']), push: flags.push ? true : null });
          if (asJson) return out(r);
          for (const step of r.steps) say(`  ${step.step}: ${step.ok ?? step.verdict ?? step.landed ?? ''}`);
          say(r.landed ? `landed as ${r.mergeSha?.slice(0, 8)}` : `did not land (${r.stage})`);
          process.exitCode = r.landed ? 0 : 1;
          return out(r.landed ? `landed ${r.mergeSha}` : `${r.stage}: ${r.guidance ?? ''}`);
        }
        default:
          return die(`Unknown work subcommand "${sub}".`);
      }
    }

    case 'ref': {
      const sub = positional[1] ?? 'list';
      switch (sub) {
        case 'list': {
          const list = await api.invoke('ref:list');
          return out(asJson ? list : list.map(r =>
            `${r.cloned ? '●' : '○'} ${r.name}\t${r.commit?.slice(0, 8) ?? '—'}\t${r.about ?? ''}`).join('\n'));
        }
        case 'update': {
          say('cloning — this reaches the network');
          const r = await api.invoke('ref:update', { name: positional[2] ?? null });
          for (const f of r.failed) say(`! ${f.name}: ${f.error}`);
          return out(asJson ? r : r.updated.map(u => `${u.name}\t${u.commit.slice(0, 8)}`).join('\n') || '(nothing updated)');
        }
        case 'grep': {
          const r = await api.invoke('ref:search', {
            pattern: positional.slice(2).join(' ') || String(flags.pattern ?? ''),
            repo: typeof flags.repo === 'string' ? flags.repo : null,
            context: Number(flags.context ?? 0)
          });
          if (asJson) return out(r);
          return out(r.results.map(m => `${m.ref}:${m.line}\t${m.text}`).join('\n')
            + (r.truncated ? '\n… (truncated)' : '') || '(no hits)');
        }
        case 'show':
          return out(await api.invoke('ref:read', { ref: positional[2] }));
        case 'index':
          return out(await api.invoke('ref:index', { name: positional[2] }));
        default:
          return die(`Unknown ref subcommand "${sub}".`);
      }
    }

    case 'feedback': {
      const sub = positional[1] ?? 'stats';
      const projectId = openProject(api, engine);
      switch (sub) {
        case 'stats':
          return out(await api.invoke('feedback:stats', { projectId }));
        case 'pending':
          return out(await api.invoke('feedback:pending', { projectId }));
        case 'preview': {
          const d = await api.invoke('feedback:preview', { projectId });
          if (asJson) return out(d);
          const { FeedbackStore } = await import('../core/feedback.js');
          return out(FeedbackStore.renderDigest(d));
        }
        case 'digest': {
          const res = await api.invoke('feedback:digest', { projectId, enqueue: Boolean(flags.enqueue) });
          if (!res.file) { say('nothing pending to digest'); return out(asJson ? res : '(nothing pending)'); }
          say(`digested ${res.digest.instances} instance(s) → ${res.file}`);
          say(`archived ${res.archived.length} entr(ies)`);
          if (res.task) say(`queued ${res.task.id} to act on it`);
          return out(asJson ? res : res.file);
        }
        case 'list':
          return out(await api.invoke('feedback:digests', { projectId }));
        case 'show':
          return out(await api.invoke('feedback:readDigest', { projectId, name: positional[2] }));
        default:
          return die(`Unknown feedback subcommand "${sub}".`);
      }
    }

    case 'runs': {
      const projectId = openProject(api, engine);
      const runs = await api.invoke('run:list', { projectId });
      return out(asJson ? runs : runs.map(r => `${r.id}\t${r.stage ?? ''}\t${r.name ?? ''}`).join('\n'));
    }

    case 'snapshot':
      return out(await api.invoke('run:snapshot', { projectId: openProject(api, engine), runId: positional[1] }));

    // The log is the primary evidence, and a fan-out writes hundreds of lines
    // of it — a run reading a repository through four lanes logged 441 entries,
    // 237 of them tool calls. Dumping all of it as one JSON array means the
    // reader writes a filter script every time, which is what happened.
    case 'log': {
      const projectId = openProject(api, engine);
      let entries = await api.invoke('run:log', { projectId, runId: positional[1] });
      const only = typeof flags.event === 'string' ? flags.event.split(',').map(s => s.trim()) : null;
      if (only) entries = entries.filter(e => only.includes(e.event));
      if (typeof flags.node === 'string') entries = entries.filter(e => e.node === flags.node);
      // `--quiet` drops the two events that are individually uninteresting and
      // collectively drown everything else.
      if (flags.quiet) entries = entries.filter(e => !['tool_call', 'reference_search'].includes(e.event));
      const tail = Number(flags.tail ?? 0);
      if (tail > 0) entries = entries.slice(-tail);
      if (asJson) return out(entries);
      return out(entries.map(e => {
        const { ts, event, node, ...rest } = e;
        const body = JSON.stringify(rest);
        return `${ts} ${event}${node ? ` [${node}]` : ''} ${body === '{}' ? '' : body.slice(0, 240)}`;
      }).join('\n'));
    }

    // These three commands answer a gate and return nothing meaningful — the
    // engine's ack is `undefined`, and printing it said `undefined`, which
    // reads as a failure at 1am. Say what happened and where the run went.
    case 'approve': case 'reject': case 'stop': {
      const projectId = openProject(api, engine);
      const runId = positional[1];
      if (!runId) return die(`flyt ${command} <runId>`);
      await api.invoke(`run:${command}`, {
        projectId, runId,
        ...(command === 'reject' ? { reason: String(flags.reason ?? '') } : {})
      });
      const stage = (await api.invoke('run:snapshot', { projectId, runId }))?.meta?.stage ?? 'unknown';
      const done = { approve: 'approved', reject: 'rejected', stop: 'stopped' }[command];
      return out(asJson ? { ok: true, runId, action: done, stage } : `${runId} ${done} — now ${stage}`);
    }

    // A node that stops to ASK could not be answered from here, only approved
    // or killed — so a headless run that asked one question sat until it timed
    // out, and the only way to move it was the desktop app. `flyt why` would
    // say it was waiting; nothing could reply.
    case 'answer': {
      const runId = positional[1];
      const text = String(flags.text ?? positional.slice(2).join(' ') ?? '').trim();
      if (!runId || !text) return die('flyt answer <runId> "<your answer>"');
      const projectId = openProject(api, engine);
      await api.invoke('run:answerInput', { projectId, runId, text });
      // Answering resumes the run, so this command waits on it exactly as
      // `flyt run` does: an interrogation is several rounds, and a reply that
      // returned `{ok:true}` and dropped the caller left them polling
      // `flyt snapshot` to find out whether they were asked again.
      const { stage, snapshot } = await waitForRun(api, projectId, runId, {
        timeoutSec: Number(flags.timeout ?? 1800),
        autoApprove: flags.gates === 'approve'
      });
      if (asJson) {
        return out({
          ok: stage === 'done', runId, stage,
          ...(stage === 'awaiting_input' ? { questions: snapshot.meta?.pendingQuestions ?? [] } : {}),
          snapshot
        });
      }
      if (stage === 'awaiting_input') {
        say(`run ${runId}: waiting on you`);
        return out(renderQuestionGate(runId, snapshot.meta));
      }
      say(`run ${runId}: ${stage}`);
      process.exitCode = stage === 'done' ? 0 : 1;
      return out(runDeliverable(snapshot) ?? `(no output; stage ${stage})`);
    }

    // --- Diagnostics (D40) ---------------------------------------------------
    // The first thing to reach for when a run fails. Defaults to the most
    // recent run, because "why did that fail" is nearly always about the last
    // one and looking its id up first is friction with no purpose.
    case 'why': {
      const projectId = openProject(api, engine);
      let runId = positional[1];
      if (!runId) {
        const runs = await api.invoke('run:list', { projectId });
        if (!runs.length) return die('No runs in this project yet.');
        runId = runs[0].id;
      }
      const report = await api.invoke('run:explain', { projectId, runId });
      if (asJson) return out(report);
      out(renderWhy(report));
      // A failed run exits non-zero, so a script can branch on it.
      process.exitCode = report.verdict === 'completed' ? 0 : 1;
      return;
    }

    case 'probe': {
      const models = positional.slice(1);
      if (!models.length) return die('flyt probe <model> [<model>...] [--provider p] [--max-tokens n]');
      const results = [];
      for (const model of models) {
        results.push(await api.invoke('model:probe', {
          model,
          provider: typeof flags.provider === 'string' ? flags.provider : null,
          ...(flags['max-tokens'] ? { maxTokens: Number(flags['max-tokens']) } : {}),
          stream: flags.stream !== 'false'
        }));
      }
      if (asJson) return out(results);
      out(results.map(renderProbe).join('\n\n'));
      process.exitCode = results.every(r => r.ok) ? 0 : 1;
      return;
    }

    case 'doctor': {
      const report = await api.invoke('diag:doctor', {
        projectId: openProject(api, engine),
        probe: Boolean(flags.probe),
        flowId: typeof flags.flow === 'string' ? flags.flow : null,
        models: [].concat(flags.model ?? []).filter(m => typeof m === 'string')
      });
      if (asJson) return out(report);
      out(renderDoctor(report));
      process.exitCode = report.findings.some(f => f.level === 'error') ? 1 : 0;
      return;
    }

    case 'run': {
      const flowId = positional[1];
      if (!flowId) return die('flyt run <flow> --input "<text>" [--in name=value ...]');
      const runInputs = {};
      for (const pair of [].concat(flags.in ?? [])) {
        const at = String(pair).indexOf('=');
        if (at < 0) return die(`--in expects name=value, got "${pair}"`);
        runInputs[String(pair).slice(0, at).trim()] = String(pair).slice(at + 1);
      }
      const projectId = openProject(api, engine);
      const runId = await api.invoke('flow:run', {
        projectId,
        flowId,
        userInput: String(flags.input ?? positional.slice(2).join(' ') ?? ''),
        approvalMode: typeof flags.approval === 'string' ? flags.approval : null,
        level: typeof flags.level === 'string' ? flags.level : null,
        // Typed run inputs (D36 P1): --in name=value, repeatable. A flow that
        // declares inputs cannot be started without them, so the headless front
        // door needs a way to supply them.
        ...(Object.keys(runInputs).length ? { launch: { inputs: runInputs } } : {})
      });
      say(`run ${runId} started`);
      const { stage, snapshot } = await waitForRun(api, projectId, runId, {
        timeoutSec: Number(flags.timeout ?? 1800),
        autoApprove: flags.gates === 'approve',
        // `--answer` pre-loads replies, one per round of questions, so an
        // interrogation can be driven from a script or by an agent without a
        // terminal — and without pretending nobody was there to ask.
        answers: [].concat(flags.answer ?? []).map(String)
      });
      // A run that did not finish is explained where it failed, without being
      // asked (D40). The alternative is handing back an exit code and a stage
      // name and making the reader — a person at 1am, or an agent with no
      // memory of this session — go and find the next command themselves.
      // A run parked on a question is not a failure and has no cause to
      // explain — it is waiting for the caller. Diagnosing it would bury the
      // question under machinery.
      const asking = stage === 'awaiting_input';
      const explained = (stage === 'done' || asking)
        ? null : await api.invoke('run:explain', { projectId, runId });
      if (asJson) {
        out({
          ok: stage === 'done', runId, stage, snapshot,
          ...(asking ? { questions: snapshot.meta?.pendingQuestions ?? [] } : {}),
          ...(explained ? { why: explained } : {})
        });
      } else if (asking) {
        say(`run ${runId}: waiting on you`);
        console.log(renderQuestionGate(runId, snapshot.meta));
      } else {
        say(`run ${runId}: ${stage}`);
        console.log(runDeliverable(snapshot) ?? `(no output; stage ${stage})`);
        if (explained) say(`\n${renderWhy(explained)}\n\nfull detail: flyt why ${runId} --json`);
      }
      // A parked or failed run is a non-zero exit, so a script or an agent can
      // branch on it without parsing anything.
      process.exitCode = stage === 'done' ? 0 : 1;
      return;
    }

    default:
      return die(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

// --- diagnostic rendering (D40) ---------------------------------------------
// stdout stays machine-readable under --json; these are the human half. They
// lead with the verdict and the next step, because a diagnostic that buries the
// action under the evidence gets read like a log file, which is the thing it
// exists to replace.

const ms = n => (n == null ? '?' : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);

function renderWhy(r) {
  const L = [`run ${r.runId} — ${r.verdict}${r.flow ? ` (${r.flow})` : ''}`];
  if (r.error) L.push(`  error: ${r.error}`);
  // The question comes first, above the machinery. A run stalled on a question
  // is not diagnosed by its call stats; it is answered.
  if (r.asking) {
    L.push('');
    L.push(`  "${r.asking.title ?? r.asking.node}" is waiting for you:`);
    for (const line of renderQuestions(r.asking.questions).split('\n')) L.push(`    ${line}`);
    L.push('');
    L.push(`  flyt answer ${r.runId} "<your answer>"`);
  }
  const s = r.signals;
  L.push(`  ${s.modelCalls} model call(s) over ${ms(s.modelMs)}, ${s.toolCalls} tool call(s)`
    + `${s.usd ? `, $${s.usd}` : ''}`);
  const flags = [
    s.emptyTurns && `${s.emptyTurns} empty turn(s)`,
    s.truncatedOutputs && `${s.truncatedOutputs} truncated output(s)`,
    s.transientRetries && `${s.transientRetries} transient retr(ies)`,
    s.nodeRestarts && `${s.nodeRestarts} manual restart(s)`
  ].filter(Boolean);
  if (flags.length) L.push(`  ${flags.join(' · ')}`);

  for (const n of r.nodes) {
    L.push('');
    L.push(`  ${n.node} [${n.inFlight ? `running for ${ms(n.runningForMs)}` : n.status}]${n.model ? ` on ${n.model}` : ''}`);
    if (n.error) L.push(`    ${n.error}`);
    const c = n.calls;
    if (!n.traced) L.push('    (no call trace — this run predates the black box)');
    else L.push(`    ${c.total} call(s), ${c.toolCalls} tool call(s), ${ms(c.totalMs)}`
      + (c.reasoningShare != null ? ` — ${c.reasoningShare}% of its output was reasoning` : ''));
    if (c.truncated) L.push(`    ${c.truncated} truncated at the token budget`);
    if (n.lastCall && n.lastCall.ok === false) L.push(`    last call failed: ${n.lastCall.error}`);
    // What the node said was wrong with the WORK. A node can fail with every
    // call green, and then the call trace is the least useful thing on screen.
    for (const p of n.problems ?? []) L.push(`    ✖ ${p}`);
  }
  if (r.suggestions.length) {
    L.push('');
    L.push('  what to try:');
    for (const s2 of r.suggestions) L.push(`    - ${s2}`);
  }
  return L.join('\n');
}

function renderProbe(p) {
  const L = [`${p.provider ?? '?'}/${p.model} — ${p.verdict}`];
  if (!p.ok && p.error) { L.push(`  ${p.error}`); return L.join('\n'); }
  L.push(`  ${ms(p.ms)} total${p.firstTextMs != null ? `, first output at ${ms(p.firstTextMs)}` : ''}`
    + `, finish_reason ${p.finishReason}`);
  L.push(`  ${p.contentChars} chars of answer, ${p.reasoningChars} chars of reasoning`
    + (p.reasoningTokens ? ` (${p.reasoningTokens} reasoning tokens)` : ''));
  if (p.servedBy) L.push(`  served by ${p.servedBy}`);
  if (p.sample) L.push(`  > ${p.sample.replace(/\s+/g, ' ')}`);
  return L.join('\n');
}

function renderDoctor(r) {
  const L = ['providers (in priority order):'];
  for (const p of r.providers) {
    // A present key and a usable key are different facts, and only one of them
    // was ever on this line.
    const left = p.credit?.limit != null && p.credit?.usage != null
      ? p.credit.limit - p.credit.usage : null;
    const credit = left == null ? ''
      : left <= 0
        ? ` — SPENT ($${p.credit.usage.toFixed(2)} of $${p.credit.limit.toFixed(2)})`
        : ` — $${left.toFixed(2)} left of $${p.credit.limit.toFixed(2)}`;
    L.push(`  ${p.connected ? '✓' : '·'} ${p.id} (${p.kind})`
      + (p.subscription?.detail ? ` — ${p.subscription.detail}` : '')
      + credit);
  }
  // Where an unpinned node of each kind actually goes (WR-04). The whole point
  // is that this is computed by the same function the runner uses, so what is
  // printed here is what will run.
  if (r.routes?.length) {
    L.push('', 'default route for an unpinned node:');
    for (const rt of r.routes) {
      L.push(`  ${rt.kind.padEnd(12)} ${rt.provider ? `${rt.provider}/${rt.model}` : '— no connected provider'}`);
    }
    const order = r.routes.find(rt => rt.order)?.order;
    if (order) {
      L.push(`  (order: ${order === 'settings-priority' ? 'your Settings provider priority' : 'built-in default, no Settings order'})`);
    }
  }
  if (r.references.length) {
    L.push('', 'reference library:');
    for (const ref of r.references) L.push(`  ${ref.cloned ? '✓' : '·'} ${ref.name}`);
  }
  if (r.probes?.length) {
    L.push('', 'models:');
    for (const p of r.probes) L.push('  ' + renderProbe(p).split('\n').join('\n  '));
  }
  L.push('', r.findings.length ? 'findings:' : 'findings: none');
  for (const f of r.findings) L.push(`  [${f.level}] ${f.message}`);
  if (r.v2) L.push('', `v2 stack: ${r.v2.enabled ? 'on' : 'off'} (${r.v2.source})`);
  L.push('', `settings: ${r.settingsPath}`);
  if (r.project) L.push(`runs:     ${r.project.runsDir}`);
  return L.join('\n');
}

main().catch(err => {
  if (err instanceof ApiError) die(err.message);
  die(err.stack ?? String(err), 1);
});

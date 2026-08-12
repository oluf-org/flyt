#!/usr/bin/env node
// The headless front door (LOOP-PLAN §13).
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

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `flyt — drive Flyt without the desktop app

  flyt flows                          list workflows
  flyt run <flow> --input "<text>"    start a run and wait for it to settle
  flyt runs                           list runs in the current project
  flyt snapshot <runId>               the run's current state
  flyt log <runId>                    the run's event log
  flyt approve|reject|stop <runId>    answer a gate or stop a run
  flyt serve [--port 7867]            run the HTTP API + event stream
  flyt call <command> [--arg k=v]     invoke any command directly
  flyt commands                       list every command

Options
  --project <dir>   project folder to bind (default: cwd)
  --json            machine-readable output on stdout
  --token <t>       bearer token for serve (default: generated and printed)
  --approval <m>    ask | smart | always   (default: the saved setting)
  --gates approve   auto-approve node gates while waiting (unattended)
  --timeout <sec>   how long to wait for a run to settle (default 1800)
`;

// --- argv ------------------------------------------------------------------
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
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
    userDataDir: projectRoot,
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

// Poll a run to a terminal stage. Files are the source of truth (principle #1),
// so polling them is not a workaround — it is reading the same state the canvas
// reads, and it survives this process dying halfway.
async function waitForRun(api, projectId, runId, { timeoutSec, autoApprove }) {
  const deadline = Date.now() + timeoutSec * 1000;
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
    if (Date.now() > deadline) return { stage: 'timeout', snapshot: snap };
    await sleep(500);
  }
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
      if (!args.projectId && name.includes(':')) args.projectId ??= openProject(api, engine);
      return out(await api.invoke(name, args));
    }

    case 'runs': {
      const projectId = openProject(api, engine);
      const runs = await api.invoke('run:list', { projectId });
      return out(asJson ? runs : runs.map(r => `${r.id}\t${r.stage ?? ''}\t${r.name ?? ''}`).join('\n'));
    }

    case 'snapshot':
      return out(await api.invoke('run:snapshot', { projectId: openProject(api, engine), runId: positional[1] }));

    case 'log':
      return out(await api.invoke('run:log', { projectId: openProject(api, engine), runId: positional[1] }));

    case 'approve':
      return out(await api.invoke('run:approve', { projectId: openProject(api, engine), runId: positional[1] }));

    case 'reject':
      return out(await api.invoke('run:reject', {
        projectId: openProject(api, engine), runId: positional[1], reason: String(flags.reason ?? '')
      }));

    case 'stop':
      return out(await api.invoke('run:stop', { projectId: openProject(api, engine), runId: positional[1] }));

    case 'run': {
      const flowId = positional[1];
      if (!flowId) return die('flyt run <flow> --input "<text>"');
      const projectId = openProject(api, engine);
      const runId = await api.invoke('flow:run', {
        projectId,
        flowId,
        userInput: String(flags.input ?? positional.slice(2).join(' ') ?? ''),
        approvalMode: typeof flags.approval === 'string' ? flags.approval : null
      });
      say(`run ${runId} started`);
      const { stage, snapshot } = await waitForRun(api, projectId, runId, {
        timeoutSec: Number(flags.timeout ?? 1800),
        autoApprove: flags.gates === 'approve'
      });
      if (asJson) out({ ok: stage === 'done', runId, stage, snapshot });
      else {
        say(`run ${runId}: ${stage}`);
        // The deliverable, not the machinery: whatever the last node produced.
        const outputs = Object.values(snapshot.nodeOutputs ?? {});
        console.log(outputs.length ? outputs[outputs.length - 1] : `(no output; stage ${stage})`);
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

main().catch(err => {
  if (err instanceof ApiError) die(err.message);
  die(err.stack ?? String(err), 1);
});

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
  flyt task add "<title>" --goal "<what>"   queue a task for a later run
  flyt task list [--status queued]    the backlog
  flyt task show <id>                 one task, in full
  flyt task ready                     what the picker would take, and what is stuck
  flyt task escalate <id>             one effort level up, back to the queue
  flyt task take                      claim the top-scoring ready task
  flyt loop start [--parallel N]      work the backlog until empty, capped or stopped
  flyt loop stop|status               stop it, or see what it is doing
  flyt report                         what landed, what needs you, what it cost
  flyt spend [--since 24h]            the ledger
  flyt work start <taskId>            worktree + branch for a task
  flyt work verify <taskId>           run the gates in it (the harness runs them)
  flyt work land <taskId> [--dry-run|--push]  gates -> review -> merge -> canary
  flyt work discard <taskId>          throw the worktree away
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
  --timeout <sec>   how long to wait for a run to settle (default 1800)
  --goal <text>     what a queued task must achieve
  --value/--effort  1-5, feeding the picker's score (default 3 each)
  --level <l>       low|medium|high|xhigh|max — the OpenRouter cost band
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
            dependsOn: flags.dependsOn ? String(flags.dependsOn).split(',') : undefined
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
        await api.invoke('loop:start', {
          projectId,
          parallelism: Number(flags.parallel ?? 1),
          maxTasks: flags.tasks ? Number(flags.tasks) : null,
          dryRun: Boolean(flags['dry-run'])
        });
        say('loop started — ctrl-c to detach, `flyt loop stop` to stop it');
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
        case 'discard':
          return out(await api.invoke('work:discard', { projectId, taskId }));
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
        approvalMode: typeof flags.approval === 'string' ? flags.approval : null,
        level: typeof flags.level === 'string' ? flags.level : null
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

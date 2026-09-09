import { app, ipcMain, contentTracing } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { ProjectRegistry } from '../core/projects.js';
import { seedPerformanceRuns } from './performance-fixture.mjs';
import { distribution } from './performance-metrics.mjs';
import { startMainProfile, startCpuProfile, saveCpuProfile, interactionMetrics, summarizeChromiumTrace } from './performance-profiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-perf-app-'));
const profileKey = process.env.FLYT_PERF_PROFILE_KEY || '';
assert(!profileKey || /^[a-zA-Z0-9-]{1,80}$/.test(profileKey), 'Profile key must be a short test identifier');
const profile = profileKey ? path.join(os.tmpdir(), `flyt-perf-profile-${profileKey}`) : path.join(temp, 'profile');
const reusedProfile = fs.existsSync(profile);
const output = path.resolve(process.env.FLYT_PERF_OUTPUT || path.join(root, '.flyt', 'performance', 'app.json'));
const count = Number(process.env.FLYT_PERF_RUNS || 100);
const recordSeconds = Number(process.env.FLYT_PERF_RECORD_SECONDS || 0);
const chunks = Number(process.env.FLYT_PERF_CHUNKS || 200);
const toolBytes = Number(process.env.FLYT_PERF_TOOL_BYTES || 0);
const cpuProfiles = process.env.FLYT_PERF_CPU === '1';
const rasterProfile = process.env.FLYT_PERF_RASTER === '1';
const experiment = process.env.FLYT_PERF_REPLY_EXPERIMENT || 'baseline';
const repeatReply = process.env.FLYT_PERF_REPLY_REPEAT === '1';
const experimentCss = {
  baseline: '',
  'history-inset-shadow': '.work-history-item.active { box-shadow: inset 2px 0 0 var(--accent) !important; } .work-history-item.active::before { content: none !important; }',
  'blurred-reply': '.work-reply { backdrop-filter: blur(8px) !important; background: color-mix(in srgb, var(--canvas) 92%, transparent) !important; }',
  'no-backdrop': '.work-reply { backdrop-filter: none !important; }',
  'opaque-reply': '.work-reply { backdrop-filter: none !important; background: var(--canvas) !important; }',
  'explicit-focus': '.work-reply textarea:focus { outline: 2px solid var(--accent) !important; outline-offset: 2px !important; }',
  'opaque-explicit-focus': '.work-reply { backdrop-filter: none !important; background: var(--canvas) !important; } .work-reply textarea:focus { outline: 2px solid var(--accent) !important; outline-offset: 2px !important; }',
  'no-motion': '.v2-work, .v2-work * { animation: none !important; transition: none !important; }',
  'no-reads': '',
  'no-outline': '.work-reply textarea:focus { outline: none !important; }',
  'square-input': '.work-reply textarea { border-radius: 0 !important; }',
  'constant-button-opacity': '.work-reply button:disabled { opacity: 1 !important; }',
  'square-notches': '.v2-work .be-block::before, .v2-work .be-block::after, .v2-work .be-activity-item::after { border-radius: 0 !important; }',
  'square-activity': '.v2-work .be-activity-item, .v2-work .be-activity-item::before, .v2-work .be-activity-item::after { border-radius: 0 !important; }',
  'square-work': '.v2-work *, .v2-work *::before, .v2-work *::after { border-radius: 0 !important; }',
  'hide-run-blocks': '.v2-work .block-editor, .v2-work .block-editor * { visibility: hidden !important; }',
  'hide-run-chrome': '.v2-work .work-history, .v2-work .work-history *, .v2-work .work-run-head, .v2-work .work-run-head * { visibility: hidden !important; }',
  'no-history-shadow': '.work-history-item.active { box-shadow: none !important; }',
  'hide-run-history': '.v2-work .work-history, .v2-work .work-history * { visibility: hidden !important; }',
};
assert(Object.hasOwn(experimentCss, experiment), 'Unknown reply experiment');
assert(Number.isInteger(count) && count >= 1 && count <= 2000);
assert(Number.isFinite(recordSeconds) && recordSeconds >= 0 && recordSeconds <= 3600);
assert(Number.isInteger(chunks) && chunks >= 0 && chunks <= 10000);
assert(Number.isInteger(toolBytes) && toolBytes >= 0 && toolBytes <= 16 * 1024 * 1024);
fs.mkdirSync(profile, { recursive: true });
app.setPath('home', temp);
app.setPath('appData', temp);
app.setPath('userData', profile);
process.env.FLYT_VERIFY_USER_DATA = profile;
process.env.FLYT_VERIFY_DATA_ROOT = path.join(temp, 'data');
process.env.FLYT_TEST_MOCK_PROVIDER = '1';
process.env.FLYT_SANDBOX_MODE = 'danger-full-access';
const registry = new ProjectRegistry({ defaultRunsDir: path.join(temp, 'data', 'runs'), appDataDir: profile });
const { project } = registry.createAppdata('Performance fixture');
const fixture = seedPerformanceRuns(project.store.rootDir, count, chunks, { toolBytes });
// A second cold history makes concurrent work explicit even if the ordinary
// startup request finishes before input. Both projects are synthetic.
const concurrentProject = registry.createAppdata('Concurrent performance fixture').project;
seedPerformanceRuns(concurrentProject.store.rootDir, count, chunks, { toolBytes });
registry.activate(project.id);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ mock: true, scratchMigrated: true, projects: registry.serialize() }));
const report = { schemaVersion: 3, at: new Date().toISOString(), versions: process.versions, cpu: os.cpus()[0]?.model, profiling: cpuProfiles, fixture: { count, chunks: fixture.chunks, toolBytes, sessionBytes: fixture.sessionBytes }, ipc: [], phases: [], mainHeartbeat: [], limitations: 'Production dist with development Electron host; synthetic settled history and injected input. Online fonts and contention affect timings. CPU/Chromium tracing adds overhead and an initial blank navigation; compare separately from unprofiled repetitions. Event Timing is quantized to 8ms and thresholded at 16ms; reported interaction tails exclude faster interactions and are not INP. Presentation delay is the Event Timing estimate, not physical display latency. Input-to-RAF remains a separate proxy. No provider execution, live replay, or release-quality tail estimates.' };
const now = () => performance.timeOrigin + performance.now();
report.replyExperiment = { name: experiment, repeatReply, css: experimentCss[experiment] };
report.profileCache = { key: profileKey || null, reused: reusedProfile };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let bootAt = now();
let stopMainProfile, stopRendererProfile, rendererProbeReady;
let replyInputOnSnapshot;
const watchdog = setTimeout(() => {
  report.error = 'Performance scenario exceeded its timeout';
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.error(report.error);
  app.exit(1);
}, (120 + recordSeconds) * 1000);
let lastBeat = now();
const heartbeat = setInterval(() => {
  const at = now(), gapMs = at - lastBeat;
  if (gapMs > 50 && report.mainHeartbeat.length < 2000) report.mainHeartbeat.push({ at, gapMs });
  lastBeat = at;
}, 20);
// Capture all registered production handlers. No arguments or returned data.
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => originalHandle(channel, async (...args) => {
  const at = now();
  let ok = false;
  try {
    const pending = listener(...args);
    if (channel === 'run:snapshot' && replyInputOnSnapshot) {
      const deliver = replyInputOnSnapshot;
      replyInputOnSnapshot = undefined;
      deliver();
    }
    const result = await pending; ok = true; return result;
  }
  finally { if (report.ipc.length < 10000) report.ipc.push({ channel, at, durationMs: now() - at, ok }); }
});

function installRendererProbe() {
  if (window.__flytPerf) return;
  performance.mark(`flyt-perf-clock:${performance.timeOrigin + performance.now()}`);
  const samples = [];
  const supported = PerformanceObserver.supportedEntryTypes;
  const append = item => { if (samples.length < 2000) samples.push(item); };
  for (const type of ['longtask', 'long-animation-frame', 'event']) {
    if (!supported.includes(type)) continue;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) append({ type, name: entry.name, at: performance.timeOrigin + entry.startTime, durationMs: entry.duration,
        ...(type === 'event' ? { interactionId: entry.interactionId, inputDelayMs: entry.processingStart - entry.startTime, processingMs: entry.processingEnd - entry.processingStart, presentationDelayMs: Math.max(0, entry.startTime + entry.duration - entry.processingEnd) } : {}),
        ...(type === 'long-animation-frame' ? { blockingMs: entry.blockingDuration, scripts: entry.scripts.map(s => ({ function: s.sourceFunctionName, url: s.sourceURL, durationMs: s.duration, forcedLayoutMs: s.forcedStyleAndLayoutDuration })) } : {}),
      });
    }).observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) });
  }
  document.addEventListener('input', event => {
    const at = performance.now();
    requestAnimationFrame(() => append({ type: 'input-to-raf', at: performance.timeOrigin + at, durationMs: performance.now() - at }));
  }, true);
  window.__flytPerf = { samples, supported, startedAt: performance.timeOrigin + performance.now() };
}

async function exercise(win) {
  const run = code => win.webContents.executeJavaScript(code, true);
  report.focusRecoveries = [];
  const sendKey = key => {
    if (!win.isFocused()) { report.focusRecoveries.push({ at: now() }); win.focus(); }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
    win.webContents.sendInputEvent({ type: 'char', keyCode: key });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
  };
  const until = async code => {
    const deadline = now() + 60000;
    while (now() < deadline) { if (await run(code)) return; await wait(50); }
    throw new Error(`UI readiness timed out: ${code}`);
  };
  try {
    await rendererProbeReady;
    // Foreground interaction scenario: visibility-aware subscriptions correctly
    // pause in occluded windows. Do not mistake that for missing history.
    win.setAlwaysOnTop(true); win.show(); win.focus();
    await run(`(${installRendererProbe.toString()})()`);
    if (experimentCss[experiment]) await win.webContents.insertCSS(experimentCss[experiment]);
    await until("Boolean(document.querySelector('textarea.lander-input'))");
    report.phases.push({ name: 'app-entry-to-composer-dom', at: bootAt, durationMs: now() - bootAt });
    win.focus();
    await run("document.querySelector('textarea.lander-input').focus()");
    const typingAt = now();
    await run(`window.__concurrentHistory = { done: false }; void window.flyt.chatHistory(${JSON.stringify(concurrentProject.id)}).then(rows => { window.__concurrentHistory = { done: true, rows: rows.length }; }, error => { window.__concurrentHistory = { done: true, error: error.message }; });`);
    for (const key of 'Measure typing while history is loading.') {
      sendKey(key);
      await wait(30);
    }
    assert.equal(await run("document.querySelector('textarea.lander-input').value"), 'Measure typing while history is loading.');
    report.phases.push({ name: 'composer-typing', at: typingAt, durationMs: now() - typingAt });
    await until('window.__concurrentHistory.done');
    assert.equal((await run('window.__concurrentHistory')).rows, count);
    report.phases.push({ name: 'startup-through-composer-typing', at: bootAt, durationMs: now() - bootAt });
    const clickNav = async label => {
      const point = await run(`(() => { const button = [...document.querySelectorAll('.activity-btn')].find(b => b.querySelector('.activity-label')?.textContent === ${JSON.stringify(label)}); if (!button) throw new Error('Missing navigation'); const r = button.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    };
    const start = now();
    await clickNav('Chats');
    await until("Boolean(document.querySelector('.chats-row'))");
    report.phases.push({ name: 'chats-click-to-rows-observed', at: start, durationMs: now() - start });
    const pollAt = now();
    await wait(11000); // Observe two rounds of the real five-second polls.
    report.phases.push({ name: 'history-polling', at: pollAt, durationMs: now() - pollAt });
    const pollCalls = report.ipc.filter(row => row.channel === 'history:activity' && row.at >= pollAt);
    assert.equal(pollCalls.length, 2, 'one shared history stream should make two polls in eleven seconds');
    report.historyPolls = pollCalls;
    const openAt = now();
    await run("document.querySelector('.chats-row').click()");
    await until("Boolean(document.querySelector('.work-reply textarea'))");
    report.phases.push({ name: 'history-row-to-reply-observed', at: openAt, durationMs: now() - openAt });
    assert(await run("Boolean(document.querySelector('.be-activity-item'))"), 'fixture must render actual block activity');
    assert.equal(await run("document.querySelectorAll('.be-activity-item:not([open]) .be-activity-body').length"), 0);
    win.focus();
    await run("document.querySelector('.work-reply textarea').focus()");
    const replyAt = now();
    // Re-read through the real IPC endpoints while the reply remains editable.
    // Targeted reconciliation always validates canonically, bypassing hints.
    const startReplyRead = () => run(experiment === 'no-reads' ? 'window.__concurrentRun = { done: true }' : `window.__concurrentRun = { done: false }; void Promise.all([window.flyt.getSnapshot(${JSON.stringify(project.id)}, ${JSON.stringify(fixture.ids.at(-1))}), window.flyt.readRunLog(${JSON.stringify(project.id)}, ${JSON.stringify(fixture.ids.at(-1))})]).then(() => { window.__concurrentRun = { done: true }; }, error => { window.__concurrentRun = { done: true, error: error.message }; });`);
    // Dispatch the first key when the real snapshot handler starts. Waiting for
    // executeJavaScript's return can miss a fast read by an extra IPC round trip.
    // Keep measuring the actual event timestamp and assert real read overlap below.
    let firstReplyKeySent = false;
    if (experiment !== 'no-reads') replyInputOnSnapshot = () => { sendKey('D'); firstReplyKeySent = true; };
    await startReplyRead();
    if (experiment === 'no-reads') { sendKey('D'); firstReplyKeySent = true; }
    assert(firstReplyKeySent, 'snapshot must dispatch the first reply key');
    report.replyInputScheduling = 'First key dispatched when snapshot handler starts; subsequent keys at 30ms intervals';
    await wait(30);
    for (const key of 'raft reply for a long completed run.') {
      sendKey(key);
      await wait(30);
    }
    assert.equal(await run("document.querySelector('.work-reply textarea').value"), 'Draft reply for a long completed run.');
    report.phases.push({ name: 'reply-typing', at: replyAt, durationMs: now() - replyAt });
    await until('window.__concurrentRun.done');
    assert.equal((await run('window.__concurrentRun')).error, undefined);
    let expectedReply = 'Draft reply for a long completed run.';
    if (repeatReply) {
      await wait(1000);
      const steadyAt = now();
      await startReplyRead();
      const more = ' More typing after the first frames.';
      for (const key of more) {
        sendKey(key);
        await wait(30);
      }
      expectedReply += more;
      report.phases.push({ name: 'reply-typing-steady', at: steadyAt, durationMs: now() - steadyAt });
      assert.equal(await run("document.querySelector('.work-reply textarea').value"), expectedReply);
      await until('window.__concurrentRun.done');
      assert.equal((await run('window.__concurrentRun')).error, undefined);
    }
    const detailSelector = toolBytes ? '.be-activity-item.kind-tool' : '.be-activity-item.kind-chat';
    await run(`document.querySelector(${JSON.stringify(detailSelector)}).open = true`);
    await until("Boolean(document.querySelector('.be-activity-item[open] .be-activity-body'))");
    await run(`document.querySelector(${JSON.stringify(detailSelector)}).open = false`);
    await until("document.querySelectorAll('.be-activity-item:not([open]) .be-activity-body').length === 0");
    assert.equal(await run("document.querySelector('.work-reply textarea').value"), expectedReply);
    report.draftChecks = { composer: true, reply: true, detailToggle: true };
    // Trace replaces Work's subtree. A draft must survive the unmount as well
    // as normal background refreshes; this caught a native acceptance failure.
    await run("document.querySelector('.v2-trace-chip').click()");
    await until("Boolean(document.querySelector('[data-surface=trace]'))");
    await run("document.querySelector('.v2-trace-chip').click()");
    await until("Boolean(document.querySelector('.work-reply textarea'))");
    assert.equal(await run("document.querySelector('.work-reply textarea').value"), expectedReply);
    report.draftChecks.traceRoundTrip = true;
    await wait(200); // Let Event Timing publish the final presented interaction.
    if (recordSeconds) {
      console.log(`Interactive recording for ${recordSeconds}s in the synthetic project. Report: ${output}`);
      await wait(recordSeconds * 1000);
    }
    report.renderer = await run('({ ...window.__flytPerf, paints: performance.getEntriesByType("paint").map(p => ({ name: p.name, at: performance.timeOrigin + p.startTime })), heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null })');
    const typingPhases = ['composer-typing', 'reply-typing', ...(repeatReply ? ['reply-typing-steady'] : [])];
    report.distributions = {
      historyPollMs: distribution(report.historyPolls.map(row => row.durationMs)),
      ...Object.fromEntries(typingPhases.map(name => {
        const phase = report.phases.find(row => row.name === name);
        return [`${name}-input-to-raf-ms`, distribution(report.renderer.samples.filter(row => row.type === 'input-to-raf' && row.at >= phase.at && row.at < phase.at + phase.durationMs).map(row => row.durationMs))];
      })),
    };
    report.interactions = Object.fromEntries(typingPhases.map(name => {
      const rows = interactionMetrics(report.renderer.samples, report.phases.find(row => row.name === name));
      return [name, { rows, ...Object.fromEntries(['durationMs', 'inputDelayMs', 'processingMs', 'presentationDelayMs'].map(key => [key, distribution(rows.map(row => row[key]))])) }];
    }));
    report.typingOverlap = ['composer-typing', 'reply-typing'].map(name => {
      const phase = report.phases.find(row => row.name === name);
      const channels = name === 'composer-typing' ? ['history:activity'] : ['run:snapshot', 'run:log'];
      const calls = report.ipc.filter(row => channels.includes(row.channel) && row.at < phase.at + phase.durationMs && row.at + row.durationMs > phase.at);
      const inputsDuringRead = report.renderer.samples.filter(row => row.type === 'input-to-raf' && row.at >= phase.at && row.at < phase.at + phase.durationMs && calls.some(call => row.at >= call.at && row.at <= call.at + call.durationMs)).length;
      return { name, calls, inputsDuringRead };
    });
    for (const overlap of report.typingOverlap) {
      if (experiment === 'no-reads' && overlap.name === 'reply-typing') continue;
      assert(overlap.inputsDuringRead > 0, `${overlap.name} must deliver input during a read`);
    }
    report.historyIndicator = await run(`(() => { const el = document.querySelector('.work-history-item.active'); const s = getComputedStyle(el); const marker = getComputedStyle(el, '::before'); const r = el.getBoundingClientRect(); return { boxShadow: s.boxShadow, marker: { content: marker.content, width: marker.width, top: marker.top, bottom: marker.bottom, background: marker.backgroundColor, pointerEvents: marker.pointerEvents }, row: { x: r.x, y: r.y, width: r.width, height: r.height } }; })()`);
    report.gpu = { features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('complete') };
    report.replyStyles = await run(`(() => { const el = document.querySelector('.work-reply'); const s = getComputedStyle(el); const t = getComputedStyle(el.querySelector('textarea')); return { backdropFilter: s.backdropFilter, background: s.backgroundColor, position: s.position, textareaTransition: t.transition, textareaAnimation: t.animation, devicePixelRatio }; })()`);
    if (process.env.FLYT_PERF_SCREENSHOT === '1') {
      const screenshot = output.replace(/\.json$/, '') + '.png';
      fs.mkdirSync(path.dirname(screenshot), { recursive: true });
      fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
      report.screenshot = path.basename(screenshot);
    }
    report.processes = app.getAppMetrics().map(({ type, cpu, memory }) => ({ type, cpu, memory }));
    assert(report.ipc.some(row => row.channel === 'history:activity' && row.ok));
    console.log(JSON.stringify({ phases: report.phases, historyCalls: report.ipc.filter(r => r.channel === 'history:activity').map(r => Math.round(r.durationMs)), mainStalls: report.mainHeartbeat.map(r => Math.round(r.gapMs)), rendererSamples: report.renderer.samples.length }));
  } catch (error) {
    report.error = error.message;
    try { report.uiState = await run("({ hidden: document.hidden, historyRows: document.querySelectorAll('.chats-row').length, historyLoading: Boolean(document.querySelector('.chats-empty[role=status]')), historyError: Boolean(document.querySelector('.chats-error')), replyReady: Boolean(document.querySelector('.work-reply textarea')) })"); } catch { /* renderer may have exited */ }
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    clearInterval(heartbeat);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    if (cpuProfiles) {
      try {
        const phases = [...report.phases, ...report.mainHeartbeat.map((row, i) => ({ name: `main-stall-${i}`, at: row.at - row.gapMs, durationMs: row.gapMs }))];
        report.cpuProfiles = {};
        if (stopMainProfile) report.cpuProfiles.main = saveCpuProfile(output, 'main', await stopMainProfile(), phases);
        if (stopRendererProfile) report.cpuProfiles.renderer = saveCpuProfile(output, 'renderer', await stopRendererProfile(), phases);
        report.chromiumTrace = await contentTracing.stopRecording(output.replace(/\.json$/, '') + '-trace.json');
        report.traceSummary = summarizeChromiumTrace(report.chromiumTrace, report.phases);
      } catch (error) { report.profileError = error.message; process.exitCode = 1; }
    }
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(`Performance report: ${output}`);
    app.exit(process.exitCode || 0);
  }
}

app.once('browser-window-created', (_event, win) => {
  let exercised = false;
  if (cpuProfiles) {
    win.webContents.debugger.attach('1.3');
    const send = (method, params) => win.webContents.debugger.sendCommand(method, params);
    rendererProbeReady = (async () => {
      const categories = ['devtools.timeline', 'blink.user_timing', 'latencyInfo', 'toplevel', 'cc', 'gpu', 'benchmark'];
      if (rasterProfile) {
        report.availableRasterCategories = (await contentTracing.getCategories()).filter(name => /skia|gpu|cc\.debug|blink\.debug.*paint/i.test(name));
        // Picture/display-list serialization can itself stall the renderer for
        // hundreds of ms. Shader and GPU spans expose native compilation without it.
        categories.push('disabled-by-default-skia.gpu', 'disabled-by-default-skia.shaders', 'gpu.angle');
      }
      report.traceCategories = [...new Set(categories)];
      await contentTracing.startRecording({ included_categories: report.traceCategories });
      await send('Page.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installRendererProbe.toString()})()` });
      stopRendererProfile = await startCpuProfile(send);
    })();
    // Install before the first navigation, so startup React and folding appear.
    const loadFile = win.loadFile.bind(win);
    win.loadFile = async (...args) => { await win.loadURL('about:blank'); await rendererProbeReady; return loadFile(...args); };
  }
  win.webContents.on('did-finish-load', () => {
    if (exercised || win.webContents.getURL() === 'about:blank') return;
    exercised = true;
    void exercise(win);
  });
});
// Profiles are left in the OS temp directory so the report can be investigated;
// Chromium may still hold files during app shutdown. Never delete a user profile.
try {
  if (cpuProfiles) {
    stopMainProfile = await startMainProfile();
  }
  bootAt = now(); lastBeat = bootAt;
  await import('../electron/main.js');
}
catch (error) {
  report.error = error.message;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.error(error);
  app.exit(1);
}

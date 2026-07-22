// The Electron half of scripts/smoke-chatrun.mjs: a hidden window pointed at
// the vite dev server (dev mock installs — no preload bridge), driving the
// chat-run surface and writing screenshots + a state dump. Never shown on
// screen; exits when done.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true, // no preload: devMock fills in
      // Fresh storage per run — UI prefs persist to localStorage, and last
      // run's sidebar/view toggles must not leak into this capture.
      partition: `smoke-${Date.now()}`
    }
  });
  const run = code => win.webContents.executeJavaScript(code, true);
  // Hidden windows produce frames lazily — nudge the compositor and give it a
  // beat before capturing, or capturePage hands back a pre-interaction frame.
  const nudge = async () => { win.setSize(1400, 901); win.setSize(1400, 900); await wait(400); };

  try {
    await win.loadURL(process.env.SMOKE_URL);
    await wait(2800); // react boot + lander render

    // Fill the lander composer the React-honest way, then run.
    await run(`(() => {
      const ta = document.querySelector('textarea.lander-input');
      if (!ta) return false;
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        .call(ta, 'Reinstall dependencies cleanly');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await wait(300);
    await run(`document.querySelector('button.lander-run.primary')?.click()`);
    await wait(2600); // chat run mounts, mock snapshot lands, approval dialog opens

    const probe = `({
      chatRun: !!document.querySelector('.chat-run'),
      stage: document.querySelector('.stage-chip')?.textContent,
      modal: !!document.querySelector('.approval-modal'),
      dock: !!document.querySelector('.gate-dock'),
      dockHasDetails: !!document.querySelector('.gate-dock .ghost.mini'),
      feedItems: document.querySelectorAll('.feed-item').length,
      sideOpen: !!document.querySelector('.chat-side'),
      composerHint: document.querySelector('.chat-input')?.placeholder
    })`;
    console.log('PROBE-1 ' + JSON.stringify(await run(probe)));

    // CSS token sanity: which tinted fills actually resolve in this runtime?
    console.log('CSS-PROBE ' + JSON.stringify(await run(`(() => {
      const probeOf = v => {
        const el = document.createElement('div');
        el.style.background = v;
        document.body.appendChild(el);
        const c = getComputedStyle(el).backgroundColor;
        el.remove();
        return c;
      };
      return {
        warnSoft: probeOf('var(--warn-soft)'),
        warn: probeOf('var(--warn)'),
        errSoft: probeOf('var(--err-soft)'),
        accentSoft: probeOf('var(--accent-soft)'),
        lightDark: probeOf('light-dark(rgb(1,2,3), rgb(4,5,6))'),
        colorMix: probeOf('color-mix(in srgb, var(--warn) 12%, #ffffff)'),
        oklchFromLiteral: probeOf('oklch(from rgb(120, 140, 128) 0.94 0.02 h)'),
        glyphTile: getComputedStyle(document.querySelector('.approval-modal-glyph')).backgroundColor
      };
    })()`)));

    // 1) The gate owns the surface.
    await nudge();
    const shot1 = await win.webContents.capturePage();
    fs.writeFileSync('smoke-chatrun-gate.png', shot1.toPNG());

    // 2) Minimize the gate, open the summary sidebar, stick to the feed tail.
    await run(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Review first')?.click()`);
    await wait(600);
    console.log('PROBE-2 ' + JSON.stringify(await run(probe)));
    await run(`document.querySelector('.chat-side-toggle')?.click()`);
    await wait(800);
    await run(`document.querySelector('.chat-scroll')?.scrollTo({ top: 999999 })`);
    await wait(600);
    console.log('PROBE-3 ' + JSON.stringify(await run(probe)));
    await nudge();
    const shot2 = await win.webContents.capturePage();
    fs.writeFileSync('smoke-chatrun-side.png', shot2.toPNG());

    const state = await run(`({
      chatRun: !!document.querySelector('.chat-run'),
      feedItems: document.querySelectorAll('.feed-item').length,
      feedStatuses: [...document.querySelectorAll('.feed-item')]
        .map(el => el.className.match(/status-\\w+/)?.[0]),
      sideOpen: !!document.querySelector('.chat-side'),
      sideNodes: document.querySelectorAll('.side-node').length,
      modalGoneAfterMinimize: !document.querySelector('.approval-modal'),
      dockPresent: !!document.querySelector('.gate-dock'),
      dockText: document.querySelector('.gate-dock-text')?.innerHTML,
      dockStrongRect: (() => { const s = document.querySelector('.gate-dock-text strong'); if (!s) return null; const r = s.getBoundingClientRect(); return { w: r.width, h: r.height, color: getComputedStyle(s).color }; })(),
      dockBg: (() => { const d = document.querySelector('.gate-dock'); return d ? getComputedStyle(d).backgroundColor : null; })(),
      themeAttr: document.documentElement.dataset.theme,
      viewButtons: [...document.querySelectorAll('.view-btn')].map(b => b.textContent.trim())
    })`);
    console.log('SMOKE-STATE ' + JSON.stringify(state));
  } catch (e) {
    console.error('smoke failed:', e);
    app.exit(1);
    return;
  }
  app.exit(0);
});

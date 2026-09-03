// A Safety choice must bind the next run, not the next app start.
//
// Observed 2026-09-03 in the desktop app: Settings was switched to "Ask
// permission", the panel confirmed it after a reopen, and two runs launched
// straight afterwards were still recorded with `approvalMode: always`. The
// panel persisted the change main-side while the launcher kept the settings it
// had read once at mount, so the safe mode was chosen and never applied.
//
// There is no DOM harness in this suite, so this pins the three links of that
// chain the way the search-provider test pins its cross-file wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = relative => fs.readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

test('a Safety change reaches the next run the launcher starts', () => {
  const settings = read('src/Settings.jsx');
  const daily = read('src/v2/DailyRoot.jsx');

  // 1. Every mutation in the panel funnels through save()...
  const save = settings.match(/const save = async patch => \{[\s\S]*?\n {2}\};/)?.[0];
  assert.ok(save, 'Settings still routes its writes through one save() funnel');
  assert.match(save, /window\.flyt\.setSettings\(patch\)/);
  // ...and that funnel tells the host its copy is now stale.
  assert.match(save, /onSaved\?\.\(/, 'save() notifies the host of the new settings');
  assert.match(settings, /export default function Settings\(\{[^}]*onSaved/,
    'and onSaved is an accepted prop rather than an undeclared global');

  // 2. The launcher accepts it into the state it launches runs from.
  const mounted = daily.match(/<Settings[\s\S]*?\/>/)?.[0];
  assert.ok(mounted, 'DailyRoot still mounts the Settings panel');
  assert.match(mounted, /onSaved=\{setSettings\}/,
    'the launcher takes the update into the same state the run request reads');

  // 3. That state is what the run request actually carries.
  assert.match(daily, /settings\?\.approvalMode \?\? null/,
    'a launched run sends the approval mode from that state');
});

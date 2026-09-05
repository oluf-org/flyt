import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('minimized chat history removes the sidebar and leaves only a reopen control', () => {
  const component = read('../src/v2/Work.jsx');
  const styles = read('../src/v2/workStyles.css');
  assert.match(component, /if \(collapsed\) return <button[^>]+className="work-history-reopen"/);
  assert.match(component, /aria-label="Show chat history"/);
  assert.doesNotMatch(component, /work-history\$\{collapsed/);
  assert.doesNotMatch(styles, /\.work-history\.collapsed/);
  assert.match(styles, /\.work-history-reopen\s*\{[^}]*position: absolute/s);
  assert.match(styles, /\.v2-work:has\(> \.work-history-reopen\) \.work-run-head \{ padding-left: 58px; \}/,
    'the collapsed control reserves its own header space instead of covering the run title');
});

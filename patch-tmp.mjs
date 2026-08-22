import fs from 'fs';
const CR = '\r\n';
const idx = (s, old) => {
  const i = s.indexOf(old);
  if (i === -1) throw new Error('MISSING: ' + JSON.stringify(old.slice(0, 70)));
  if (i !== s.lastIndexOf(old)) throw new Error('NOT UNIQUE: ' + JSON.stringify(old.slice(0, 70)));
  return i;
};
function patch(path, pairs) {
  let s = fs.readFileSync(path, 'utf8');
  for (const [old, neu] of pairs) s = s.slice(0, idx(s, old)) + neu + s.slice(idx(s, old) + old.length);
  fs.writeFileSync(path, s);
  console.log('patched', path);
}

patch('src/App.jsx', [
  [
    '      flowViewMode: slim.flowViewMode, runView2: slim.runView2,' + CR,
    '      flowViewMode: slim.flowViewMode, runView2: slim.runView2,' + CR +
    '      loopDensity: slim.loopDensity ?? \'comfortable\',' + CR
  ],
  [
    '                onOpenRun={id => { setActiveActivity(\'runs\'); openRun(id); }}',
    '                onOpenRun={id => { setActiveActivity(\'runs\'); openRun(id); }}' + CR +
    '                density={loopDensity}' + CR +
    '                onDensityChange={setLoopDensity}'
  ]
]);

patch('src/loop/LoopPage.jsx', [
  [
    'export default function LoopPage({ projectId, activeModels = [], onOpenRun = null }) {',
    'export default function LoopPage({ projectId, activeModels = [], onOpenRun = null, density = \'comfortable\', onDensityChange = null }) {'
  ],
  [
    '        >?</button>' + CR + '      </div>' + CR,
    '        >?</button>' + CR +
    '        {/* Density (D4): comfortable when you are reading six tasks,' + CR +
    '            compact when you are scanning eighty. The choice is per-project' + CR +
    '            and survives a reload via saveProjectState. */}' + CR +
    '        <div className="loop-density" role="group" aria-label="Card density">' + CR +
    '          {[[\'comfortable\', \'Comfortable\'], [\'compact\', \'Compact\']].map(([value, label]) => (' + CR +
    '            <button' + CR +
    '              key={value}' + CR +
    '              type="button"' + CR +
    '              className={`loop-density-btn${density === value ? \' active\' : \'\'}`}' + CR +
    '              aria-pressed={density === value}' + CR +
    '              onClick={() => onDensityChange?.(value)}' + CR +
    '            >{label}</button>' + CR +
    '          ))}' + CR +
    '        </div>' + CR +
    '      </div>' + CR
  ],
  [
    '      <Board' + CR + '        columns={columns}',
    '      <Board' + CR + '        density={density}' + CR + '        columns={columns}'
  ]
]);

patch('src/loop/Board.jsx', [
  [
    '  showDone = false,',
    '  showDone = false,' + CR + '  density = \'comfortable\','
  ],
  [
    '    <div className="loop-board">',
    '    <div className="loop-board" data-density={density}>'
  ]
]);

const css =
'/* --- compact density (D4) ------------------------------------------------- */' + CR +
'/* A board set to compact drops each collapsed card to ONE line - no value/' + CR +
'   effort chip, no blocker sentence - for scanning eighty tasks rather than' + CR +
'   reading six. The choice lives in the data attribute on the board, so these' + CR +
'   rules are keyed off it and there is still exactly one card renderer. An' + CR +
'   open card is a person reading one task, so it gets the roomy look back. */' + CR +
'.loop-board[data-density="compact"] .loop-card { padding: 0 7px; }' + CR +
'.loop-board[data-density="compact"] .loop-card-head { font-size: 11px; line-height: 1.15; gap: 6px; }' + CR +
'.loop-board[data-density="compact"] .loop-card-head .caret { font-size: 8px; }' + CR +
'.loop-board[data-density="compact"] .loop-card-head .id { font-size: 10px; }' + CR +
'.loop-board[data-density="compact"] .loop-card-head .chip { display: none; }' + CR +
'.loop-board[data-density="compact"] .loop-card-line { display: none; }' + CR +
'.loop-board[data-density="compact"] .loop-card .source-run { display: none; }' + CR +
'/* The hover-revealed action row would re-grow the card mid-scan; the keyboard' + CR +
'   paths (j/k, enter, r, x) still reach every one of those actions. */' + CR +
'.loop-board[data-density="compact"] .loop-card-actions { display: none; }' + CR +
'.loop-board[data-density="compact"] .loop-column-cards { gap: 2px; }' + CR +
'.loop-board[data-density="compact"] .loop-card.open { padding: 6px 9px; }' + CR +
'.loop-board[data-density="compact"] .loop-card.open .loop-card-head { font-size: 12px; line-height: 1.5; }' + CR +
'.loop-board[data-density="compact"] .loop-card.open .loop-card-head .chip { display: revert; }' + CR +
CR;
fs.appendFileSync('src/styles.css', css);
console.log('appended styles.css');
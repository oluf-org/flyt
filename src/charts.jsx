import React from 'react';

// Hand-rolled SVG charts (PIVOT-PLAN §10.1, answered).
//
// The question was: a charting dependency, or build them? D24's zero-dependency
// rule is written about the DSL parser, not the UI, so this was a judgement
// call rather than a rule. Four shapes are needed — line, bar, histogram, box —
// and each is thirty lines of path maths against a scale. A charting library
// would be 150 KB, a second theming system to reconcile with the oklch tokens
// in styles.css, and a third way of drawing things next to src/Constellation.jsx
// and src/sigil.js, both of which are already hand-drawn SVG. Built.
//
// Every chart here:
//   • takes plain numbers, never a data frame
//   • uses currentColor and the CSS custom properties, so light/dark comes free
//   • degrades to an explicit empty state rather than an empty box
//   • renders nothing that moves — these are read, not watched (D9)

const PAD = { top: 10, right: 10, bottom: 22, left: 46 };

function Empty({ label }) {
  return <div className="chart-empty">{label}</div>;
}

// A linear scale, the only one any of these need.
const scale = (d0, d1, r0, r1) => v => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));

// "Nice" ticks: 1/2/5 × 10ⁿ, so an axis reads 0 · 0.05 · 0.10 rather than
// 0 · 0.0333 · 0.0667.
function ticks(max, count = 4) {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].find(m => m * mag >= raw) * mag;
  const out = [];
  for (let v = 0; v <= max + step / 2; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

// --- line / area: a value over time -------------------------------------------
//
// `points` is [{ at, value }] already sorted. Gaps in time are drawn as gaps in
// the line, not interpolated across — a week with no runs is a week with no
// spend, and a line sloping smoothly through it would invent history.
export function LineChart({ points, height = 150, format = String, label = '' }) {
  const data = (points ?? []).filter(p => typeof p.value === 'number' && Number.isFinite(p.value));
  if (data.length === 0) return <Empty label={`No ${label || 'data'} in this window.`} />;
  const w = 640;
  const h = height;
  const max = Math.max(...data.map(p => p.value), 0);
  const yTicks = ticks(max);
  const top = yTicks[yTicks.length - 1] || 1;
  const x = scale(0, Math.max(1, data.length - 1), PAD.left, w - PAD.right);
  const y = scale(0, top, h - PAD.bottom, PAD.top);
  const line = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  // Enough labels to orient, never so many they collide.
  const every = Math.max(1, Math.ceil(data.length / 6));
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} preserveAspectRatio="none">
      {yTicks.map(t => (
        <g key={t}>
          <line className="chart-grid" x1={PAD.left} x2={w - PAD.right} y1={y(t)} y2={y(t)} />
          <text className="chart-tick" x={PAD.left - 6} y={y(t) + 3} textAnchor="end">{format(t)}</text>
        </g>
      ))}
      <path className="chart-area" d={area} />
      <path className="chart-line" d={line} />
      {data.map((p, i) => <circle key={p.at} className="chart-dot" cx={x(i)} cy={y(p.value)} r={2.5}><title>{`${p.at} — ${format(p.value)}`}</title></circle>)}
      {data.map((p, i) => (i % every === 0
        ? <text key={'t' + p.at} className="chart-tick" x={x(i)} y={h - 6} textAnchor="middle">{shortDate(p.at)}</text>
        : null))}
    </svg>
  );
}

// --- histogram: how a set of measurements is actually shaped --------------------
//
// The shape §6.2.3 asks for. A p95 marker rides on top because the percentile
// is the number people act on and the bars are what make it believable.
export function Histogram({ hist, height = 150, format = String, label = '', p95 = null }) {
  if (!hist?.bins?.length) return <Empty label={`No ${label || 'measurements'} yet.`} />;
  const w = 640;
  const h = height;
  const max = Math.max(...hist.bins.map(b => b.count));
  const x = scale(hist.min, hist.max || hist.min + 1, PAD.left, w - PAD.right);
  const y = scale(0, max, h - PAD.bottom, PAD.top);
  const bw = Math.max(1, (w - PAD.left - PAD.right) / hist.bins.length - 1.5);
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} preserveAspectRatio="none">
      {ticks(max).map(t => (
        <g key={t}>
          <line className="chart-grid" x1={PAD.left} x2={w - PAD.right} y1={y(t)} y2={y(t)} />
          <text className="chart-tick" x={PAD.left - 6} y={y(t) + 3} textAnchor="end">{t}</text>
        </g>
      ))}
      {hist.bins.map((b, i) => (
        <rect
          key={i} className="chart-bar"
          x={x(b.from)} width={bw}
          y={y(b.count)} height={Math.max(0, y(0) - y(b.count))}
        ><title>{`${format(b.from)} – ${format(b.to)}: ${b.count} call(s)`}</title></rect>
      ))}
      {p95 != null && p95 >= hist.min && p95 <= hist.max && (
        <g>
          <line className="chart-marker" x1={x(p95)} x2={x(p95)} y1={PAD.top} y2={h - PAD.bottom} />
          <text className="chart-marker-label" x={x(p95) + 4} y={PAD.top + 9}>p95 {format(p95)}</text>
        </g>
      )}
      <text className="chart-tick" x={PAD.left} y={h - 6}>{format(hist.min)}</text>
      <text className="chart-tick" x={w - PAD.right} y={h - 6} textAnchor="end">{format(hist.max)}</text>
    </svg>
  );
}

// --- box plot: one distribution per row, compared -------------------------------
//
// The honest alternative to a bar chart of averages (§10.4). A row shows where
// a model's calls actually landed; a bar would claim a single number describes
// them, which for latency it never does.
export function BoxRows({ rows, format = String, label = '' }) {
  const usable = (rows ?? []).filter(r => r.dist && Number.isFinite(r.dist.p50));
  if (!usable.length) return <Empty label={`No ${label || 'measurements'} yet.`} />;
  const max = Math.max(...usable.map(r => r.dist.max));
  const min = Math.min(...usable.map(r => r.dist.min));
  const w = 640;
  const rowH = 26;
  const h = usable.length * rowH + 20;
  const labelW = 150;
  const x = scale(min, max, labelW, w - 12);
  return (
    <svg className="chart chart-box" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      {usable.map((r, i) => {
        const cy = i * rowH + rowH / 2;
        const d = r.dist;
        return (
          <g key={r.key} className={'box-row' + (r.comparable ? '' : ' narrow')}>
            <text className="chart-rowlabel" x={0} y={cy + 3}>{r.key}</text>
            <line className="box-whisker" x1={x(d.min)} x2={x(d.max)} y1={cy} y2={cy} />
            <rect className="box-body" x={x(d.p50)} width={Math.max(1.5, x(d.p95) - x(d.p50))} y={cy - 5} height={10} rx={2} />
            <circle className="box-median" cx={x(d.p50)} cy={cy} r={3.5} />
            <title>{`${r.key}: median ${format(d.p50)} · p95 ${format(d.p95)} · max ${format(d.max)} (${d.n} calls)`}</title>
          </g>
        );
      })}
      <text className="chart-tick" x={labelW} y={h - 4}>{format(min)}</text>
      <text className="chart-tick" x={w - 12} y={h - 4} textAnchor="end">{format(max)}</text>
    </svg>
  );
}

// --- stacked bars: composition over time ------------------------------------------
export function StackedBars({ buckets, keys, height = 150, format = String, label = '' }) {
  const data = buckets ?? [];
  if (!data.length) return <Empty label={`No ${label || 'data'} in this window.`} />;
  const w = 640;
  const h = height;
  const totals = data.map(b => b.parts.reduce((n, p) => n + (p.value ?? 0), 0));
  const max = Math.max(...totals, 0);
  const yTicks = ticks(max);
  const top = yTicks[yTicks.length - 1] || 1;
  const y = scale(0, top, h - PAD.bottom, PAD.top);
  const slot = (w - PAD.left - PAD.right) / data.length;
  const bw = Math.max(2, slot - 3);
  const every = Math.max(1, Math.ceil(data.length / 6));
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} preserveAspectRatio="none">
      {yTicks.map(t => (
        <g key={t}>
          <line className="chart-grid" x1={PAD.left} x2={w - PAD.right} y1={y(t)} y2={y(t)} />
          <text className="chart-tick" x={PAD.left - 6} y={y(t) + 3} textAnchor="end">{format(t)}</text>
        </g>
      ))}
      {data.map((b, i) => {
        let acc = 0;
        return b.parts.map(p => {
          const from = acc;
          acc += p.value ?? 0;
          return (
            <rect
              key={b.at + p.key} className={'chart-bar series-' + (keys.indexOf(p.key) % 6)}
              x={PAD.left + i * slot} width={bw}
              y={y(acc)} height={Math.max(0, y(from) - y(acc))}
            ><title>{`${b.at} — ${p.key}: ${format(p.value)}`}</title></rect>
          );
        });
      })}
      {data.map((b, i) => (i % every === 0
        ? <text key={'t' + b.at} className="chart-tick" x={PAD.left + i * slot + bw / 2} y={h - 6} textAnchor="middle">{shortDate(b.at)}</text>
        : null))}
    </svg>
  );
}

function shortDate(at) {
  const s = String(at ?? '');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}/.test(s)) return s.slice(11, 16);
  return s.slice(5);
}

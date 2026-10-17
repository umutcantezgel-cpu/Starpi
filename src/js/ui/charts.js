// @ts-check
// Plain SVG charts: horizontal bars with reference lines, and a sparkline. No library and no inline
// styles: every colour, size and font is a class (Tailwind utilities on the theme's colour tokens), so
// the charts pass the CSP, follow the dark theme and keep their contrast in both.
//
// Charts are drawn at the pixel width they get (the caller passes the container's width), so text
// keeps its size on a phone instead of scaling with a viewBox. Each chart is an image with an
// accessible name; each bar carries its value as a tooltip (<title>), and the caller shows the same
// numbers in a table.
//
// Marks: bars at most 24 px thick with a 4 px rounded end and a square baseline, 2 px lines, end dots
// of 8 px with a ring in the surface colour, hairline reference lines.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @typedef {object} Bar
 * @property {string} label category name, shown left of the bar
 * @property {number} value
 * @property {string} valueText the value as shown at the end of the bar
 * @property {string} [title] tooltip text (default: "label: valueText")
 *
 * @typedef {object} BarChartOptions
 * @property {number} width rendered width in CSS pixels
 * @property {string} label accessible name of the chart
 * @property {ReadonlyArray<{ value: number, label: string }>} [marks] vertical reference lines
 * @property {number} [max] value at the right end of the scale (default: the largest value or mark, rounded up)
 * @property {Document} [doc]
 *
 * @typedef {object} SparklineOptions
 * @property {string} label accessible name
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [max] top of the scale (default: the largest value)
 * @property {Document} [doc]
 */

const ROW = 28;
const BAR = 14;
const TOP = 18;
const BOTTOM = 6;
const VALUE_WIDTH = 72;
/** Average glyph width of the 12 px label font, to fit labels without measuring them. */
const CHAR_PX = 6.6;
const RADIUS = 4;

/**
 * @param {Document} doc
 * @param {string} name
 * @param {Record<string, string | number>} [attrs]
 * @param {string} [className]
 */
function el(doc, name, attrs = {}, className) {
  const node = doc.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (className) node.setAttribute('class', className);
  return node;
}

/** @param {number} v */
const safe = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

/** @param {number} v */
const px = (v) => String(Math.round(v * 10) / 10);

/**
 * A round number at or above `value` (1, 2, 2.5 or 5 times a power of ten), for the end of a scale.
 * @param {number} value
 */
export function niceMax(value) {
  if (!(value > 0) || !Number.isFinite(value)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

/**
 * The outline of a horizontal bar: square at the baseline (x), rounded at its end.
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 */
export function barPath(x, y, width, height) {
  if (width <= 0) return '';
  const r = Math.min(RADIUS, width, height / 2);
  const end = x + width;
  return `M${px(x)} ${px(y)}H${px(end - r)}A${px(r)} ${px(r)} 0 0 1 ${px(end)} ${px(y + r)}V${px(y + height - r)}A${px(r)} ${px(r)} 0 0 1 ${px(end - r)} ${px(y + height)}H${px(x)}Z`;
}

/**
 * @param {string} text
 * @param {number} chars
 */
function fit(text, chars) {
  return text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1))}…`;
}

/**
 * Horizontal bars, one row per category, with optional vertical reference lines labelled above.
 * @param {readonly Bar[]} bars
 * @param {BarChartOptions} options
 * @returns {SVGSVGElement}
 */
export function barChart(bars, options) {
  const doc = options.doc ?? document;
  const width = Math.max(240, Math.round(options.width));
  const marks = (options.marks ?? []).filter((m) => safe(m.value) > 0);
  const height = TOP + bars.length * ROW + BOTTOM;
  const longest = bars.reduce((n, b) => Math.max(n, b.label.length), 0);
  const labelWidth = Math.round(Math.min(width * 0.42, Math.max(64, longest * CHAR_PX + 12)));
  const x0 = labelWidth;
  const plot = Math.max(40, width - labelWidth - VALUE_WIDTH);
  const max = options.max ?? niceMax(Math.max(...bars.map((b) => safe(b.value)), ...marks.map((m) => m.value)));
  const scale = (/** @type {number} */ v) => (Math.min(safe(v), max) / max) * plot;

  const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (el(doc, 'svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': options.label }, 'block max-w-full')));
  for (const m of marks) {
    const x = x0 + scale(m.value);
    svg.append(el(doc, 'line', { x1: px(x), x2: px(x), y1: TOP - 4, y2: height - BOTTOM, 'stroke-width': 1 }, 'stroke-slate-300'));
    const text = el(doc, 'text', { x: px(x), y: TOP - 7, 'text-anchor': 'middle' }, 'fill-slate-500 text-[10px]');
    text.textContent = m.label;
    svg.append(text);
  }
  svg.append(el(doc, 'line', { x1: x0, x2: x0, y1: TOP - 4, y2: height - BOTTOM, 'stroke-width': 1 }, 'stroke-slate-300'));

  bars.forEach((bar, i) => {
    const y = TOP + i * ROW;
    const g = el(doc, 'g', { 'data-bar': i });
    const title = el(doc, 'title');
    title.textContent = bar.title ?? `${bar.label}: ${bar.valueText}`;
    g.append(title);
    // The whole row is the hover target, not only the bar.
    g.append(el(doc, 'rect', { x: 0, y, width, height: ROW }, 'fill-transparent'));
    const label = el(doc, 'text', { x: x0 - 8, y: y + ROW / 2, 'text-anchor': 'end', 'dominant-baseline': 'central' }, 'fill-slate-700 text-[12px]');
    label.textContent = fit(bar.label, Math.floor((labelWidth - 12) / CHAR_PX));
    g.append(label);
    const w = scale(bar.value);
    const d = barPath(x0, y + (ROW - BAR) / 2, w, BAR);
    if (d) g.append(el(doc, 'path', { d }, 'fill-emerald-600'));
    const value = el(doc, 'text', { x: px(x0 + w + 6), y: y + ROW / 2, 'dominant-baseline': 'central' }, 'fill-slate-700 text-[11px] font-semibold tabular-nums');
    value.textContent = bar.valueText;
    g.append(value);
    svg.append(g);
  });
  return svg;
}

/**
 * A small trend line of values in order, with a dot on the latest one.
 * @param {readonly number[]} values
 * @param {SparklineOptions} options
 * @returns {SVGSVGElement}
 */
export function sparkline(values, options) {
  const doc = options.doc ?? document;
  const width = options.width ?? 96;
  const height = options.height ?? 28;
  const pad = 6;
  const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (el(doc, 'svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': options.label }, 'block')));
  if (values.length === 0) return svg;
  const max = options.max ?? Math.max(...values.map(safe));
  const top = max > 0 ? max : 1;
  const step = values.length > 1 ? (width - 2 * pad) / (values.length - 1) : 0;
  const points = values.map((v, i) => [pad + i * step, height - pad - (safe(v) / top) * (height - 2 * pad)]);
  svg.append(el(doc, 'line', { x1: pad, x2: width - pad, y1: height - pad, y2: height - pad, 'stroke-width': 1 }, 'stroke-slate-200'));
  if (points.length > 1) {
    const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${px(x)} ${px(y)}`).join('');
    svg.append(el(doc, 'path', { d, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, 'fill-none stroke-emerald-600'));
  }
  const [lx, ly] = points[points.length - 1];
  svg.append(el(doc, 'circle', { cx: px(lx), cy: px(ly), r: 4, 'stroke-width': 2 }, 'fill-emerald-600 stroke-white'));
  return svg;
}

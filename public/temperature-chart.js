export const TEMPERATURE_CHART_RANGE = Object.freeze({
  xMinMinutes: 0,
  xMaxMinutes: 1440,
  yMin: -5,
  yMax: 35,
  xTicks: Array.from({ length: 25 }, (_, hour) => hour * 60),
  yTicks: Array.from({ length: 9 }, (_, index) => -5 + index * 5),
});

const SVG_NS = 'http://www.w3.org/2000/svg';
const TIME_ZONE = 'Europe/Rome';
const WIDTH = 900;
const HEIGHT = 430;
const PLOT = Object.freeze({ left: 54, right: 18, top: 18, bottom: 43 });
const SERIES_GAP_MS = 20 * 60_000;

function timeParts(timestamp) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { hour: Number(values.hour), minute: Number(values.minute) };
}

export function minuteOfDay(timestamp) {
  const { hour, minute } = timeParts(timestamp);
  return hour * 60 + minute;
}

export function temperatureMarkerStride(sampleCount) {
  return Math.max(1, Math.ceil(sampleCount / 24));
}

function seriesStats(values) {
  if (!values.length) return { min: null, max: null };
  return { min: Math.min(...values), max: Math.max(...values) };
}

export function buildTemperatureChartModel(history, snapshot) {
  const samples = (history?.samples || [])
    .filter((sample) => sample?.timestamp && Number.isFinite(sample.pond) && Number.isFinite(sample.ambient))
    .map((sample) => ({ ...sample, minute: minuteOfDay(sample.timestamp) }))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return {
    date: history?.date ?? null,
    samples,
    current: {
      pond: snapshot?.externalProbeTemperature?.value ?? samples.at(-1)?.pond ?? null,
      ambient: snapshot?.ambientTemperature?.value ?? samples.at(-1)?.ambient ?? null,
    },
    pond: seriesStats(samples.map((sample) => sample.pond)),
    ambient: seriesStats(samples.map((sample) => sample.ambient)),
  };
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function xPosition(minute) {
  const plotWidth = WIDTH - PLOT.left - PLOT.right;
  return PLOT.left + (minute / TEMPERATURE_CHART_RANGE.xMaxMinutes) * plotWidth;
}

function yPosition(value) {
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
  return PLOT.top + ((TEMPERATURE_CHART_RANGE.yMax - value)
    / (TEMPERATURE_CHART_RANGE.yMax - TEMPERATURE_CHART_RANGE.yMin)) * plotHeight;
}

export function buildTemperatureSeriesPath(samples, field) {
  return samples.map((sample, index) => {
    const previous = samples[index - 1];
    const gap = previous ? Date.parse(sample.timestamp) - Date.parse(previous.timestamp) : 0;
    const command = !previous || gap > SERIES_GAP_MS ? 'M' : 'L';
    return `${command} ${xPosition(sample.minute).toFixed(2)} ${yPosition(sample[field]).toFixed(2)}`;
  }).join(' ');
}

function formatTemperature(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} °C` : '—';
}

function statBlock(label, className, current, stats) {
  const block = document.createElement('div');
  block.className = `temperature-stat ${className}`;
  const name = document.createElement('span');
  name.textContent = label;
  const value = document.createElement('strong');
  value.textContent = formatTemperature(current);
  const range = document.createElement('small');
  range.textContent = `Min ${formatTemperature(stats.min)} · Max ${formatTemperature(stats.max)}`;
  block.append(name, value, range);
  return block;
}

export function renderTemperatureChart(container, history, snapshot) {
  const model = buildTemperatureChartModel(history, snapshot);
  const header = document.createElement('header');
  header.className = 'temperature-chart-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'temperature-chart-heading';
  const icon = document.createElement('img');
  icon.className = 'temperature-chart-icon';
  icon.src = '/icons/history.svg';
  icon.alt = '';
  const titleText = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = 'Temperature Oggi';
  const subtitle = document.createElement('p');
  subtitle.className = 'temperature-chart-subtitle';
  subtitle.textContent = 'Sonda DEWIN';
  titleText.append(title, subtitle);
  titleWrap.append(icon, titleText);
  const stats = document.createElement('div');
  stats.className = 'temperature-stats';
  stats.append(
    statBlock('Pond', 'series-pond', model.current.pond, model.pond),
    statBlock('Ambiente', 'series-ambient', model.current.ambient, model.ambient),
  );
  header.append(titleWrap, stats);

  const chartWrap = document.createElement('div');
  chartWrap.className = 'temperature-chart-wrap';
  const svg = svgElement('svg', {
    class: 'temperature-chart-svg', viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    role: 'img', 'aria-label': 'Grafico giornaliero temperatura Pond e ambiente dalle 00:00 alle 24:00, da meno 5 a 35 gradi Celsius',
  });
  const defs = svgElement('defs');
  for (const [id, deviation] of [['pond-neon-blur', 3.2]]) {
    const filter = svgElement('filter', { id, x: '-30%', y: '-30%', width: '160%', height: '160%' });
    filter.append(svgElement('feGaussianBlur', { stdDeviation: deviation }));
    defs.append(filter);
  }
  const dayNight = svgElement('linearGradient', { id: 'temperature-day-night', x1: '0%', y1: '0%', x2: '100%', y2: '0%' });
  for (const [offset, color, opacity] of [
    ['0%', '#061426', '.72'], ['24%', '#0a1c31', '.62'], ['31%', '#273044', '.48'],
    ['42%', '#5a4028', '.34'], ['62%', '#6a4828', '.3'], ['75%', '#293044', '.45'],
    ['84%', '#0b1d33', '.62'], ['100%', '#061426', '.74'],
  ]) dayNight.append(svgElement('stop', { offset, 'stop-color': color, 'stop-opacity': opacity }));
  defs.append(dayNight);
  svg.append(defs);
  svg.append(svgElement('rect', {
    class: 'temperature-day-night', x: PLOT.left, y: PLOT.top,
    width: WIDTH - PLOT.left - PLOT.right, height: HEIGHT - PLOT.top - PLOT.bottom,
    fill: 'url(#temperature-day-night)',
  }));
  const yGrid = svgElement('g', { class: 'chart-grid chart-grid-y' });

  for (const tick of TEMPERATURE_CHART_RANGE.yTicks) {
    const y = yPosition(tick);
    yGrid.append(svgElement('line', { x1: PLOT.left, y1: y, x2: WIDTH - PLOT.right, y2: y }));
    const label = svgElement('text', { x: PLOT.left - 10, y: y + 4, 'text-anchor': 'end' });
    label.textContent = `${tick}°`;
    yGrid.append(label);
  }
  const xGrid = svgElement('g', { class: 'chart-grid chart-grid-x' });
  for (const tick of TEMPERATURE_CHART_RANGE.xTicks) {
    const x = xPosition(tick);
    xGrid.append(svgElement('line', { x1: x, y1: PLOT.top, x2: x, y2: HEIGHT - PLOT.bottom }));
    const label = svgElement('text', { x, y: HEIGHT - 11, 'text-anchor': 'middle' });
    label.textContent = `${String(tick / 60).padStart(2, '0')}:00`;
    xGrid.append(label);
  }
  svg.append(yGrid, xGrid);

  const plot = svgElement('g', { class: 'chart-series', 'clip-path': 'inset(0)' });
  if (model.samples.length) {
    plot.append(
      svgElement('path', { class: 'chart-glow chart-glow-pond', d: buildTemperatureSeriesPath(model.samples, 'pond') }),
      svgElement('path', { class: 'chart-line chart-line-pond', d: buildTemperatureSeriesPath(model.samples, 'pond') }),
      svgElement('path', { class: 'chart-line chart-line-ambient', d: buildTemperatureSeriesPath(model.samples, 'ambient') }),
    );
    const markerStride = temperatureMarkerStride(model.samples.length);
    for (const [index, sample] of model.samples.entries()) {
      if (index % markerStride !== 0 && index !== model.samples.length - 1) continue;
      plot.append(
        svgElement('circle', { class: 'chart-point chart-point-pond', cx: xPosition(sample.minute), cy: yPosition(sample.pond), r: 1.8 }),
        svgElement('circle', { class: 'chart-point chart-point-ambient', cx: xPosition(sample.minute), cy: yPosition(sample.ambient), r: 1.8 }),
      );
    }
  }
  const marker = svgElement('line', {
    class: 'chart-hover-marker', x1: PLOT.left, y1: PLOT.top,
    x2: PLOT.left, y2: HEIGHT - PLOT.bottom,
  });
  svg.append(plot, marker);

  const tooltip = document.createElement('div');
  tooltip.className = 'temperature-tooltip';
  tooltip.setAttribute('aria-live', 'polite');
  const showTooltip = (event) => {
    if (!model.samples.length) return;
    const bounds = svg.getBoundingClientRect();
    const minute = Math.max(0, Math.min(1440, ((event.clientX - bounds.left) / bounds.width * WIDTH - PLOT.left)
      / (WIDTH - PLOT.left - PLOT.right) * 1440));
    const sample = model.samples.reduce((nearest, candidate) => (
      Math.abs(candidate.minute - minute) < Math.abs(nearest.minute - minute) ? candidate : nearest
    ));
    const x = xPosition(sample.minute);
    marker.setAttribute('x1', x);
    marker.setAttribute('x2', x);
    marker.classList.add('is-visible');
    const { hour, minute: sampleMinute } = timeParts(sample.timestamp);
    tooltip.replaceChildren();
    const time = document.createElement('strong');
    time.textContent = `${String(hour).padStart(2, '0')}:${String(sampleMinute).padStart(2, '0')}`;
    const pond = document.createElement('span');
    pond.textContent = `Pond: ${formatTemperature(sample.pond)}`;
    const ambient = document.createElement('span');
    ambient.textContent = `Ambiente: ${formatTemperature(sample.ambient)}`;
    tooltip.append(time, pond, ambient);
    tooltip.style.left = `${Math.max(12, Math.min(88, x / WIDTH * 100))}%`;
    tooltip.classList.add('is-visible');
  };
  svg.addEventListener('pointermove', showTooltip);
  svg.addEventListener('pointerdown', showTooltip);
  svg.addEventListener('pointerleave', () => {
    marker.classList.remove('is-visible');
    tooltip.classList.remove('is-visible');
  });
  const legend = document.createElement('div');
  legend.className = 'temperature-chart-legend';
  legend.innerHTML = '<span class="legend-pond"><i></i>Pond</span><span class="legend-ambient"><i></i>Ambiente</span>';
  chartWrap.append(legend, svg, tooltip);

  if (!model.samples.length) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = 'Nessun campione disponibile per oggi';
    chartWrap.append(empty);
  }
  container.replaceChildren(header, chartWrap);
}

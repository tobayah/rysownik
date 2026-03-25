const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const toolsEl = document.getElementById('tools');
const strokeColorEl = document.getElementById('strokeColor');
const fillColorEl = document.getElementById('fillColor');
const strokeWidthEl = document.getElementById('strokeWidth');

const state = {
  elements: [],
  selectedIds: new Set(),
  tool: 'select',
  drag: null,
  history: [],
  historyIndex: -1,
  viewport: { x: 0, y: 0, zoom: 1 },
  spacePan: false,
  clipboard: null,
};

const elementDefaults = () => ({
  stroke: strokeColorEl.value,
  fill: fillColorEl.value,
  strokeWidth: Number(strokeWidthEl.value),
});

const uid = () => crypto.randomUUID();
const save = () => localStorage.setItem('rysownik-scene', JSON.stringify(state.elements));
const load = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem('rysownik-scene') || '[]');
    if (Array.isArray(parsed)) state.elements = parsed;
  } catch {
    state.elements = [];
  }
};

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function worldFromScreen(x, y) {
  return {
    x: (x - state.viewport.x) / state.viewport.zoom,
    y: (y - state.viewport.y) / state.viewport.zoom,
  };
}

function pushHistory() {
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(structuredClone(state.elements));
  state.historyIndex = state.history.length - 1;
  save();
}

function restoreFromHistory(index) {
  if (index < 0 || index >= state.history.length) return;
  state.historyIndex = index;
  state.elements = structuredClone(state.history[index]);
  state.selectedIds.clear();
  save();
  draw();
}

function withViewport(fn) {
  ctx.save();
  ctx.translate(state.viewport.x, state.viewport.y);
  ctx.scale(state.viewport.zoom, state.viewport.zoom);
  fn();
  ctx.restore();
}

function roughStroke(pathDraw, el) {
  ctx.save();
  ctx.strokeStyle = el.stroke;
  ctx.fillStyle = el.fill;
  ctx.lineWidth = el.strokeWidth;
  for (let i = 0; i < 2; i++) {
    ctx.save();
    ctx.translate((Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 0.9);
    pathDraw();
    if (el.type !== 'line' && el.type !== 'arrow' && el.type !== 'freedraw') ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function drawElement(el) {
  switch (el.type) {
    case 'rectangle':
      roughStroke(() => ctx.beginPath() || ctx.rect(el.x, el.y, el.w, el.h), el);
      break;
    case 'ellipse':
      roughStroke(() => {
        ctx.beginPath();
        ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2);
      }, el);
      break;
    case 'diamond':
      roughStroke(() => {
        const cx = el.x + el.w / 2;
        const cy = el.y + el.h / 2;
        ctx.beginPath();
        ctx.moveTo(cx, el.y);
        ctx.lineTo(el.x + el.w, cy);
        ctx.lineTo(cx, el.y + el.h);
        ctx.lineTo(el.x, cy);
        ctx.closePath();
      }, el);
      break;
    case 'line':
    case 'arrow':
      roughStroke(() => {
        ctx.beginPath();
        ctx.moveTo(el.x1, el.y1);
        ctx.lineTo(el.x2, el.y2);
        if (el.type === 'arrow') {
          const a = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
          const s = 12;
          ctx.moveTo(el.x2, el.y2);
          ctx.lineTo(el.x2 - s * Math.cos(a - Math.PI / 6), el.y2 - s * Math.sin(a - Math.PI / 6));
          ctx.moveTo(el.x2, el.y2);
          ctx.lineTo(el.x2 - s * Math.cos(a + Math.PI / 6), el.y2 - s * Math.sin(a + Math.PI / 6));
        }
      }, el);
      break;
    case 'freedraw':
      roughStroke(() => {
        ctx.beginPath();
        const [first, ...rest] = el.points;
        ctx.moveTo(first.x, first.y);
        for (const p of rest) ctx.lineTo(p.x, p.y);
      }, el);
      break;
    case 'text':
      ctx.save();
      ctx.fillStyle = el.stroke;
      ctx.font = `${16 + el.strokeWidth * 2}px Virgil, "Comic Sans MS", cursive`;
      ctx.fillText(el.text, el.x, el.y);
      ctx.restore();
      break;
  }

  if (state.selectedIds.has(el.id)) {
    const b = getBounds(el);
    ctx.save();
    ctx.strokeStyle = '#4f46e5';
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
    ctx.restore();
  }
}

function getBounds(el) {
  if (el.type === 'line' || el.type === 'arrow') {
    const x = Math.min(el.x1, el.x2);
    const y = Math.min(el.y1, el.y2);
    return { x, y, w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1) };
  }
  if (el.type === 'freedraw') {
    const xs = el.points.map((p) => p.x);
    const ys = el.points.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  if (el.type === 'text') return { x: el.x, y: el.y - 20, w: Math.max(50, el.text.length * 11), h: 30 };
  return { x: Math.min(el.x, el.x + el.w), y: Math.min(el.y, el.y + el.h), w: Math.abs(el.w), h: Math.abs(el.h) };
}

function pickElement(pos) {
  for (let i = state.elements.length - 1; i >= 0; i--) {
    const el = state.elements[i];
    const b = getBounds(el);
    if (pos.x >= b.x - 8 && pos.x <= b.x + b.w + 8 && pos.y >= b.y - 8 && pos.y <= b.y + b.h + 8) return el;
  }
  return null;
}

function drawGrid() {
  const step = 24;
  const { width, height } = canvas;
  ctx.save();
  ctx.strokeStyle = '#f0f1f7';
  ctx.lineWidth = 1;
  for (let x = (state.viewport.x % (step * state.viewport.zoom)); x < width; x += step * state.viewport.zoom) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = (state.viewport.y % (step * state.viewport.zoom)); y < height; y += step * state.viewport.zoom) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();
  withViewport(() => state.elements.forEach(drawElement));
}

function setTool(tool) {
  state.tool = tool;
  toolsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const pos = worldFromScreen(e.offsetX, e.offsetY);

  if (e.button === 1 || state.spacePan) {
    state.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: state.viewport.x, oy: state.viewport.y };
    return;
  }

  if (state.tool === 'text') {
    const text = prompt('Text', 'Double-click to edit later')?.trim();
    if (text) {
      const el = { id: uid(), type: 'text', x: pos.x, y: pos.y, text, ...elementDefaults() };
      state.elements.push(el);
      pushHistory();
      draw();
    }
    return;
  }

  if (state.tool === 'select') {
    const hit = pickElement(pos);
    if (!e.shiftKey) state.selectedIds.clear();
    if (hit) {
      state.selectedIds.add(hit.id);
      state.drag = { mode: 'move', start: pos, snapshot: structuredClone(state.elements) };
    }
    draw();
    return;
  }

  const base = { id: uid(), ...elementDefaults() };
  let el = null;
  if (['rectangle', 'ellipse', 'diamond'].includes(state.tool)) el = { ...base, type: state.tool, x: pos.x, y: pos.y, w: 0, h: 0 };
  if (['line', 'arrow'].includes(state.tool)) el = { ...base, type: state.tool, x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y };
  if (state.tool === 'freedraw') el = { ...base, type: 'freedraw', points: [pos] };
  state.elements.push(el);
  state.drag = { mode: 'draw', elId: el.id, start: pos };
  state.selectedIds = new Set([el.id]);
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!state.drag) return;

  if (state.drag.mode === 'pan') {
    state.viewport.x = state.drag.ox + (e.clientX - state.drag.sx);
    state.viewport.y = state.drag.oy + (e.clientY - state.drag.sy);
    draw();
    return;
  }

  const pos = worldFromScreen(e.offsetX, e.offsetY);

  if (state.drag.mode === 'move') {
    const dx = pos.x - state.drag.start.x;
    const dy = pos.y - state.drag.start.y;
    state.elements = structuredClone(state.drag.snapshot);
    for (const el of state.elements) {
      if (!state.selectedIds.has(el.id)) continue;
      if (['rectangle', 'ellipse', 'diamond', 'text'].includes(el.type)) {
        el.x += dx;
        el.y += dy;
      } else if (['line', 'arrow'].includes(el.type)) {
        el.x1 += dx;
        el.y1 += dy;
        el.x2 += dx;
        el.y2 += dy;
      } else if (el.type === 'freedraw') {
        el.points = el.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      }
    }
    draw();
    return;
  }

  const el = state.elements.find((item) => item.id === state.drag.elId);
  if (!el) return;
  if (['rectangle', 'ellipse', 'diamond'].includes(el.type)) {
    el.w = pos.x - state.drag.start.x;
    el.h = pos.y - state.drag.start.y;
  } else if (['line', 'arrow'].includes(el.type)) {
    el.x2 = pos.x;
    el.y2 = pos.y;
  } else if (el.type === 'freedraw') {
    el.points.push(pos);
  }
  draw();
});

canvas.addEventListener('pointerup', () => {
  if (state.drag && state.drag.mode !== 'pan') pushHistory();
  state.drag = null;
});

canvas.addEventListener('dblclick', (e) => {
  const pos = worldFromScreen(e.offsetX, e.offsetY);
  const hit = pickElement(pos);
  if (!hit || hit.type !== 'text') return;
  const text = prompt('Edit text', hit.text);
  if (text !== null) {
    hit.text = text;
    pushHistory();
    draw();
  }
});

canvas.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const scale = e.deltaY < 0 ? 1.06 : 0.94;
  const nextZoom = Math.min(3, Math.max(0.2, state.viewport.zoom * scale));
  const wx = (e.offsetX - state.viewport.x) / state.viewport.zoom;
  const wy = (e.offsetY - state.viewport.y) / state.viewport.zoom;
  state.viewport.zoom = nextZoom;
  state.viewport.x = e.offsetX - wx * nextZoom;
  state.viewport.y = e.offsetY - wy * nextZoom;
  draw();
}, { passive: false });

toolsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tool]');
  if (btn) setTool(btn.dataset.tool);
});

document.getElementById('undoBtn').addEventListener('click', () => restoreFromHistory(state.historyIndex - 1));
document.getElementById('redoBtn').addEventListener('click', () => restoreFromHistory(state.historyIndex + 1));

document.getElementById('deleteBtn').addEventListener('click', () => {
  state.elements = state.elements.filter((el) => !state.selectedIds.has(el.id));
  state.selectedIds.clear();
  pushHistory();
  draw();
});

document.getElementById('duplicateBtn').addEventListener('click', () => {
  const dupes = state.elements
    .filter((el) => state.selectedIds.has(el.id))
    .map((el) => {
      const d = structuredClone(el);
      d.id = uid();
      if ('x' in d) d.x += 24;
      if ('y' in d) d.y += 24;
      if ('x1' in d) d.x1 += 24;
      if ('x2' in d) d.x2 += 24;
      if ('y1' in d) d.y1 += 24;
      if ('y2' in d) d.y2 += 24;
      if (d.points) d.points = d.points.map((p) => ({ x: p.x + 24, y: p.y + 24 }));
      return d;
    });
  if (!dupes.length) return;
  state.elements.push(...dupes);
  state.selectedIds = new Set(dupes.map((d) => d.id));
  pushHistory();
  draw();
});

document.getElementById('clearBtn').addEventListener('click', () => {
  if (!confirm('Clear the entire scene?')) return;
  state.elements = [];
  state.selectedIds.clear();
  pushHistory();
  draw();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') state.spacePan = true;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.shiftKey ? restoreFromHistory(state.historyIndex + 1) : restoreFromHistory(state.historyIndex - 1);
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    state.clipboard = state.elements.filter((el) => state.selectedIds.has(el.id)).map((el) => structuredClone(el));
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && state.clipboard?.length) {
    const pasted = state.clipboard.map((el) => {
      const d = structuredClone(el);
      d.id = uid();
      if ('x' in d) d.x += 32;
      if ('y' in d) d.y += 32;
      if ('x1' in d) d.x1 += 32;
      if ('x2' in d) d.x2 += 32;
      if ('y1' in d) d.y1 += 32;
      if ('y2' in d) d.y2 += 32;
      if (d.points) d.points = d.points.map((p) => ({ x: p.x + 32, y: p.y + 32 }));
      return d;
    });
    state.elements.push(...pasted);
    state.selectedIds = new Set(pasted.map((d) => d.id));
    pushHistory();
    draw();
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    state.elements = state.elements.filter((el) => !state.selectedIds.has(el.id));
    state.selectedIds.clear();
    pushHistory();
    draw();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') state.spacePan = false;
});

window.addEventListener('resize', resize);

load();
pushHistory();
resize();

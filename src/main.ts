// Latin subset only: the answers are digits, and it keeps the offline cache small.
import '@fontsource/caveat/latin-600.css';
import '@fontsource/caveat/latin-700.css';
import './styles.css';
import { InkCanvas, type Tool } from './ink/InkCanvas';
import type { EquationResult } from './recognition/pipeline';
import { ANSWER_FONT, AnswerLayer } from './ui/answers';
import { playAnswerCue, playEraseCue, setSoundEnabled } from './ui/feedback';
import { loadPage, savePage } from './ui/storage';
import { RecognizerClient, type RecognizerStatus } from './worker/client';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const paper = $('#paper');
const hint = $('#hint');
const undoBtn = $<HTMLButtonElement>('#undo');
const redoBtn = $<HTMLButtonElement>('#redo');
const panel = $('#panel');
const readings = $('#readings');
const statusDot = $('#status-dot');
const statusText = $('#status-text');
const net = $('#net');

// ---------------------------------------------------------------- wiring

let firstResult = true;
// Created after the canvas (it draws on the canvas' overlay layer).
let answerLayer: AnswerLayer | undefined;

const recognizer = new RecognizerClient(onEquations, onStatus);

let saveTimer: ReturnType<typeof setTimeout> | undefined;
const ink = new InkCanvas(paper, {
  onChange(strokes, reason) {
    recognizer.schedule(strokes);
    hint.classList.toggle('hidden', strokes.length > 0);
    undoBtn.disabled = !ink.canUndo;
    redoBtn.disabled = !ink.canRedo;
    if (reason === 'scratch') playEraseCue();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savePage(strokes), 400);
  },
  onResize(_w, _h, dpr) {
    answerLayer?.setDpr(dpr);
  },
});

answerLayer = new AnswerLayer(ink.overlay, (eq) => {
  // Don't chime for answers restored from the autosave on startup.
  if (!firstResult) playAnswerCue(eq.result.kind);
});
answerLayer.setDpr(ink.cssSize.dpr);

function onEquations(eqs: EquationResult[]) {
  answerLayer?.update(eqs);
  firstResult = false;
  renderReadings(eqs);
}

// ---------------------------------------------------------------- status

function onStatus(s: RecognizerStatus) {
  statusDot.className = `dot ${s.state === 'ready' ? 'ready' : s.state === 'error' ? 'error' : ''}`;
  statusText.textContent =
    s.state === 'ready' ? 'On-device model ready' : s.state === 'error' ? 'Recognition unavailable' : 'Loading model…';
  if (s.state === 'error') console.error('[CalcInk]', s.message);
}

function updateNet() {
  net.textContent = navigator.onLine ? '' : 'Offline ✓';
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);
updateNet();

// ---------------------------------------------------------------- toolbar

function setTool(tool: Tool) {
  ink.tool = tool;
  paper.classList.toggle('eraser', tool !== 'pen');
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  });
}

document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
  b.addEventListener('click', () => setTool(b.dataset.tool as Tool));
});

document.querySelectorAll<HTMLButtonElement>('[data-width]').forEach((b) => {
  b.addEventListener('click', () => {
    ink.penWidth = Number(b.dataset.width);
    document.querySelectorAll('[data-width]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    setTool('pen');
  });
});

undoBtn.addEventListener('click', () => ink.undo());
redoBtn.addEventListener('click', () => ink.redo());
$('#clear').addEventListener('click', () => ink.clear());

const soundBtn = $('#sound');
soundBtn.addEventListener('click', () => {
  const on = soundBtn.getAttribute('aria-pressed') !== 'true';
  soundBtn.setAttribute('aria-pressed', String(on));
  setSoundEnabled(on);
});

const panelBtn = $('#panel-toggle');
panelBtn.addEventListener('click', () => {
  panel.hidden = !panel.hidden;
  panelBtn.setAttribute('aria-pressed', String(!panel.hidden));
});

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) ink.redo();
    else ink.undo();
  } else if (mod && key === 'y') {
    e.preventDefault();
    ink.redo();
  } else if (!mod && !e.altKey) {
    if (key === 'p') setTool('pen');
    else if (key === 'e') setTool('eraser');
    else if (key === 'x') setTool('pixel-eraser');
  }
});

// ---------------------------------------------------------------- readings panel

function renderReadings(eqs: EquationResult[]) {
  const sorted = [...eqs].sort((a, b) => a.anchor.y - b.anchor.y);
  readings.replaceChildren(
    ...sorted.map((eq) => {
      const li = document.createElement('li');
      const expr = document.createElement('div');
      expr.className = 'expr';
      const ans = document.createElement('b');
      ans.textContent = eq.display;
      if (eq.result.kind !== 'ok') ans.className = 'bad';
      expr.append(`${eq.expression} = `, ans);
      const conf = document.createElement('div');
      conf.className = 'conf';
      const pct = Math.round(eq.confidence * 100);
      const bar = document.createElement('span');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = `${pct}%`;
      if (eq.confidence < 0.6) fill.className = 'low';
      bar.append(fill);
      conf.append(bar, `${pct}% sure`);
      if (eq.result.kind === 'error') conf.append(` · ${eq.result.message}`);
      li.append(expr, conf);
      return li;
    }),
  );
}

// ---------------------------------------------------------------- startup

const saved = loadPage();
if (saved.length) ink.load(saved);

// Canvas text doesn't wait for web fonts; redraw answers once the handwriting font is ready.
document.fonts.load(`600 32px ${ANSWER_FONT}`).then(() => answerLayer?.update(answerLayer.current));

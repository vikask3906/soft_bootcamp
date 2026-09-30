// Latin subset only: the answers are digits, and it keeps the offline cache small.
import '@fontsource/caveat/latin-600.css';
import '@fontsource/caveat/latin-700.css';
import './styles.css';
import { InkCanvas, type Tool } from './ink/InkCanvas';
import type { EquationResult, LineReading } from './recognition/pipeline';
import { ANSWER_FONT, AnswerLayer } from './ui/answers';
import { CorrectionUI } from './ui/corrections';
import { playAnswerCue, playEraseCue, setSoundEnabled } from './ui/feedback';
import type { View } from './ink/viewport';
import { loadPage, loadView, savePage, saveView } from './ui/storage';
import { setupToolbar } from './ui/toolbar';
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
// Tap-to-correct (created after the canvas; the canvas calls into it lazily).
let fixer: CorrectionUI | undefined;

const recognizer = new RecognizerClient(onEquations, onStatus);

let saveTimer: ReturnType<typeof setTimeout> | undefined;
const ink = new InkCanvas(paper, {
  onChange(strokes, reason) {
    fixer?.prune(strokes);
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
  onView(view) {
    answerLayer?.setView(view);
    fixer?.reposition();
    syncPaper(view);
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => saveView(view), 300);
  },
  // Tapping an answer opens it for correction.
  isTapTarget: (p) => !!answerLayer?.hitTest(p),
  onTap(p) {
    const eq = answerLayer?.hitTest(p);
    if (eq) fixer?.open(eq.key);
  },
});
let viewTimer: ReturnType<typeof setTimeout> | undefined;

const zoomLabel = $('#zoom-reset');
/** Moves the CSS paper (ruled lines, margin) with the camera and updates the zoom label. */
function syncPaper(view: View) {
  const gap = 48 * view.scale;
  paper.style.setProperty('--rule-gap', `${gap}px`);
  paper.style.setProperty('--rule-y', `${((view.y % gap) + gap) % gap}px`);
  paper.style.setProperty('--margin-x', `${view.x + 72 * view.scale}px`);
  zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
}

answerLayer = new AnswerLayer(ink.overlay, (eq) => {
  // Don't chime for answers restored from the autosave on startup.
  if (!firstResult) playAnswerCue(eq.result.kind);
});
answerLayer.setDpr(ink.cssSize.dpr);

fixer = new CorrectionUI($('.app'), {
  getView: () => ink.currentView,
  getStrokes: () => ink.all,
  onCorrectionsChanged: () => recognizer.now(ink.all),
  onActiveChange(key) {
    if (answerLayer) {
      answerLayer.highlighted = key;
      answerLayer.redraw();
    }
  },
});
recognizer.corrections = () => fixer?.corrections ?? {};

function onEquations(eqs: EquationResult[], lines: LineReading[]) {
  answerLayer?.update(eqs);
  fixer?.update(eqs);
  firstResult = false;
  renderReadings(eqs, lines);
  if (import.meta.env.DEV) autoCapture(lines);
}

// Dev only: quietly mirror the page to the laptop (debug/latest.json) so
// recognition can be diagnosed on real tablet handwriting.
let captureTimer: ReturnType<typeof setTimeout> | undefined;
function autoCapture(lines: LineReading[]) {
  clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    void fetch('/__calcink/capture?auto=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userAgent: navigator.userAgent, viewport: { ...ink.cssSize }, view: ink.currentView, strokes: ink.all, lines }),
    }).catch(() => {});
  }, 1200);
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
  paper.classList.toggle('eraser', tool === 'eraser' || tool === 'pixel-eraser');
  paper.classList.toggle('panning', tool === 'hand');
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
$('#zoom-in').addEventListener('click', () => ink.zoomBy(1.25));
$('#zoom-out').addEventListener('click', () => ink.zoomBy(1 / 1.25));
zoomLabel.addEventListener('click', () => ink.resetView());
setupToolbar($('#toolbar'), $('#grip'), $('#collapse'));

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
  } else if (mod && (key === '=' || key === '+')) {
    e.preventDefault();
    ink.zoomBy(1.25);
  } else if (mod && key === '-') {
    e.preventDefault();
    ink.zoomBy(1 / 1.25);
  } else if (mod && key === '0') {
    e.preventDefault();
    ink.resetView();
  } else if (!mod && !e.altKey) {
    if (key === 'p') setTool('pen');
    else if (key === 'e') setTool('eraser');
    else if (key === 'x') setTool('pixel-eraser');
    else if (key === 'h') setTool('hand');
  }
});

// ---------------------------------------------------------------- readings panel

function renderReadings(eqs: EquationResult[], lines: LineReading[]) {
  const sorted = [...eqs].sort((a, b) => a.anchor.y - b.anchor.y);
  // Lines that didn't produce an answer still show what was read, with a hint why.
  const unsolved = lines
    .filter((l) => !l.solved)
    .map((l) => {
      const li = document.createElement('li');
      li.className = 'unsolved';
      const expr = document.createElement('div');
      expr.className = 'expr';
      expr.textContent = l.text;
      const why = document.createElement('div');
      why.className = 'conf';
      why.textContent = l.text.includes('=') ? 'Answer already written, or no room after =' : 'No = found — end the line with = to solve';
      li.append(expr, why);
      return li;
    });
  readings.replaceChildren(
    ...unsolved,
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
      const fix = document.createElement('button');
      fix.className = 'fix';
      fix.textContent = 'Fix';
      fix.title = 'Correct a misread symbol';
      fix.addEventListener('click', () => fixer?.open(eq.key));
      conf.append(fix);
      li.append(expr, conf);
      return li;
    }),
  );
}

// ---------------------------------------------------------------- dev: capture real handwriting

if (import.meta.env.DEV) {
  const btn = document.createElement('button');
  btn.className = 'capture';
  btn.textContent = 'Send this page to laptop';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await fetch('/__calcink/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userAgent: navigator.userAgent,
          viewport: { ...ink.cssSize },
          strokes: ink.all,
          readings: answerLayer?.current.map((eq) => ({ expression: eq.expression, display: eq.display, symbols: eq.symbols })),
        }),
      });
      btn.textContent = res.ok ? 'Sent ✓ — send again?' : `Failed (${res.status})`;
    } catch {
      btn.textContent = 'Failed — is the laptop server running?';
    } finally {
      btn.disabled = false;
    }
  });
  panel.append(btn);
}

// ---------------------------------------------------------------- startup

const saved = loadPage();
if (saved.length) ink.load(saved);
const savedView = loadView();
if (savedView) ink.setView(savedView);
syncPaper(ink.currentView);
// The hint starts hidden (so it never flashes over restored ink) and fades in on an empty page.
hint.classList.toggle('hidden', ink.all.length > 0);

// Canvas text doesn't wait for web fonts; redraw answers once the handwriting font is ready.
document.fonts.load(`600 32px ${ANSWER_FONT}`).then(() => answerLayer?.update(answerLayer.current));

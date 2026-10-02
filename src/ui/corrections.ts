import type { Stroke } from '../ink/types';
import { worldToScreen, type View } from '../ink/viewport';
import { IGNORE, type Corrections, type EquationResult, type RecognizedSymbol } from '../recognition/pipeline';

/**
 * Tap-to-correct. Tapping an answer (or "Fix" in the panel) opens the
 * equation: every symbol gets a small label showing what was read; tapping a
 * label opens a picker (model runner-ups first, then every symbol, plus
 * "ignore this mark"). Corrections are keyed by stroke ids and sent to the
 * recogniser with every request, so the answer updates immediately and a
 * correction disappears by itself when its strokes are erased or rewritten.
 */
const STORE_KEY = 'calcink.corrections.v1';
const ALL_SYMBOLS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '−', '×', '÷', '(', ')', '.', 'x'];

export interface CorrectionUIOptions {
  getView: () => View;
  getStrokes: () => readonly Stroke[];
  /** Re-run recognition now (a correction changed). */
  onCorrectionsChanged: () => void;
  /** Highlight the open equation's answer on the paper (null = none). */
  onActiveChange: (eqKey: string | null) => void;
}

export class CorrectionUI {
  corrections: Corrections = load();
  private active: string | null = null;
  private equations: EquationResult[] = [];
  private pickerFor: string | null = null;

  private root: HTMLDivElement;
  private chips: HTMLDivElement;
  private picker: HTMLDivElement;
  private bar: HTMLDivElement;

  constructor(
    host: HTMLElement,
    private readonly opts: CorrectionUIOptions,
  ) {
    this.root = el('div', 'correct-layer');
    this.root.hidden = true;
    const catcher = el('div', 'correct-catcher');
    catcher.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.pickerFor) this.closePicker();
      else this.close();
    });
    this.chips = el('div', 'correct-chips');
    this.picker = el('div', 'picker');
    this.picker.hidden = true;
    this.bar = el('div', 'correct-bar');
    this.root.append(catcher, this.chips, this.picker, this.bar);
    host.append(this.root);

    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.active) return;
      if (this.pickerFor) this.closePicker();
      else this.close();
    });
  }

  get isOpen() {
    return this.active !== null;
  }

  open(eqKey: string) {
    this.active = eqKey;
    this.pickerFor = null;
    this.root.hidden = false;
    this.opts.onActiveChange(eqKey);
    this.render();
  }

  close() {
    this.active = null;
    this.pickerFor = null;
    this.root.hidden = true;
    this.picker.hidden = true;
    this.opts.onActiveChange(null);
  }

  /** Called with every recognition result. */
  update(equations: EquationResult[]) {
    this.equations = equations;
    if (!this.active) return;
    if (!equations.some((e) => e.key === this.active)) this.close(); // its "=" was erased
    else this.render();
  }

  /** Called when the camera moves: labels follow their symbols. */
  reposition() {
    if (this.active) this.render();
  }

  /** Drops corrections whose strokes no longer exist (erased, rewritten, cleared). */
  prune(strokes: readonly Stroke[]) {
    const ids = new Set(strokes.map((s) => s.id));
    let changed = false;
    for (const key of Object.keys(this.corrections)) {
      if (!key.split(',').every((id) => ids.has(Number(id)))) {
        delete this.corrections[key];
        changed = true;
      }
    }
    if (changed) save(this.corrections);
  }

  // ---------------------------------------------------------------- rendering

  private get eq() {
    return this.equations.find((e) => e.key === this.active) ?? null;
  }

  private render() {
    const eq = this.eq;
    if (!eq) return;
    const view = this.opts.getView();

    this.chips.replaceChildren(
      ...eq.symbols.map((sym) => {
        const chip = el('button', `chip${sym.source === 'user' ? ' fixed' : ''}${sym.confidence < 0.6 ? ' unsure' : ''}`);
        chip.textContent = sym.symbol;
        chip.title =
          sym.source === 'user'
            ? `You set this (was read as ${sym.recognizedAs})`
            : sym.source === 'repair'
              ? `Guessed from bracket balance (was read as ${sym.recognizedAs}) — tap to change`
              : `Read as ${sym.symbol} — tap to fix`;
        const p = worldToScreen(view, { x: (sym.bbox.minX + sym.bbox.maxX) / 2, y: sym.bbox.maxY });
        chip.style.left = `${p.x}px`;
        chip.style.top = `${p.y + 6}px`;
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openPicker(sym, chip);
        });
        return chip;
      }),
    );

    const fixes = this.fixesInActive();
    this.bar.replaceChildren(
      text('span', 'correct-hint', 'Tap a symbol to fix it'),
      ...(fixes.length ? [button('Reset fixes', () => this.resetActive(), 'ghost')] : []),
      button('Done', () => this.close(), 'primary'),
    );

    if (this.pickerFor) {
      const idx = eq.symbols.findIndex((s) => s.key === this.pickerFor);
      const chip = this.chips.children[idx] as HTMLElement | undefined;
      if (idx >= 0 && chip) this.openPicker(eq.symbols[idx], chip);
      else this.closePicker();
    }
  }

  private openPicker(sym: RecognizedSymbol, chip: HTMLElement) {
    this.pickerFor = sym.key;
    const original = sym.source === 'user' || sym.source === 'repair' ? sym.recognizedAs! : sym.symbol;
    const head = el('div', 'picker-head');
    head.textContent =
      sym.source === 'user'
        ? `You set ${sym.symbol} · read as ${original}`
        : sym.source === 'repair'
          ? `Guessed ${sym.symbol} so the brackets balance · read as ${original}`
          : `Read as ${sym.symbol} · ${Math.round(sym.confidence * 100)}% sure`;

    const suggestions = [...new Set([...(sym.source !== 'shape' && sym.source !== 'model' ? [original] : []), ...sym.alternatives])]
      .filter((s) => s !== sym.symbol)
      .slice(0, 4);
    // Choosing the original reading of a user fix just removes the fix. For an automatic
    // repair it is stored explicitly, which also stops the repair from being re-applied.
    const pick = (value: string) => () => this.setCorrection(sym.key, value === original && sym.source === 'user' ? null : value);

    const sugRow = el('div', 'picker-row suggest');
    sugRow.append(...suggestions.map((s) => button(s, pick(s), 'sym sug')));
    const grid = el('div', 'picker-grid');
    grid.append(...ALL_SYMBOLS.map((s) => button(s, pick(s), s === sym.symbol ? 'sym current' : 'sym')));
    const actions = el('div', 'picker-row');
    actions.append(button('Ignore this mark', () => this.setCorrection(sym.key, IGNORE), 'ghost'));
    if (sym.source === 'user') actions.append(button(`Back to ${original}`, () => this.setCorrection(sym.key, null), 'ghost'));

    this.picker.replaceChildren(head, ...(suggestions.length ? [sugRow] : []), grid, actions);
    this.picker.hidden = false;
    this.bar.hidden = true; // the picker is the focus now; the bar would cover it on short screens
    for (const c of this.chips.children) c.classList.toggle('open', c === chip);

    // Place under the chip, kept on screen.
    const r = chip.getBoundingClientRect();
    const host = this.root.getBoundingClientRect();
    // Never taller than the screen: scroll inside instead (short landscape phones).
    this.picker.style.maxHeight = `${host.height - 16}px`;
    const w = this.picker.offsetWidth;
    const h = this.picker.offsetHeight;
    let left = r.left + r.width / 2 - w / 2 - host.left;
    let top = r.bottom + 8 - host.top;
    left = Math.max(8, Math.min(left, host.width - w - 8));
    if (top + h > host.height - 8) top = r.top - h - 8 - host.top;
    if (top < 8) top = Math.max(8, host.height - h - 8); // no room above or below: keep it fully visible
    this.picker.style.left = `${left}px`;
    this.picker.style.top = `${top}px`;
  }

  private closePicker() {
    this.pickerFor = null;
    this.picker.hidden = true;
    this.bar.hidden = false;
    for (const c of this.chips.children) c.classList.remove('open');
  }

  private setCorrection(key: string, value: string | null) {
    if (value === null) delete this.corrections[key];
    else this.corrections[key] = value;
    save(this.corrections);
    this.closePicker();
    this.opts.onCorrectionsChanged();
  }

  /** Corrections on strokes that sit on the open equation's line (including ignored marks). */
  private fixesInActive(): string[] {
    const eq = this.eq;
    if (!eq) return [];
    // The area covered by the equation's symbols (works for slanted rows too), plus a margin.
    const m = eq.anchor.height * 0.5;
    const minX = Math.min(...eq.symbols.map((s) => s.bbox.minX)) - m;
    const maxX = Math.max(eq.anchor.x, ...eq.symbols.map((s) => s.bbox.maxX)) + m;
    const minY = Math.min(...eq.symbols.map((s) => s.bbox.minY)) - m;
    const maxY = Math.max(...eq.symbols.map((s) => s.bbox.maxY)) + m;
    const byId = new Map(this.opts.getStrokes().map((s) => [s.id, s]));
    return Object.keys(this.corrections).filter((key) =>
      key.split(',').some((id) => byId.get(Number(id))?.points.some((p) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY)),
    );
  }

  private resetActive() {
    for (const key of this.fixesInActive()) delete this.corrections[key];
    save(this.corrections);
    this.opts.onCorrectionsChanged();
  }
}

// ---------------------------------------------------------------- helpers

function load(): Corrections {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Corrections) : {};
  } catch {
    return {};
  }
}

function save(c: Corrections) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(c));
  } catch {
    /* best-effort */
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string) {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function text(tag: 'span', className: string, content: string) {
  const e = el(tag, className);
  e.textContent = content;
  return e;
}

function button(label: string, onClick: () => void, className = '') {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

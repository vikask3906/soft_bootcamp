import { eraseStrokesAt, erasePixelsAt, isScratchGesture, strokesHitByScratch } from './erase';
import { backingStoreSize, clientToCanvas } from './geometry';
import { History } from './history';
import { drawStroke } from './render';
import type { InkPoint, Stroke } from './types';

export type Tool = 'pen' | 'eraser' | 'pixel-eraser';

export interface InkCanvasOptions {
  /** Called after every committed change (draw, erase, undo, …). */
  onChange: (strokes: readonly Stroke[], reason: 'draw' | 'erase' | 'scratch' | 'undo' | 'redo' | 'clear' | 'load') => void;
  /** Called whenever the canvas is resized (CSS px) so overlays can follow. */
  onResize?: (width: number, height: number, dpr: number) => void;
}

const STROKE_ERASER_RADIUS = 8;
const PIXEL_ERASER_RADIUS = 11;
const MIN_POINT_DISTANCE = 0.75;

/**
 * Three stacked canvases:
 *   ink     — committed strokes; redrawn fully only on erase/undo/resize,
 *             new strokes are appended incrementally.
 *   live    — the stroke being drawn plus the eraser cursor; cleared each frame.
 *   overlay — owned by the answer layer.
 * All drawing is batched into requestAnimationFrame so input handlers stay tiny.
 */
export class InkCanvas {
  readonly ink: HTMLCanvasElement;
  readonly live: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  private inkCtx: CanvasRenderingContext2D;
  private liveCtx: CanvasRenderingContext2D;

  private history = new History();
  private strokes: readonly Stroke[] = [];
  private nextId = 1;
  private nextOrder = 1;

  tool: Tool = 'pen';
  penWidth = 3;
  penColor = '#1d2740';

  private activePointer: number | null = null;
  private activeTool: Tool = 'pen';
  private current: InkPoint[] | null = null;
  private eraseStart: readonly Stroke[] | null = null;
  private hover: { x: number; y: number } | null = null;
  private lastPenTime = 0;

  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  private rect = { left: 0, top: 0 };
  private frameRequested = false;
  private inkDirty = false;
  private resizeObserver: ResizeObserver;
  private dprQuery: MediaQueryList | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly opts: InkCanvasOptions,
  ) {
    this.ink = this.makeLayer('ink');
    this.live = this.makeLayer('live');
    this.overlay = this.makeLayer('overlay');
    this.inkCtx = this.ink.getContext('2d', { desynchronized: true })!;
    this.liveCtx = this.live.getContext('2d', { desynchronized: true })!;

    host.style.touchAction = 'none';
    host.addEventListener('pointerdown', this.onDown);
    host.addEventListener('pointermove', this.onMove);
    host.addEventListener('pointerup', this.onUp);
    host.addEventListener('pointercancel', this.onCancel);
    host.addEventListener('pointerleave', this.onLeave);
    host.addEventListener('contextmenu', (e) => e.preventDefault());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.watchDpr();
    this.resize();
  }

  // ------------------------------------------------------------------ public API

  get all(): readonly Stroke[] {
    return this.strokes;
  }
  get canUndo() {
    return this.history.canUndo;
  }
  get canRedo() {
    return this.history.canRedo;
  }

  undo() {
    if (!this.history.canUndo) return;
    this.setStrokes(this.history.undo(), 'undo');
  }

  redo() {
    if (!this.history.canRedo) return;
    this.setStrokes(this.history.redo(), 'redo');
  }

  clear() {
    if (this.strokes.length === 0) return;
    this.commit([], 'clear');
  }

  /** Replaces the page (e.g. restoring an autosave) and resets history. */
  load(strokes: readonly Stroke[]) {
    this.nextId = strokes.reduce((m, s) => Math.max(m, s.id), 0) + 1;
    this.nextOrder = strokes.reduce((m, s) => Math.max(m, s.order), 0) + 1;
    this.history.reset(strokes);
    this.setStrokes(strokes, 'load');
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDprChange);
  }

  // ------------------------------------------------------------------ layout / DPR

  private makeLayer(name: string) {
    const c = document.createElement('canvas');
    c.className = `layer layer-${name}`;
    this.host.appendChild(c);
    return c;
  }

  /** Re-listens whenever DPR changes (e.g. window dragged to another monitor or browser zoom). */
  private watchDpr() {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  private onDprChange = () => {
    this.watchDpr();
    this.resize();
  };

  private resize() {
    const r = this.host.getBoundingClientRect();
    this.rect = { left: r.left, top: r.top };
    this.cssW = r.width;
    this.cssH = r.height;
    this.dpr = window.devicePixelRatio || 1;
    const size = backingStoreSize(r.width, r.height, this.dpr);
    for (const c of [this.ink, this.live, this.overlay]) {
      if (c.width !== size.width || c.height !== size.height) {
        c.width = size.width;
        c.height = size.height;
      }
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
    }
    this.inkDirty = true;
    this.requestFrame();
    this.opts.onResize?.(r.width, r.height, this.dpr);
  }

  // ------------------------------------------------------------------ state

  private commit(next: readonly Stroke[], reason: Parameters<InkCanvasOptions['onChange']>[1]) {
    this.history.push(next);
    this.setStrokes(next, reason);
  }

  private setStrokes(next: readonly Stroke[], reason: Parameters<InkCanvasOptions['onChange']>[1]) {
    this.strokes = next;
    this.inkDirty = true;
    this.requestFrame();
    this.opts.onChange(next, reason);
  }

  // ------------------------------------------------------------------ input

  private toPoint(e: PointerEvent): InkPoint {
    const { x, y } = clientToCanvas(e.clientX, e.clientY, this.rect);
    const p = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
    return { x, y, p };
  }

  private onDown = (e: PointerEvent) => {
    if (this.activePointer !== null) return;
    if (e.pointerType === 'pen') this.lastPenTime = performance.now();
    // Palm rejection: ignore touches while a stylus has recently been used.
    if (e.pointerType === 'touch' && performance.now() - this.lastPenTime < 1500) return;
    if (e.button !== 0 && e.button !== 5) return;
    e.preventDefault();

    const r = this.host.getBoundingClientRect();
    this.rect = { left: r.left, top: r.top };
    this.activePointer = e.pointerId;
    try {
      this.host.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone (or synthetic) — drawing still works without capture */
    }
    // Stylus eraser end / barrel button acts as a stroke eraser.
    this.activeTool = e.button === 5 || (e.buttons & 32) !== 0 ? 'eraser' : this.tool;

    const pt = this.toPoint(e);
    if (this.activeTool === 'pen') {
      this.current = [pt];
    } else {
      this.eraseStart = this.strokes;
      this.eraseAt(pt);
    }
    this.hover = pt;
    this.requestFrame();
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerType === 'pen') this.lastPenTime = performance.now();
    const pt = this.toPoint(e);
    this.hover = pt;
    if (e.pointerId !== this.activePointer) {
      if (this.tool !== 'pen') this.requestFrame(); // eraser hover cursor
      return;
    }
    // Coalesced events recover the full-rate stylus samples the browser batched per frame.
    const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const events = samples.length ? samples : [e];
    for (const ev of events) {
      const p = this.toPoint(ev);
      if (this.current) {
        const last = this.current[this.current.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) >= MIN_POINT_DISTANCE) this.current.push(p);
      } else {
        this.eraseAt(p);
      }
    }
    this.requestFrame();
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    if (this.current) {
      const pts = this.current;
      this.current = null;
      this.finishStroke(pts);
    } else if (this.eraseStart) {
      const before = this.eraseStart;
      this.eraseStart = null;
      if (this.strokes !== before) {
        this.history.push(this.strokes);
        this.opts.onChange(this.strokes, 'erase');
      }
    }
    if (e.pointerType !== 'mouse') this.hover = null;
    this.requestFrame();
  };

  private onCancel = (e: PointerEvent) => {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    this.current = null;
    if (this.eraseStart) {
      // Roll back a half-finished erase.
      this.strokes = this.eraseStart;
      this.eraseStart = null;
      this.inkDirty = true;
    }
    this.hover = null;
    this.requestFrame();
  };

  private onLeave = (e: PointerEvent) => {
    if (e.pointerId === this.activePointer) return;
    this.hover = null;
    this.requestFrame();
  };

  private eraseAt(p: InkPoint) {
    const next =
      this.activeTool === 'pixel-eraser'
        ? erasePixelsAt(this.strokes, p, PIXEL_ERASER_RADIUS, () => this.nextId++)
        : eraseStrokesAt(this.strokes, p, STROKE_ERASER_RADIUS);
    if (next !== this.strokes) {
      this.strokes = next;
      this.inkDirty = true;
    }
  }

  private finishStroke(points: InkPoint[]) {
    if (isScratchGesture(points)) {
      const hit = strokesHitByScratch(this.strokes, points);
      if (hit.size > 0) {
        this.commit(
          this.strokes.filter((s) => !hit.has(s.id)),
          'scratch',
        );
        return;
      }
    }
    const stroke: Stroke = { id: this.nextId++, order: this.nextOrder++, points, width: this.penWidth, color: this.penColor };
    // Append-only fast path: draw just this stroke onto the ink layer.
    if (!this.inkDirty) drawStroke(this.inkCtx, stroke);
    this.history.push([...this.strokes, stroke]);
    this.strokes = this.history.current;
    this.opts.onChange(this.strokes, 'draw');
  }

  // ------------------------------------------------------------------ rendering

  private requestFrame() {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.frameRequested = false;
    const d = this.dpr;
    if (this.inkDirty) {
      this.inkDirty = false;
      this.inkCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.inkCtx.clearRect(0, 0, this.ink.width, this.ink.height);
      this.inkCtx.setTransform(d, 0, 0, d, 0, 0);
      for (const s of this.strokes) drawStroke(this.inkCtx, s);
    }

    const ctx = this.liveCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    if (this.current) drawStroke(ctx, { points: this.current, width: this.penWidth, color: this.penColor });
    const erasing = this.activePointer !== null ? this.activeTool !== 'pen' : this.tool !== 'pen';
    if (this.hover && erasing) {
      const r = (this.activePointer !== null ? this.activeTool : this.tool) === 'pixel-eraser' ? PIXEL_ERASER_RADIUS : STROKE_ERASER_RADIUS;
      ctx.beginPath();
      ctx.arc(this.hover.x, this.hover.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(120, 110, 90, 0.10)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(80, 70, 50, 0.55)';
      ctx.stroke();
    }
  };

  get cssSize() {
    return { width: this.cssW, height: this.cssH, dpr: this.dpr };
  }
}

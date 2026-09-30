import { eraseStrokesAt, erasePixelsAt, isScratchGesture, strokesHitByScratch } from './erase';
import { backingStoreSize, clientToCanvas, type XY } from './geometry';
import { History } from './history';
import { drawStroke } from './render';
import type { InkPoint, Stroke } from './types';
import { IDENTITY_VIEW, panBy, pinchView, screenToWorld, zoomAt, type View } from './viewport';

export type Tool = 'pen' | 'eraser' | 'pixel-eraser' | 'hand';

export interface InkCanvasOptions {
  /** Called after every committed change (draw, erase, undo, …). */
  onChange: (strokes: readonly Stroke[], reason: 'draw' | 'erase' | 'scratch' | 'undo' | 'redo' | 'clear' | 'load') => void;
  /** Called whenever the canvas is resized (CSS px) so overlays can follow. */
  onResize?: (width: number, height: number, dpr: number) => void;
  /** Called whenever the camera pans or zooms. */
  onView?: (view: View) => void;
}

/** Eraser sizes are in screen pixels, so they feel the same at any zoom. */
const STROKE_ERASER_RADIUS = 8;
const PIXEL_ERASER_RADIUS = 11;
const MIN_POINT_DISTANCE = 0.75;

type Mode = 'draw' | 'erase' | 'pan' | 'pinch';

/**
 * Three stacked canvases over an infinite, zoomable page:
 *   ink     — committed strokes; redrawn fully only on erase/undo/resize/view
 *             change, new strokes are appended incrementally.
 *   live    — the stroke being drawn plus the eraser cursor; cleared each frame.
 *   overlay — owned by the answer layer.
 * Strokes are stored in world coordinates; `view` maps them to the screen.
 * All drawing is batched into requestAnimationFrame so input handlers stay tiny.
 *
 * Input model:
 *   pen            draws (eraser end / barrel button erases); palms are ignored
 *   finger         draws until a pen is seen, then pans; two fingers pan + pinch-zoom
 *   mouse          left draws, middle-drag / Space-drag / hand tool pans,
 *                  wheel scrolls, Ctrl+wheel (and trackpad pinch) zooms
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

  private view: View = IDENTITY_VIEW;

  // Drawing / erasing (single pointer)
  private activePointer: number | null = null;
  private mode: Mode | null = null;
  private eraseTool: Tool = 'eraser';
  private current: InkPoint[] | null = null;
  private eraseStart: readonly Stroke[] | null = null;
  private hover: XY | null = null;
  private penSeen = false;
  private penDown = false;
  private penUpAt = -Infinity;
  /** Touches classified as palm/accidental; ignored until lifted. */
  private ignored = new Set<number>();
  private spaceHeld = false;

  // Pan / pinch gesture
  /** Latest screen position of every finger and every pointer driving a gesture. */
  private positions = new Map<number, XY>();
  private fingers = new Set<number>();
  private gesturePtrs = new Set<number>();
  private gesture: { view: View; center: XY; spread: number } | null = null;

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
    host.addEventListener('wheel', this.onWheel, { passive: false });
    host.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);

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
  get currentView(): View {
    return this.view;
  }
  /** What the user is doing right now (null when idle). */
  get interaction(): Mode | null {
    return this.mode;
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

  setView(v: View) {
    if (v.x === this.view.x && v.y === this.view.y && v.scale === this.view.scale) return;
    this.view = v;
    this.inkDirty = true;
    this.requestFrame();
    this.opts.onView?.(v);
  }

  /** Zoom by a factor around the centre of the screen (toolbar buttons). */
  zoomBy(factor: number) {
    this.setView(zoomAt(this.view, { x: this.cssW / 2, y: this.cssH / 2 }, factor));
  }

  resetView() {
    this.setView(IDENTITY_VIEW);
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
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

  private toScreen(e: PointerEvent | WheelEvent): XY {
    return clientToCanvas(e.clientX, e.clientY, this.rect);
  }

  private toWorld(e: PointerEvent): InkPoint {
    const { x, y } = screenToWorld(this.view, this.toScreen(e));
    const p = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
    return { x, y, p };
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.code !== 'Space') return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    this.spaceHeld = e.type === 'keydown';
    this.host.classList.toggle('panning', this.spaceHeld || this.tool === 'hand');
    if (e.type === 'keydown') e.preventDefault();
  };

  private onDown = (e: PointerEvent) => {
    const r = this.host.getBoundingClientRect();
    this.rect = { left: r.left, top: r.top };

    if (e.pointerType === 'touch') {
      // Palm rejection: ignore touches while the pen is down or was just lifted
      // (the hand is still resting), and any contact too big to be a fingertip.
      const recentPen = performance.now() - this.penUpAt < 600;
      const palmSized = (e.width || 0) > 45 || (e.height || 0) > 45;
      if (this.penDown || recentPen || palmSized) {
        this.ignored.add(e.pointerId);
        return;
      }
      this.positions.set(e.pointerId, this.toScreen(e));
      this.fingers.add(e.pointerId);
      this.capture(e);
      if (this.fingers.size >= 2) {
        // Second finger: abandon any finger-drawn stroke and pan/pinch with all fingers.
        this.abortActive();
        this.gesturePtrs = new Set(this.fingers);
        this.startGesture('pinch');
        return;
      }
      if (this.penSeen || this.tool === 'hand') {
        this.gesturePtrs.add(e.pointerId);
        this.startGesture('pan');
        return;
      }
      // No stylus on this device: a single finger draws.
    }

    if (e.pointerType === 'pen') {
      this.penSeen = true;
      this.penDown = true;
      // The palm usually lands a moment before the pen. Whatever it did — a pan,
      // a pinch, or a finger stroke — was accidental: undo it and ignore those touches.
      this.cancelTouchInput();
    }
    if (this.activePointer !== null) return;

    const wantsPan = e.button === 1 || this.tool === 'hand' || (e.pointerType === 'mouse' && this.spaceHeld);
    if (wantsPan) {
      e.preventDefault();
      this.positions.set(e.pointerId, this.toScreen(e));
      this.gesturePtrs.add(e.pointerId);
      this.capture(e);
      this.startGesture('pan');
      return;
    }
    if (e.button !== 0 && e.button !== 5) return;
    e.preventDefault();

    this.activePointer = e.pointerId;
    this.capture(e);
    // Stylus eraser end / barrel button acts as a stroke eraser.
    const erasing = e.button === 5 || (e.buttons & 32) !== 0;
    this.eraseTool = erasing ? 'eraser' : this.tool;

    const pt = this.toWorld(e);
    if (this.eraseTool === 'pen') {
      this.mode = 'draw';
      this.current = [pt];
    } else {
      this.mode = 'erase';
      this.eraseStart = this.strokes;
      this.eraseAt(pt);
    }
    this.hover = pt;
    this.requestFrame();
  };

  private onMove = (e: PointerEvent) => {
    if (this.ignored.has(e.pointerId)) return; // palm
    if (this.positions.has(e.pointerId)) this.positions.set(e.pointerId, this.toScreen(e));
    if (this.gesturePtrs.has(e.pointerId)) {
      this.updateGesture();
      return;
    }

    const pt = this.toWorld(e);
    this.hover = pt;
    if (e.pointerId !== this.activePointer) {
      if (this.tool === 'eraser' || this.tool === 'pixel-eraser') this.requestFrame(); // eraser hover cursor
      return;
    }
    // Coalesced events recover the full-rate stylus samples the browser batched per frame.
    const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const events = samples.length ? samples : [e];
    const minDist = MIN_POINT_DISTANCE / this.view.scale;
    for (const ev of events) {
      const p = this.toWorld(ev);
      if (this.current) {
        const last = this.current[this.current.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) >= minDist) this.current.push(p);
      } else {
        this.eraseAt(p);
      }
    }
    this.requestFrame();
  };

  private penLifted() {
    this.penDown = false;
    this.penUpAt = performance.now();
  }

  /** Called when the pen lands: rolls back and ignores everything fingers/palms were doing. */
  private cancelTouchInput() {
    const touchGesture = [...this.gesturePtrs].some((id) => this.fingers.has(id));
    if (touchGesture && this.gesture) this.setView(this.gesture.view); // snap back the accidental pan
    if (this.activePointer !== null && this.fingers.has(this.activePointer)) this.abortActive();
    for (const id of this.fingers) {
      this.ignored.add(id);
      this.gesturePtrs.delete(id);
      this.positions.delete(id);
    }
    this.fingers.clear();
    if (this.gesturePtrs.size === 0) this.gesture = null;
  }

  /** Forgets a lifted pointer; returns true if it was driving a pan/pinch. */
  private releasePointer(id: number): boolean {
    this.ignored.delete(id);
    this.positions.delete(id);
    this.fingers.delete(id);
    if (!this.gesturePtrs.delete(id)) return false;
    // Lifting one of two fingers continues as a one-finger pan from here.
    if (this.gesturePtrs.size > 0) this.startGesture('pan');
    else {
      this.gesture = null;
      this.mode = null;
    }
    return true;
  }

  private onUp = (e: PointerEvent) => {
    if (e.pointerType === 'pen') this.penLifted();
    if (this.releasePointer(e.pointerId)) return;
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
    this.mode = null;
    if (e.pointerType !== 'mouse') this.hover = null;
    this.requestFrame();
  };

  private onCancel = (e: PointerEvent) => {
    if (e.pointerType === 'pen') this.penLifted();
    if (this.releasePointer(e.pointerId)) return;
    if (e.pointerId !== this.activePointer) return;
    this.abortActive();
  };

  private onLeave = (e: PointerEvent) => {
    if (e.pointerId === this.activePointer || this.gesturePtrs.has(e.pointerId)) return;
    this.hover = null;
    this.requestFrame();
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const at = this.toScreen(e);
    // Normalise line/page deltas to pixels.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.cssH : 1;
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+wheel, and trackpad pinch (which browsers report as ctrl+wheel).
      this.setView(zoomAt(this.view, at, Math.exp((-e.deltaY * unit) / 300)));
    } else {
      this.setView(panBy(this.view, -e.deltaX * unit, -e.deltaY * unit));
    }
  };

  private capture(e: PointerEvent) {
    try {
      this.host.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone (or synthetic) — still works without capture */
    }
  }

  /** Cancels the in-progress stroke or erase without committing it. */
  private abortActive() {
    if (this.activePointer === null) return;
    this.activePointer = null;
    this.current = null;
    if (this.eraseStart) {
      // Roll back a half-finished erase.
      this.strokes = this.eraseStart;
      this.eraseStart = null;
      this.inkDirty = true;
    }
    this.mode = null;
    this.hover = null;
    this.requestFrame();
  }

  private gestureCenter(): { center: XY; spread: number } {
    const pts = [...this.gesturePtrs].map((id) => this.positions.get(id)).filter((p): p is XY => !!p);
    if (pts.length === 0) return { center: { x: 0, y: 0 }, spread: 0 };
    const center = {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
    };
    const spread = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    return { center, spread };
  }

  private startGesture(mode: 'pan' | 'pinch') {
    this.mode = mode;
    const { center, spread } = this.gestureCenter();
    this.gesture = { view: this.view, center, spread };
  }

  private updateGesture() {
    if (!this.gesture) return;
    const { center, spread } = this.gestureCenter();
    const g = this.gesture;
    this.setView(this.gesturePtrs.size >= 2 ? pinchView(g.view, g.center, g.spread, center, spread) : panBy(g.view, center.x - g.center.x, center.y - g.center.y));
  }

  private eraseAt(p: InkPoint) {
    const s = this.view.scale;
    const next =
      this.eraseTool === 'pixel-eraser'
        ? erasePixelsAt(this.strokes, p, PIXEL_ERASER_RADIUS / s, () => this.nextId++)
        : eraseStrokesAt(this.strokes, p, STROKE_ERASER_RADIUS / s);
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

  /** Sets a context to draw world coordinates at the current view and DPR. */
  private applyView(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
    const d = this.dpr;
    const { x, y, scale } = this.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(d * scale, 0, 0, d * scale, d * x, d * y);
  }

  private frame = () => {
    this.frameRequested = false;
    if (this.inkDirty) {
      this.inkDirty = false;
      this.applyView(this.inkCtx, this.ink);
      const s = this.view.scale;
      // Skip strokes entirely off screen (cheap culling for big pages).
      const left = -this.view.x / s;
      const top = -this.view.y / s;
      const right = left + this.cssW / s;
      const bottom = top + this.cssH / s;
      for (const st of this.strokes) {
        const p0 = st.points[0];
        if (st.points.length && !this.maybeVisible(st, left, top, right, bottom, p0)) continue;
        drawStroke(this.inkCtx, st);
      }
    }

    const ctx = this.liveCtx;
    this.applyView(ctx, this.live);
    if (this.current) drawStroke(ctx, { points: this.current, width: this.penWidth, color: this.penColor });
    const tool = this.activePointer !== null ? this.eraseTool : this.tool;
    if (this.hover && (tool === 'eraser' || tool === 'pixel-eraser')) {
      const s = this.view.scale;
      const r = (tool === 'pixel-eraser' ? PIXEL_ERASER_RADIUS : STROKE_ERASER_RADIUS) / s;
      ctx.beginPath();
      ctx.arc(this.hover.x, this.hover.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(120, 110, 90, 0.10)';
      ctx.fill();
      ctx.lineWidth = 1 / s;
      ctx.strokeStyle = 'rgba(80, 70, 50, 0.55)';
      ctx.stroke();
    }
  };

  private maybeVisible(st: Stroke, left: number, top: number, right: number, bottom: number, p0: InkPoint) {
    // Quick reject using the first point and a generous margin (strokes are small).
    const m = 400;
    return p0.x > left - m && p0.x < right + m && p0.y > top - m && p0.y < bottom + m ? true : st.points.some((p) => p.x > left && p.x < right && p.y > top && p.y < bottom);
  }

  get cssSize() {
    return { width: this.cssW, height: this.cssH, dpr: this.dpr };
  }
}

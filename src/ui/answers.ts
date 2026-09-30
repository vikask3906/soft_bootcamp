import { IDENTITY_VIEW, type View } from '../ink/viewport';
import type { EquationResult } from '../recognition/pipeline';

export const ANSWER_FONT = 'Caveat';
const WRITE_MS = 420;
const LOW_CONFIDENCE = 0.6;

interface Answer {
  eq: EquationResult;
  born: number;
}

/**
 * Projects answers onto the overlay canvas next to each "=".
 * Answers "write themselves" left-to-right (a clip reveal) when they appear
 * or change; unchanged answers are left alone so editing elsewhere on the
 * page never makes them flicker. The overlay only animates while needed.
 */
export class AnswerLayer {
  private answers = new Map<string, Answer>();
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private dpr = 1;
  private view: View = IDENTITY_VIEW;
  /** Where each answer was last drawn (world coords), for tap hit-testing. */
  private rects = new Map<string, { x: number; y: number; w: number; h: number }>();
  /** Equation currently open in tap-to-correct (drawn with a highlight). */
  highlighted: string | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onNewAnswer?: (eq: EquationResult) => void,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  setDpr(dpr: number) {
    this.dpr = dpr;
    this.draw();
  }

  redraw() {
    this.draw();
  }

  /**
   * Answers live in world space like the ink, so they pan and zoom with it.
   * Coalesced to one redraw per frame (a trackpad can fire several zoom events per frame).
   */
  setView(view: View) {
    this.view = view;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.draw);
  }

  /** The equation whose drawn answer is at world point p (with a finger-friendly margin), if any. */
  hitTest(p: { x: number; y: number }): EquationResult | null {
    const pad = 10 / this.view.scale;
    for (const [key, r] of this.rects) {
      if (p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad) {
        return this.answers.get(key)?.eq ?? null;
      }
    }
    return null;
  }

  update(equations: EquationResult[]) {
    const now = performance.now();
    const next = new Map<string, Answer>();
    for (const eq of equations) {
      const prev = this.answers.get(eq.key);
      const same = prev && prev.eq.display === eq.display;
      // Keep the birth time for unchanged answers; still take the fresh position/confidence.
      next.set(eq.key, { eq, born: same ? prev.born : now });
      if (!same) this.onNewAnswer?.(eq);
    }
    this.answers = next;
    this.draw();
  }

  get current(): EquationResult[] {
    return [...this.answers.values()].map((a) => a.eq);
  }

  private draw = () => {
    cancelAnimationFrame(this.raf);
    const { ctx, canvas, dpr, view } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);

    const now = performance.now();
    let animating = false;
    this.rects.clear();
    for (const { eq, born } of this.answers.values()) {
      const t = Math.min(1, (now - born) / WRITE_MS);
      if (t < 1) animating = true;
      this.drawAnswer(eq, easeOut(t));
    }
    if (animating) this.raf = requestAnimationFrame(this.draw);
  };

  private drawAnswer(eq: EquationResult, t: number) {
    const { ctx } = this;
    const size = Math.max(22, Math.min(eq.anchor.height * 1.05, 140));
    const x = eq.anchor.x + size * 0.28;
    const y = eq.anchor.y;
    const kind = eq.result.kind;
    const color = kind === 'ok' ? '#1f5fd1' : kind === 'undefined' ? '#b4432f' : '#9a8f7a';

    ctx.save();
    ctx.font = `600 ${size}px ${ANSWER_FONT}, "Segoe Print", "Bradley Hand", cursive`;
    ctx.textBaseline = 'middle';
    const width = ctx.measureText(eq.display).width;
    this.rects.set(eq.key, { x, y: y - size * 0.5, w: width, h: size });

    if (this.highlighted === eq.key) {
      // Soft marker behind the answer while it's open for correction.
      ctx.fillStyle = 'rgba(31, 95, 209, 0.10)';
      ctx.beginPath();
      ctx.roundRect(x - 6, y - size * 0.55, width + 12, size * 1.1, 8);
      ctx.fill();
    }

    // Clip-reveal from the left: the answer looks like it is being written.
    ctx.beginPath();
    ctx.rect(x - 4, y - size, (width + 8) * t, size * 2);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35 + 0.65 * t;
    ctx.fillText(eq.display, x, y + size * 0.04);

    // Confidence cue: a dashed amber underline when the recogniser is unsure.
    if (kind !== 'error' && eq.confidence < LOW_CONFIDENCE) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#d99a1e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y + size * 0.42);
      ctx.lineTo(x + width, y + size * 0.42);
      ctx.stroke();
    }
    ctx.restore();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
  }
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

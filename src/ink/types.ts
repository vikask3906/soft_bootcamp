/** A single sampled pen position in CSS-pixel (logical) canvas coordinates. */
export interface InkPoint {
  x: number;
  y: number;
  /** Normalised pressure 0..1 (0.5 for devices without pressure). */
  p: number;
}

/**
 * An immutable stroke. Strokes are never mutated in place; edits (erase,
 * undo, …) replace whole strokes so history snapshots can share them.
 */
export interface Stroke {
  readonly id: number;
  /** Monotonic creation order; pieces split by the pixel eraser keep it. */
  readonly order: number;
  readonly points: readonly InkPoint[];
  readonly width: number;
  readonly color: string;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

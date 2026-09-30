import type { Stroke } from './types';

/**
 * Snapshot-based undo/redo. Because strokes are immutable, each snapshot is
 * just an array of references — cheap to store — and every edit (draw,
 * either eraser, scratch-out, clear) is undone the same way.
 */
export class History {
  private stack: (readonly Stroke[])[] = [[]];
  private index = 0;

  constructor(private readonly limit = 200) {}

  get current(): readonly Stroke[] {
    return this.stack[this.index];
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index < this.stack.length - 1;
  }

  /** Records a new state; drops the redo branch and trims the oldest entries. */
  push(next: readonly Stroke[]) {
    if (next === this.current) return;
    this.stack.length = this.index + 1;
    this.stack.push(next);
    if (this.stack.length > this.limit) this.stack.splice(0, this.stack.length - this.limit);
    this.index = this.stack.length - 1;
  }

  undo(): readonly Stroke[] {
    if (this.canUndo) this.index--;
    return this.current;
  }

  redo(): readonly Stroke[] {
    if (this.canRedo) this.index++;
    return this.current;
  }

  reset(initial: readonly Stroke[] = []) {
    this.stack = [initial];
    this.index = 0;
  }
}

/**
 * Makes the floating toolbar movable (drag the grip) and collapsible, and
 * remembers both per device. Positions are clamped so the toolbar can never
 * be dragged off screen, including after the window is resized or rotated.
 */
const POS_KEY = 'calcink.toolbar.v1';

interface ToolbarState {
  x?: number;
  y?: number;
  collapsed?: boolean;
}

function read(): ToolbarState {
  try {
    return JSON.parse(localStorage.getItem(POS_KEY) ?? '{}') as ToolbarState;
  } catch {
    return {};
  }
}

function write(s: ToolbarState) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — position just won't persist */
  }
}

export function setupToolbar(bar: HTMLElement, grip: HTMLElement, collapseBtn: HTMLElement) {
  let state = read();

  const clampAndPlace = (x: number, y: number) => {
    const margin = 8;
    const maxX = window.innerWidth - bar.offsetWidth - margin;
    const maxY = window.innerHeight - bar.offsetHeight - margin;
    const cx = Math.round(Math.min(Math.max(margin, x), Math.max(margin, maxX)));
    const cy = Math.round(Math.min(Math.max(margin, y), Math.max(margin, maxY)));
    bar.classList.add('placed');
    bar.style.left = `${cx}px`;
    bar.style.top = `${cy}px`;
    return { x: cx, y: cy };
  };

  const resetPosition = () => {
    bar.classList.remove('placed');
    bar.style.left = '';
    bar.style.top = '';
    state = { collapsed: state.collapsed };
    write(state);
  };

  const applyCollapsed = () => {
    bar.classList.toggle('collapsed', !!state.collapsed);
    collapseBtn.setAttribute('aria-label', state.collapsed ? 'Expand toolbar' : 'Collapse toolbar');
    if (state.x !== undefined && state.y !== undefined) clampAndPlace(state.x, state.y);
  };

  applyCollapsed();

  collapseBtn.addEventListener('click', () => {
    state = { ...state, collapsed: !state.collapsed };
    write(state);
    applyCollapsed();
  });

  let drag: { id: number; dx: number; dy: number } | null = null;

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = bar.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    bar.classList.add('dragging');
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });

  grip.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const p = clampAndPlace(e.clientX - drag.dx, e.clientY - drag.dy);
    state = { ...state, ...p };
  });

  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    bar.classList.remove('dragging');
    write(state);
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', resetPosition);

  // Keep it on screen after resize / rotation.
  window.addEventListener('resize', () => {
    if (state.x !== undefined && state.y !== undefined) {
      const p = clampAndPlace(state.x, state.y);
      state = { ...state, ...p };
    }
  });
}

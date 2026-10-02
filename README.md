# CalcInk — on-device handwritten math calculator

Write an equation by hand — with a stylus, finger or mouse — end it with `=`, and the answer
appears on the page next to it, in handwriting. Edit any number and the answer updates.
Everything runs **in the browser, on your device**: no server, no cloud APIs, and it keeps
working in airplane mode.

> Inter IIT Bootcamp · IIT Guwahati Tech Board · Software track · Phase 1

**Live demo:** https://vikask3906.github.io/soft_bootcamp/ · [![CI](https://github.com/vikask3906/soft_bootcamp/actions/workflows/ci.yml/badge.svg)](https://github.com/vikask3906/soft_bootcamp/actions/workflows/ci.yml)

---

## Features

**Digital ink**

- Smooth, pressure-sensitive ink (mouse, pen, touch) with crisp rendering on high-DPI screens
- Undo / redo, stroke eraser, pixel eraser, clear page, three pen widths
- Infinite page: pinch or two-finger pan/zoom, Ctrl + wheel, hand tool, zoom buttons
- Palm rejection: a hand resting on the screen never draws or moves the page
- Stylus eraser end / barrel button erases; **scratch-out** (scribble over ink) deletes it

**Recognition & maths**

- Digits `0–9`, `+ − × ÷`, decimal point, `=`, and brackets `( )`
- BODMAS evaluation with multi-digit numbers, decimals, negatives, nested brackets and
  implicit multiplication (`2(3+4)`) — by a hand-written parser, never `eval()`
- `9 ÷ 0 =` shows **Undefined**; malformed input shows `?` plus a short reason
  (`? missing )`, `? two operators`, …) and never crashes

**Equations & variable memory** (creative extension)

- Write `2x + 4 = 10` and the solution `x = 3` appears next to it — any linear equation in x,
  with x on either side or both (`3(x − 1) = 2x + 5`), plus "no solution" / "any x"
- `x = 10` stores a value (shown with a ✓); a line below such as `x × 3 + 1 =` uses it (→ 31).
  A solved equation stores its x too; each line uses the nearest definition above it
- A cursive x (two curves, `)(`) is told apart from the multiplication sign `×` (two straight
  lines); an x written as `×` is still understood where multiplication makes no sense (`2×+4=10`)

**On the paper**

- The answer "writes itself" next to the `=`, and re-evaluates live as you edit
- Uncertain answers get a dashed amber underline (confidence indicator)
- **Tap-to-correct:** tap an answer, tap a misread symbol, pick the right one (the model's
  runner-up guesses are offered first) — or "ignore this mark" for a stray tap
- **Slanted writing:** each row is straightened by its own measured slope (tested from −30° to
  +30°, including rows at different angles), and the answer follows the row's slope
- Bracket-balance safety net: an unbalanced expression retries the likely `1` ↔ `(`/`)` misread
- Soft audio / haptic cues, autosave, movable & collapsible toolbar, "what CalcInk reads" panel

## Quick start

Requirements: **Node.js 22.12 or newer** (needed by the test runner; developed on Node 22.15) and npm.

```bash
npm install
npm run dev
```

Open http://localhost:5173.

> **Windows PowerShell:** if `npm` is blocked by the execution policy, use `npm.cmd` instead
> (e.g. `npm.cmd install`, `npm.cmd run dev`).

### Try it on a tablet

The laptop serves the app over Wi-Fi; the tablet just opens it in a browser.

```bash
npm run dev:lan
```

Open the printed `Network: http://<laptop-ip>:5173` address on the tablet (same Wi-Fi network;
allow Node through the firewall on private networks if asked). Offline mode needs `https://`
or `localhost`, so test airplane mode on the deployed site or with `npm run preview`.

### All scripts

| Command             | What it does                                                              |
| ------------------- | ------------------------------------------------------------------------- |
| `npm run dev`       | Dev server with hot reload                                                |
| `npm run dev:lan`   | Dev server reachable from other devices on the network                    |
| `npm run build`     | Type-check + production build into `dist/` (with offline service worker)  |
| `npm run preview`   | Serve the production build locally                                        |
| `npm test`          | Run all automated tests (214)                                             |
| `npm run bench`     | Handwriting benchmark on real tablet recordings, with a per-symbol report |
| `npm run typecheck` | TypeScript only                                                           |
| `npm run format`    | Prettier                                                                  |

## How it works (short version)

```
pen strokes ──► main thread: draw ink at 60 FPS
                     │  (strokes copied to a Web Worker)
                     ▼
            Web Worker: group strokes into rows & symbols
                     → operators by geometry rules, digits by a CNN (ONNX)
                     → BODMAS parser → answer
                     │
                     ▼
            main thread: draw the answer next to "=" (animated)
```

The heavy work never runs on the UI thread, so drawing stays smooth while recognition runs.
Full design, the model choice and the maths are in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Pre-trained model

|                       |                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Model**             | MNIST handwritten-digit CNN, `mnist-12.onnx`                                                                                                     |
| **Source**            | [ONNX Model Zoo — MNIST](https://github.com/onnx/models/tree/main/validated/vision/classification/mnist) (trained in CNTK, tutorial _CNTK 103D_) |
| **License**           | MIT                                                                                                                                              |
| **Architecture**      | Conv 5×5 (8 filters) → ReLU → MaxPool 2×2 → Conv 5×5 (16 filters) → ReLU → MaxPool 3×3 → Fully connected (256 → 10)                              |
| **Size**              | 26 KB, 5,994 learned parameters, ONNX opset 12                                                                                                   |
| **Input / output**    | `1×1×28×28` float32 (white ink on black, 0–1) → 10 logits                                                                                        |
| **Reported accuracy** | 1.1 % top-1 error on the MNIST test set                                                                                                          |
| **Runtime**           | [ONNX Runtime Web](https://onnxruntime.ai/) 1.30 (WebAssembly backend), MIT                                                                      |

The model reads **digits**. Operators, the decimal point, `=` and brackets are recognised by
geometric rules on the vector strokes — why, and how, is explained in
[ARCHITECTURE.md §4](ARCHITECTURE.md#4-recognition-model-choice-and-alternatives).

## Accuracy on real handwriting

Measured with `npm run bench` on real stylus recordings from an Android tablet
(`tests/fixtures/sheets/`), scored symbol-by-symbol against what the writer was asked to write:

| Test sheet                                         | Symbols correct  | Correct answers |
| -------------------------------------------------- | ---------------- | --------------- |
| Sheet 1 (digits ×5 each, operator rows, equations) | 173 / 175 (99 %) | 5 / 6           |
| Sheet 2 (16 fresh equations, written freely)       | 152 / 153 (99 %) | 15 / 16         |

The remaining errors are two digit misreads by the model (`3→2`, `5→4`) and a one-stroke cursive
`×`; tap-to-correct fixes each in two taps. Eight more real pages (free writing with erasing, retracing, stray pen touches, nested brackets,
slanted rows and a cursive x) are regression tests in `tests/fixtures/real/`.
The benchmark fails the test run if accuracy on either sheet drops below 98 %.

## Tests

`npm test` runs 214 tests (Vitest, in Node — no browser needed):

- **Parser** — BODMAS, associativity, decimals, negatives, brackets, implicit ×, every error reason,
  division by zero, overflow, float formatting (`0.1 + 0.2 → 0.3`)
- **Geometry & display** — pointer → canvas coordinate conversion, high-DPI backing-store sizing
  (1×, 1.25×, 2×, 3×), pan/zoom camera maths
- **Ink** — undo/redo, stroke and pixel erasers, scratch-out detection
- **Recognition** — every operator rule, stroke grouping, rasterisation into the model's input,
  corrections, bracket repair
- **Real model on real handwriting** — the ONNX model on all digits, on ten real tablet recordings (incl. slanted lines and a cursive x), and on rows from −30° to +30°

## Project structure

```
src/
  main.ts                entry point: wires everything together
  ink/                   canvas engine (input, rendering, zoom, undo, erasers)   — main thread
  worker/                Web Worker + typed messages                             — both threads
  recognition/           strokes → rows → symbols → digits/operators             — worker
  math/evaluate.ts       tokenizer + recursive-descent BODMAS parser             — worker
  ui/                    answers on paper, tap-to-correct, toolbar, feedback, autosave
tests/                   unit, integration and benchmark tests + real handwriting fixtures
public/models/           the pre-trained ONNX model
```

## Deployment

The app is a static site (`npm run build` → `dist/`), so any static host works.

**GitHub Pages (automatic).** `.github/workflows/deploy.yml` runs the tests, builds and publishes
on every push to `main`. One-time setup: repository **Settings → Pages → Source: GitHub Actions**.
The workflow sets Vite's `base` to the repository's sub-path (`/<repo>/`) automatically; locally,
`BASE=/<repo>/ npm run build` does the same.

**Vercel / Netlify.** Import the repository — the Vite preset works as is (build `npm run build`,
output `dist`, base `/`).

**Continuous integration.** `.github/workflows/ci.yml` runs `npm ci`, all tests (including the
handwriting benchmark) and a production build on every push and pull request.

## Known limitations

- **Vocabulary:** one variable (`x`), linear equations only; no fractions written vertically,
  exponents or roots.
- **Joined-up digits:** two digits written in one stroke without lifting the pen (e.g. `27`) are
  read as one symbol — lift the pen between digits.
- **Digit model:** MNIST was trained on neat, centred digits; unusual shapes can be misread
  (tap-to-correct covers this).
- **Developer tools:** `npm run dev` adds a "Send this page to laptop" button that saves strokes
  to `debug/` for diagnosis. It exists only in dev mode and is not part of the production build.

## Built with

TypeScript · Vite · ONNX Runtime Web · vite-plugin-pwa (Workbox) · Vitest ·
Caveat font (@fontsource, OFL-1.1) — all running client-side.

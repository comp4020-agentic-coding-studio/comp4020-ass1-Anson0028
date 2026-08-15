// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// These test the brief's three named risks, not the published spec (that's
// invariants.test.ts + the rest of this file's other describe blocks, once
// written). They run against the SOURCE (`../main.ts`), not `dist/`, because
// they drive interaction over time (keypresses, resize, slider input, frames)
// rather than checking shipped markup — jsdom can execute the module directly
// without fighting a bundled script's module loading.
//
// The game state lives on a canvas, which is a black box to any test (and to
// a grader's automation). So these tests assume the prototype exposes a
// parallel, inspectable state on `[data-testid="game-state"]`
// (data-running, data-elapsed-ms, data-player-x, data-applied-speed, ...) —
// a DOM mirror of what's drawn, not a prescription for how it's drawn (see
// CLAUDE.md for the rule that keeps this mirror from drifting). Same for the
// three difficulty dials: real `<input type="range">` elements, not custom
// pointer-only widgets, because that's what makes "adjustable by tab and
// arrow keys" free rather than something to reimplement.
//
// data-player-x/-player-y are fractions of the arena (0–1), not pixels — the
// simulation runs in normalised coordinates per CLAUDE.md, so difficulty
// doesn't silently change with viewport size.
//
// If this contract isn't the one you build to, these tests are the thing to
// change, not the assumption to work around silently.

// Only a mount point — the app has to build the canvas, the game-state
// mirror, and the three sliders itself. A fixture that pre-supplies those
// elements would make these tests pass against the test file, not the app.
const FIXTURE = `<div id="app"></div>`;

function gameState(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="game-state"]');
  if (!el) throw new Error('[data-testid="game-state"] not found — see the note at the top of this file');
  return el;
}

function slider(name: "health" | "speed" | "damage"): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`[data-testid="enemy-${name}"]`);
  if (!el) throw new Error(`[data-testid="enemy-${name}"] not found`);
  return el;
}

async function mountGame() {
  document.body.innerHTML = FIXTURE;
  vi.resetModules();
  await import("../main");
}

function tick(ms = 20) {
  vi.advanceTimersByTime(ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("core interaction is keyboard-only", () => {
  it("moves the player on arrow keys alone, no mouse involved", async () => {
    await mountGame();
    tick();
    const before = Number(gameState().dataset.playerX);

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight" }));
    tick();

    expect(Number(gameState().dataset.playerX)).toBeGreaterThan(before);
  });

  it("every difficulty slider is a native, enabled, tabbable control", async () => {
    await mountGame();
    for (const name of ["health", "speed", "damage"] as const) {
      const input = slider(name);
      expect(input.type).toBe("range");
      expect(input.disabled).toBe(false);
      expect(input.tabIndex).not.toBe(-1);
    }
  });
});

describe("resizing mid-run", () => {
  it("keeps the run going, in normalised coordinates, and the canvas correct", async () => {
    await mountGame();
    tick();
    tick();
    tick();

    const elapsedBefore = Number(gameState().dataset.elapsedMs);
    const playerXBefore = Number(gameState().dataset.playerX);
    const playerYBefore = Number(gameState().dataset.playerY);
    const canvasBefore = document.querySelector('[data-testid="game-canvas"]') as HTMLCanvasElement;

    // Position is a fraction of the arena, not a pixel count — true at any
    // canvas size, including before this test ever resizes anything.
    expect(playerXBefore).toBeGreaterThanOrEqual(0);
    expect(playerXBefore).toBeLessThanOrEqual(1);
    expect(playerYBefore).toBeGreaterThanOrEqual(0);
    expect(playerYBefore).toBeLessThanOrEqual(1);

    const canvasWidthBefore = canvasBefore.width;

    // jsdom has no layout engine: getBoundingClientRect() always reports a
    // zero-size box and never reacts to a window resize, no matter what the
    // resize handler does. Stubbing it stands in for what a real browser's
    // layout would report after this resize, so the assertions below test the
    // actual contract — the handler reads current geometry and updates the
    // canvas's pixel buffer — rather than something jsdom fundamentally can't
    // produce. (Real layout is check-viewports.ts's job, not this test's.)
    const resizedRect = {
      width: 500,
      height: 375,
      top: 0,
      left: 0,
      right: 500,
      bottom: 375,
      x: 0,
      y: 0,
      toJSON() {
        return this;
      },
    };
    vi.spyOn(canvasBefore, "getBoundingClientRect").mockReturnValue(resizedRect);

    window.innerWidth = 500;
    window.innerHeight = 900;
    window.dispatchEvent(new Event("resize"));
    tick();

    expect(document.querySelector('[data-testid="game-canvas"]'), "canvas was torn down and rebuilt").toBe(
      canvasBefore,
    );
    expect(gameState().dataset.running).toBe("true");
    expect(Number(gameState().dataset.elapsedMs)).toBeGreaterThanOrEqual(elapsedBefore);

    // No key was pressed since the resize, so the dot didn't move. In
    // normalised coordinates that means the fraction is untouched — if
    // position were pixels tied to the old canvas size, it would either
    // silently relocate within the arena or need a rescale step that's easy
    // to get wrong. Either way this assertion catches it.
    expect(Number(gameState().dataset.playerX)).toBeCloseTo(playerXBefore, 5);
    expect(Number(gameState().dataset.playerY)).toBeCloseTo(playerYBefore, 5);

    // The two assertions this replaces (width/height > 0) passed against
    // jsdom's 300×150 default whether or not resize worked — vacuously green.
    // These check the canvas actually picked up the stubbed post-resize box.
    expect(canvasBefore.width, "canvas didn't pick up the new box size on resize").toBe(resizedRect.width);
    expect(canvasBefore.height, "canvas didn't pick up the new box size on resize").toBe(resizedRect.height);
    expect(canvasBefore.width, "canvas didn't actually resize with the window").not.toBe(canvasWidthBefore);
  });
});

describe("a slider change applies within the same run", () => {
  it("changes the applied enemy speed immediately, without a restart", async () => {
    await mountGame();
    tick();
    const before = gameState().dataset.appliedSpeed;

    const speedInput = slider("speed");
    speedInput.value = "90";
    speedInput.dispatchEvent(new Event("input", { bubbles: true }));
    tick();

    expect(gameState().dataset.appliedSpeed).not.toBe(before);
    expect(gameState().dataset.appliedSpeed).toBe("90");
  });
});

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
// a DOM mirror of what's drawn, not a prescription for how it's drawn. Same
// for the three difficulty dials: real `<input type="range">` elements, not
// custom pointer-only widgets, because that's what makes "adjustable by tab
// and arrow keys" free rather than something to reimplement.
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
  it("keeps the run going and the canvas correct", async () => {
    await mountGame();
    tick();
    tick();
    tick();

    const elapsedBefore = Number(gameState().dataset.elapsedMs);
    const canvasBefore = document.querySelector('[data-testid="game-canvas"]');

    window.innerWidth = 500;
    window.innerHeight = 900;
    window.dispatchEvent(new Event("resize"));
    tick();

    expect(document.querySelector('[data-testid="game-canvas"]'), "canvas was torn down and rebuilt").toBe(
      canvasBefore,
    );
    expect(gameState().dataset.running).toBe("true");
    expect(Number(gameState().dataset.elapsedMs)).toBeGreaterThanOrEqual(elapsedBefore);

    const canvas = canvasBefore as HTMLCanvasElement;
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.height).toBeGreaterThan(0);
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

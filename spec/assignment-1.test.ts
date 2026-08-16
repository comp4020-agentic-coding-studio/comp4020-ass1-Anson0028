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

// Three panels each have their own health/speed/damage slider, namespaced
// `enemy-${name}-${panel}` — panel 0 is active by default (see CLAUDE.md's
// "Three configurations" section), so panel 0 is what any test not
// specifically about panel-switching should read or drive.
function slider(name: "health" | "speed" | "damage", panel = 0): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`[data-testid="enemy-${name}-${panel}"]`);
  if (!el) throw new Error(`[data-testid="enemy-${name}-${panel}"] not found`);
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

  // Found by playing the built site, not by any check in this repo: the arrows
  // scrolled the page 420px mid-run, and with a slider focused they drove the
  // player as well as the slider. See CLAUDE.md's owner-attribution rule — the
  // two tests below are its two halves, and neither is sufficient alone.
  it("stops the browser scrolling the page when it consumes an arrow key", async () => {
    await mountGame();
    tick();

    const event = new KeyboardEvent("keydown", { code: "ArrowDown", cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented, "arrow keydown was not preventDefault'd, so the page scrolls under the arena").toBe(
      true,
    );
  });

  it("leaves arrow keys to a focused slider instead of also driving the player", async () => {
    await mountGame();
    tick();
    const dial = slider("speed");
    dial.focus();
    const before = Number(gameState().dataset.playerX);

    const event = new KeyboardEvent("keydown", { code: "ArrowRight", cancelable: true, bubbles: true });
    dial.dispatchEvent(event);
    tick();

    expect(Number(gameState().dataset.playerX), "the player moved while a slider was being adjusted").toBeCloseTo(
      before,
      5,
    );
    expect(event.defaultPrevented, "the slider's own arrow-key adjustment was swallowed by the game").toBe(false);
  });

  it("moves the player on WASD as well, in the same directions as the arrows", async () => {
    for (const [wasd, arrow, axis, sign] of [
      ["KeyD", "ArrowRight", "playerX", 1],
      ["KeyA", "ArrowLeft", "playerX", -1],
      ["KeyS", "ArrowDown", "playerY", 1],
      ["KeyW", "ArrowUp", "playerY", -1],
    ] as const) {
      await mountGame();
      tick();
      const before = Number(gameState().dataset[axis]);

      window.dispatchEvent(new KeyboardEvent("keydown", { code: wasd, cancelable: true }));
      tick();
      const after = Number(gameState().dataset[axis]);
      window.dispatchEvent(new KeyboardEvent("keyup", { code: wasd }));

      const moved = (after - before) * sign;
      expect(moved, `${wasd} did not move the player the way ${arrow} does`).toBeGreaterThan(0);
    }
  });

  it("every difficulty slider is a native, enabled, tabbable control", async () => {
    await mountGame();
    // Three panels x three stats = nine sliders. Queried generically by
    // input[type=range] rather than by exact id, so this test (and
    // check-viewports.ts's liveness check) covers however many panels exist
    // without hardcoding their ids in two places.
    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="range"]');
    expect(inputs.length).toBe(9);
    for (const input of inputs) {
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

describe("three configurations, only one live at a time", () => {
  it("mirrors which panel is active, and switching starts a fresh run", async () => {
    await mountGame();
    tick();
    tick();

    expect(gameState().dataset.activeConfig).toBe("0");
    const elapsedBeforeSwitch = Number(gameState().dataset.elapsedMs);
    expect(elapsedBeforeSwitch).toBeGreaterThan(0);

    const panel1 = document.querySelector<HTMLInputElement>('[data-testid="panel-select-1"]');
    if (!panel1) throw new Error('[data-testid="panel-select-1"] not found');
    panel1.checked = true;
    panel1.dispatchEvent(new Event("change", { bubbles: true }));
    tick();

    expect(gameState().dataset.activeConfig).toBe("1");
    // A fresh run, not the old one still ticking under a swapped config —
    // comparing how a configuration feels is only honest from the same
    // starting point every time (see CLAUDE.md).
    expect(Number(gameState().dataset.elapsedMs)).toBeLessThan(elapsedBeforeSwitch);
  });

  it("states the reference-player limitation in plain language on the page", async () => {
    await mountGame();
    const el = document.querySelector<HTMLElement>('[data-testid="equalise-limitation"]');
    if (!el) throw new Error('[data-testid="equalise-limitation"] not found');
    const text = el.textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
    // Not just present — it has to actually say what the honest half of the
    // argument is, not a vague disclaimer.
    expect(text.toLowerCase()).toContain("reference player");
    expect(text.toLowerCase()).toContain("human");
  });

  it("shows a running status the moment equalising starts, not just at the end", async () => {
    await mountGame();
    tick();

    const button = document.querySelector<HTMLButtonElement>('[data-testid="equalise-button"]');
    const status = document.querySelector<HTMLElement>('[data-testid="equalise-status"]');
    if (!button || !status) throw new Error("equalise button or status element not found");

    expect(button.disabled).toBe(false);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // Before a single frame has ticked the search forward at all — this is
    // the state a real visitor sees the instant they click.
    expect(button.disabled).toBe(true);
    expect(status.textContent?.length).toBeGreaterThan(0);
  });
});

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

// Three panels each have their own health/speed/spawn slider, namespaced
// `enemy-${name}-${panel}` — panel 0 is active by default (see CLAUDE.md's
// "Three configurations" section), so panel 0 is what any test not
// specifically about panel-switching should read or drive.
function slider(name: "health" | "speed" | "spawn", panel = 0): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`[data-testid="enemy-${name}-${panel}"]`);
  if (!el) throw new Error(`[data-testid="enemy-${name}-${panel}"] not found`);
  return el;
}

// The opening screen is an overlay over an already-laid-out tool, so the app
// is fully mounted before this is pressed — see CLAUDE.md. Dismissing it here
// is setup, not an assertion: every test below is about the running tool, and
// a visitor reaches it the same way.
async function mountGame() {
  document.body.innerHTML = FIXTURE;
  vi.resetModules();
  await import("../main");
  document.querySelector<HTMLButtonElement>('[data-testid="start-button"]')?.click();
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

// Three defects found by playing the built site, none of which any existing
// check could see — see CLAUDE.md's run-lifecycle rule.
describe("the visitor controls the run", () => {
  it("lays the tool out underneath the opening screen rather than after it", async () => {
    document.body.innerHTML = FIXTURE;
    vi.resetModules();
    await import("../main");

    // Before any click: the geometry checks (canvas buffer, 44x44 targets)
    // measure real boxes, so a tool that only mounts on Start would make them
    // pass against nothing.
    expect(document.querySelector('[data-testid="game-canvas"]'), "canvas is not mounted behind the intro").toBeTruthy();
    expect(document.querySelectorAll('input[type="range"]').length, "sliders are not mounted behind the intro").toBe(9);
    expect(document.querySelector('[data-testid="start-button"]'), "no start control").toBeTruthy();
  });

  it("holds the run until the visitor starts it, so nobody begins on drained health", async () => {
    document.body.innerHTML = FIXTURE;
    vi.resetModules();
    await import("../main");
    tick();
    tick();

    expect(Number(gameState().dataset.elapsedMs), "the run was already going behind the intro").toBe(0);

    document.querySelector<HTMLButtonElement>('[data-testid="start-button"]')!.click();
    tick();
    tick();

    expect(Number(gameState().dataset.elapsedMs), "Start did not begin the run").toBeGreaterThan(0);
  });

  it("pauses and resumes, because changing a number mid-run is the point", async () => {
    await mountGame();
    tick();
    tick();
    const pause = document.querySelector<HTMLButtonElement>('[data-testid="pause-button"]');
    expect(pause, "no pause control").toBeTruthy();

    pause!.click();
    const frozen = Number(gameState().dataset.elapsedMs);
    tick();
    tick();
    expect(Number(gameState().dataset.elapsedMs), "time kept running while paused").toBe(frozen);

    pause!.click();
    tick();
    tick();
    expect(Number(gameState().dataset.elapsedMs), "resuming did not restart the clock").toBeGreaterThan(frozen);
  });

  it("says the run is over and offers a fresh one instead of freezing silently", async () => {
    await mountGame();
    tick();
    // Crowding the arena at the maximum spawn count ends the run quickly
    // rather than after a five-minute wait.
    const spawn = slider("spawn");
    spawn.value = spawn.max;
    spawn.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 400 && gameState().dataset.running === "true"; i++) tick(100);

    expect(gameState().dataset.running, "the run never ended").toBe("false");
    const over = document.querySelector<HTMLElement>('[data-testid="run-over"]');
    expect(over, "the page said nothing when the run ended").toBeTruthy();
    expect(over!.hidden, "the run-over message exists but is hidden").toBe(false);
    expect(over!.textContent?.length, "the run-over message is empty").toBeGreaterThan(0);

    const restart = document.querySelector<HTMLButtonElement>('[data-testid="restart-button"]');
    expect(restart, "no way to start a fresh run").toBeTruthy();
    expect(restart!.hidden, "the restart control exists but is hidden").toBe(false);
    restart!.click();
    tick();
    expect(gameState().dataset.running, "restart did not start a fresh run").toBe("true");
    expect(Number(gameState().dataset.elapsedMs)).toBeLessThan(1000);
  });
});

// Health is three hearts, not a hundred hit points — CLAUDE.md's health rule.
describe("three hearts", () => {
  it("starts a run with exactly three, shown as hearts rather than a number", async () => {
    await mountGame();
    tick();
    expect(Number(gameState().dataset.playerHearts), "hearts are not published in the mirror").toBe(3);
    const readout = document.querySelector('[data-testid="player-health"]');
    expect(readout?.textContent ?? "", "the readout still shows a hit-point number").toMatch(/♥|❤/);
  });

  it("costs whole hearts on contact, and grants immunity so one touch isn't three", async () => {
    await mountGame();
    tick();
    // The Easy preset as-is (one slow enemy at a time, median survival ~15s),
    // so the window has to be long enough for a first contact to happen at
    // all — the point here is that a sustained contact costs one heart per
    // immunity window, not one per frame.
    for (let i = 0; i < 3000 && Number(gameState().dataset.playerHearts) === 3; i++) tick(20);
    const afterFirst = Number(gameState().dataset.playerHearts);

    expect(afterFirst, "no heart was ever lost").toBeLessThan(3);
    // Immediately after a hit the player is immune, so the very next frames
    // must not take another one.
    tick(20);
    tick(20);
    expect(Number(gameState().dataset.playerHearts), "immunity frames did nothing — contact drained hearts per frame").toBe(
      afterFirst,
    );
  });

  it("ends the run once all three are gone, at the highest arrival rate", async () => {
    await mountGame();
    tick();
    const spawn = slider("spawn");
    spawn.value = spawn.max;
    spawn.dispatchEvent(new Event("input", { bubbles: true }));

    // Long enough for a crowd to close in even on the Easy step, whose
    // enemies are slower than the player and can be outrun indefinitely
    // one-on-one — being surrounded is what ends it, and that takes time.
    for (let i = 0; i < 6000 && gameState().dataset.running === "true"; i++) tick(20);

    expect(gameState().dataset.running, "the run never ended at the highest arrival rate").toBe("false");
    expect(Number(gameState().dataset.playerHearts)).toBe(0);
  });
});

// CLAUDE.md: the arena holds the play. Attention elsewhere means the run is
// not advancing, which is what makes changing a number mid-run the default
// rather than something the visitor has to remember to do.
describe("the arena holds the play", () => {
  function press(el: EventTarget) {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  }

  it("pauses when the visitor presses a slider, and resumes when they press the arena", async () => {
    await mountGame();
    tick();
    tick();
    const canvas = document.querySelector('[data-testid="game-canvas"]')!;

    press(slider("speed"));
    const frozen = Number(gameState().dataset.elapsedMs);
    tick();
    tick();
    expect(Number(gameState().dataset.elapsedMs), "the run kept going while a slider was being used").toBe(frozen);

    press(canvas);
    tick();
    tick();
    expect(Number(gameState().dataset.elapsedMs), "pressing the arena did not resume the run").toBeGreaterThan(frozen);
  });

  it("says how to resume rather than just freezing", async () => {
    await mountGame();
    tick();
    press(slider("speed"));
    tick();

    const hint = document.querySelector<HTMLElement>('[data-testid="paused-hint"]');
    expect(hint, "nothing tells the visitor why the arena stopped").toBeTruthy();
    expect(hint!.hidden, "the paused hint is hidden while paused").toBe(false);
    expect(hint!.textContent?.length).toBeGreaterThan(0);
  });

  it("does not pause on the controls that manage the run themselves", async () => {
    await mountGame();
    tick();
    const pause = document.querySelector<HTMLButtonElement>('[data-testid="pause-button"]')!;

    // Pause, then Resume via the button: if the document-level handler didn't
    // exempt it, the same click would pause again and Resume could never work.
    pause.click();
    press(pause);
    pause.click();
    const before = Number(gameState().dataset.elapsedMs);
    tick();
    tick();
    expect(Number(gameState().dataset.elapsedMs), "Resume was undone by its own click").toBeGreaterThan(before);
  });
});

describe("choosing a difficulty is a configuration action, not a play action", () => {
  it("starts the new step paused, so the visitor is not dropped mid-run", async () => {
    await mountGame();
    tick();
    tick();

    const hard = document.querySelector<HTMLInputElement>('[data-testid="panel-select-2"]')!;
    hard.checked = true;
    hard.dispatchEvent(new Event("change", { bubbles: true }));
    tick();
    tick();

    expect(gameState().dataset.activeConfig, "the panel did not become active").toBe("2");
    expect(Number(gameState().dataset.elapsedMs), "switching difficulty threw the visitor straight into a run").toBe(0);
    const hint = document.querySelector<HTMLElement>('[data-testid="paused-hint"]')!;
    expect(hint.hidden, "nothing invited the visitor to start the new run").toBe(false);
  });
});

describe("the finding is on the page before anyone presses anything", () => {
  it("states a recorded measurement, and says that is what it is", async () => {
    await mountGame();
    tick();

    const note = document.querySelector<HTMLElement>('[data-testid="baseline-note"]');
    expect(note, "a visitor who never presses the button never meets the argument").toBeTruthy();
    expect(note!.hidden).toBe(false);
    // Not passed off as live: a recorded number presented as a fresh one is
    // the same dishonesty as a censored median presented as a measurement.
    expect(note!.textContent, "the recorded numbers don't say they were recorded").toMatch(/recorded/i);
    expect(note!.textContent, "no sample size on the headline claim").toMatch(/51/);
  });

  it("hides the recorded numbers once a live measurement starts", async () => {
    await mountGame();
    tick();
    document.querySelector<HTMLButtonElement>('[data-testid="equalise-button"]')!.click();
    tick();

    expect(
      document.querySelector<HTMLElement>('[data-testid="baseline-note"]')!.hidden,
      "recorded and live numbers were on screen at the same time",
    ).toBe(true);
  });
});

// The live, rendered game. All simulation logic lives in ./sim (pure,
// DOM-free, headlessly runnable) and the equalisation search lives in
// ./measure (also pure, DOM-free) — this file is deliberately just DOM
// setup, canvas rendering, a requestAnimationFrame loop, and the chunked
// driver that runs the equalise search a little at a time per frame.
import {
  createInitialState,
  step,
  ENEMY_PURSUIT_SPEED_RATING,
  PLAYER_ATTACK_INTERVAL,
  PLAYER_ATTACK_RANGE,
  PLAYER_MAX_HEARTS,
  HEADLESS_MAX_MS,
  type DifficultyConfig,
  type Input,
} from "./sim";
import { measurePanels, FINAL_TRIALS, TOLERANCE_FRACTION, type AxisBounds, type MeasureProgress } from "./measure";
import type { Measurement } from "./sim";

const PLAYER_RADIUS = 0.02; // fraction of the canvas's shorter side
// Smaller than the player's dot: a crowd of these has to read as a crowd
// rather than as a wall of squares.
const ENEMY_RADIUS = 0.011;
// How small a nearly-dead enemy draws, as a fraction of ENEMY_RADIUS.
const ENEMY_MIN_RADIUS_FRACTION = 0.45;

// Slider bounds, shared with equalise.ts's search so a retuned config can
// never land outside what the UI can even represent.
const SLIDER_STEP = 5;
const BOUNDS: AxisBounds = {
  enemyHealth: { min: 10, max: 100, step: SLIDER_STEP },
  enemySpeed: { min: 0, max: 100, step: SLIDER_STEP },
  // One per tick to eight; whole enemies only, so this axis steps by 1.
  enemySpawnCount: { min: 1, max: 8, step: 1 },
};

// Three deliberately different archetypes, not three copies of the same dial
// position — see CLAUDE.md's "Three configurations" section for why. The
// speed values are deliberately split across ENEMY_PURSUIT_SPEED_RATING
// (sim.ts, = 60): swarm and hunter sit above it (their enemies CAN catch a
// fleeing player) with two different health/damage trade-offs from each
// other; tanks sits below it (its enemies CANNOT — see isCorneringRegime in
// measure.ts). That split is intentional, not incidental — it's what makes
// pressing "make these equally hard" produce one clean match and one honest,
// explained failure from a cold start, rather than three failures that would
// just read as a broken button. An earlier version of this third preset was
// `{ ...DEFAULT_DIFFICULTY }` labelled "Balanced" — enemySpeed 15, which put
// it on the SAME side of the threshold as tanks, so a first press could only
// ever fail twice. This preset replaces it on purpose.
// A designer's difficulty ladder, stepped the way difficulty ladders actually
// get built: evenly, on every dial at once. Health 20/50/80, speed 40/55/70,
// arrivals 1/2/3 — three tidy, equal increments. Whether that produces three
// equal increments of DIFFICULTY is the question the measure button answers,
// and the honest answer here is no (measured: ~25s, ~10.5s, ~7.8s — the
// second step is under half the size of the first). The presets are not rigged
// to make that point; they are what an even step looks like, and the point is
// what came out of measuring them.
const PANEL_PRESETS: readonly DifficultyConfig[] = [
  { enemyHealth: 15, enemySpeed: 30, enemySpawnCount: 1 },
  { enemyHealth: 40, enemySpeed: 45, enemySpawnCount: 2 },
  { enemyHealth: 65, enemySpeed: 60, enemySpawnCount: 3 },
];
const PANEL_LABELS = ["Easy", "Medium", "Hard"] as const;
const PANEL_BLURBS = [
  "Every dial at its low step: one enemy at a time, slower than you, dead in a single hit.",
  "Each dial up one step — tougher, quicker, two at a time.",
  "The same step again: three at a time, five hits each, and exactly as fast as you are.",
] as const;

// A measurement of the ladder as labelled, recorded ahead of time so the page
// can state its own finding before anyone presses anything. Without this, the
// argument only exists for a visitor who happens to press the button — and a
// reader who plays for thirty seconds and leaves would never meet it at all.
//
// Honest about what it is: these are recorded numbers, not a live run, and the
// page says so and says when. Measured across five independent seeds of 51
// runs each on 16 August 2026 against the default ladder — Easy 28.8 / 26.8 /
// 25.2 / 27.5 / 26.0, Medium 10.1 / 10.4 / 10.9 / 10.3 / 10.1, Hard 7.8 / 7.6
// / 7.7 / 7.8 / 7.8 — so the spread across seeds is roughly a second on Easy
// and a tenth on Hard, and the middle of each is quoted below. Pressing the
// button replaces all of it with a live run, which is the point.
// Drawn from 9-14s because a coarse scan of 150 configurations found survival
// times heavily concentrated there (55 of 124 uncapped configs land in 8-15s;
// five in 15-25s; one in 25-40s). A target outside that band would be a task
// the dials cannot complete — see CLAUDE.md.
const CHALLENGE_MIN_MS = 9000;
const CHALLENGE_MAX_MS = 14000;
const CHALLENGE_PANEL = 1; // Medium: retuned in place, so there is no fourth set of dials

const BASELINE = { easyMs: 26800, mediumMs: 10300, hardMs: 7800, seeds: 5, measuredOn: "16 August 2026" };

// TOLERANCE_FRACTION / FINAL_TRIALS / SEARCH_TRIALS / SEARCH_ITERATIONS all
// live in ./measure, next to the measurement they describe — see that file's
// comments for how each number was derived from this sim's own measured
// sampling noise, not guessed.

// This budget used to be decorative, and a comment right here used to claim
// otherwise. Through slice 5, job.gen.next() advanced a WHOLE
// medianSurvivalMs(trials=SEARCH_TRIALS) measurement per call — one
// uninterruptible unit that measured ~240ms, ~30x this budget — so
// tickEqualisation's `while (performance.now() < deadline)` loop could never
// fit a second one into a frame no matter what this constant said. Measured
// consequence at the time: ~4.2fps during a press (25 rAF frames over
// 5944ms) against ~60fps at rest — 4 canvas updates a second is a freeze, not
// a dip, and "must not freeze the page" was a stated requirement this failed.
//
// Fix: measure.ts's generators now
// yield once per individual simulated trial (one runHeadless call) instead of
// once per whole batch, and measurePanels chunks all of the flow's
// measurements this way — the search's own bisection probes, but also the
// reference-target measurement and the post-search FINAL_TRIALS re-verify,
// which were two more synchronous, unchunked medianSurvivalMs calls the old
// comment didn't mention because it only chased the one instance named at
// the time. "Must not freeze" is unconditional, so all three needed it.
//
// Measured again, same method, same machine, after that change (Playwright,
// both panels retuned from the default Swarm-active state): 5840ms
// wall-clock — essentially unchanged from the old 5944ms, not the ~2x
// slower this was expected to land at from per-trial overhead — at 34.6fps
// during the press (202 rAF frames), against 120fps measured at rest in this
// same environment. Instrumented gen.next() calls directly (595 total calls
// across 193 job-active frames, avg 3.08/frame, 62 frames ran more than one,
// max 68 in one frame) to confirm the budget is actually doing the gating
// this constant's name claims — some frames run one trial, some run dozens,
// which is the mechanism, not an inference from the fps number alone. Total
// simulated work is unchanged (~600 trials either way); what changed is that
// it's now spent in pieces small enough for this budget to slice, instead of
// in one piece too big for any budget to matter.
//
// Considered and rejected: moving the search onto a Web Worker.
// sim.ts/equalise.ts are already pure and DOM-free, so it would drop in
// almost for free, and it would give both 60fps AND the original ~6s (no
// main-thread chunking overhead at all, since none would be needed). Turned
// down not because it wouldn't work, but because Vite's worker bundling is a
// new failure surface in CI, and the remaining time before the deadline is
// going to a visual pass and the process write-up rather than a second
// bundling pipeline. Worth revisiting if a future week needs the fps back.
const FRAME_BUDGET_MS = 8;

// The HUD clock is m:ss, but a measurement readout at that resolution rounds a
// 1.6-second gap to "0:01" and makes a real difference look like noise. Results
// get their own format.
function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const app = document.querySelector<HTMLElement>("#app");

if (app) {
  // Beat one (CLAUDE.md): a full-height opening screen, built as an overlay
  // over a tool that is already laid out underneath it. Not a separate page,
  // and not a tool that mounts on click — check-viewports.ts measures the
  // canvas's pixel buffer against its rendered box and check-a11y.ts measures
  // 44x44 targets, and both would pass vacuously against elements that don't
  // have boxes yet.
  const intro = document.createElement("section");
  intro.className = "intro";
  intro.dataset.testid = "intro";
  intro.setAttribute("aria-label", "Introduction");

  const introKicker = document.createElement("p");
  introKicker.className = "intro-kicker";
  introKicker.textContent = "Interactive explainer";

  const introTitle = document.createElement("h2");
  introTitle.textContent = "You balance it then.";

  // The title is a retort, and a retort needs the thing it is answering on
  // screen or it reads as a slogan. One line, directly under it.
  const introDek = document.createElement("p");
  introDek.className = "intro-dek";
  introDek.dataset.testid = "intro-dek";
  introDek.textContent = "— what you end up wanting to say to everyone who blames the game's balance designer.";

  // Where the idea came from, in the author's own words — before what the
  // thing is. A visitor who doesn't know why it exists has no reason to care
  // what it measures.
  const introOrigin = document.createElement("p");
  introOrigin.className = "intro-lede";
  introOrigin.dataset.testid = "intro-origin";
  introOrigin.textContent =
    "Lose enough fights and the reflex is to blame whoever picked the numbers. But balancing those numbers against what different players each want out of a game is genuinely hard, and nothing on a designer's screen tells them whether they got it right. So here are the numbers, and a way to test them yourself.";

  const introLede = document.createElement("p");
  introLede.className = "intro-lede";
  introLede.textContent =
    "Easy, Medium, Hard. Three steps of a difficulty ladder, and every dial stepped evenly to build it — the way difficulty ladders actually get made. Play all three, then measure them, and see whether even steps in the numbers buy even steps in difficulty.";

  const introCards = document.createElement("ul");
  introCards.className = "intro-cards";
  for (let i = 0; i < 3; i++) {
    const card = document.createElement("li");
    const name = document.createElement("b");
    name.textContent = PANEL_LABELS[i];
    const blurb = document.createElement("span");
    blurb.className = "intro-card-note";
    blurb.textContent = PANEL_BLURBS[i];
    card.append(name, blurb);
    introCards.append(card);
  }

  const startBtn = document.createElement("button");
  startBtn.type = "button";
  startBtn.className = "equalise-button start-button";
  startBtn.dataset.testid = "start-button";
  startBtn.textContent = "Start";

  const introHint = document.createElement("p");
  introHint.className = "intro-hint";
  introHint.textContent = "Arrow keys or WASD to move. You attack automatically — anything inside your ring takes damage. Three hearts; one touch costs one.";

  const introActions = document.createElement("div");
  introActions.className = "intro-actions";
  introActions.append(startBtn, introHint);

  intro.append(introKicker, introTitle, introDek, introOrigin, introLede, introCards, introActions);
  app.append(intro);

  // Canvas and its paused hint share one grid cell. They were two separate
  // children of #app, so the hint appearing consumed a cell of its own and
  // auto-placement pushed the whole right-hand column down a row every time
  // the run paused.
  const arena = document.createElement("div");
  arena.className = "arena";

  const canvas = document.createElement("canvas");
  canvas.dataset.testid = "game-canvas";
  canvas.setAttribute("aria-hidden", "true");
  arena.append(canvas);
  app.append(arena);

  // A frozen rectangle with no explanation reads as a crash, and with
  // press-to-play the arena spends a lot of its life frozen on purpose.
  const pausedHint = document.createElement("p");
  pausedHint.className = "paused-hint";
  pausedHint.dataset.testid = "paused-hint";
  pausedHint.textContent = "Paused — click the arena to play.";
  pausedHint.hidden = true;
  arena.append(pausedHint);

  const mirror = document.createElement("div");
  mirror.dataset.testid = "game-state";
  mirror.hidden = true;
  app.append(mirror);

  const panel = document.createElement("section");
  panel.setAttribute("aria-label", "Difficulty");

  const hud = document.createElement("div");
  hud.className = "hud";
  const timerEl = document.createElement("span");
  timerEl.dataset.testid = "survival-timer";
  timerEl.className = "tabular";
  const healthEl = document.createElement("span");
  healthEl.dataset.testid = "player-health";
  healthEl.className = "tabular";
  const enemyCountEl = document.createElement("span");
  enemyCountEl.dataset.testid = "enemy-count";
  enemyCountEl.className = "tabular";

  // Wanting to change a number halfway through a run is the activity this tool
  // exists for, not an edge case — CLAUDE.md's run-lifecycle rule. Paused
  // lives here and never reaches sim.ts, so the headless search can't see it.
  const pauseBtn = document.createElement("button");
  pauseBtn.type = "button";
  pauseBtn.className = "run-control";
  pauseBtn.dataset.testid = "pause-button";
  pauseBtn.textContent = "Pause";

  hud.append(timerEl, healthEl, enemyCountEl, pauseBtn);
  panel.append(hud);

  // sim.ts stops the run at zero health, but the page said nothing and offered
  // no way back, so it simply froze — the defect was silence, not a clock that
  // failed to stop.
  const runOver = document.createElement("p");
  runOver.className = "run-over";
  runOver.dataset.testid = "run-over";
  runOver.hidden = true;
  const restartBtn = document.createElement("button");
  restartBtn.type = "button";
  restartBtn.className = "run-control";
  restartBtn.dataset.testid = "restart-button";
  restartBtn.textContent = "Run it again";
  panel.append(runOver, restartBtn);
  restartBtn.hidden = true;

  // Three live config objects (mutable copies of the presets — equalising or
  // dragging a slider mutates these directly). sim's step() reads whichever
  // one is currently active, fresh every frame, so a change takes effect
  // immediately for the active panel — no restart, no second copy of "the
  // current difficulty" to keep in sync.
  const configs: DifficultyConfig[] = PANEL_PRESETS.map((preset) => ({ ...preset }));
  let activeIndex = 0;

  // Per-panel [health, speed, damage] slider inputs and their value readouts,
  // so equalising a panel can push its new numbers back into the UI.
  const sliderInputs: HTMLInputElement[][] = [[], [], []];
  const sliderValues: HTMLSpanElement[][] = [[], [], []];
  const panelStatusEls: HTMLElement[] = [];
  const panelRadios: HTMLInputElement[] = [];

  const configPanels = document.createElement("div");
  configPanels.className = "config-panels";

  function refreshSliderUI(panelIndex: number): void {
    const keys: (keyof DifficultyConfig)[] = ["enemyHealth", "enemySpeed", "enemySpawnCount"];
    keys.forEach((key, axisIndex) => {
      const value = configs[panelIndex][key];
      sliderInputs[panelIndex][axisIndex].value = String(value);
      sliderValues[panelIndex][axisIndex].textContent = String(value);
    });
  }

  function setActivePanel(index: number): void {
    if (index === activeIndex) return;
    activeIndex = index;
    // Comparing how a configuration feels is only honest from the same
    // starting point every time, so switching panels starts a fresh run
    // rather than swapping the config under a run already in progress.
    // Switching steps starts a fresh run, so it has to clear a finished one's
    // message too — otherwise "Hard killed you at 0:07" sits over an Easy run
    // that just began. Paused, because choosing a difficulty is not the same
    // as asking to play it. beginRun also resets lastFrameTime, without which
    // loop()'s next dt is measured against the pre-switch timestamp.
    beginRun({ startPaused: true });
    panelRadios.forEach((radio, i) => (radio.checked = i === activeIndex));
  }

  function addSlider(
    panelIndex: number,
    axisIndex: number,
    key: keyof DifficultyConfig,
    testid: string,
    label: string,
    min: number,
    max: number,
    stepSize: number,
  ): void {
    const row = document.createElement("label");
    row.className = "slider-row";
    // Drives styles.css's per-stat colour (health/speed/damage), so the same
    // three colours mean the same thing in every one of the nine sliders —
    // see CLAUDE.md's "three sliders get three distinguishable colours,
    // reused everywhere" rule.
    row.dataset.stat = key === "enemyHealth" ? "health" : key === "enemySpeed" ? "speed" : "spawn";

    const name = document.createElement("span");
    name.textContent = label;

    const input = document.createElement("input");
    input.type = "range";
    input.dataset.testid = testid;
    input.min = String(min);
    input.max = String(max);
    input.step = String(stepSize);
    input.value = String(configs[panelIndex][key]);

    const value = document.createElement("span");
    value.className = "tabular slider-value";
    value.textContent = input.value;

    input.addEventListener("input", () => {
      configs[panelIndex][key] = Number(input.value);
      value.textContent = input.value;
    });

    sliderInputs[panelIndex][axisIndex] = input;
    sliderValues[panelIndex][axisIndex] = value;

    row.append(name, input, value);
    sliderRows[panelIndex].push(row);
  }

  const sliderRows: HTMLLabelElement[][] = [[], [], []];

  for (let p = 0; p < 3; p++) {
    addSlider(p, 0, "enemyHealth", `enemy-health-${p}`, "Enemy health", BOUNDS.enemyHealth.min, BOUNDS.enemyHealth.max, 5);
    addSlider(p, 1, "enemySpeed", `enemy-speed-${p}`, "Enemy speed", BOUNDS.enemySpeed.min, BOUNDS.enemySpeed.max, 5);
    addSlider(p, 2, "enemySpawnCount", `enemy-spawn-${p}`, "Arriving at once", BOUNDS.enemySpawnCount.min, BOUNDS.enemySpawnCount.max, 1);

    const configSection = document.createElement("fieldset");
    configSection.className = "config-panel";

    const legend = document.createElement("legend");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "active-panel";
    radio.checked = p === activeIndex;
    radio.dataset.testid = `panel-select-${p}`;
    radio.addEventListener("change", () => setActivePanel(p));
    panelRadios.push(radio);

    const legendText = document.createElement("span");
    legendText.textContent = ` ${PANEL_LABELS[p]}`;
    legend.append(radio, legendText);
    configSection.append(legend);

    // "Swarm", "Tanks" and "Hunter" are trade jargon, and the page defined
    // none of them. That's fatal rather than untidy: "these three feel nothing
    // alike" is the premise the whole argument rests on, so if it doesn't land
    // the payoff reads as "three slider sets are roughly similar, obviously".
    // Each line is derived from the constants, not invented — the player has
    // 100 HP, moves 0.6 arena-fractions/sec, and auto-attacks every 0.4s for
    // 20 damage.
    const blurb = document.createElement("p");
    blurb.className = "panel-blurb";
    blurb.dataset.testid = `panel-blurb-${p}`;
    blurb.textContent = PANEL_BLURBS[p];
    configSection.append(blurb);

    const sliderGroup = document.createElement("div");
    sliderGroup.className = "sliders";
    sliderGroup.append(...sliderRows[p]);
    configSection.append(sliderGroup);

    const statusEl = document.createElement("p");
    statusEl.className = "panel-status";
    statusEl.dataset.testid = `panel-status-${p}`;
    panelStatusEls.push(statusEl);
    configSection.append(statusEl);

    configPanels.append(configSection);
  }

  panel.append(configPanels);

  // Beat three of the reading order (CLAUDE.md): pose the question the button
  // answers, immediately above the button, so pressing it is a reply rather
  // than a poke at an unexplained control.
  const prompt = document.createElement("p");
  prompt.className = "equalise-prompt";
  prompt.dataset.testid = "equalise-prompt";
  prompt.textContent =
    `Three steps of a difficulty ladder, stepped evenly on every dial. Play them, then measure: each step is simulated ${FINAL_TRIALS} times over and the median survival is reported, because one run tells you almost nothing about a distribution. Then see whether even steps in the numbers buy even steps in difficulty.`;
  panel.append(prompt);

  const equaliseBtn = document.createElement("button");
  equaliseBtn.type = "button";
  equaliseBtn.className = "equalise-button";
  equaliseBtn.dataset.testid = "equalise-button";
  equaliseBtn.textContent = "Measure these three";
  panel.append(equaliseBtn);

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "run-control";
  resetBtn.dataset.testid = "reset-button";
  resetBtn.textContent = "Reset to the labelled ladder";
  panel.append(resetBtn);

  const baselineNote = document.createElement("p");
  baselineNote.className = "baseline-note";
  baselineNote.dataset.testid = "baseline-note";
  baselineNote.textContent =
    `Recorded earlier, on this ladder as labelled: Easy ${formatSeconds(BASELINE.easyMs)} · ` +
    `Medium ${formatSeconds(BASELINE.mediumMs)} · Hard ${formatSeconds(BASELINE.hardMs)}. ` +
    `Easy→Medium costs ${formatSeconds(BASELINE.easyMs - BASELINE.mediumMs)} of survival; Medium→Hard only ` +
    `${formatSeconds(BASELINE.mediumMs - BASELINE.hardMs)}. Evenly spaced numbers, unevenly spaced difficulty. ` +
    `(${BASELINE.seeds} independent runs of ${FINAL_TRIALS} simulations each, ${BASELINE.measuredOn} — press the button to measure it live.)`;
  panel.append(baselineNote);

  // Stage two lives in the arena column, under the canvas, where there was
  // nothing but empty space at 1920x1080.
  const challengeBtn = document.createElement("button");
  challengeBtn.type = "button";
  challengeBtn.className = "run-control challenge-button";
  challengeBtn.dataset.testid = "challenge-button";
  challengeBtn.textContent = "Now you try →";
  challengeBtn.disabled = true;
  challengeBtn.title = "Play a run first";
  arena.append(challengeBtn);

  const challenge = document.createElement("section");
  challenge.className = "challenge";
  challenge.dataset.testid = "challenge";
  challenge.hidden = true;
  challenge.setAttribute("aria-label", "Hit a target survival time");

  const challengeIntro = document.createElement("p");
  challengeIntro.className = "challenge-intro";
  challengeIntro.textContent =
    "Your turn. Move the three dials until a reference player survives this long, then test it. You can play your attempt first — the arena is still live.";

  const challengeTarget = document.createElement("p");
  challengeTarget.className = "challenge-target";
  challengeTarget.dataset.testid = "challenge-target";

  const testBtn = document.createElement("button");
  testBtn.type = "button";
  testBtn.className = "equalise-button";
  testBtn.dataset.testid = "test-answer-button";
  testBtn.textContent = "Test my answer";

  const challengeVerdict = document.createElement("p");
  challengeVerdict.className = "challenge-verdict";
  challengeVerdict.dataset.testid = "challenge-verdict";
  challengeVerdict.setAttribute("aria-live", "polite");

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "run-control";
  backBtn.dataset.testid = "back-button";
  backBtn.textContent = "← Back to the ladder";

  challenge.append(challengeIntro, challengeTarget, testBtn, challengeVerdict, backBtn);
  panel.append(challenge);

  const equaliseStatus = document.createElement("p");
  equaliseStatus.dataset.testid = "equalise-status";
  equaliseStatus.setAttribute("aria-live", "polite");
  panel.append(equaliseStatus);

  const limitation = document.createElement("p");
  limitation.className = "equalise-limitation";
  limitation.dataset.testid = "equalise-limitation";
  limitation.textContent =
    "These times are how long one fixed scripted reference player survives — it flees the nearest enemy once that enemy gets close, and otherwise holds still. It is not a human, and it is not you. A real person reads the whole arena and plays the gaps, so a ladder that measures evenly against this policy is not thereby even for a person, and one that measures unevenly may still feel fine. The measurement is a second opinion, not a verdict.";
  panel.append(limitation);

  app.append(panel);

  const ctx = canvas.getContext("2d"); // null under jsdom (no `canvas` package) — render() guards it

  let state = createInitialState();

  // WASD is an addition, never a replacement: the arrows are held in place by
  // the brief's checkable line, the test derived from it, and CLAUDE.md's
  // accessibility rule.
  const MOVEMENT_KEYS: Readonly<Record<string, Input>> = {
    ArrowLeft: { x: -1, y: 0 },
    KeyA: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
    KeyD: { x: 1, y: 0 },
    ArrowUp: { x: 0, y: -1 },
    KeyW: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
    KeyS: { x: 0, y: 1 },
  };

  // CLAUDE.md: a key event is attributed to an owner before it is acted on.
  // With focus inside a form control the key belongs to that control — the
  // difficulty sliders have to stay arrow-adjustable, and the radios have to
  // keep their native arrow-key group navigation — so the game neither
  // consumes it nor preventDefaults it.
  function ownedByAControl(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest("input, select, textarea, button, [contenteditable]") !== null;
  }

  // Relative touch-drag (CLAUDE.md): the first touch point becomes the origin
  // and the drag from it is a direction. Relative rather than absolute
  // positioning, so the visitor's finger never covers the thing they are
  // supposed to be watching.
  //
  // Direction only, not magnitude. CLAUDE.md originally said "proportional to
  // drag distance", but movePlayer normalises its input to a unit direction
  // and moves at PLAYER_SPEED — magnitude is discarded in the simulation, and
  // making it matter would change every survival time this repo has measured.
  // The rule is amended there rather than half-honoured here.
  type TouchPoint = { clientX: number; clientY: number };
  type TouchLikeEvent = Event & { touches?: ArrayLike<TouchPoint> };
  const TOUCH_DEAD_ZONE_PX = 8;
  let touchOrigin: TouchPoint | null = null;
  let touchInput: Input = { x: 0, y: 0 };

  function firstTouch(e: TouchLikeEvent): TouchPoint | null {
    const list = e.touches;
    return list && list.length > 0 ? list[0] : null;
  }

  canvas.addEventListener("touchstart", (e: Event) => {
    const point = firstTouch(e as TouchLikeEvent);
    if (!point) return;
    touchOrigin = { clientX: point.clientX, clientY: point.clientY };
    touchInput = { x: 0, y: 0 };
    // Without this the page scrolls under the arena on the first drag, the
    // same defect the arrow keys had.
    e.preventDefault();
    if (state.running && intro.hidden) setPaused(false);
  });

  canvas.addEventListener("touchmove", (e: Event) => {
    const point = firstTouch(e as TouchLikeEvent);
    if (!point || !touchOrigin) return;
    e.preventDefault();
    const dx = point.clientX - touchOrigin.clientX;
    const dy = point.clientY - touchOrigin.clientY;
    // A dead zone, or resting a thumb steers the player.
    touchInput = Math.hypot(dx, dy) < TOUCH_DEAD_ZONE_PX ? { x: 0, y: 0 } : { x: dx, y: dy };
  });

  function endTouch(): void {
    touchOrigin = null;
    touchInput = { x: 0, y: 0 };
  }
  canvas.addEventListener("touchend", endTouch);
  canvas.addEventListener("touchcancel", endTouch);

  const pressed = new Set<string>();
  window.addEventListener("keydown", (e) => {
    if (!(e.code in MOVEMENT_KEYS) || ownedByAControl(e.target)) return;
    pressed.add(e.code);
    // Without this the browser scrolls the page out from under the arena while
    // the visitor is playing — measured at 420px in a real browser.
    e.preventDefault();
  });
  window.addEventListener("keyup", (e) => pressed.delete(e.code));

  function keyboardInput(): Input {
    let x = touchInput.x;
    let y = touchInput.y;
    for (const code of pressed) {
      const delta = MOVEMENT_KEYS[code];
      if (delta) {
        x += delta.x;
        y += delta.y;
      }
    }
    return { x, y };
  }

  // The pixel buffer is sized in device pixels (rect * devicePixelRatio) so
  // the canvas doesn't render blurry on a high-DPI screen — the exact phone
  // viewport this ships to is emulated at deviceScaleFactor 3. render() below
  // keeps drawing in CSS-pixel coordinates (cssWidth/cssHeight, not
  // canvas.width/height); the transform set here maps those to the buffer.
  // sim.ts stays untouched — DPR is a rendering concern, not a simulated one.
  let cssWidth = 0;
  let cssHeight = 0;

  function resizeCanvas(): void {
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const dpr = window.devicePixelRatio || 1;
      cssWidth = rect.width;
      cssHeight = rect.height;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  // The whole loop was invisible: enemies drifted in and vanished, with no
  // sign the player had a weapon at all. That makes "Enemy health" — one of
  // the three dials the argument rests on — meaningless to a visitor, so the
  // mechanic has to be legible before any of the difficulty claim can land.
  //
  // All of it is derived from public simulation state. Hit resolution is
  // instant and radius-based inside sim.ts; the beams below are hitscan
  // tracers, the accurate visual for an instant-resolution weapon (this is
  // what shipped games draw for hitscan guns), not a re-implementation of the
  // attack as travelling projectiles. Real projectiles would change the
  // simulation, and every measured number in the equalise search — the
  // tolerance, the determinism of equalise.test.ts, every achieved survival
  // figure — was calibrated against the mechanic that actually exists. The
  // Tanks non-convergence finding would survive that (it turns on player
  // speed versus enemy speed, not on how the attack works) but its numbers
  // would not. Not a trade worth making for a visual available for free.
  type Tracer = { x: number; y: number; born: number };
  let tracers: Tracer[] = [];
  const TRACER_LIFETIME_MS = 140;

  // Captured *before* step() runs, because an enemy killed by this tick is
  // filtered out of state.enemies by the time render() sees it — and the
  // one-hit Swarm kill is exactly the case most worth showing.
  function captureTracers(dt: number, now: number): void {
    if (state.attackCooldown - dt > 0) return;
    for (const enemy of state.enemies) {
      const dist = Math.hypot(enemy.x - state.player.x, enemy.y - state.player.y);
      if (dist <= PLAYER_ATTACK_RANGE) tracers.push({ x: enemy.x, y: enemy.y, born: now });
    }
  }

  function render(now: number): void {
    if (!ctx || cssWidth === 0 || cssHeight === 0) return;
    const side = Math.min(cssWidth, cssHeight);
    const px = state.player.x * cssWidth;
    const py = state.player.y * cssHeight;
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Instrument HUD (CLAUDE.md): the arena is a sensor display, not a
    // playfield. Cyan is measurement, red is what hurts you, and nothing here
    // is drawn that doesn't carry information.
    const CYAN = "34 211 238";
    const RED = "255 107 131";

    // A graticule, so distance in the arena is readable rather than merely
    // felt — the same reason the rest of the page reports numbers.
    ctx.strokeStyle = `rgb(${CYAN} / 6%)`;
    ctx.lineWidth = 1;
    const cell = side * 0.1;
    ctx.beginPath();
    for (let gx = cell; gx < cssWidth; gx += cell) {
      ctx.moveTo(Math.round(gx) + 0.5, 0);
      ctx.lineTo(Math.round(gx) + 0.5, cssHeight);
    }
    for (let gy = cell; gy < cssHeight; gy += cell) {
      ctx.moveTo(0, Math.round(gy) + 0.5);
      ctx.lineTo(cssWidth, Math.round(gy) + 0.5);
    }
    ctx.stroke();

    // The attack range (0.12) against the enemy contact radius (0.03) is the
    // game: an enemy has to survive this ring to reach the middle of it.
    // Dashed and slowly rotating on the attack beat, like a sweep.
    const attackPhase = 1 - Math.min(1, state.attackCooldown / PLAYER_ATTACK_INTERVAL);
    const ringRadius = PLAYER_ATTACK_RANGE * side;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(attackPhase * Math.PI * 0.5);
    ctx.strokeStyle = `rgb(${CYAN} / ${30 + 35 * attackPhase}%)`;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.strokeStyle = `rgb(${CYAN} / ${8 + 10 * attackPhase}%)`;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(px, py, ringRadius, 0, Math.PI * 2);
    ctx.stroke();

    tracers = tracers.filter((t) => now - t.born < TRACER_LIFETIME_MS);
    for (const tracer of tracers) {
      const life = 1 - (now - tracer.born) / TRACER_LIFETIME_MS;
      ctx.strokeStyle = `rgb(${CYAN} / ${Math.round(life * 90)}%)`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(tracer.x * cssWidth, tracer.y * cssHeight);
      ctx.stroke();
    }

    // Enemies are wireframe diamonds in the warning colour, and their outline
    // breaks to a dash as they take damage — shape and line quality, not just
    // brightness, so a damaged one reads without relying on a value
    // difference. A 65-health Hard enemy soaking five hits looks nothing like
    // an Easy one dying to a single one.
    const config = configs[activeIndex];
    for (const enemy of state.enemies) {
      const life = Math.max(0, Math.min(1, enemy.health / Math.max(1, config.enemyHealth)));
      const r = ENEMY_RADIUS * (ENEMY_MIN_RADIUS_FRACTION + (1 - ENEMY_MIN_RADIUS_FRACTION) * life) * side;
      const ex = enemy.x * cssWidth;
      const ey = enemy.y * cssHeight;
      ctx.strokeStyle = `rgb(${RED} / ${Math.round(55 + 45 * life)}%)`;
      ctx.lineWidth = 1.4;
      ctx.setLineDash(life < 0.7 ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(ex, ey - r);
      ctx.lineTo(ex + r, ey);
      ctx.lineTo(ex, ey + r);
      ctx.lineTo(ex - r, ey);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The player is a reticle: crosshair plus ring, the thing an instrument
    // draws around what it is tracking. Pulses while immune — two seconds of
    // invulnerability, unmarked, reads as a hit that never registered.
    const immune = state.invulnerableFor > 0;
    ctx.globalAlpha = immune ? 0.4 + 0.4 * Math.abs(Math.sin(now / 220)) : 1;
    const pr = PLAYER_RADIUS * side;
    ctx.strokeStyle = "#d6fbff";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(px, py - pr * 2.1);
    ctx.lineTo(px, py - pr * 0.9);
    ctx.moveTo(px, py + pr * 0.9);
    ctx.lineTo(px, py + pr * 2.1);
    ctx.moveTo(px - pr * 2.1, py);
    ctx.lineTo(px - pr * 0.9, py);
    ctx.moveTo(px + pr * 0.9, py);
    ctx.lineTo(px + pr * 2.1, py);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = `rgb(${CYAN})`;
    ctx.beginPath();
    ctx.arc(px, py, pr * 0.32, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // --- Equalisation: chunked across frames, see FRAME_BUDGET_MS above. ---

  // The panels are a labelled ladder now, not three shapes to equalise, so the
  // button measures what the labels already claim instead of searching for a
  // multiplier. See equalise.ts's measurePanels.
  type MeasureJob = {
    gen: Generator<MeasureProgress, Map<number, Measurement>, void>;
    currentPanel: number | null;
    trialsThisPhase: number;
  };
  let measureJob: MeasureJob | null = null;
  const ALL_PANELS = [0, 1, 2];

  // --- Stage two ---------------------------------------------------------
  let hasPlayed = false;
  let targetMs = 0;
  let attemptJob: { gen: Generator<MeasureProgress, Map<number, Measurement>, void>; trials: number } | null = null;

  function unlockChallenge(): void {
    if (hasPlayed) return;
    hasPlayed = true;
    challengeBtn.disabled = false;
    challengeBtn.title = "";
  }

  // Ladder-stage furniture, hidden while stage two is up: the challenge is
  // about one configuration, and three panels plus a baseline reading is the
  // demonstration the visitor has just finished.
  function setStage(stage: "explore" | "challenge"): void {
    const inChallenge = stage === "challenge";
    challenge.hidden = !inChallenge;
    challengeBtn.hidden = inChallenge;
    prompt.hidden = inChallenge;
    equaliseBtn.hidden = inChallenge;
    resetBtn.hidden = inChallenge;
    baselineNote.hidden = inChallenge || baselineNote.dataset.spent === "true";
    equaliseStatus.hidden = inChallenge;
    ALL_PANELS.forEach((i) => {
      configPanels.children[i].toggleAttribute("hidden", inChallenge && i !== CHALLENGE_PANEL);
    });
    if (inChallenge) {
      targetMs = CHALLENGE_MIN_MS + Math.round((Math.random() * (CHALLENGE_MAX_MS - CHALLENGE_MIN_MS)) / 500) * 500;
      challengeTarget.dataset.targetMs = String(targetMs);
      challengeTarget.textContent = `Target: ${formatSeconds(targetMs)} of survival.`;
      challengeVerdict.textContent = "";
      delete challengeVerdict.dataset.hit;
      setActivePanel(CHALLENGE_PANEL);
      panelRadios[CHALLENGE_PANEL].checked = true;
    }
  }

  challengeBtn.addEventListener("click", () => setStage("challenge"));
  backBtn.addEventListener("click", () => setStage("explore"));

  testBtn.addEventListener("click", () => {
    if (attemptJob) return;
    attemptJob = { gen: measurePanels([CHALLENGE_PANEL], (i: number) => configs[i], Math.random), trials: 0 };
    testBtn.disabled = true;
    challengeVerdict.textContent = "Measuring…";
  });

  function tickAttempt(): void {
    if (!attemptJob) return;
    const job = attemptJob;
    const deadline = performance.now() + FRAME_BUDGET_MS;
    while (performance.now() < deadline) {
      const result = job.gen.next();
      if (result.done) {
        attemptJob = null;
        testBtn.disabled = false;
        const m = result.value.get(CHALLENGE_PANEL)!;
        // Same 9% this repo already derived from its own sampling noise — a
        // freshly invented threshold would be a number with no provenance
        // sitting in judgement over someone's answer.
        const hit = !m.censored && Math.abs(m.medianMs - targetMs) <= targetMs * TOLERANCE_FRACTION;
        challengeVerdict.dataset.achievedMs = String(m.medianMs);
        challengeVerdict.dataset.hit = String(hit);
        const gap = m.medianMs - targetMs;
        const direction = gap > 0 ? "too easy" : "too hard";
        challengeVerdict.textContent = m.censored
          ? `${describeMeasurement(m)} — nothing resolved inside the time limit, so there is no number to compare yet.`
          : hit
            ? `${describeMeasurement(m)} — inside the ${Math.round(TOLERANCE_FRACTION * 100)}% the measurement itself can resolve. You hit it.`
            : `${describeMeasurement(m)} — ${formatSeconds(Math.abs(gap))} ${direction}, ${Math.round((Math.abs(gap) / targetMs) * 100)}% off.`;
        return;
      }
      if (result.value.kind === "trial") {
        job.trials++;
        challengeVerdict.textContent = `Measuring… (${job.trials} runs)`;
      }
    }
  }

  // A median that reached the headless cap is a floor, not a survival time, and
  // saying "300.0s" would be the exact species of unearned number this whole
  // prototype argues against. Trials that were cut off get reported even when
  // the median itself is sound, because "a fifth of the runs never resolved"
  // is something a designer needs to know about a configuration.
  // Says the trial count on every reported line, not just once above the
  // button: the difference between "I played it and it felt about right" and
  // a measurement is the sample size, and that is the claim the whole page
  // rests on.
  function describeMeasurement(m: Measurement): string {
    const value = m.censored ? `at least ${formatSeconds(m.medianMs)} — runs were cut off` : formatSeconds(m.medianMs);
    const cut = m.cappedTrials > 0 && !m.censored ? ` (${m.cappedTrials} of ${m.trials} runs hit the time limit)` : "";
    return `median of ${m.trials} runs: ${value}${cut}`;
  }

  function reportLadder(results: Map<number, Measurement>): void {
    const measured = ALL_PANELS.map((i) => results.get(i)!);
    const ms = measured.map((m) => m.medianMs);
    ALL_PANELS.forEach((i) => {
      panelStatusEls[i].textContent = describeMeasurement(measured[i]);
    });
    if (measured.some((m) => m.censored)) {
      // Comparing gaps between a real number and a floor would produce a gap
      // that is itself only a floor, presented as if it were measured.
      const shown = measured.map((m) => (m.censored ? `≥${formatSeconds(m.medianMs)}` : formatSeconds(m.medianMs)));
      equaliseStatus.textContent =
        `Easy ${shown[0]} · Medium ${shown[1]} · Hard ${shown[2]}. ` +
        `At least one step ran past the ${formatSeconds(HEADLESS_MAX_MS)} limit without resolving, so its number is a floor rather than a measurement — the step sizes below it can't be compared honestly until it does.`;
      return;
    }
    // The claim under test is not "is Hard harder than Easy" — it plainly is.
    // It's whether three evenly-stepped dial positions buy three evenly-sized
    // steps of difficulty. Reported as the two gaps, because that is the thing
    // the labels quietly promise and the thing nobody can read off a slider.
    const firstGap = ms[0] - ms[1];
    const secondGap = ms[1] - ms[2];
    const ratio = secondGap === 0 ? Infinity : firstGap / secondGap;
    const evenness =
      !isFinite(ratio) || ratio > 1.35 || ratio < 0.74
        ? `The steps are not the same size: Easy→Medium costs ${formatSeconds(Math.abs(firstGap))} of survival, ` +
          `Medium→Hard only ${formatSeconds(Math.abs(secondGap))}. Evenly spaced numbers, unevenly spaced difficulty.`
        : `The two steps came out within a third of each other this time — on these numbers the ladder is roughly even.`;
    equaliseStatus.textContent =
      `Easy ${formatSeconds(ms[0])} · Medium ${formatSeconds(ms[1])} · Hard ${formatSeconds(ms[2])}. ${evenness}`;
  }

  equaliseBtn.addEventListener("click", () => {
    if (measureJob) return;
    measureJob = { gen: measurePanels(ALL_PANELS, (i: number) => configs[i], Math.random), currentPanel: null, trialsThisPhase: 0 };
    equaliseBtn.disabled = true;
    // The recorded figures stop being the page's headline the moment a live
    // measurement starts — two sets of numbers side by side is how a reader
    // ends up quoting the wrong one.
    baselineNote.hidden = true;
    baselineNote.dataset.spent = "true";
    equaliseStatus.textContent = "Measuring…";
    for (const i of ALL_PANELS) panelStatusEls[i].textContent = "waiting…";
  });

  resetBtn.addEventListener("click", () => {
    if (measureJob) return;
    ALL_PANELS.forEach((i) => {
      configs[i] = { ...PANEL_PRESETS[i] };
      refreshSliderUI(i);
      panelStatusEls[i].textContent = "";
    });
    equaliseStatus.textContent = "Back to the ladder as it was labelled.";
    beginRun({ startPaused: true });
  });

  function tickEqualisation(): void {
    if (!measureJob) return;
    const job = measureJob;
    const deadline = performance.now() + FRAME_BUDGET_MS;
    while (performance.now() < deadline) {
      const result = job.gen.next();
      if (result.done) {
        measureJob = null;
        equaliseBtn.disabled = false;
        reportLadder(result.value);
        return;
      }
      const progress = result.value;
      if (progress.kind === "panel-start") {
        job.currentPanel = progress.panel;
        job.trialsThisPhase = 0;
        panelStatusEls[progress.panel].textContent = "measuring…";
      } else if (progress.kind === "trial") {
        // A pacing pulse, not a result. It still has to move every trial, or a
        // multi-second measurement reads as a hang.
        job.trialsThisPhase++;
        if (job.currentPanel !== null) {
          panelStatusEls[job.currentPanel].textContent = `measuring… (${job.trialsThisPhase} runs)`;
        }
      }
    }
  }


  // The one place the mirror (and the HUD text) is written, from `state`
  // itself, once per frame — see CLAUDE.md's mirror-drift guard. Never set
  // these piecemeal elsewhere.
  function publishState(): void {
    const config = configs[activeIndex];
    mirror.dataset.running = String(state.running);
    mirror.dataset.elapsedMs = String(Math.round(state.elapsedMs));
    mirror.dataset.playerHearts = String(state.playerHearts);
    mirror.dataset.playerX = String(state.player.x);
    mirror.dataset.playerY = String(state.player.y);
    mirror.dataset.appliedHealth = String(config.enemyHealth);
    mirror.dataset.appliedSpeed = String(config.enemySpeed);
    mirror.dataset.appliedSpawnCount = String(config.enemySpawnCount);
    mirror.dataset.activeConfig = String(activeIndex);

    timerEl.textContent = formatTime(state.elapsedMs);
    // Hearts, not a number: three discrete lives read at a glance, and the
    // spent ones stay on screen so the cost of the last contact is visible.
    healthEl.textContent = "♥".repeat(state.playerHearts) + "♡".repeat(Math.max(0, PLAYER_MAX_HEARTS - state.playerHearts));
    healthEl.setAttribute("aria-label", `${state.playerHearts} of ${PLAYER_MAX_HEARTS} hearts left`);
    enemyCountEl.textContent = `${state.enemies.length} alive`;
  }

  // Paused until the visitor presses Start, so nobody arrives at the tool on
  // health that drained while they were reading the opening screen.
  let paused = true;

  function setPaused(next: boolean): void {
    paused = next;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    pauseBtn.setAttribute("aria-pressed", String(paused));
    pausedHint.hidden = !paused || !state.running || !intro.hidden;
    // loop()'s next dt is measured from lastFrameTime; leaving a stale one in
    // place would hand the first frame after a resume the entire pause as one
    // enormous step.
    lastFrameTime = undefined;
  }

  function showRunOver(): void {
    runOver.hidden = false;
    restartBtn.hidden = false;
    runOver.textContent = `${PANEL_LABELS[activeIndex]} killed you at ${formatTime(state.elapsedMs)}. That number is what the equalise button matches against.`;
  }

  // `startPaused` is the difference between a play action and a configuration
  // one. Pressing Start or "Run it again" says "I am ready"; picking a
  // different step of the ladder does not, and dropping someone straight into
  // a live run because they clicked a radio button gives them no time to
  // react. Consistent with CLAUDE.md's rule that the arena holds the play: a
  // run the visitor didn't ask for waits for them to press the arena.
  function beginRun({ startPaused = false } = {}): void {
    state = createInitialState();
    tracers = [];
    runOver.hidden = true;
    restartBtn.hidden = true;
    setPaused(startPaused);
  }

  startBtn.addEventListener("click", () => {
    intro.hidden = true;
    beginRun();
  });

  // CLAUDE.md: the arena holds the play. Pressing inside the canvas plays,
  // pressing anywhere else pauses — so reaching for a slider stops the run
  // without the visitor having to remember to, and the arrow keys never fight
  // a control someone is currently using. mousedown rather than click,
  // because a drag on a slider starts with a press and never produces a
  // click on it.
  const RUN_CONTROLS = '[data-testid="start-button"], [data-testid="pause-button"], [data-testid="restart-button"]';
  canvas.addEventListener("mousedown", () => {
    if (state.running && intro.hidden) setPaused(false);
  });
  document.addEventListener("mousedown", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    // The run's own controls are exempt, or pressing Resume would pause again
    // on the very same press and Resume could never work.
    if (target === canvas || canvas.contains(target) || target.closest(RUN_CONTROLS)) return;
    setPaused(true);
  });
  // Switching tab or window is attention leaving the arena too.
  window.addEventListener("blur", () => setPaused(true));
  // "Run it again" is an explicit ask to play, so it starts running.
  restartBtn.addEventListener("click", () => beginRun());
  pauseBtn.addEventListener("click", () => {
    if (!state.running) return;
    setPaused(!paused);
  });

  let lastFrameTime: number | undefined;
  function loop(now: number): void {
    if (lastFrameTime !== undefined && !paused) {
      const dt = (now - lastFrameTime) / 1000;
      captureTracers(dt, now);
      step(state, dt, keyboardInput(), configs[activeIndex]);
      // The run just ended. Say so, and put a fresh one one control away —
      // the old behaviour was to freeze in place and explain nothing.
      if (state.elapsedMs > 0) unlockChallenge();
      if (!state.running && runOver.hidden) showRunOver();
    }
    lastFrameTime = now;
    tickEqualisation();
    tickAttempt();
    render(now);
    publishState();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

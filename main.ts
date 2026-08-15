// The live, rendered game. All simulation logic lives in ./sim (pure,
// DOM-free, headlessly runnable) and the equalisation search lives in
// ./equalise (also pure, DOM-free) — this file is deliberately just DOM
// setup, canvas rendering, a requestAnimationFrame loop, and the chunked
// driver that runs the equalise search a little at a time per frame.
import {
  createInitialState,
  step,
  ENEMY_PURSUIT_SPEED_RATING,
  medianSurvivalMs,
  fleeNearestPolicy,
  type DifficultyConfig,
  type Input,
} from "./sim";
import {
  equalisePanel,
  isCorneringRegime,
  TOLERANCE_FRACTION,
  FINAL_TRIALS,
  SEARCH_TRIALS,
  SEARCH_ITERATIONS,
  type AxisBounds,
  type EqualiseStep,
  type EqualiseOutcome,
} from "./equalise";

const PLAYER_RADIUS = 0.02; // fraction of the canvas's shorter side
const ENEMY_RADIUS = 0.018;

// Slider bounds, shared with equalise.ts's search so a retuned config can
// never land outside what the UI can even represent.
const BOUNDS: AxisBounds = {
  enemyHealth: { min: 10, max: 100 },
  enemySpeed: { min: 0, max: 100 },
  enemyDamage: { min: 0, max: 50 },
};

// Three deliberately different archetypes, not three copies of the same dial
// position — see CLAUDE.md's "Three configurations" section for why. The
// speed values are deliberately split across ENEMY_PURSUIT_SPEED_RATING
// (sim.ts, = 60): swarm and hunter sit above it (their enemies CAN catch a
// fleeing player) with two different health/damage trade-offs from each
// other; tanks sits below it (its enemies CANNOT — see isCorneringRegime in
// equalise.ts). That split is intentional, not incidental — it's what makes
// pressing "make these equally hard" produce one clean match and one honest,
// explained failure from a cold start, rather than three failures that would
// just read as a broken button. An earlier version of this third preset was
// `{ ...DEFAULT_DIFFICULTY }` labelled "Balanced" — enemySpeed 15, which put
// it on the SAME side of the threshold as tanks, so a first press could only
// ever fail twice. This preset replaces it on purpose.
const PANEL_PRESETS: readonly DifficultyConfig[] = [
  { enemyHealth: 20, enemySpeed: 70, enemyDamage: 10 }, // swarm: weak, fast, hits soft
  { enemyHealth: 90, enemySpeed: 10, enemyDamage: 30 }, // tanks: tough, slow, hits hard
  { enemyHealth: 60, enemySpeed: 65, enemyDamage: 25 }, // hunter: tough AND fast, hits moderately hard
];
const PANEL_LABELS = ["Swarm", "Tanks", "Hunter"] as const;

// TOLERANCE_FRACTION / FINAL_TRIALS / SEARCH_TRIALS / SEARCH_ITERATIONS all
// live in ./equalise, next to the search they tune — see that file's
// comments for how each number was derived from this sim's own measured
// sampling noise, not guessed.

// Real Monte Carlo work is real CPU work: measured in an actual browser
// against the built site (Playwright, both panels retuned from the default
// Swarm-active state) at ~5.9s wall-clock end to end — a from-first-principles
// estimate before that measurement said ~1.5-1.8s, wrong by more than 3x,
// which is exactly why this is a measured number, not a computed one.
//
// That measurement also showed FRAME_BUDGET_MS isn't pacing what its name
// implies. One job.gen.next() call is one full, uninterruptible
// medianSurvivalMs(trials=SEARCH_TRIALS) measurement, and that alone averaged
// ~240ms in the same run (25 gen.next() calls total across both panels over
// 5944ms wall-clock) — ~30x this budget. So tickEqualisation's
// `while (performance.now() < deadline)` loop never gets a second step into
// one frame: the first step already blows the deadline. What actually
// happens is "one step per animation frame, however long that step takes",
// not "spend up to 8ms of steps per frame".
//
// Measured consequence: ~4.2fps during a press (25 rAF frames over 5944ms),
// against ~60fps at rest — the loop keeps ticking throughout (elapsedMs
// keeps advancing, confirmed) rather than freezing, but a visitor watching
// it sees roughly 4 canvas updates a second, not a small dip.
const FRAME_BUDGET_MS = 8;

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const app = document.querySelector<HTMLElement>("#app");

if (app) {
  const canvas = document.createElement("canvas");
  canvas.dataset.testid = "game-canvas";
  canvas.setAttribute("aria-hidden", "true");
  app.append(canvas);

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
  hud.append(timerEl, healthEl);
  panel.append(hud);

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
    const keys: (keyof DifficultyConfig)[] = ["enemyHealth", "enemySpeed", "enemyDamage"];
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
    state = createInitialState();
    // Without this, loop()'s next dt is measured against the pre-switch
    // timestamp — a stale reference that inflates the first frame after any
    // switch, not just a test artifact.
    lastFrameTime = undefined;
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
    addSlider(p, 2, "enemyDamage", `enemy-damage-${p}`, "Enemy damage", BOUNDS.enemyDamage.min, BOUNDS.enemyDamage.max, 5);

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

  const equaliseBtn = document.createElement("button");
  equaliseBtn.type = "button";
  equaliseBtn.className = "equalise-button";
  equaliseBtn.dataset.testid = "equalise-button";
  equaliseBtn.textContent = "Make these equally hard";
  panel.append(equaliseBtn);

  const equaliseStatus = document.createElement("p");
  equaliseStatus.dataset.testid = "equalise-status";
  equaliseStatus.setAttribute("aria-live", "polite");
  panel.append(equaliseStatus);

  const limitation = document.createElement("p");
  limitation.className = "equalise-limitation";
  limitation.dataset.testid = "equalise-limitation";
  limitation.textContent =
    '"Equally hard" here means equally hard for one fixed scripted reference player (it flees the nearest enemy once it gets close, otherwise holds still) — not for a human. A real person plays differently, so a configuration equalised against this policy is not thereby equalised for a person.';
  panel.append(limitation);

  app.append(panel);

  const ctx = canvas.getContext("2d"); // null under jsdom (no `canvas` package) — render() guards it

  let state = createInitialState();

  const pressed = new Set<string>();
  window.addEventListener("keydown", (e) => pressed.add(e.code));
  window.addEventListener("keyup", (e) => pressed.delete(e.code));

  function keyboardInput(): Input {
    let x = 0;
    let y = 0;
    if (pressed.has("ArrowLeft")) x -= 1;
    if (pressed.has("ArrowRight")) x += 1;
    if (pressed.has("ArrowUp")) y -= 1;
    if (pressed.has("ArrowDown")) y += 1;
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

  function render(): void {
    if (!ctx || cssWidth === 0 || cssHeight === 0) return;
    const side = Math.min(cssWidth, cssHeight);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    ctx.fillStyle = "#888";
    for (const enemy of state.enemies) {
      ctx.beginPath();
      ctx.arc(enemy.x * cssWidth, enemy.y * cssHeight, ENEMY_RADIUS * side, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#e8e8e8";
    ctx.beginPath();
    ctx.arc(state.player.x * cssWidth, state.player.y * cssHeight, PLAYER_RADIUS * side, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Equalisation: chunked across frames, see FRAME_BUDGET_MS above. ---

  type EqualiseJob = {
    targetMs: number;
    toleranceMs: number;
    queue: number[];
    gen: Generator<EqualiseStep, EqualiseOutcome, void> | null;
    panel: number | null;
    outcomes: Map<number, EqualiseOutcome>;
    total: number;
    stepCount: number;
  };
  let equaliseJob: EqualiseJob | null = null;

  function describeOutcome(outcome: EqualiseOutcome): string {
    if (outcome.status === "matched") return `matched at ${formatTime(outcome.achievedMs)}`;
    // "budget" on a config whose enemies are already too slow to catch a
    // fleeing player isn't a search that needs more steps — it's this
    // archetype's difficulty being a fundamentally different, high-variance
    // process (cornering by accumulation, not pursuit). Say that, not just
    // that the search gave up — see ENEMY_PURSUIT_SPEED_RATING in sim.ts.
    if (outcome.reason === "budget" && isCorneringRegime(outcome.config)) {
      return (
        `couldn't converge — this archetype's enemies (speed ${outcome.config.enemySpeed}) move slower than the ` +
        `player (parity at ${ENEMY_PURSUIT_SPEED_RATING}) and can't catch one that's fleeing. It only kills by ` +
        `cornering as enemies accumulate over a run, which varies far more than pursuit-regime configs do — a ` +
        `single intensity knob can't reliably land it in this target's tolerance. Closest reached: ` +
        `${formatTime(outcome.achievedMs)}.`
      );
    }
    const reason =
      outcome.reason === "floor"
        ? "every slider is already at its easiest setting and it's still too hard to reach that target"
        : outcome.reason === "ceiling"
          ? "every slider is already at its hardest setting and it's still too easy to reach that target"
          : "ran out of search steps before converging";
    return `couldn't reach equal difficulty (${reason}) — closest reached: ${formatTime(outcome.achievedMs)}`;
  }

  function finishPanel(panelIndex: number, outcome: EqualiseOutcome): void {
    configs[panelIndex] = outcome.config;
    refreshSliderUI(panelIndex);
    panelStatusEls[panelIndex].textContent = describeOutcome(outcome);
  }

  equaliseBtn.addEventListener("click", () => {
    if (equaliseJob) return;
    const targetMs = medianSurvivalMs(configs[activeIndex], FINAL_TRIALS, fleeNearestPolicy, Math.random);
    const toleranceMs = targetMs * TOLERANCE_FRACTION;
    const queue = [0, 1, 2].filter((i) => i !== activeIndex);
    equaliseJob = { targetMs, toleranceMs, queue, gen: null, panel: null, outcomes: new Map(), total: queue.length, stepCount: 0 };
    equaliseBtn.disabled = true;
    equaliseStatus.textContent = `Equalising to ${PANEL_LABELS[activeIndex]}'s ${formatTime(targetMs)}…`;
    for (const i of queue) panelStatusEls[i].textContent = "waiting…";
  });

  function tickEqualisation(): void {
    if (!equaliseJob) return;
    const job = equaliseJob;
    const deadline = performance.now() + FRAME_BUDGET_MS;
    while (performance.now() < deadline) {
      if (!job.gen) {
        const next = job.queue.shift();
        if (next === undefined) {
          equaliseJob = null;
          equaliseBtn.disabled = false;
          const total = job.outcomes.size;
          const matched = [...job.outcomes.values()].filter((o) => o.status === "matched").length;
          // Honest either way: don't say "Done" as if every panel succeeded
          // when one didn't — the per-panel status below says why.
          equaliseStatus.textContent =
            matched === total
              ? `Done — matched ${PANEL_LABELS[activeIndex]}'s ${formatTime(job.targetMs)}.`
              : `Done — ${matched} of ${total} matched ${PANEL_LABELS[activeIndex]}'s ${formatTime(job.targetMs)}; see below for the rest.`;
          return;
        }
        job.panel = next;
        job.stepCount = 0;
        panelStatusEls[next].textContent = "equalising… (step 1)";
        job.gen = equalisePanel(configs[next], BOUNDS, job.targetMs, job.toleranceMs, Math.random, SEARCH_TRIALS, SEARCH_ITERATIONS);
      }
      const result = job.gen.next();
      if (!result.done) {
        // Six seconds of a static "working…" label reads as a hang even
        // though the game keeps animating behind it — this has to visibly
        // change every step, not just at the end.
        job.stepCount++;
        const panelPosition = job.outcomes.size + 1;
        panelStatusEls[job.panel!].textContent = `equalising… (step ${job.stepCount})`;
        equaliseStatus.textContent =
          `Equalising ${PANEL_LABELS[job.panel!]} (${panelPosition} of ${job.total}) to ` +
          `${PANEL_LABELS[activeIndex]}'s ${formatTime(job.targetMs)} — step ${job.stepCount}, ` +
          `last try ${formatTime(result.value.achievedMs)}…`;
      }
      if (result.done) {
        const outcome = result.value;
        // Re-verify at full trial count so every reported/compared number
        // shares the same precision as the reference target.
        const verifiedMs = medianSurvivalMs(outcome.config, FINAL_TRIALS, fleeNearestPolicy, Math.random);
        const verified: EqualiseOutcome =
          outcome.status === "matched"
            ? { ...outcome, achievedMs: verifiedMs }
            : { ...outcome, achievedMs: verifiedMs };
        finishPanel(job.panel!, verified);
        job.outcomes.set(job.panel!, verified);
        job.gen = null;
        job.panel = null;
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
    mirror.dataset.playerX = String(state.player.x);
    mirror.dataset.playerY = String(state.player.y);
    mirror.dataset.appliedHealth = String(config.enemyHealth);
    mirror.dataset.appliedSpeed = String(config.enemySpeed);
    mirror.dataset.appliedDamage = String(config.enemyDamage);
    mirror.dataset.activeConfig = String(activeIndex);

    timerEl.textContent = formatTime(state.elapsedMs);
    healthEl.textContent = `HP ${Math.ceil(state.playerHealth)}`;
  }

  let lastFrameTime: number | undefined;
  function loop(now: number): void {
    if (lastFrameTime !== undefined) {
      step(state, (now - lastFrameTime) / 1000, keyboardInput(), configs[activeIndex]);
    }
    lastFrameTime = now;
    tickEqualisation();
    render();
    publishState();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

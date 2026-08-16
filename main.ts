// The live, rendered game. All simulation logic lives in ./sim (pure,
// DOM-free, headlessly runnable) and the equalisation search lives in
// ./equalise (also pure, DOM-free) — this file is deliberately just DOM
// setup, canvas rendering, a requestAnimationFrame loop, and the chunked
// driver that runs the equalise search a little at a time per frame.
import {
  createInitialState,
  step,
  ENEMY_CONTACT_RADIUS,
  ENEMY_PURSUIT_SPEED_RATING,
  PLAYER_ATTACK_INTERVAL,
  PLAYER_ATTACK_RANGE,
  type DifficultyConfig,
  type Input,
} from "./sim";
import {
  equaliseAllPanels,
  isCorneringRegime,
  type AxisBounds,
  type MultiPanelProgress,
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
const PANEL_BLURBS = [
  "Dies to a single hit, but it is faster than you and they never stop arriving. Death by a hundred small ones.",
  "Takes five hits to kill and moves six times slower than you, so you can walk away from it all day — but three seconds of contact takes a third of your health.",
  "Faster than you, survives three hits, and hurts. The one that is actually dangerous.",
] as const;

// TOLERANCE_FRACTION / FINAL_TRIALS / SEARCH_TRIALS / SEARCH_ITERATIONS all
// live in ./equalise, next to the search they tune — see that file's
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
// Fix: equalise.ts's generators (medianSurvivalMsSteps, measureSteps) now
// yield once per individual simulated trial (one runHeadless call) instead of
// once per whole batch, and equaliseAllPanels chunks ALL three of the flow's
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
  const enemyCountEl = document.createElement("span");
  enemyCountEl.dataset.testid = "enemy-count";
  enemyCountEl.className = "tabular";
  hud.append(timerEl, healthEl, enemyCountEl);
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
    // Drives styles.css's per-stat colour (health/speed/damage), so the same
    // three colours mean the same thing in every one of the nine sliders —
    // see CLAUDE.md's "three sliders get three distinguishable colours,
    // reused everywhere" rule.
    row.dataset.stat = key === "enemyHealth" ? "health" : key === "enemySpeed" ? "speed" : "damage";

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
    "Selected panel is the one you are playing. The other two get retuned until a fixed reference player survives them for as long as it survives yours.";
  panel.append(prompt);

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
    let x = 0;
    let y = 0;
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

    // The attack range (0.12) against the enemy contact radius (0.03) is the
    // game: an enemy has to survive this ring long enough to reach the middle
    // of it. Neither was drawn before, so neither was playable knowledge.
    const attackPhase = 1 - Math.min(1, state.attackCooldown / PLAYER_ATTACK_INTERVAL);
    ctx.strokeStyle = `rgb(226 178 84 / ${18 + 26 * attackPhase}%)`;
    ctx.lineWidth = 1 + 1.5 * attackPhase;
    ctx.beginPath();
    ctx.arc(px, py, PLAYER_ATTACK_RANGE * side, 0, Math.PI * 2);
    ctx.stroke();

    tracers = tracers.filter((t) => now - t.born < TRACER_LIFETIME_MS);
    for (const tracer of tracers) {
      const life = 1 - (now - tracer.born) / TRACER_LIFETIME_MS;
      ctx.strokeStyle = `rgb(226 178 84 / ${Math.round(life * 85)}%)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(tracer.x * cssWidth, tracer.y * cssHeight);
      ctx.stroke();
    }

    // Enemies are squares and the player is a ringed circle: shape, not just
    // brightness, so the two are still distinguishable on a small canvas and
    // without relying on a value difference. A damaged enemy shrinks toward
    // its contact radius and dims, so a 90-health Tanks soaking five hits
    // reads differently from a Swarm dying to one.
    const config = configs[activeIndex];
    for (const enemy of state.enemies) {
      const life = Math.max(0, Math.min(1, enemy.health / Math.max(1, config.enemyHealth)));
      const r = (ENEMY_CONTACT_RADIUS + (ENEMY_RADIUS - ENEMY_CONTACT_RADIUS) * life) * side;
      ctx.fillStyle = `rgb(158 158 165 / ${Math.round(45 + 55 * life)}%)`;
      ctx.fillRect(enemy.x * cssWidth - r, enemy.y * cssHeight - r, r * 2, r * 2);
    }

    ctx.fillStyle = "#f2f2f4";
    ctx.beginPath();
    ctx.arc(px, py, PLAYER_RADIUS * side, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#e2b254";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, PLAYER_RADIUS * side + 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  // --- Equalisation: chunked across frames, see FRAME_BUDGET_MS above. ---

  type EqualiseJob = {
    gen: Generator<MultiPanelProgress, Map<number, EqualiseOutcome>, void>;
    targetMs: number | null; // unknown until the "target" progress event arrives
    currentPanel: number | null; // unknown until the first "panel-start" event
    panelsStarted: number; // for "(N of total)" — incremented on "panel-start"
    trialsThisPhase: number; // resets on "target"/"panel-start"/"step", for the visible trial counter
    total: number;
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
    const otherPanels = [0, 1, 2].filter((i) => i !== activeIndex);
    equaliseJob = {
      gen: equaliseAllPanels(configs[activeIndex], (i) => configs[i], otherPanels, BOUNDS, Math.random),
      targetMs: null,
      currentPanel: null,
      panelsStarted: 0,
      trialsThisPhase: 0,
      total: otherPanels.length,
    };
    equaliseBtn.disabled = true;
    // The target isn't known yet — it's itself a chunked measurement now (see
    // FRAME_BUDGET_MS above), so this can't say a number until the first
    // "target" progress event arrives.
    equaliseStatus.textContent = `Measuring ${PANEL_LABELS[activeIndex]}'s reference difficulty…`;
    for (const i of otherPanels) panelStatusEls[i].textContent = "waiting…";
  });

  function tickEqualisation(): void {
    if (!equaliseJob) return;
    const job = equaliseJob;
    const deadline = performance.now() + FRAME_BUDGET_MS;
    while (performance.now() < deadline) {
      const result = job.gen.next();
      if (result.done) {
        const outcomes = result.value;
        equaliseJob = null;
        equaliseBtn.disabled = false;
        const total = outcomes.size;
        const matched = [...outcomes.values()].filter((o) => o.status === "matched").length;
        const targetMs = job.targetMs ?? 0;
        // Honest either way: don't say "Done" as if every panel succeeded
        // when one didn't — the per-panel status (written live, below) says why.
        equaliseStatus.textContent =
          matched === total
            ? `Done — matched ${PANEL_LABELS[activeIndex]}'s ${formatTime(targetMs)}.`
            : `Done — ${matched} of ${total} matched ${PANEL_LABELS[activeIndex]}'s ${formatTime(targetMs)}; see below for the rest.`;
        return;
      }

      const progress = result.value;
      switch (progress.kind) {
        case "trial":
          // One simulated run just finished — a pacing pulse, not a result.
          // Still has to visibly change the label every trial, or a slow
          // phase (measuring the target, or a search step) reads as a hang
          // even though it's clearly ticking underneath.
          job.trialsThisPhase++;
          if (job.currentPanel === null) {
            equaliseStatus.textContent =
              `Measuring ${PANEL_LABELS[activeIndex]}'s reference difficulty… (${job.trialsThisPhase} trials)`;
          } else {
            panelStatusEls[job.currentPanel].textContent = `equalising… (${job.trialsThisPhase} trials this step)`;
          }
          break;
        case "target":
          job.targetMs = progress.achievedMs;
          job.trialsThisPhase = 0;
          equaliseStatus.textContent = `Equalising to ${PANEL_LABELS[activeIndex]}'s ${formatTime(progress.achievedMs)}…`;
          break;
        case "panel-start":
          job.currentPanel = progress.panel;
          job.panelsStarted++;
          job.trialsThisPhase = 0;
          panelStatusEls[progress.panel].textContent = "equalising…";
          break;
        case "step":
          job.trialsThisPhase = 0;
          panelStatusEls[job.currentPanel!].textContent = `equalising… last try ${formatTime(progress.achievedMs)}`;
          equaliseStatus.textContent =
            `Equalising ${PANEL_LABELS[job.currentPanel!]} (${job.panelsStarted} of ${job.total}) to ` +
            `${PANEL_LABELS[activeIndex]}'s ${formatTime(job.targetMs ?? 0)} — last try ${formatTime(progress.achievedMs)}…`;
          break;
        case "panel-done":
          // Includes the FINAL_TRIALS re-verify (see equaliseAllPanels) — the
          // number this reports already shares the reference target's
          // precision, not the cheaper SEARCH_TRIALS estimate the search used.
          finishPanel(progress.panel, progress.outcome);
          break;
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
    enemyCountEl.textContent = `${state.enemies.length} alive`;
  }

  let lastFrameTime: number | undefined;
  function loop(now: number): void {
    if (lastFrameTime !== undefined) {
      const dt = (now - lastFrameTime) / 1000;
      captureTracers(dt, now);
      step(state, dt, keyboardInput(), configs[activeIndex]);
    }
    lastFrameTime = now;
    tickEqualisation();
    render(now);
    publishState();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

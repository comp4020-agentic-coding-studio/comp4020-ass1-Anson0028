// Pure, DOM-free equalisation search — no canvas, no requestAnimationFrame,
// no wall-clock reads. Every generator here yields once per *trial* (one
// `runHeadless` call), not once per whole measurement — that granularity is
// the difference between a per-frame time budget actually pacing the work
// and merely decorating it (see main.ts's FRAME_BUDGET_MS comment for the
// measurement that caught it decorating). main.ts drains these a little at a
// time per animation frame; see its `tickEqualisation`. See CLAUDE.md's
// "Three configurations" section for why equalisePanel scales one multiplier
// across a panel's whole shape instead of independently retuning three knobs
// against one target (underdetermined).
import { ENEMY_PURSUIT_SPEED_RATING, fleeNearestPolicy, medianSurvivalMsSteps, type DifficultyConfig } from "./sim";

// `step` is the resolution of the control that displays this axis. The search
// only ever proposes configurations that control can represent — see
// scaledConfig. Without it the search returns its own arithmetic (a slider
// whose step is 5 sat next to the label "59.9853515625"), and worse, the
// achieved time it reports belongs to a configuration nobody is playing.
export type AxisBounds = Record<keyof DifficultyConfig, { min: number; max: number; step: number }>;

export type EqualiseStep = { config: DifficultyConfig; achievedMs: number };

// What a caller sees while a search is in progress. "trial": one simulated
// run just finished — a pacing pulse with no other information, since a
// single trial's result isn't meaningful on its own (see medianSurvivalMs).
// "step": a full trials-sized measurement just completed (one bisection
// probe) — this is what a progress UI reports "last try Xs" from.
export type EqualiseProgress = { kind: "trial" } | ({ kind: "step" } & EqualiseStep);

// Runs one Monte Carlo measurement trial-by-trial, yielding a pacing pulse
// after each one instead of blocking for the whole batch. Shared by
// equalisePanel (its bisection probes) and equaliseAllPanels (the reference
// target and the post-search verify) so there's exactly one place that turns
// "a batch of trials" into "something a frame budget can chunk".
function* measureSteps(
  config: Readonly<DifficultyConfig>,
  trials: number,
  rng: () => number,
): Generator<EqualiseProgress, number, void> {
  const gen = medianSurvivalMsSteps(config, trials, fleeNearestPolicy, rng);
  let result = gen.next();
  while (!result.done) {
    yield { kind: "trial" };
    result = gen.next();
  }
  return result.value;
}

export type EqualiseOutcome =
  | { status: "matched"; config: DifficultyConfig; achievedMs: number; targetMs: number }
  | {
      status: "unreachable";
      // "floor"/"ceiling": every axis is already at its slider's own bound
      // and the target is still on the wrong side. "budget": still
      // converging, iteration budget ran out first — a bigger maxIterations
      // would likely resolve it, unlike the other two.
      reason: "floor" | "ceiling" | "budget";
      config: DifficultyConfig;
      achievedMs: number;
      targetMs: number;
    };

// How close two median survival times have to be to count as "equally hard".
// Derived, not guessed — but derived in one specific regime, and that matters:
// medianSurvivalMs(trials=51) has ~1.4-2.2% relative sampling noise as
// *measured* against DEFAULT_DIFFICULTY and a fast config (20 seeds each — see
// the slice-5 commit message for the raw numbers), both configs whose
// enemySpeed sits above ENEMY_PURSUIT_SPEED_RATING (sim.ts) — the "gets
// caught" pursuit regime, where outcomes cluster. Comparing two independent
// 51-trial medians there gives combined noise of ~sqrt(2) x that, ~3.05% at
// the worst observed rate; tripling for a comfortable non-flaky margin lands
// at ~9.15%, and 9% is what's actually used.
//
// This number is NOT valid below ENEMY_PURSUIT_SPEED_RATING. Down there, a run
// only ends by accumulation and cornering rather than pursuit, which is
// bimodal/high-variance (a run either gets cornered early or runs to the
// headless cap) rather than concentrated the way the measurement above
// assumes — see isCorneringRegime and its callers. Widening this fraction
// wouldn't fix that; it's a different distribution, not a noisier version of
// the same one.
export const TOLERANCE_FRACTION = 0.09;

// True when a config's enemies are at or below the speed where they can catch
// a fleeing player (see ENEMY_PURSUIT_SPEED_RATING in sim.ts). Exported so
// both the equalise UI and its tests can name the actual mechanism behind a
// "budget" outcome instead of only reporting that the search ran out of
// iterations.
export function isCorneringRegime(config: Readonly<DifficultyConfig>): boolean {
  return config.enemySpeed < ENEMY_PURSUIT_SPEED_RATING;
}

// Trials per Monte Carlo measurement. 51 (sim.ts's own default) for the
// reference target and every reported/compared number, so everything being
// compared shares the same precision. Fewer (21) while bisecting a
// multiplier during search — a coarser estimate is fine there since 9%
// tolerance clears trials=21's noise too, and it's ~2.5x cheaper per step,
// which matters directly to how long an equalise press stays chunked across
// frames (see main.ts's FRAME_BUDGET_MS).
export const FINAL_TRIALS = 51;
export const SEARCH_TRIALS = 21;
export const SEARCH_ITERATIONS = 12;

export function withinTolerance(a: number, b: number, toleranceMs: number): boolean {
  return Math.abs(a - b) <= toleranceMs;
}

const AXES: (keyof DifficultyConfig)[] = ["enemyHealth", "enemySpeed", "enemyDamage"];

function scaledConfig(base: Readonly<DifficultyConfig>, bounds: AxisBounds, k: number): DifficultyConfig {
  const out = {} as DifficultyConfig;
  for (const axis of AXES) {
    const b = base[axis];
    // A zero base can't be scaled by multiplication — leave it at zero
    // rather than pretending a multiplier can move it. Only reachable if a
    // panel's own slider was manually set to its zero end before equalising.
    const { min, max, step } = bounds[axis];
    const scaled = b === 0 ? 0 : Math.min(max, Math.max(min, b * k));
    // Quantised here, inside the search, rather than rounded on the way out:
    // every candidate the search measures is then one the sliders can hold, so
    // the achieved time it finally reports belongs to the configuration the
    // visitor is left playing. Rounding afterwards would report a time
    // measured against a configuration that no longer exists.
    out[axis] = step > 0 ? Math.min(max, Math.max(min, Math.round(scaled / step) * step)) : scaled;
  }
  return out;
}

// Binary-searches a single multiplier `k` applied to every non-zero axis of
// `base`, so the panel's shape (the ratio between its three stats) survives
// equalisation and only its intensity changes. Valid because harder-per-axis
// is monotonic: increasing any of health/speed/damage can only shorten (or
// leave unchanged) median survival time, so achievedMs(k) is non-increasing
// in k — see sim.ts's scan in the slice-5 commit message for the measured
// curves this assumes.
export function* equalisePanel(
  base: Readonly<DifficultyConfig>,
  bounds: AxisBounds,
  targetMs: number,
  toleranceMs: number,
  rng: () => number,
  trials: number,
  maxIterations: number,
): Generator<EqualiseProgress, EqualiseOutcome, void> {
  const kMax = Math.max(1, ...AXES.filter((a) => base[a] > 0).map((a) => bounds[a].max / base[a]));

  const loConfig = scaledConfig(base, bounds, 0);
  const loMs = yield* measureSteps(loConfig, trials, rng);
  yield { kind: "step", config: loConfig, achievedMs: loMs };
  if (targetMs > loMs + toleranceMs) {
    // Even at every axis's easiest slider position, this shape can't survive
    // as long as the target — it's already at its floor.
    return { status: "unreachable", reason: "floor", config: loConfig, achievedMs: loMs, targetMs };
  }

  const hiConfig = scaledConfig(base, bounds, kMax);
  const hiMs = yield* measureSteps(hiConfig, trials, rng);
  yield { kind: "step", config: hiConfig, achievedMs: hiMs };
  if (targetMs < hiMs - toleranceMs) {
    // Even at every axis's hardest slider position, this shape is still
    // easier than the target — it's already at its ceiling.
    return { status: "unreachable", reason: "ceiling", config: hiConfig, achievedMs: hiMs, targetMs };
  }

  let lo = 0;
  let hi = kMax;
  let best: EqualiseStep = { config: loConfig, achievedMs: loMs };
  for (let i = 0; i < maxIterations; i++) {
    const mid = (lo + hi) / 2;
    const config = scaledConfig(base, bounds, mid);
    const achievedMs = yield* measureSteps(config, trials, rng);
    yield { kind: "step", config, achievedMs };
    best = { config, achievedMs };
    if (Math.abs(achievedMs - targetMs) <= toleranceMs) {
      return { status: "matched", config, achievedMs, targetMs };
    }
    if (achievedMs > targetMs) {
      lo = mid; // survived longer than target -> too easy -> push harder
    } else {
      hi = mid; // died sooner than target -> too hard -> pull easier
    }
  }
  return { status: "unreachable", reason: "budget", config: best.config, achievedMs: best.achievedMs, targetMs };
}

// The full button-press flow: measure the active panel's own reference time,
// then search+verify every other panel against it. One generator for the
// whole thing (rather than main.ts stitching several generators together)
// so there's a single place that knows the sequence — target, then each
// panel's search, then that panel's FINAL_TRIALS re-verify — and main.ts
// only has to drain it and react to what it yields.
export type MultiPanelProgress =
  | EqualiseProgress
  | { kind: "target"; achievedMs: number }
  | { kind: "panel-start"; panel: number }
  | { kind: "panel-done"; panel: number; outcome: EqualiseOutcome };

export function* equaliseAllPanels(
  activeConfig: Readonly<DifficultyConfig>,
  getPanelConfig: (panel: number) => Readonly<DifficultyConfig>,
  otherPanels: readonly number[],
  bounds: AxisBounds,
  rng: () => number,
): Generator<MultiPanelProgress, Map<number, EqualiseOutcome>, void> {
  const targetMs = yield* measureSteps(activeConfig, FINAL_TRIALS, rng);
  yield { kind: "target", achievedMs: targetMs };
  const toleranceMs = targetMs * TOLERANCE_FRACTION;

  const outcomes = new Map<number, EqualiseOutcome>();
  for (const panel of otherPanels) {
    yield { kind: "panel-start", panel };
    const outcome = yield* equalisePanel(
      getPanelConfig(panel),
      bounds,
      targetMs,
      toleranceMs,
      rng,
      SEARCH_TRIALS,
      SEARCH_ITERATIONS,
    );
    // Re-verify at full trial count so every reported/compared number shares
    // the same precision as the reference target — the search itself runs
    // at the cheaper SEARCH_TRIALS.
    const verifiedMs = yield* measureSteps(outcome.config, FINAL_TRIALS, rng);
    const verified: EqualiseOutcome = { ...outcome, achievedMs: verifiedMs };
    yield { kind: "panel-done", panel, outcome: verified };
    outcomes.set(panel, verified);
  }
  return outcomes;
}

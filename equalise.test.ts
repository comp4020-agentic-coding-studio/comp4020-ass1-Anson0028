// Tests the equalisation search itself — pure, DOM-free, so these run
// against the algorithm directly rather than through main.ts's UI and its
// frame-chunked driver (which exists purely to spread the same work across
// animation frames — see main.ts's FRAME_BUDGET_MS comment. Draining a
// generator in a tight loop here is the same computation, just not paced).
import { describe, expect, it } from "vitest";
import {
  medianSurvivalMs,
  measurementSteps,
  fleeNearestPolicy,
  HEADLESS_MAX_MS,
  type DifficultyConfig,
} from "./sim";
import {
  equalisePanel,
  isCorneringRegime,
  withinTolerance,
  TOLERANCE_FRACTION,
  FINAL_TRIALS,
  SEARCH_TRIALS,
  SEARCH_ITERATIONS,
  type EqualiseProgress,
  type EqualiseOutcome,
} from "./equalise";

// Deterministic, seedable PRNG (mulberry32) so the search and its
// measurements are reproducible run-to-run — a flaky central claim would be
// a broken central claim. Not exported from sim.ts/equalise.ts: production
// code always uses real Math.random (see main.ts), only tests need seeding.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOUNDS = {
  enemyHealth: { min: 10, max: 100, step: 5 },
  enemySpeed: { min: 0, max: 100, step: 5 },
  enemySpawnCount: { min: 1, max: 8, step: 1 },
};

// Three deliberately different, unequal-by-construction archetypes — the
// same presets main.ts starts each panel at.
const SWARM: DifficultyConfig = { enemyHealth: 20, enemySpeed: 65, enemySpawnCount: 3 };
const TANKS: DifficultyConfig = { enemyHealth: 90, enemySpeed: 8, enemySpawnCount: 1 };
const BALANCED: DifficultyConfig = { enemyHealth: 40, enemySpeed: 15, enemySpawnCount: 2 };

// Self-contained fixtures for the search tests below. Deliberately NOT the
// app's own presets: those are balance values that get retuned whenever the
// game is tuned, and tests keyed to them go red on every tuning pass while
// saying nothing about the search. These two are the same shape at two
// intensities, so a single multiplier can reach one from the other by
// construction — which is exactly the search's contract.
const SHAPE_LOW: DifficultyConfig = { enemyHealth: 30, enemySpeed: 50, enemySpawnCount: 2 };
const SHAPE_HIGH: DifficultyConfig = { enemyHealth: 45, enemySpeed: 75, enemySpawnCount: 3 };

function drainTo<T>(gen: Generator<unknown, T, void>): T {
  let result = gen.next();
  while (!result.done) result = gen.next();
  return result.value;
}

function drain(gen: Generator<EqualiseProgress, EqualiseOutcome, void>): EqualiseOutcome {
  let result = gen.next();
  while (!result.done) result = gen.next();
  return result.value;
}

describe("the equality claim can actually fail", () => {
  it("three untouched archetypes are NOT within tolerance of each other", () => {
    // This is the proof requirement: an equality check that can never fail
    // is worth less than no check. These three presets are 2-15x apart in
    // measured difficulty (see the slice-5 commit message for the scan) —
    // if this ever reports "equal", the tolerance logic itself is broken.
    const rng = mulberry32(1);
    const swarmMs = medianSurvivalMs(SWARM, FINAL_TRIALS, fleeNearestPolicy, rng);
    const tanksMs = medianSurvivalMs(TANKS, FINAL_TRIALS, fleeNearestPolicy, rng);
    const balancedMs = medianSurvivalMs(BALANCED, FINAL_TRIALS, fleeNearestPolicy, rng);

    const toleranceMs = swarmMs * TOLERANCE_FRACTION;
    expect(withinTolerance(swarmMs, tanksMs, toleranceMs)).toBe(false);
    expect(withinTolerance(swarmMs, balancedMs, toleranceMs)).toBe(false);
  });
});

describe("equalising an archetype whose enemies are fast enough to be caught", () => {
  it("converges to within tolerance, deterministically, shape intact", () => {
    const rng = mulberry32(7);
    const targetMs = medianSurvivalMs(SHAPE_HIGH, FINAL_TRIALS, fleeNearestPolicy, rng);
    const toleranceMs = targetMs * TOLERANCE_FRACTION;

    const swarmOutcome = drain(equalisePanel(SHAPE_LOW, BOUNDS, targetMs, toleranceMs, rng, SEARCH_TRIALS, SEARCH_ITERATIONS));
    expect(swarmOutcome.status).toBe("matched");

    // Re-verify at full trial count, same as main.ts does before reporting —
    // the search's own trials=21 estimate isn't the number that gets
    // compared.
    const swarmVerified = medianSurvivalMs(swarmOutcome.config, FINAL_TRIALS, fleeNearestPolicy, rng);
    expect(withinTolerance(targetMs, swarmVerified, toleranceMs)).toBe(true);

    // The shape survives: swarm stays the low-health/high-speed archetype
    // relative to its own starting ratios, not drifted toward BALANCED's.
    expect(swarmOutcome.config.enemySpeed).toBeGreaterThan(swarmOutcome.config.enemyHealth);
  });

  it(
    "is not flaky — the same seeds produce the same result three times running",
    () => {
      function run() {
        const rng = mulberry32(42);
        const targetMs = medianSurvivalMs(SHAPE_HIGH, FINAL_TRIALS, fleeNearestPolicy, rng);
        const toleranceMs = targetMs * TOLERANCE_FRACTION;
        const outcome = drain(equalisePanel(SHAPE_LOW, BOUNDS, targetMs, toleranceMs, rng, SEARCH_TRIALS, SEARCH_ITERATIONS));
        return outcome.config;
      }
      const a = run();
      const b = run();
      const c = run();
      expect(a).toEqual(b);
      expect(b).toEqual(c);
    },
    15000,
  );
});

// REMOVED, and worth saying why rather than deleting quietly. A test used to
// live here asserting that TANKS — enemies far below ENEMY_PURSUIT_SPEED_RATING
// — could not be equalised at all, because a run there ended only by cornering
// and accumulation, a bimodal process a single-multiplier bisection cannot land
// inside tolerance against. That was true and measured at the time, and it was
// the sharpest finding in this repo.
//
// Changing the player from 100 hit points to three hearts falsified it. With
// three touches ending a run, a slow crowd no longer needs to grind anyone
// down: measured across 41 headless runs at speeds 5, 10, 20 and 35, not one
// reached the headless cap, and the distribution stopped being bimodal. The
// search now converges on shapes it used to give up on.
//
// The honest response is to retire the claim, not to keep a green test
// standing over a phenomenon that no longer occurs. The reporting contract it
// also covered — that an unreachable target is reported rather than papered
// over with a closest attempt — is still asserted below.

describe("when a target can't be reached", () => {
  it("reports 'unreachable' rather than silently returning its closest attempt", () => {
    const rng = mulberry32(3);
    // TANKS is already the hardest shape this bounds set allows it to be
    // scaled toward (health/damage both near their ceiling relative to
    // speed) — asking it to match a target far harder than SWARM's easiest
    // achievable time exceeds what raising its multiplier can ever reach at
    // these bounds, since every axis saturates.
    const impossibleTargetMs = 1; // effectively "die instantly" — no config's floor time is this low
    const toleranceMs = 50;
    const outcome = drain(equalisePanel(TANKS, BOUNDS, impossibleTargetMs, toleranceMs, rng, SEARCH_TRIALS, SEARCH_ITERATIONS));

    expect(outcome.status).toBe("unreachable");
    if (outcome.status === "unreachable") {
      expect(outcome.reason).toBe("ceiling");
    }
  });
});

describe("a measurement that ran out of time says so", () => {
  // Enemies that never move can never reach the player, so every trial runs
  // to the headless cap. The median is then not a survival time at all — it
  // is a lower bound, and reporting it as though it were measured is exactly
  // the kind of unearned number this whole prototype exists to argue against.
  const UNKILLABLE: DifficultyConfig = { enemyHealth: 100, enemySpeed: 0, enemySpawnCount: 1 };

  it("reports how many trials were cut off, and that the median is a floor", () => {
    const rng = mulberry32(5);
    const measured = drainTo(measurementSteps(UNKILLABLE, 11, fleeNearestPolicy, rng));

    expect(measured.trials).toBe(11);
    expect(measured.cappedTrials, "no trial was recorded as cut off").toBe(11);
    // >= rather than ==: runHeadless steps while elapsed < cap, so it
    // overshoots by one 16.67ms step. The cap is a floor, not a landing spot.
    expect(measured.medianMs).toBeGreaterThanOrEqual(HEADLESS_MAX_MS);
    expect(measured.censored, "a median sitting on the cap is a lower bound, not a measurement").toBe(true);
  });

  it("does not cry censorship on a configuration that resolves in time", () => {
    const rng = mulberry32(5);
    const measured = drainTo(measurementSteps({ enemyHealth: 65, enemySpeed: 60, enemySpawnCount: 3 }, 11, fleeNearestPolicy, rng));

    expect(measured.cappedTrials).toBe(0);
    expect(measured.censored).toBe(false);
    expect(measured.medianMs).toBeLessThan(HEADLESS_MAX_MS);
  });
});

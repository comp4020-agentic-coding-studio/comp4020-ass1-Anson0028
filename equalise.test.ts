// Tests the equalisation search itself — pure, DOM-free, so these run
// against the algorithm directly rather than through main.ts's UI and its
// frame-chunked driver (which exists purely to spread the same work across
// animation frames — see main.ts's FRAME_BUDGET_MS comment. Draining a
// generator in a tight loop here is the same computation, just not paced).
import { describe, expect, it } from "vitest";
import { medianSurvivalMs, fleeNearestPolicy, type DifficultyConfig } from "./sim";
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
  enemyHealth: { min: 10, max: 100 },
  enemySpeed: { min: 0, max: 100 },
  enemyDamage: { min: 0, max: 50 },
};

// Three deliberately different, unequal-by-construction archetypes — the
// same presets main.ts starts each panel at.
const SWARM: DifficultyConfig = { enemyHealth: 20, enemySpeed: 70, enemyDamage: 10 };
const TANKS: DifficultyConfig = { enemyHealth: 90, enemySpeed: 10, enemyDamage: 30 };
const BALANCED: DifficultyConfig = { enemyHealth: 40, enemySpeed: 15, enemyDamage: 15 };

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
    const targetMs = medianSurvivalMs(BALANCED, FINAL_TRIALS, fleeNearestPolicy, rng);
    const toleranceMs = targetMs * TOLERANCE_FRACTION;

    const swarmOutcome = drain(equalisePanel(SWARM, BOUNDS, targetMs, toleranceMs, rng, SEARCH_TRIALS, SEARCH_ITERATIONS));
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
        const targetMs = medianSurvivalMs(BALANCED, FINAL_TRIALS, fleeNearestPolicy, rng);
        const toleranceMs = targetMs * TOLERANCE_FRACTION;
        const outcome = drain(equalisePanel(SWARM, BOUNDS, targetMs, toleranceMs, rng, SEARCH_TRIALS, SEARCH_ITERATIONS));
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

describe("equalising an archetype whose enemies are too slow to ever be caught", () => {
  // TANKS's enemySpeed (10) is well below ENEMY_PURSUIT_SPEED_RATING (60,
  // sim.ts) — its enemies can never close distance on a fleeing player. A run
  // there only ends by accumulation and cornering over the run's length, which
  // is bimodal (cornered early, or hits the headless cap) rather than
  // concentrated, so a single-multiplier bisection can fail to land inside
  // tolerance even with the target well within [floor, ceiling]. That's a real
  // property of this archetype against this reference policy, not a bug in the
  // search — the assertions below require the search to REPORT that
  // honestly (status "unreachable", reason "budget") rather than silently
  // returning its closest attempt as if it were a match. If equalisePanel were
  // changed to return "matched" on budget exhaustion instead of reporting it,
  // this test goes red — verified by hand while writing it, not committed.
  it(
    "reports non-convergence rather than a false match, deterministically",
    () => {
      function run() {
        const rng = mulberry32(7);
        const targetMs = medianSurvivalMs(BALANCED, FINAL_TRIALS, fleeNearestPolicy, rng);
        const toleranceMs = targetMs * TOLERANCE_FRACTION;
        return drain(equalisePanel(TANKS, BOUNDS, targetMs, toleranceMs, rng, SEARCH_TRIALS, SEARCH_ITERATIONS));
      }
      const outcome = run();

      expect(outcome.status).toBe("unreachable");
      if (outcome.status !== "unreachable") return;
      expect(outcome.reason).toBe("budget");
      // Confirms the specific mechanism, not just that the budget ran out —
      // this is what the UI's message is allowed to assert too.
      expect(isCorneringRegime(outcome.config)).toBe(true);

      const second = run();
      const third = run();
      expect(second).toEqual(outcome);
      expect(third).toEqual(outcome);
    },
    15000,
  );
});

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

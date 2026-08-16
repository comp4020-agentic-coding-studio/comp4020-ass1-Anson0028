// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  fleeNearestPolicy,
  measurementSteps,
  HEADLESS_MAX_MS,
  type DifficultyConfig,
} from "./sim";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drainTo<T>(gen: Generator<unknown, T, void>): T {
  let result = gen.next();
  while (!result.done) result = gen.next();
  return result.value;
}

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

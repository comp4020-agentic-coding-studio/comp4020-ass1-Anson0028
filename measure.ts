// Pure, DOM-free measurement — no canvas, no requestAnimationFrame, no
// wall-clock reads. Yields once per *trial* (one `runHeadless` call) rather
// than once per whole measurement: that granularity is the difference between
// a per-frame time budget actually pacing the work and merely decorating it
// (see main.ts's FRAME_BUDGET_MS for the measurement that caught it
// decorating). main.ts drains this a little at a time per animation frame.
//
// This file used to be `equalise.ts` and carried a bisection search that
// retuned two panels to match a third. When the panels became a labelled
// Easy/Medium/Hard ladder, the question changed from "can these be made
// equal" to "is the ladder you labelled actually a ladder", and the search
// stopped having a caller. It is deleted rather than kept: ~180 lines of
// unreachable code with passing tests is worse than no code, because the
// green ticks imply something is being protected. It is still readable at
// 0285ce1 and earlier, and PROCESS.md cites it there.
import { fleeNearestPolicy, measurementSteps, type DifficultyConfig, type Measurement } from "./sim";

// The resolution of the control that displays each axis. The UI builds its
// sliders from these, so a value it shows is always one the control can hold.
export type AxisBounds = Record<keyof DifficultyConfig, { min: number; max: number; step: number }>;

// Trials per Monte Carlo measurement. 51, so every number the page reports
// shares one precision — see main.ts, which prints the count beside every
// figure rather than relying on the reader having seen it explained once.
export const FINAL_TRIALS = 51;

// How close two survival times have to be to count as the same, derived from
// this simulation's own measured sampling noise rather than picked: a
// 51-trial median carries ~1.4-2.2% relative noise, comparing two independent
// ones gives ~sqrt(2) times that, and tripling for a non-flaky margin lands
// near 9%. Stage two judges the visitor's answer against this rather than
// against a second, freshly invented threshold with no provenance.
export const TOLERANCE_FRACTION = 0.09;

// A pacing pulse: one simulated run finished. Carries nothing else, because a
// single trial's result means nothing on its own.
export type MeasureProgress = { kind: "trial" } | { kind: "panel-start"; panel: number };

export function* measurePanels(
  panels: readonly number[],
  getPanelConfig: (panel: number) => Readonly<DifficultyConfig>,
  rng: () => number,
): Generator<MeasureProgress, Map<number, Measurement>, void> {
  const results = new Map<number, Measurement>();
  for (const panel of panels) {
    yield { kind: "panel-start", panel };
    // measurementSteps, not a bare median: the UI reports these numbers to a
    // reader, so it has to know whether each one is a measurement or a floor.
    const gen = measurementSteps(getPanelConfig(panel), FINAL_TRIALS, fleeNearestPolicy, rng);
    let step = gen.next();
    while (!step.done) {
      yield { kind: "trial" };
      step = gen.next();
    }
    results.set(panel, step.value);
  }
  return results;
}

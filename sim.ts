// Pure, DOM-free simulation. No canvas, no requestAnimationFrame, no
// wall-clock reads — step() only ever advances by the `dt` it's given. That's
// what lets the same function drive the live, rendered game (real dt, real
// keyboard input) AND a headless run (fixed dt, scripted input, no delay
// between steps) for the equalise-difficulty search in slice 5: many
// simulated runs per second, not one real-time run per multi-minute wait.
//
// Everything here runs in normalised (0-1) arena coordinates — see CLAUDE.md.

export type Vec2 = { x: number; y: number };
export type Enemy = Vec2 & { health: number };

// The three quantities the difficulty sliders drive. These are "ratings", not
// raw physical units — enemyHealth is hit points directly, enemyDamage is
// contact damage per second directly, but enemySpeed is a 0-100 rating where
// 100 means "crosses the whole arena in one second" (see moveEnemies). The
// mirror published to the DOM shows exactly these rating numbers, unconverted
// — "applied-speed" is what's on the slider, not a derived physics value.
export type DifficultyConfig = {
  enemyHealth: number;
  enemySpeed: number;
  // How many arrive per spawn tick. This axis replaced enemyDamage: with three
  // hearts and one heart lost per contact, a damage dial had no resolution
  // left to express — 10 and 30 would both have meant "you died", and the
  // control would have been decorative. How many turn up does still change
  // the answer. See CLAUDE.md.
  enemySpawnCount: number;
};

export const DEFAULT_DIFFICULTY: DifficultyConfig = {
  enemyHealth: 40,
  enemySpeed: 15,
  enemySpawnCount: 2,
};

// Desired movement direction; magnitude beyond sign is currently ignored (see
// movePlayer) — keyboard input is always a unit direction. Revisit if/when
// proportional touch-drag needs magnitude to matter.
export type Input = { x: number; y: number };

export type SimState = {
  player: Vec2;
  playerHearts: number;
  // Seconds of immunity left after a hit. Per-hit damage needs this: without
  // it, three consecutive frames of contact take three hearts in ~50ms, which
  // is a rounding error rather than a difficulty setting.
  invulnerableFor: number;
  enemies: Enemy[];
  running: boolean;
  elapsedMs: number;
  attackCooldown: number;
  spawnCooldown: number;
};

export const PLAYER_SPEED = 0.6; // arena-fractions per second

// enemySpeed is a 0-100 rating; PLAYER_SPEED is a fixed fraction/second, so
// this is the rating at which an enemy's raw speed equals the player's — not
// an independently-chosen number, derived from PLAYER_SPEED so the two can
// never drift apart. Below it, an enemy can never close distance on a player
// that's actively fleeing it (fleeNearestPolicy flees directly away once
// triggered): the enemy is simply slower. A run at that rating only ends by
// accumulation and cornering as more enemies spawn over the run's length, a
// qualitatively different, high-variance process from the "gets caught"
// pursuit regime above this line. See equalise.ts's isCorneringRegime, which
// reads this to explain (not just report) why a slow archetype can fail to
// converge under the equalise search.
export const ENEMY_PURSUIT_SPEED_RATING = PLAYER_SPEED * 100;
// Three hearts, not a hundred hit points — see CLAUDE.md. Contact costs whole
// hearts on impact, so damage has to buy something discrete; heartsPerHit maps
// the dial onto that. Without the mapping the damage slider would be
// decorative, since every contact would cost exactly one.
export const PLAYER_MAX_HEARTS = 3;
// 2.0s, not the 0.9s this started at. Measured: Swarm's own three dials barely
// move its difficulty (dropping from four arrivals per tick to two moved the
// median 5.5s -> 6.7s, and halving enemy health moved it almost nothing) while
// this one constant took Swarm from 5.6s to 8.3s. Worth recording because it
// is the tool's own thesis turned on its author: the dial that looked like the
// difficulty knob wasn't, and only measuring said so.
export const PLAYER_INVULNERABLE_SECONDS = 2.0;
export const HEARTS_PER_HIT = 1;
export const PLAYER_ATTACK_RANGE = 0.12; // arena-fractions
export const PLAYER_ATTACK_DAMAGE = 20;
export const PLAYER_ATTACK_INTERVAL = 0.4; // seconds between automatic attack pulses
export const ENEMY_CONTACT_RADIUS = 0.03; // arena-fractions
// 1.8s, up from 1.2s. Hard was unpleasant at the old rate and none of the
// per-archetype dials could fix it without breaking the even stepping the
// whole argument rests on — measured, the ladder's Hard step moved only
// 6.4s -> 7.2s across four different preset sets. The arrival rate is the
// lever that isn't on any slider.
export const ENEMY_SPAWN_INTERVAL = 1.8; // seconds

export function createInitialState(): SimState {
  return {
    player: { x: 0.5, y: 0.5 },
    playerHearts: PLAYER_MAX_HEARTS,
    invulnerableFor: 0,
    enemies: [],
    running: true,
    elapsedMs: 0,
    attackCooldown: PLAYER_ATTACK_INTERVAL,
    spawnCooldown: ENEMY_SPAWN_INTERVAL,
  };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function spawnEnemy(config: Readonly<DifficultyConfig>, rng: () => number): Enemy {
  const side = Math.floor(rng() * 4);
  const along = rng();
  const [x, y] = side === 0 ? [0, along] : side === 1 ? [1, along] : side === 2 ? [along, 0] : [along, 1];
  return { x, y, health: config.enemyHealth };
}

function movePlayer(state: SimState, dt: number, input: Input): void {
  const { x: dx, y: dy } = input;
  if (dx === 0 && dy === 0) return;
  const len = Math.hypot(dx, dy);
  state.player.x = clamp01(state.player.x + (dx / len) * PLAYER_SPEED * dt);
  state.player.y = clamp01(state.player.y + (dy / len) * PLAYER_SPEED * dt);
}

function moveEnemies(state: SimState, dt: number, config: Readonly<DifficultyConfig>): void {
  const speed = config.enemySpeed / 100; // rating -> arena-fractions/second
  for (const enemy of state.enemies) {
    const dx = state.player.x - enemy.x;
    const dy = state.player.y - enemy.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1e-6) {
      enemy.x += (dx / dist) * speed * dt;
      enemy.y += (dy / dist) * speed * dt;
    }
  }
}

// No `config` parameter any more: contact costs one heart flat, so nothing
// here reads the difficulty dials. It used to take damage-per-second from
// them, which is what the three-hearts change removed.
function applyContactDamage(state: SimState, dt: number): void {
  state.invulnerableFor = Math.max(0, state.invulnerableFor - dt);
  if (state.invulnerableFor > 0) return;
  for (const enemy of state.enemies) {
    const dist = Math.hypot(enemy.x - state.player.x, enemy.y - state.player.y);
    if (dist <= ENEMY_CONTACT_RADIUS) {
      // One hit per immunity window however many enemies are touching: being
      // surrounded should kill by denying escape, which is what the cornering
      // regime already is, not by multiplying a single instant.
      state.playerHearts -= HEARTS_PER_HIT;
      state.invulnerableFor = PLAYER_INVULNERABLE_SECONDS;
      return;
    }
  }
}

function runAutomaticAttack(state: SimState, dt: number): void {
  state.attackCooldown -= dt;
  if (state.attackCooldown > 0) return;
  state.attackCooldown += PLAYER_ATTACK_INTERVAL;
  for (const enemy of state.enemies) {
    const dist = Math.hypot(enemy.x - state.player.x, enemy.y - state.player.y);
    if (dist <= PLAYER_ATTACK_RANGE) {
      enemy.health -= PLAYER_ATTACK_DAMAGE;
    }
  }
  state.enemies = state.enemies.filter((enemy) => enemy.health > 0);
}

export function step(
  state: SimState,
  dt: number,
  input: Input,
  config: Readonly<DifficultyConfig>,
  rng: () => number = Math.random,
): void {
  if (!state.running) return;

  movePlayer(state, dt, input);

  state.spawnCooldown -= dt;
  if (state.spawnCooldown <= 0) {
    state.spawnCooldown += ENEMY_SPAWN_INTERVAL;
    const count = Math.max(0, Math.round(config.enemySpawnCount));
    for (let i = 0; i < count; i++) state.enemies.push(spawnEnemy(config, rng));
  }

  moveEnemies(state, dt, config);
  applyContactDamage(state, dt);
  runAutomaticAttack(state, dt);

  state.elapsedMs += dt * 1000;
  if (state.playerHearts <= 0) {
    state.playerHearts = 0;
    state.running = false;
  }
}

export type Policy = (state: SimState) => Input;

// Flee directly away from the nearest enemy once one is within double the
// player's attack range, otherwise hold still. Not meant to be a *good*
// player — just a fixed, reproducible stand-in so different difficulty
// configs get measured against the same yardstick.
export function fleeNearestPolicy(state: SimState): Input {
  let nearest: Enemy | undefined;
  let nearestDist = Infinity;
  for (const enemy of state.enemies) {
    const dist = Math.hypot(enemy.x - state.player.x, enemy.y - state.player.y);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = enemy;
    }
  }
  if (!nearest || nearestDist > PLAYER_ATTACK_RANGE * 2) return { x: 0, y: 0 };
  return { x: state.player.x - nearest.x, y: state.player.y - nearest.y };
}

const HEADLESS_DT = 1 / 60;
// Exported because a number produced under this cap has to be able to say so.
// A trial that reached it didn't survive 300s; it survived AT LEAST 300s, and
// the difference matters to anyone reading the result as a measurement.
export const HEADLESS_MAX_MS = 5 * 60 * 1000; // cap so an unkillable config can't hang a search or test

// Runs one simulation to its natural end (or the time cap) with no delay
// between steps — this is the "faster than real time" headless run.
export function runHeadless(
  config: Readonly<DifficultyConfig>,
  policy: Policy = fleeNearestPolicy,
  rng: () => number = Math.random,
): number {
  const state = createInitialState();
  while (state.running && state.elapsedMs < HEADLESS_MAX_MS) {
    step(state, HEADLESS_DT, policy(state), config, rng);
  }
  return state.elapsedMs;
}

function medianOf(results: number[]): number {
  const sorted = [...results].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Same measurement as medianSurvivalMs, but yields once per trial instead of
// running the whole batch synchronously — the difference between "the page
// freezes for the whole measurement" and "a caller can pace this across
// animation frames". See equalise.ts's measureSteps, which is what actually
// drives this per trial, and main.ts's FRAME_BUDGET_MS comment for why this
// granularity, not the whole-batch one, is what a "must not freeze" UI needs.
export function* medianSurvivalMsSteps(
  config: Readonly<DifficultyConfig>,
  trials: number,
  policy: Policy = fleeNearestPolicy,
  rng: () => number = Math.random,
): Generator<void, number, void> {
  const results: number[] = [];
  for (let i = 0; i < trials; i++) {
    results.push(runHeadless(config, policy, rng));
    yield;
  }
  return medianOf(results);
}

// What a measurement actually knows about itself. `censored` is true only when
// the median itself sits on the cap: below that the median is exact even with
// some trials capped, because every capped trial's true value lies above the
// observed one and therefore above the median. `cappedTrials` is reported
// separately because "a fifth of the runs never resolved" tells a designer
// something real about a configuration even when the median is sound.
export type Measurement = {
  medianMs: number;
  trials: number;
  cappedTrials: number;
  censored: boolean;
};

export function* measurementSteps(
  config: Readonly<DifficultyConfig>,
  trials: number,
  policy: Policy = fleeNearestPolicy,
  rng: () => number = Math.random,
): Generator<void, Measurement, void> {
  const results: number[] = [];
  for (let i = 0; i < trials; i++) {
    results.push(runHeadless(config, policy, rng));
    yield;
  }
  const medianMs = medianOf(results);
  return {
    medianMs,
    trials,
    cappedTrials: results.filter((ms) => ms >= HEADLESS_MAX_MS).length,
    censored: medianMs >= HEADLESS_MAX_MS,
  };
}

export function medianSurvivalMs(
  config: Readonly<DifficultyConfig>,
  trials = 51,
  policy: Policy = fleeNearestPolicy,
  rng: () => number = Math.random,
): number {
  return medianOf(Array.from({ length: trials }, () => runHeadless(config, policy, rng)));
}

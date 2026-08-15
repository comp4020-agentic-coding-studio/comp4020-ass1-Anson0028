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
  enemyDamage: number;
};

export const DEFAULT_DIFFICULTY: DifficultyConfig = {
  enemyHealth: 40,
  enemySpeed: 15,
  enemyDamage: 15,
};

// Desired movement direction; magnitude beyond sign is currently ignored (see
// movePlayer) — keyboard input is always a unit direction. Revisit if/when
// proportional touch-drag needs magnitude to matter.
export type Input = { x: number; y: number };

export type SimState = {
  player: Vec2;
  playerHealth: number;
  enemies: Enemy[];
  running: boolean;
  elapsedMs: number;
  attackCooldown: number;
  spawnCooldown: number;
};

export const PLAYER_SPEED = 0.6; // arena-fractions per second
export const PLAYER_MAX_HEALTH = 100;
export const PLAYER_ATTACK_RANGE = 0.12; // arena-fractions
export const PLAYER_ATTACK_DAMAGE = 20;
export const PLAYER_ATTACK_INTERVAL = 0.4; // seconds between automatic attack pulses
export const ENEMY_CONTACT_RADIUS = 0.03; // arena-fractions
export const ENEMY_SPAWN_INTERVAL = 1.2; // seconds

export function createInitialState(): SimState {
  return {
    player: { x: 0.5, y: 0.5 },
    playerHealth: PLAYER_MAX_HEALTH,
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

function applyContactDamage(state: SimState, dt: number, config: Readonly<DifficultyConfig>): void {
  for (const enemy of state.enemies) {
    const dist = Math.hypot(enemy.x - state.player.x, enemy.y - state.player.y);
    if (dist <= ENEMY_CONTACT_RADIUS) {
      state.playerHealth -= config.enemyDamage * dt;
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
    state.enemies.push(spawnEnemy(config, rng));
  }

  moveEnemies(state, dt, config);
  applyContactDamage(state, dt, config);
  runAutomaticAttack(state, dt);

  state.elapsedMs += dt * 1000;
  if (state.playerHealth <= 0) {
    state.playerHealth = 0;
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
const HEADLESS_MAX_MS = 5 * 60 * 1000; // cap so an unkillable config can't hang a search or test

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

export function medianSurvivalMs(
  config: Readonly<DifficultyConfig>,
  trials = 51,
  policy: Policy = fleeNearestPolicy,
  rng: () => number = Math.random,
): number {
  const results = Array.from({ length: trials }, () => runHeadless(config, policy, rng)).sort((a, b) => a - b);
  const mid = Math.floor(results.length / 2);
  return results.length % 2 === 0 ? (results[mid - 1] + results[mid]) / 2 : results[mid];
}

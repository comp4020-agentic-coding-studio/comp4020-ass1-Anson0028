// The simulation runs in normalised coordinates: the arena is 1x1, and every
// position, velocity and distance here is a fraction of it. Pixels only exist
// in render(), where a fraction is multiplied by the canvas's current size.
// See CLAUDE.md — this is what keeps difficulty the same at both marking
// viewports and makes resize safe by construction.
type Vec2 = { x: number; y: number };

type Enemy = Vec2 & { health: number };

type GameState = {
  player: Vec2;
  playerHealth: number;
  enemies: Enemy[];
  running: boolean;
  elapsedMs: number;
  attackCooldown: number;
  spawnCooldown: number;
};

const PLAYER_SPEED = 0.6; // arena-fractions per second
const PLAYER_RADIUS = 0.02; // fraction of the canvas's shorter side
const PLAYER_MAX_HEALTH = 100;
const PLAYER_ATTACK_RANGE = 0.12; // arena-fractions
const PLAYER_ATTACK_DAMAGE = 20;
const PLAYER_ATTACK_INTERVAL = 0.4; // seconds between automatic attack pulses

const ENEMY_RADIUS = 0.018;
const ENEMY_CONTACT_RADIUS = 0.03; // arena-fractions; overlap within this deals contact damage
const ENEMY_SPAWN_INTERVAL = 1.2; // seconds

// The three quantities the difficulty sliders will drive in slice 3. Speed
// and contact damage are read fresh every frame (a live change affects every
// enemy immediately); health is only read when an enemy spawns (changing max
// health doesn't retroactively heal or hurt enemies already mid-fight).
const difficulty = {
  enemyHealth: 40,
  enemySpeed: 0.15, // arena-fractions per second
  enemyDamage: 15, // per second of contact
};

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

  app.append(panel);

  const ctx = canvas.getContext("2d"); // null under jsdom (no `canvas` package) — render() guards it

  const state: GameState = {
    player: { x: 0.5, y: 0.5 },
    playerHealth: PLAYER_MAX_HEALTH,
    enemies: [],
    running: true,
    elapsedMs: 0,
    attackCooldown: PLAYER_ATTACK_INTERVAL,
    spawnCooldown: ENEMY_SPAWN_INTERVAL,
  };

  const pressed = new Set<string>();
  window.addEventListener("keydown", (e) => pressed.add(e.code));
  window.addEventListener("keyup", (e) => pressed.delete(e.code));

  function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n));
  }

  function resizeCanvas(): void {
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  function spawnEnemy(): Enemy {
    const side = Math.floor(Math.random() * 4);
    const along = Math.random();
    const [x, y] =
      side === 0 ? [0, along] : side === 1 ? [1, along] : side === 2 ? [along, 0] : [along, 1];
    return { x, y, health: difficulty.enemyHealth };
  }

  function movePlayer(dt: number): void {
    let dx = 0;
    let dy = 0;
    if (pressed.has("ArrowLeft")) dx -= 1;
    if (pressed.has("ArrowRight")) dx += 1;
    if (pressed.has("ArrowUp")) dy -= 1;
    if (pressed.has("ArrowDown")) dy += 1;
    if (dx === 0 && dy === 0) return;
    const len = Math.hypot(dx, dy);
    state.player.x = clamp01(state.player.x + (dx / len) * PLAYER_SPEED * dt);
    state.player.y = clamp01(state.player.y + (dy / len) * PLAYER_SPEED * dt);
  }

  function moveEnemies(dt: number): void {
    for (const enemy of state.enemies) {
      const dx = state.player.x - enemy.x;
      const dy = state.player.y - enemy.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1e-6) {
        enemy.x += (dx / dist) * difficulty.enemySpeed * dt;
        enemy.y += (dy / dist) * difficulty.enemySpeed * dt;
      }
    }
  }

  function applyContactDamage(dt: number): void {
    for (const enemy of state.enemies) {
      const dist = Math.hypot(enemy.x - state.player.x, enemy.y - state.player.y);
      if (dist <= ENEMY_CONTACT_RADIUS) {
        state.playerHealth -= difficulty.enemyDamage * dt;
      }
    }
  }

  function runAutomaticAttack(dt: number): void {
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

  function update(dt: number): void {
    if (!state.running) return;

    movePlayer(dt);

    state.spawnCooldown -= dt;
    if (state.spawnCooldown <= 0) {
      state.spawnCooldown += ENEMY_SPAWN_INTERVAL;
      state.enemies.push(spawnEnemy());
    }

    moveEnemies(dt);
    applyContactDamage(dt);
    runAutomaticAttack(dt);

    state.elapsedMs += dt * 1000;
    if (state.playerHealth <= 0) {
      state.playerHealth = 0;
      state.running = false;
    }
  }

  function render(): void {
    if (!ctx || canvas.width === 0 || canvas.height === 0) return;
    const side = Math.min(canvas.width, canvas.height);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#888";
    for (const enemy of state.enemies) {
      ctx.beginPath();
      ctx.arc(enemy.x * canvas.width, enemy.y * canvas.height, ENEMY_RADIUS * side, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#e8e8e8";
    ctx.beginPath();
    ctx.arc(state.player.x * canvas.width, state.player.y * canvas.height, PLAYER_RADIUS * side, 0, Math.PI * 2);
    ctx.fill();
  }

  function formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  // The one place the mirror (and the HUD text) is written, from `state`
  // itself, once per frame — see CLAUDE.md's mirror-drift guard. Never set
  // these piecemeal elsewhere.
  function publishState(): void {
    mirror.dataset.running = String(state.running);
    mirror.dataset.elapsedMs = String(Math.round(state.elapsedMs));
    mirror.dataset.playerX = String(state.player.x);
    mirror.dataset.playerY = String(state.player.y);
    mirror.dataset.appliedHealth = String(difficulty.enemyHealth);
    mirror.dataset.appliedSpeed = String(difficulty.enemySpeed);
    mirror.dataset.appliedDamage = String(difficulty.enemyDamage);

    timerEl.textContent = formatTime(state.elapsedMs);
    healthEl.textContent = `HP ${Math.ceil(state.playerHealth)}`;
  }

  let lastFrameTime: number | undefined;
  function loop(now: number): void {
    if (lastFrameTime !== undefined) {
      update((now - lastFrameTime) / 1000);
    }
    lastFrameTime = now;
    render();
    publishState();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

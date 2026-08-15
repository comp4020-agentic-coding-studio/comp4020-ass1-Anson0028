// The live, rendered game. All simulation logic lives in ./sim (pure,
// DOM-free, headlessly runnable) — this file is deliberately just DOM setup,
// canvas rendering, and a requestAnimationFrame loop that feeds real dt and
// real keyboard input into sim's step().
import { createInitialState, step, DEFAULT_DIFFICULTY, type DifficultyConfig, type Input } from "./sim";

const PLAYER_RADIUS = 0.02; // fraction of the canvas's shorter side
const ENEMY_RADIUS = 0.018;

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

  // The three difficulty dials write directly into this object; sim's step()
  // reads it fresh every frame, so a change takes effect immediately — no
  // restart, no second copy of "the current difficulty" to keep in sync.
  const config: DifficultyConfig = { ...DEFAULT_DIFFICULTY };

  const sliders = document.createElement("div");
  sliders.className = "sliders";

  function addSlider(
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
    input.value = String(config[key]);

    const value = document.createElement("span");
    value.className = "tabular slider-value";
    value.textContent = input.value;

    input.addEventListener("input", () => {
      config[key] = Number(input.value);
      value.textContent = input.value;
    });

    row.append(name, input, value);
    sliders.append(row);
  }

  addSlider("enemyHealth", "enemy-health", "Enemy health", 10, 100, 5);
  addSlider("enemySpeed", "enemy-speed", "Enemy speed", 0, 100, 5);
  addSlider("enemyDamage", "enemy-damage", "Enemy damage", 0, 50, 5);

  panel.append(sliders);
  app.append(panel);

  const ctx = canvas.getContext("2d"); // null under jsdom (no `canvas` package) — render() guards it

  const state = createInitialState();

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

  function resizeCanvas(): void {
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

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
    mirror.dataset.appliedHealth = String(config.enemyHealth);
    mirror.dataset.appliedSpeed = String(config.enemySpeed);
    mirror.dataset.appliedDamage = String(config.enemyDamage);

    timerEl.textContent = formatTime(state.elapsedMs);
    healthEl.textContent = `HP ${Math.ceil(state.playerHealth)}`;
  }

  let lastFrameTime: number | undefined;
  function loop(now: number): void {
    if (lastFrameTime !== undefined) {
      step(state, (now - lastFrameTime) / 1000, keyboardInput(), config);
    }
    lastFrameTime = now;
    render();
    publishState();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

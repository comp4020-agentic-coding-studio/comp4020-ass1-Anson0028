// The simulation runs in normalised coordinates: the arena is 1x1, and every
// position, velocity and distance here is a fraction of it. Pixels only exist
// in render(), where a fraction is multiplied by the canvas's current size.
// See CLAUDE.md — this is what keeps difficulty the same at both marking
// viewports and makes resize safe by construction.
type Vec2 = { x: number; y: number };

type GameState = {
  player: Vec2;
  running: boolean;
  elapsedMs: number;
};

const PLAYER_SPEED = 0.6; // arena-fractions per second
const PLAYER_RADIUS = 0.02; // fraction of the canvas's shorter side

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
  app.append(panel);

  const ctx = canvas.getContext("2d"); // null under jsdom (no `canvas` package) — render() guards it

  const state: GameState = {
    player: { x: 0.5, y: 0.5 },
    running: true,
    elapsedMs: 0,
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

  function update(dt: number): void {
    let dx = 0;
    let dy = 0;
    if (pressed.has("ArrowLeft")) dx -= 1;
    if (pressed.has("ArrowRight")) dx += 1;
    if (pressed.has("ArrowUp")) dy -= 1;
    if (pressed.has("ArrowDown")) dy += 1;
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      state.player.x = clamp01(state.player.x + (dx / len) * PLAYER_SPEED * dt);
      state.player.y = clamp01(state.player.y + (dy / len) * PLAYER_SPEED * dt);
    }
    state.elapsedMs += dt * 1000;
  }

  function render(): void {
    if (!ctx || canvas.width === 0 || canvas.height === 0) return;
    const side = Math.min(canvas.width, canvas.height);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#e8e8e8";
    ctx.beginPath();
    ctx.arc(state.player.x * canvas.width, state.player.y * canvas.height, PLAYER_RADIUS * side, 0, Math.PI * 2);
    ctx.fill();
  }

  // The one place the mirror is written, from `state` itself, once per frame
  // — see CLAUDE.md's mirror-drift guard. Never set these piecemeal elsewhere.
  function publishState(): void {
    mirror.dataset.running = String(state.running);
    mirror.dataset.elapsedMs = String(Math.round(state.elapsedMs));
    mirror.dataset.playerX = String(state.player.x);
    mirror.dataset.playerY = String(state.player.y);
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

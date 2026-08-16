#!/usr/bin/env node
// "Does it look good at 390×844" is a crit call. "Does anything overflow
// horizontally at 390×844" is a number, and a real browser can answer it —
// jsdom can't, since it has no layout engine. This loads the BUILT site
// (run `pnpm build` first) in real Chromium at both marking viewports and
// asserts nothing overflows horizontally, the app actually mounted, and the
// canvas's pixel buffer matches its rendered box.
//
// Served over real HTTP via Vite's own preview server (already a
// devDependency, so no new one) rather than opened as a file:// URL: a
// file:// origin is opaque per-file, so the built page's
// `<script type="module" crossorigin>` and `<link crossorigin>` get blocked
// by CORS and never run at all. That silently happened here for a long time
// — the overflow check was measuring an empty, unstyled document and staying
// green regardless, because nothing checked that the app had mounted or that
// the page loaded without errors. The three checks below exist so that
// failure mode is loud instead of invisible.
//
// Deliberately outside `pnpm check`: a browser launch is slower than the rest
// of the roster and needs `pnpm exec playwright install chromium` once.
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { preview } from "vite";

const DIST = resolve("dist");

// deviceScaleFactor matters here specifically: Playwright defaults to 1, which
// makes `expected = box * devicePixelRatio` always multiply by 1 and never
// actually exercise the devicePixelRatio term. 390×844 is marked under
// Chrome's device emulation at deviceScaleFactor 3 — that's the real number to
// check against, not the default.
const VIEWPORTS = [
  { name: "desktop", width: 1920, height: 1080, deviceScaleFactor: 1 },
  // hasTouch, because the phone viewport has no keyboard and the only way in
  // is a finger. Without it, Playwright pages have no touchscreen and the
  // question "can this be played here at all" cannot even be asked.
  { name: "phone", width: 390, height: 844, deviceScaleFactor: 3, hasTouch: true },
];

function htmlFiles(dir: string = DIST): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

async function main(): Promise<void> {
  if (!existsSync(DIST)) {
    console.error(`✗ ${DIST} not found — run \`pnpm build\` first`);
    process.exit(1);
  }

  const pages = htmlFiles();
  if (pages.length === 0) {
    console.error(`✗ no built pages found under ${DIST}`);
    process.exit(1);
  }

  let failed = false;
  const server = await preview({ preview: { port: 0 } });
  const baseUrl = server.resolvedUrls?.local[0];
  if (!baseUrl) {
    console.error("✗ preview server didn't report a URL");
    process.exit(1);
  }

  const browser = await chromium.launch();
  try {
    for (const path of pages) {
      const name = relative(DIST, path);
      const url = new URL(name, baseUrl).href;
      for (const viewport of VIEWPORTS) {
        const label = `${name} @ ${viewport.name} (${viewport.width}×${viewport.height})`;
        const page = await browser.newPage({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.deviceScaleFactor,
          hasTouch: viewport.hasTouch ?? false,
        });

        // Both kinds of error sat right in the console the whole time this
        // script was silently measuring a blank page — nothing was listening.
        const consoleErrors: string[] = [];
        const requestFailures: string[] = [];
        page.on("console", (msg) => {
          if (msg.type() === "error") consoleErrors.push(msg.text());
        });
        page.on("pageerror", (err) => consoleErrors.push(`uncaught exception: ${err.message}`));
        page.on("requestfailed", (req) => {
          requestFailures.push(`${req.url()} — ${req.failure()?.errorText ?? "unknown error"}`);
        });

        try {
          await page.goto(url, { waitUntil: "load" });

          function reportErrors(): void {
            for (const e of consoleErrors) console.error(`    console error: ${e}`);
            for (const r of requestFailures) console.error(`    failed request: ${r}`);
          }

          // 1. Liveness, first, before anything else is measured: every check
          // below is meaningless on a page where the app never mounted.
          try {
            await page.waitForFunction(
              () => {
                const canvas = document.querySelector('[data-testid="game-canvas"]');
                // Nine sliders (three panels x health/speed/damage), queried
                // generically rather than by nine hardcoded ids — this is
                // the one place in the repo that used to hardcode slider ids
                // (see CLAUDE.md's "Three configurations" section).
                const slidersPresent = document.querySelectorAll('input[type="range"]').length === 9;
                const state = document.querySelector('[data-testid="game-state"]');
                return !!canvas && slidersPresent && state instanceof HTMLElement && !!state.dataset.running;
              },
              { timeout: 5000 },
            );
          } catch {
            console.error(`✗ ${label}: app never mounted — canvas, sliders, or game-state missing after 5s`);
            reportErrors();
            failed = true;
            continue;
          }

          // 1b. The opening overlay has to actually leave the screen when it
          // is dismissed. Setting `hidden` did not: `#app section` (1,0,1)
          // outranked `.intro[hidden]` (0,2,0), so the property read true
          // while the computed display stayed `flex` and the overlay sat over
          // everything. jsdom cannot catch that — it asserts the flag and runs
          // no cascade — so the assertion belongs here, where there is a real
          // one. Everything measured below is measured over the dismissed
          // overlay, so this runs before any of it.
          const overlay = await page.evaluate(() => {
            const intro = document.querySelector<HTMLElement>('[data-testid="intro"]');
            const start = document.querySelector<HTMLButtonElement>('[data-testid="start-button"]');
            if (!intro || !start) return { ok: false, why: "no intro overlay or start control" };
            start.click();
            const display = getComputedStyle(intro).display;
            return display === "none"
              ? { ok: true, why: "" }
              : { ok: false, why: `dismissed overlay still computes display: ${display} (hidden=${intro.hidden})` };
          });
          if (!overlay.ok) {
            console.error(`✗ ${label}: ${overlay.why}`);
            reportErrors();
            failed = true;
            continue;
          }

          // 2. Errors during load are a failure on their own, mount or not —
          // an asset that 404s or a script that throws doesn't get to pass
          // just because the rest of the page happened to render.
          if (consoleErrors.length > 0 || requestFailures.length > 0) {
            console.error(`✗ ${label}: errors during load`);
            reportErrors();
            failed = true;
          }

          // 1c. Pausing must not move the layout. The paused hint used to be a
          // grid child of #app in its own right, so the moment it appeared it
          // consumed a cell and auto-placement pushed the entire right-hand
          // column down a row — every time the run paused. jsdom has no layout
          // engine and cannot see this class of bug at all; a real browser can.
          const shift = await page.evaluate(() => {
            const panel = document.querySelector<HTMLElement>('[data-testid="equalise-button"]')?.closest("section");
            const slider = document.querySelector<HTMLElement>('input[type="range"]');
            if (!panel || !slider) return { ok: false, why: "no difficulty panel or slider to measure" };
            const before = panel.getBoundingClientRect().top;
            // Pressing outside the arena pauses (CLAUDE.md), which is what
            // reveals the hint.
            slider.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            const after = panel.getBoundingClientRect().top;
            return Math.abs(after - before) < 1
              ? { ok: true, why: "" }
              : { ok: false, why: `pausing moved the difficulty panel ${(after - before).toFixed(1)}px` };
          });
          if (!shift.ok) {
            console.error(`✗ ${label}: ${shift.why}`);
            reportErrors();
            failed = true;
            continue;
          }

          // 1d. The phone viewport has to be playable by finger. CLAUDE.md
          // described relative touch-drag from week one and it was never
          // built: for the whole project the player could not move at all at
          // 390x844, and no check noticed, because the input tests dispatch
          // keyboard events and everything here measured layout.
          if (viewport.hasTouch) {
            const box = await page.locator('[data-testid="game-canvas"]').boundingBox();
            const state = page.locator('[data-testid="game-state"]');
            if (!box) {
              console.error(`✗ ${label}: no canvas to touch`);
              failed = true;
              continue;
            }
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            const before = Number(await state.getAttribute("data-player-x"));
            await page.touchscreen.tap(cx, cy);
            await page.waitForTimeout(60);
            // A drag, not a tap: dispatched directly because Playwright's
            // touchscreen has no move primitive.
            await page.evaluate(
              ([x, y]) => {
                const canvas = document.querySelector('[data-testid="game-canvas"]')!;
                const fire = (type: string, px: number) => {
                  const touch = new Touch({ identifier: 1, target: canvas, clientX: px, clientY: y });
                  canvas.dispatchEvent(new TouchEvent(type, { touches: [touch], cancelable: true, bubbles: true }));
                };
                fire("touchstart", x);
                fire("touchmove", x + 70);
              },
              [cx, cy],
            );
            await page.waitForTimeout(400);
            const after = Number(await state.getAttribute("data-player-x"));
            if (!(after > before)) {
              console.error(`✗ ${label}: dragging on the arena moved the player nowhere (${before} -> ${after})`);
              reportErrors();
              failed = true;
              continue;
            }
            console.log(`✓ ${label}: a finger can move the player`);
          }

          const { scrollWidth, clientWidth } = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          if (scrollWidth > clientWidth) {
            console.error(`✗ ${label}: horizontal overflow — scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`);
            failed = true;
          } else {
            console.log(`✓ ${label}: no horizontal overflow`);
          }

          // 3. jsdom can't run layout, so it can't tell a correctly-sized
          // canvas from a blurry or stretched one — that needs a real layout
          // engine. Compare the canvas's pixel buffer (canvas.width/.height)
          // against its rendered CSS box scaled by devicePixelRatio: a
          // mismatch is exactly what a resize handler that ignores DPR, or a
          // stale buffer left from before a resize, looks like.
          const { bufferWidth, bufferHeight, boxWidth, boxHeight, devicePixelRatio } = await page.evaluate(() => {
            const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="game-canvas"]')!;
            const rect = canvas.getBoundingClientRect();
            return {
              bufferWidth: canvas.width,
              bufferHeight: canvas.height,
              boxWidth: rect.width,
              boxHeight: rect.height,
              devicePixelRatio: window.devicePixelRatio,
            };
          });
          const expectedWidth = Math.round(boxWidth * devicePixelRatio);
          const expectedHeight = Math.round(boxHeight * devicePixelRatio);
          const TOLERANCE_PX = 1; // rendered box size is itself sub-pixel
          if (Math.abs(bufferWidth - expectedWidth) > TOLERANCE_PX || Math.abs(bufferHeight - expectedHeight) > TOLERANCE_PX) {
            console.error(
              `✗ ${label}: canvas pixel buffer ${bufferWidth}×${bufferHeight} doesn't match its rendered box ` +
                `${boxWidth}×${boxHeight} at devicePixelRatio ${devicePixelRatio} (expected ~${expectedWidth}×${expectedHeight})`,
            );
            failed = true;
          } else {
            console.log(`✓ ${label}: canvas buffer matches rendered box`);
          }
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
    await new Promise<void>((res, rej) => server.httpServer.close((err) => (err ? rej(err) : res())));
  }

  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

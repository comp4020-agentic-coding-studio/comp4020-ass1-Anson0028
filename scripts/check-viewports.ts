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

const VIEWPORTS = [
  { name: "desktop", width: 1920, height: 1080 },
  { name: "phone", width: 390, height: 844 },
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
        const page = await browser.newPage({ viewport });

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
                const slidersPresent = ["enemy-health", "enemy-speed", "enemy-damage"].every(
                  (id) => document.querySelector(`[data-testid="${id}"]`) !== null,
                );
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

          // 2. Errors during load are a failure on their own, mount or not —
          // an asset that 404s or a script that throws doesn't get to pass
          // just because the rest of the page happened to render.
          if (consoleErrors.length > 0 || requestFailures.length > 0) {
            console.error(`✗ ${label}: errors during load`);
            reportErrors();
            failed = true;
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

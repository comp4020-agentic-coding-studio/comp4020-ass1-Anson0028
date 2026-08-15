#!/usr/bin/env node
// "Does it look good at 390×844" is a crit call. "Does anything overflow
// horizontally at 390×844" is a number, and a real browser can answer it —
// jsdom can't, since it has no layout engine. This loads the BUILT site
// (run `pnpm build` first) in real Chromium at both marking viewports and
// asserts nothing overflows horizontally.
//
// Deliberately outside `pnpm check`: a browser launch is slower than the rest
// of the roster and needs `pnpm exec playwright install chromium` once.
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

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
  const browser = await chromium.launch();
  try {
    for (const path of pages) {
      const name = relative(DIST, path);
      for (const viewport of VIEWPORTS) {
        const page = await browser.newPage({ viewport });
        try {
          await page.goto(pathToFileURL(path).href);
          const { scrollWidth, clientWidth } = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          if (scrollWidth > clientWidth) {
            console.error(
              `✗ ${name} @ ${viewport.name} (${viewport.width}×${viewport.height}): horizontal overflow — scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`,
            );
            failed = true;
          } else {
            console.log(`✓ ${name} @ ${viewport.name} (${viewport.width}×${viewport.height})`);
          }
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

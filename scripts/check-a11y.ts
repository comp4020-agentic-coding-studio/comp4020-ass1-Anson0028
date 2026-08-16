#!/usr/bin/env node
// CLAUDE.md says out loud that nothing else in this repo measures
// accessibility and that wiring those sensors is this project's own work —
// this is that wiring. Same real-browser setup as check-viewports.ts (Vite's
// preview server + real Chromium, not jsdom, which has no layout engine and
// can't compute rendered colour, focus styling, or hit-target size) so it
// asserts against what actually ships, not a simulation of it.
//
// Deliberately outside `pnpm check`, same reason as check-viewports.ts: a
// browser launch is slower than the rest of the roster and needs
// `pnpm exec playwright install chromium` once.
//
// Four checks, each chosen to measure a real DOM/CSSOM property rather than
// assume one from markup — see CLAUDE.md's checks philosophy: an assertion
// that can't fail is worth less than no assertion. This repo already found
// four vacuous checks this week (see PROCESS.md); these are written to not be
// a fifth.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { preview } from "vite";

const DIST = resolve("dist");
const AXE_PATH = resolve("node_modules/axe-core/axe.min.js");

const DESKTOP = { name: "desktop", width: 1920, height: 1080, deviceScaleFactor: 1 };
const PHONE = { name: "phone", width: 390, height: 844, deviceScaleFactor: 3 };

async function main(): Promise<void> {
  if (!existsSync(DIST)) {
    console.error(`✗ ${DIST} not found — run \`pnpm build\` first`);
    process.exit(1);
  }
  if (!existsSync(AXE_PATH)) {
    console.error(`✗ ${AXE_PATH} not found — run \`pnpm add -D axe-core\``);
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
    for (const viewport of [DESKTOP, PHONE]) {
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor,
      });
      await page.goto(new URL("index.html", baseUrl).href, { waitUntil: "load" });
      await page.waitForFunction(
        () => document.querySelectorAll('input[type="range"]').length === 9,
        { timeout: 5000 },
      );

      console.log(`\n--- ${viewport.name} (${viewport.width}×${viewport.height}) ---`);
      failed = (await checkContrast(page, viewport.name)) || failed;
      failed = (await checkFocusIndicators(page, viewport.name)) || failed;
      if (viewport.name === "phone") {
        failed = (await checkTouchTargets(page)) || failed;
      }
      failed = (await checkReducedMotion(page, viewport.name)) || failed;

      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((res, rej) => server.httpServer.close((err) => (err ? rej(err) : res())));
  }

  if (failed) process.exit(1);
}

// --- 1. Text contrast >= 4.5:1 against actual rendered background --------
// axe-core's color-contrast rule walks real computed styles (including
// stacked backgrounds, opacity, and font weight/size for the 3:1 large-text
// exception) rather than reading a colour off a stylesheet in isolation —
// that's the "actual background" part CLAUDE.md's checklist item asks for.
async function runAxe(page: Page, rules: string[]): Promise<{ violations: unknown[] }> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (ruleIds: string[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axe = (window as any).axe;
    const result = await axe.run(document, {
      runOnly: { type: "rule", values: ruleIds },
      resultTypes: ["violations"],
    });
    return { violations: result.violations };
  }, rules);
}

async function checkContrast(page: Page, label: string): Promise<boolean> {
  const { violations } = await runAxe(page, ["color-contrast"]);
  if (violations.length === 0) {
    console.log(`✓ ${label}: text contrast >= 4.5:1 (axe color-contrast, 0 violations)`);
    return false;
  }
  console.error(`✗ ${label}: color-contrast — ${violations.length} violation(s)`);
  for (const v of violations as any[]) {
    for (const node of v.nodes) {
      console.error(`    ${node.target.join(" ")}: ${node.failureSummary}`);
    }
  }
  return true;
}

// --- 2. Every focusable control has a visible focus indicator ------------
// Captures each control's computed outline/box-shadow/border while blurred,
// then again after .focus(), and requires at least one of those to actually
// change. A rule that only checked "outline-style !== none" would go green
// on `outline: none` paired with nothing to replace it — the actual failure
// mode this exists to catch — so it compares before/after, not presence.
async function checkFocusIndicators(page: Page, label: string): Promise<boolean> {
  const results = await page.evaluate(() => {
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const els = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE));

    function snapshot(el: HTMLElement) {
      const s = getComputedStyle(el);
      return {
        outlineStyle: s.outlineStyle,
        outlineWidth: s.outlineWidth,
        outlineColor: s.outlineColor,
        boxShadow: s.boxShadow,
        borderColor: s.borderColor,
        backgroundColor: s.backgroundColor,
      };
    }

    const failures: string[] = [];
    for (const el of els) {
      const before = snapshot(el);
      el.focus();
      const after = snapshot(el);
      el.blur();
      const changed =
        before.outlineStyle !== after.outlineStyle ||
        before.outlineWidth !== after.outlineWidth ||
        before.outlineColor !== after.outlineColor ||
        before.boxShadow !== after.boxShadow ||
        before.borderColor !== after.borderColor ||
        before.backgroundColor !== after.backgroundColor;
      if (!changed) {
        const testid = el.dataset.testid ? `[data-testid="${el.dataset.testid}"]` : "";
        failures.push(`${el.tagName.toLowerCase()}${testid || "#" + (el.id || "(no id)")}`);
      }
    }
    return { total: els.length, failures };
  });

  if (results.failures.length === 0) {
    console.log(`✓ ${label}: focus indicator — all ${results.total} focusable controls change style on focus`);
    return false;
  }
  console.error(`✗ ${label}: focus indicator — ${results.failures.length} of ${results.total} controls show no visible change on focus`);
  for (const f of results.failures) console.error(`    ${f}`);
  return true;
}

// --- 3. Touch targets >= 44x44 CSS px at 390x844 --------------------------
// Reads getBoundingClientRect() on the actual rendered box, not a slider's
// nominal `height` attribute — a native <input type="range"> renders its
// hit area far smaller than 44px unless CSS says otherwise, which is exactly
// the failure CLAUDE.md names ("nine range inputs on a phone is exactly
// where this fails").
async function checkTouchTargets(page: Page): Promise<boolean> {
  const results = await page.evaluate(() => {
    const TARGETS = 'a[href], button:not([disabled]), input[type="range"], input[type="radio"]';
    const els = Array.from(document.querySelectorAll<HTMLElement>(TARGETS));
    const MIN = 44;
    const failures: string[] = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < MIN || r.height < MIN) {
        const testid = el.dataset.testid ? `[data-testid="${el.dataset.testid}"]` : `#${el.id || "(no id)"}`;
        failures.push(`${el.tagName.toLowerCase()}${testid}: ${r.width.toFixed(1)}×${r.height.toFixed(1)}px`);
      }
    }
    return { total: els.length, failures };
  });

  if (results.failures.length === 0) {
    console.log(`✓ phone: touch targets — all ${results.total} controls are >= 44×44 CSS px`);
    return false;
  }
  console.error(`✗ phone: touch targets — ${results.failures.length} of ${results.total} controls are below 44×44 CSS px`);
  for (const f of results.failures) console.error(`    ${f}`);
  return true;
}

// --- 4. prefers-reduced-motion is respected if any transition exists ------
// Vacuous-check risk is explicit here: if the stylesheet defines no
// transitions at all, there is nothing this check could ever catch, and
// reporting a bare "✓" would be exactly the kind of assertion-that-can't-fail
// this repo has already been burned by four times. So the two outcomes are
// reported distinctly: "no transitions defined" (nothing tested) vs. "found
// N transition(s), all neutralised under reduced motion" (something tested
// and it held).
async function checkReducedMotion(page: Page, label: string): Promise<boolean> {
  const before = await page.evaluate(() => {
    const withTransition: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const s = getComputedStyle(el);
      if (s.transitionDuration.split(",").some((d) => parseFloat(d) > 0)) {
        const testid = el.dataset.testid ? `[data-testid="${el.dataset.testid}"]` : el.tagName.toLowerCase();
        withTransition.push(testid);
      }
    }
    return withTransition;
  });

  if (before.length === 0) {
    console.log(`… ${label}: prefers-reduced-motion — no transitions defined, nothing to check yet`);
    return false;
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  const stillAnimating = await page.evaluate((selectors: string[]) => {
    const remaining: string[] = [];
    for (const sel of selectors) {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) continue;
      const s = getComputedStyle(el);
      if (s.transitionDuration.split(",").some((d) => parseFloat(d) > 0)) remaining.push(sel);
    }
    return remaining;
  }, before);
  await page.emulateMedia({ reducedMotion: null });

  if (stillAnimating.length === 0) {
    console.log(`✓ ${label}: prefers-reduced-motion — ${before.length} transition(s) found, all neutralised under reduced motion`);
    return false;
  }
  console.error(`✗ ${label}: prefers-reduced-motion — ${stillAnimating.length} transition(s) still active under reduced motion`);
  for (const f of stillAnimating) console.error(`    ${f}`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

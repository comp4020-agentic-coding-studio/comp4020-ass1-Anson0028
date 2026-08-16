#!/usr/bin/env node
// "Does it hold up on a slow connection" is one of the three things the
// assessment names, and it was the only one this repo had no sensor for. The
// site was small — but "it's small" was an impression, not a measurement, and
// that is the exact distinction the prototype itself argues about.
//
// A budget needs a stated link to mean anything. LINK_KBPS is 400 kbit/s,
// roughly a bad mobile connection (the low end of what "3G" is usually taken
// to mean), so 50 KB/s of payload. BUDGET_BYTES is what fits in three seconds
// of that, which is about where a first paint stops feeling broken. Both
// numbers are assumptions and are written down as assumptions; what the check
// removes is the guessing about whether the site currently fits them.
//
// In `pnpm check` rather than beside the browser checks: it reads files off
// disk, so it costs milliseconds, and a payload regression should stop a push
// the same way a type error does.
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DIST = resolve("dist");
const LINK_KBPS = 400;
const BUDGET_SECONDS = 3;
const BUDGET_BYTES = Math.round(((LINK_KBPS * 1000) / 8) * BUDGET_SECONDS);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function main(): boolean {
  const all = files(DIST).map((path) => ({ path, bytes: statSync(path).size }));
  const total = all.reduce((sum, f) => sum + f.bytes, 0);
  const seconds = total / ((LINK_KBPS * 1000) / 8);

  if (total > BUDGET_BYTES) {
    console.error(
      `✗ payload: ${kb(total)} over ${LINK_KBPS} kbit/s is ${seconds.toFixed(1)}s, past the ${BUDGET_SECONDS}s budget (${kb(BUDGET_BYTES)})`,
    );
    for (const f of [...all].sort((a, b) => b.bytes - a.bytes).slice(0, 5)) {
      console.error(`    ${kb(f.bytes).padStart(9)}  ${relative(DIST, f.path)}`);
    }
    return true;
  }

  console.log(
    `✓ payload: ${kb(total)} across ${all.length} files — ${seconds.toFixed(1)}s over ${LINK_KBPS} kbit/s, inside the ${BUDGET_SECONDS}s budget`,
  );
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (main()) process.exit(1);
}

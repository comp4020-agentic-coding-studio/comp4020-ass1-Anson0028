# COMP4020 prototype

This is your starter repo for a COMP4020 prototype: a static site written in
HTML/CSS/TypeScript that builds to plain HTML/CSS/JS and deploys to GitHub
Pages. The **deployed site is what gets marked** --- not this repo, and not "it
works on my machine". It's marked live in Chrome against the deployed URL at two
viewports --- 1920×1080 (desktop) and 390×844 (phone) --- and both count in
full, so make that artefact good at both and use the checks below to know
whether it is.

What you're building this week — the spec — is published on the course website,
and this repo's name tells you which deliverable it is. Run the course plugin's
**start** skill at the start of each week: it pulls the right spec from the
course API, carries your harness forward from last week, and helps you turn the
spec's checkable lines into tests of your own. Read the spec before you build,
and see `spec/README.md` for how the checks in this repo relate to it.

## How to work in here

- Keep the dev server running (`pnpm dev`) so you see changes as you make them.
- Before you push, run `pnpm check`. It runs most of what CI runs --- build,
  lint, and the spec --- so you catch those in seconds instead of waiting for
  the pipeline. The links check, the evidence check, the secrets scan, and the
  deploy itself only run in CI; run `pnpm dlx linkinator ./dist --silent`
  locally against a fresh `pnpm build` for the links check without waiting for
  CI.
- To see what the page actually looks like rather than what you assume it looks
  like, open it in a browser (the `agent-browser` CLI, documented on
  [the course site](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/backpressure/#agent-browser-the-rendered-page-as-ground-truth),
  works well for this). The rendered page is the truth; your mental model of it
  isn't.
- When a check fails, read its output before changing anything. Each check below
  names what it measures, and the failure message is the instruction: it tells
  you the file, the line, or the contract. Treat a red check as authoritative
  --- the page is wrong until the check is green, not until you decide it should
  be.
- Commit when the checks pass. Never commit a red state.

## The checks (your sensors)

CI runs these on every push once your repo is public. GitHub's checks UI shows
two jobs, `check` and `deploy` --- not one status per sensor below --- and
within `check` the steps run in sequence (`pnpm check` chains typecheck, build,
lint, and the spec with `&&`), so an early failure like a broken build stops the
later sensors from running for that push; fix it and push again to see the rest.
While the repo is private (all week, until you ship) the CI jobs stay skipped
--- `pnpm check` is the same roster on your machine, and it's the faster loop
anyway. They aren't hoops. Each is a different way of finding out something true
about the site that you can't reliably see by looking at it.

They also carry a mark at a crit: the sweep runs fifteen minutes after your
cutoff, and green checks there are worth half that week's shipped mark. Still
running counts as not green, so ship with time for CI to finish.

- **typecheck** --- `tsc --noEmit` runs first in `pnpm check`, so a type error
  stops the roster before the build even starts. The types are extra
  backpressure: a red here is the compiler telling you a claim in the code is
  false.
- **build** --- the site must build (`pnpm build`). A build failure means the
  deployed site is broken or stale, so nothing else matters until this is green.
- **deploy / online** --- the live GitHub Pages URL must load and return the
  page you expect. An asset that 404s on the deployed URL counts as broken even
  if it loads locally.
- **spec** --- `spec/invariants.test.ts` asserts what's true of any good
  website, whatever the week's brief asks; the tests you write for the week's
  own spec run alongside it (any `spec/*.test.ts`). A failure names the contract
  you haven't met yet.
- **lint** --- `stylelint` for CSS, `oxlint` for TypeScript. Flags code that's
  wrong, fragile, or non-idiomatic. Read the rule it names.
- **tests** --- any other tests you write, wherever you put them (co-located
  with your source is fine, not just `spec/`), must pass. Vitest picks up both
  this and the spec suite in one `vitest run`, the last step of `pnpm check`. A
  failing test is a claim about the site that's no longer true.
- **evidence** (`pnpm check:evidence`) --- checks your process evidence:
  `PROCESS.md`'s citations resolve to real commits, the current deliverable's
  exact reflection is in `reflections/` (worked out from this repo's name
  against the public course API), and your `CLAUDE.md` is present. Evidence
  gates the deploy --- `deploy` needs `check` to pass, so failing evidence
  blocks the deploy alongside everything else. See
  [Your process is part of the mark](#your-process-is-part-of-the-mark) below,
  and the course website's
  [assessment page](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/assessment/#what-you-submit)
  for what counts as evidence.
- **links** --- internal links must resolve. A broken link is a dead end you
  didn't mean to ship.
- **secrets** --- the repo is scanned for committed credentials. Never put a
  key, token, or password in a tracked file. If one leaks, rotate it. A local
  pre-commit hook (`.githooks/pre-commit`, installed by `pnpm install`) also
  blocks any commit containing something shaped like an API key --- by the time
  CI sees a key it's already pushed, so the hook is the sensor that matters.

Nothing here measures **performance** --- wiring that sensor (Lighthouse or
whatever you choose) is still your work, and later in the course the spec will
ask you to show how you tested it. When you do, read a green result honestly:
it's a lab estimate from one run on a CI machine, not proof the site is fast
for real users.

**Accessibility** is now wired: `pnpm check:a11y` (`scripts/check-a11y.ts`)
runs the same real-Chromium/Vite-preview setup as `check:viewports` against
`dist/` and asserts four things at both marking viewports --- text contrast
>= 4.5:1 (axe-core's `color-contrast` rule, walking real computed styles, not
a colour read off a stylesheet in isolation), every focusable control changes
computed style on focus (compares before/after `.focus()`, not just "outline
isn't `none`" --- that alone would go green on `outline:none` paired with
nothing to replace it), touch targets >= 44×44 CSS px at 390×844 (read from
`getBoundingClientRect()`, since a native `<input type="range">` renders a hit
area far smaller than its nominal size), and `prefers-reduced-motion` is
respected by any transition that exists. That last one reports a distinct
"nothing to check yet" rather than a bare pass when the stylesheet defines no
transitions at all --- a check that can't fail is worth less than no check,
and this repo already found four of those this week (see `PROCESS.md`); this
one is written not to be a fifth. Deliberately outside `pnpm check`, same
reason as `check:viewports`: a browser launch is slower than the rest of the
roster.

## The stack is swappable

Out of the box this is plain HTML/CSS/TypeScript on Vite, and every `.html` file
in the repo is a page: add pages, link them, and the build picks them up with no
config. That's a default, not a rule (unless the week's spec says otherwise).
You can swap in Astro or any other static generator, because nothing in CI names
a tool --- the whole contract is:

- `pnpm build` emits the complete site into `dist/`
- the `package.json` scripts (`check`, `check:evidence`, `build`) keep working
- whatever lands in `dist/` still passes the invariants in `spec/`

Two things bite in a swap. The deployed site lives under a path
(`…github.io/<repo>/`), so configure your generator's base path --- this
template's Vite config uses relative asset URLs to sidestep that, but most
generators (Astro included) need `base` set explicitly, and getting it wrong
looks fine locally while every asset 404s on the live URL. And commit the
updated `pnpm-lock.yaml`: CI installs with `--frozen-lockfile`.

## Your process is part of the mark

The deployed page is only half of it. How you got there is marked too: your
commit history, your agent files, and the decisions visible across them. The
checks above can't see any of that, so a person reads it directly --- which
means building legibly is part of building well.

- **Commit as you go.** Small, frequent commits are the record of how the work
  came together, and that record is read, not just the final state. A trail that
  grew alongside the code is the strongest evidence of your process; a single
  dump the night before is the weakest.
- **Keep a process overview** (`PROCESS.md`). A short reading-guide, not an
  essay: what you built, the moments that mattered --- each pointing at a
  commit, a `CLAUDE.md` change, or a prompt and the commit it produced --- and
  where to look in the history. It points a marker at the evidence; it doesn't
  stand in for it, and claims the history doesn't back don't count. The
  `PROCESS.md` in this repo is a template showing the shape and the citation
  format (link text the commit hash or range, target the commit or compare URL);
  `pnpm check:evidence` verifies your citations resolve to real commits before
  you ship. Markers follow those citations and don't trawl the repo for evidence
  you didn't cite.
- **Write your reflection in `reflections/`** --- a short markdown file in this
  repo, named for the deliverable it answers, so the number in the filename is
  the number in this repo's name (`crit-1.md` in `comp4020-crit1-<you>`,
  `assignment-1.md` in `comp4020-ass1-<you>`); `reflections/README.md` has the
  full rule. `pnpm check:evidence` checks the exact current name against the
  course API, not merely the presence of any well-named file. It answers the two
  standing prompts: the breakthrough that moved the work forward, and what this
  work changed about the developer you want to be. It stays out of the deployed
  site. It's due at the cutoff, and if it isn't in the repo by then the week
  doesn't count as shipped, however good the prototype is.
- **This file is process evidence.** The harness you build to direct the agent,
  this `CLAUDE.md` and any `AGENTS.md`, is itself read as part of how you
  worked. Keep it honest and current (see below).

You don't need a name, a student number, or any identity file in the repo: we
know whose repo it is. Spend the effort on the work.

## This file is yours

This CLAUDE.md is a starting point, not a fixed rulebook. As you learn what your
prototype needs --- a convention to hold the agent to, a sensor that keeps
catching you out, a fact about the stack the agent keeps getting wrong --- write
it down here. Growing this file is the work of harness engineering, and the gap
between this boilerplate and your own version is part of what your prototype
says about the developer you're becoming.

## Design decisions for this prototype (the difficulty-sliders piece)

These were made deliberately, before any code, and the tests in
`spec/assignment-1.test.ts` assume them. Don't relitigate them mid-build —
flag it and ask if one turns out to be wrong, don't quietly work around it.

### The game-state mirror must not drift from the truth

`spec/assignment-1.test.ts` can't see the canvas, so the prototype publishes a
parallel state onto `[data-testid="game-state"]` (`data-running`,
`data-elapsed-ms`, `data-player-x/-y`, `data-applied-health/-speed/-damage`,
`data-active-config` — see below for what that last one is).
A test that reads a mirror which has quietly diverged from what's actually
simulated is worse than no test — it stays green while the game is broken.
So: the mirror is written from the exact same state object the renderer
reads, in one place, once per frame (e.g. a single `publishState()` call at
the end of the game loop's tick). Never update DOM dataset attributes
piecemeal wherever state changes — that's exactly how a second, competing copy
of "the truth" gets created.

### The simulation runs in normalised coordinates

The arena is 1×1. Every position, velocity and distance the simulation
computes is a fraction of it. Pixels exist only in the render step, where you
multiply by the current canvas size. Reasons this matters more than it looks:

- the phone viewport's arena is physically smaller, so the same enemy speed
  is effectively harder there — normalising is what makes the piece's central
  claim (three configurations are equally hard) true at both marking
  viewports instead of only the one it was tuned on
- it's also what makes a mid-run resize safe by construction: a resize is
  just a change of multiplier, not a change to any simulated quantity

`data-player-x` / `data-player-y` on the mirror are these fractions (0–1),
not pixels.

### Three configurations, not one dial — and only one is ever live

"Make these equally hard" needs a plural subject. One panel of three sliders
collapses the button into a generic difficulty slider, which isn't the
argument. So there are **three parallel panels, nine sliders total** — three
full `DifficultyConfig` instances (health/speed/damage each) — deliberately
shaped as different archetypes (a swarm of weak fast enemies, a few slow tanky
ones, something in between) rather than three copies of the same dial
position. The claim the button exists to make ("these look nothing alike and
are the same difficulty") is only sayable if the three actually look nothing
alike to start with.

Only one arena exists, so only one panel is ever live: the panels are
selectable, and the selected one drives the single running `SimState` —
picking a different panel means playing *that* configuration, not reading
three numbers that claim to match. Which panel is live is part of the mirror
(`data-active-config` on `[data-testid="game-state"]`), because a test
asserting "the right configuration is driving the game" needs to see it same
as everything else the mirror exposes. Switching panels starts a fresh run
(full health, elapsed 0) rather than swapping the config under a run in
progress — comparing how a configuration feels is only honest from the same
starting point every time.

Sliders are namespaced per panel (`enemy-health-0`, `enemy-health-1`, ... not
one shared `enemy-health`), and only the active panel's slider edits affect
the live simulation — editing an inactive panel's dial just updates that
panel's stored config for whenever it's selected next, exactly as if you'd
paused on it. `scripts/check-viewports.ts`'s liveness check and
`spec/assignment-1.test.ts`'s tabbability test both query
`input[type="range"]` generically rather than by exact id, so this scales to
nine sliders without hardcoding nine ids in two places.

Equalising doesn't independently retune three knobs per non-active panel
against one scalar target (underdetermined — many stat combinations hit the
same median survival time). It scales that panel's *entire current shape* by
one multiplier, binary-searched against the active panel's measured median
survival, clamped per-axis to the slider's own min/max. That's what keeps a
panel's archetype recognisable through equalisation (the swarm stays a swarm,
just tuned to a different intensity) instead of drifting toward one generic
"balanced" shape every time. See `equalise.ts` for the search itself, and its
own file comment for the tolerance, trial counts, and chunking rationale —
those were measured against this repo's actual simulation, not assumed.

If a target survival time is outside what a panel's shape can reach within its
sliders' own bounds (every axis already at its floor or ceiling), the search
can't converge, and the UI says so plainly next to that panel rather than
silently applying its closest attempt and calling it equal.

### Input: keyboard on desktop, relative touch-drag on phone

Arrow keys move the player — unconditionally, an accessibility requirement,
not something to trade off for the touch implementation.

The phone has no arrow keys, so touch drags the player: the first touch point
becomes the origin, dragging moves the player in that direction proportional
to drag distance, releasing stops. Not absolute positioning — that would put
the visitor's finger over the thing they're supposed to be watching.

WASD is an alternative to the arrows, never a replacement for them. Three
layers hold the arrows in place: the brief's own checkable line, the test
`spec/assignment-1.test.ts` derives from it, and the accessibility rule above.
A future week that finds arrow keys inconvenient should add another binding,
not remove this one.

**A key event has to be attributed to an owner before it is acted on.** When
focus is inside a form control, the key belongs to that control: the game must
not also consume it, and must not call `preventDefault`, because the brief
requires the difficulty sliders to be adjustable by tab and arrow keys. When
the game does consume a key, it must call `preventDefault`, or the browser
scrolls the page out from under the arena while the visitor is playing. Both
halves are one rule, and getting either half alone produces a bug: a
window-level handler with no owner check moved the player while a slider was
being adjusted, and the same handler without `preventDefault` scrolled the
page 420px during a run.

### Visual direction: a designer's tuning tool, not a game portal

The visitor is sitting where the designer sits, not playing a game. That's
the argument, in visual form:

- dark surface; canvas reads better dark and sells the tool framing
- one accent colour, spent only on the "make these equally hard" button and
  the readout it changes — everywhere else is greyscale, or the accent means
  nothing
- all numbers monospace, `font-variant-numeric: tabular-nums` — the survival
  timer must not jitter as digit widths change
- each slider shows its current value as a number beside it; the three
  sliders get three distinguishable colours, reused everywhere the three are
  compared, so the mapping is learned once
- no easing on the slider-to-game response — the point is that it's immediate
- the equalise button is the most prominent control on the page: it's the
  thesis, not a feature
- layout: canvas left / panel right on desktop, stacked with canvas on top
  and full-width sliders below on phone; the canvas resizes with the
  viewport without losing the run
- restraint: no gradients-on-everything, no decorative flourishes, no icons
  that carry no information

## Build plan (this week), slice by slice

Building in slices, one commit per slice, `pnpm check` green before each
commit. Tests in `spec/assignment-1.test.ts` that belong to a not-yet-built
slice are `it.skip`'d (not deleted, not left failing) and flipped to active
in the commit that makes them true — that's what keeps "green before every
commit" compatible with genuinely red-to-green tests. `spec/starter.test.ts`
is gone as of slice 1 (it describes the starter page, which slice 1 replaces
— see its own comment for why deleting it is the intended next step).

1. **The dot that moves** — player in normalised coords, arrow keys, canvas
   draw, state mirror. No enemies, no timer. Turns the keyboard-movement test
   green.
2. **Something to survive** — enemies spawn at the arena edge and chase,
   automatic attacks (no aiming), survival timer (tabular-nums), run ends at
   zero health.
3. **The dials** — three native range inputs (health/speed/damage), each with
   a visible value, changes apply live (no restart). Turns both slider tests
   green.
4. **Resize** — should be nearly free if slice 1's normalisation is real;
   if the resize test still fails here, that's a genuine finding to report,
   not something to quietly patch around.
5. **The button** — "make these equally hard" retunes two of the three
   parallel configurations (below) to match the third's measured difficulty.
   Gets the accent colour and the most prominent position once it exists.
6. **Visual pass** — the dark/accent/tabular-nums/per-slider-colour direction
   above, applied last, once the mechanics are all real.

Standing rule for every slice: no scope beyond the brief (no XP, levels,
upgrades, enemy types, starting stats) without asking first — the brief is
one idea and nothing else, and scope is this piece's biggest risk.

## What this repo has taught me

### pnpm brings its own Node; `mise.toml` alone does not bind it

`mise` installs pnpm as a standalone binary with Node embedded, so `pnpm exec`
runs under that embedded Node no matter what `mise.toml` declares. Anything
spawned via `process.execPath` --- `scripts/check-evidence.ts` is the one that
bit me --- then gets the wrong Node, and a Node older than 22 cannot load a
`.ts` file at all. The failure looks like a broken test and is really a broken
toolchain.

`.npmrc` pins it (`use-node-version`), and that file is the authority for which
Node pnpm runs. If a check fails with `ERR_UNKNOWN_FILE_EXTENSION`, check
`pnpm exec node -v` against `mise current node` before touching the code.

### The a11y baseline, measured before any CSS changed

Ran `pnpm check:a11y` against the pre-visual-pass stylesheet to see what was
already true rather than assume it. Contrast and focus indicators were
already green (27 elements axe actually evaluated for contrast, 0
incomplete; 14 of 14 focusable controls genuinely change style on focus,
since nothing in the stylesheet sets `outline: none`) --- worth recording
because a check that's green from the start and a check that's green because
it measures nothing look identical unless you check which one happened.
Touch targets were red on all 14 controls at 390×844: the nine range inputs
rendered at `129×16px`, the three panel-select radios at `13×13px`, matching
exactly the failure CLAUDE.md's own checklist named in advance.

### PROCESS.md and reflections use my facts, not a plausible reconstruction

When I give you the facts of a moment you weren't present for --- what I
tried, what I rejected, why --- use those facts as given. If a beat is
missing, ask me for it or leave it out. Don't fill the gap with something
plausible: I have to defend every claim in `PROCESS.md` and the reflection out
loud, and I can only answer for the alternatives I actually weighed, not ones
that merely sound like something I might have weighed.

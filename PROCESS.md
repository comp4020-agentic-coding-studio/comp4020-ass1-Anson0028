# Process overview

## What I built

A canvas-based "difficulty instrument": three parallel enemy-archetype
panels (Swarm, Tanks, Hunter), only one ever driving the live simulation,
plus a button that binary-searches two of them to match the third's
measured survival time. The pitch is that three visibly different shapes
of difficulty can be tuned to feel equally hard — not that a slider is a
slider.

## The moments that mattered

The throughline this week wasn't any one bug — it's that a check is
easiest to pass when the thing it's supposed to measure isn't actually
there. That happened six times building this repo: four in the harness
itself, twice in requirements or shortcuts I proposed to the agent myself.

1. **The resize test measured jsdom's own defaults, not a resize.**
   `canvas.width > 0` was true on jsdom's stock 300×150 box whether or not
   the resize handler ever ran — a vacuous assertion. Fixed by stubbing
   `getBoundingClientRect()` to a real post-resize box, so the test only
   passes if the handler actually reads it
   ([`d921132`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/d921132)).

2. **The viewport check had been passing against an empty page since it
   was written.** `check-viewports.ts` opened the built site over
   `file://`, which CORS-blocks a crossorigin module script — so "no
   horizontal overflow" had been true since
   [`46672e5`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/46672e5)
   of a document with no canvas, no sliders, no app at all. Serving
   `dist/` over real HTTP, plus a liveness assertion that fails if the app
   never mounted, is what caught it
   ([`d921132`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/d921132)).

3. **The DPR check multiplied by a value that could only be 1.**
   `expected = box * devicePixelRatio` looked correct, but every page ran
   at Playwright's default `deviceScaleFactor` of 1, so the term never did
   anything — and the canvas really did render blurry at the phone
   viewport that carries half the mark. Setting `deviceScaleFactor: 3`
   there is what turned an inert multiply into a real check, and a real
   check into a real fix
   ([`8679b27`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/8679b27)).

4. **A named constant read as a guarantee it didn't keep.**
   `FRAME_BUDGET_MS = 8` had a comment above it claiming the game
   "animates at full rate throughout," while `equalisePanel` yielded once
   per ~240ms measurement — 30x the budget — so the loop ran at 4.2fps for
   six seconds straight. The fix wasn't the comment; it was pushing the
   yield granularity down to one trial so the budget started gating
   something real
   ([`f929b1e`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/f929b1e)).

5. **The agent recommended the same shape of fix again, and I refused
   it.** When Tanks wouldn't converge, the agent's top recommendation was
   to raise `SEARCH_TRIALS` and average out the noise — quieting the
   failure without explaining it, the fourth instance of exactly this
   pattern that same day. Refusing it is what surfaced the actual finding:
   below `ENEMY_PURSUIT_SPEED_RATING`, enemies can't catch a fleeing
   player at all, so survival is decided by cornering, not pursuit — a
   different distribution a single-multiplier search can't be expected to
   converge against. That the recommendation still came, despite four
   prior corrections, says the pull toward passing a check instead of
   telling the truth is systematic, not an occasional lapse — which is why
   the harness has to hold the line rather than my memory
   ([`90e67d7`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/90e67d7)).

6. **An estimate was beaten by measurement twice, once by each of us.**
   The agent's own from-first-principles comment guessed the equalise
   press at ~1.5–1.8s against a measured 5944ms
   ([`90e67d7`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/90e67d7)).
   I later guessed the per-trial chunking fix would push that further, to
   ~10s; measurement put it at 5840ms instead
   ([`f929b1e`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/f929b1e)).
   Same failure on both sides of the harness: computing instead of
   measuring.

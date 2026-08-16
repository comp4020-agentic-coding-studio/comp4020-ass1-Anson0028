# Process overview

## What I built

An interactive explainer about difficulty numbers. Three panels labelled Easy,
Medium and Hard, stepped evenly on every dial the way ladders actually get
built — health +25, speed +15, arrivals +1. Play each step, then press one
button, which simulates each 51 times and reports the median survival of a
fixed reference player. The measured answer is the argument: **Easy 26.8s,
Medium 10.3s, Hard 7.8s** — evenly spaced numbers, badly uneven difficulty.
Stage two then hands the problem over: a target time, drawn from a range
measured to be reachable, and the dials.

## The moments that mattered

The throughline is one sentence: **an assertion goes green most easily when
the thing it is supposed to measure isn't there.** That happened seven times
in this repo in a week, and it is the reason the prototype ended up being
about unearned numbers.

1. **A check that had never once run against this site.**
   `check-viewports.ts` opened built pages over `file://`, where the page's
   crossorigin script and stylesheet are CORS-blocked. It had been green since
   the day it was written while measuring an empty, unstyled document with no
   app on it. The fix was a liveness assertion that fails when the app isn't
   mounted
   ([`d921132`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/d921132)).
   Two more of the same shape followed: a `devicePixelRatio` term that could
   only ever multiply by 1, hiding a canvas that really did render blurry on
   the phone
   ([`8679b27`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/8679b27)),
   and `FRAME_BUDGET_MS = 8` gating nothing under a comment claiming full
   frame rate, while the real number was 4.2fps
   ([`f929b1e`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/f929b1e)).

2. **The worst one: a rule I'd written and never implemented.**
   `CLAUDE.md` had described touch input since before the first line of code.
   There were no touch handlers at all, so at 390×844 the player could not
   move by any means — and 47 tests plus 11 browser assertions all looked
   somewhere else. The fix was the sensor, verified red first
   ([`4e7c28d`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/4e7c28d)).
   See `reflections/assignment-1.md`.

3. **The page was printing a number it hadn't earned.**
   Dragging a dial produced a confident "300.0s", which is the headless time
   cap, not a survival time. A run that reached it survived *at least* 300
   seconds. Measurements now report whether they were cut off, and the summary
   refuses to compare step sizes when any step is a floor
   ([`11eede0`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/11eede0)).
   Same rule applied twice more: the page now says how the numbers are made
   ([`5266be0`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/5266be0))
   and labels its headline figures as recorded rather than live
   ([`dad1897`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/dad1897)).

4. **Measurement took my best finding away.**
   The sharpest result in the project was that one archetype could not be
   equalised at all, because below a certain enemy speed a run ends by
   cornering rather than pursuit. Changing the player from 100 hit points to
   three hearts falsified it: 41 runs each at speeds 5, 10, 20 and 35 produced
   no timeouts, and the distribution stopped being bimodal. I retired the
   claim and left the reason where the test had been
   ([`0285ce1`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/0285ce1)).
   That commit also records the tool's own thesis landing on its author:
   Swarm's three dials barely moved its difficulty at all (four arrivals down
   to two: 5.5s → 6.7s), while an invulnerability window nobody can see moved
   it 5.6s → 8.3s.

## Where to look

`CLAUDE.md` is the harness: every rule was written before the code it governs,
and two were amended after building them proved them wrong
([`adf01b0`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Anson0028/commit/adf01b0)).
`scripts/check-viewports.ts` and `scripts/check-a11y.ts` are mine, not the
template's — real-browser sensors for layout, playability, contrast, focus,
touch targets and reduced motion, each run against a broken build before being
trusted green.

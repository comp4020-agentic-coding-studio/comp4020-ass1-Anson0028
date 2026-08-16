# Assignment 1

## What was the breakthrough that moved the work forward?

Before I had written any code for this assignment, `CLAUDE.md` said that the
player had to use touch dragging on mobile because phones do not have arrow
keys. The agent had read and followed that file elsewhere, but never
implemented this rule, and I had assumed that writing it down was enough. At
390×844, the viewport the course weights in full, the player could not move
through touch at all.

The project still had 47 passing tests, all driving movement through keyboard
input, plus 11 browser assertions checking layout, contrast and canvas
geometry. Nothing asked whether the game was actually playable on a phone.

I changed the harness by adding a browser check that taps the arena, drags
70px through touch input, and fails if the player does not move. I then
removed the touch implementation to verify that the check really went red:
`dragging on the arena moved the player nowhere (0.5 -> 0.5)`.

That changed how I treated instructions to the agent. A rule written in an
agent file is not really a rule until breaking it causes an observable failure
somewhere.

## What did this work change about who I want to be as a software developer?

I want to be much less impressed by green tests that I have never seen fail.
This project repeatedly produced checks that passed while missing the thing
they claimed to verify: a viewport check ran against an unstyled page, and two
touch-behaviour tests were already green before touch movement existed.

I also want to be willing to remove evidence that no longer describes the
system. After changing the game from 100 HP to three hearts, a previously
observed non-converging survival pattern disappeared. At speeds 5, 10, 20 and
35, 41 runs at each speed produced no 300-second timeouts. I removed that test
and left a comment explaining why, rather than keeping a green test because I
liked the earlier finding.

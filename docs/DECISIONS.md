# Architecture Decision Records

Numbered, immutable once accepted. Status: Accepted · Superseded · Rejected.
New decisions must be appended, never rewritten.

---

## ADR-001 — Vanilla TypeScript + Vite instead of a game/UI framework
**Date:** 2026-10-16 · **Status:** Accepted

**Context.** WORLDBUG must ship as a static HTML5 bundle usable on portals, run at 60 fps with
hundreds of simulated organisms, and be maintainable by a small team without a framework's runtime
or upgrade treadmill.

**Decision.** Use TypeScript (strict) on top of Vite with **zero runtime dependencies**. Canvas 2D
for the world, hand-written DOM for the UI, a ~120-line observable store for state.

**Consequences.** (+) Small bundle, no dependency risk, no licence surface, full control over
performance and accessibility, fast cold start. (−) We must write our own store/router/DOM helpers
(small, ~200 lines total) and cannot lean on a component ecosystem.

**Alternatives rejected.** React/Preact: extra runtime and re-render cost for a UI that is 90 %
numeric readouts. Pixi/Phaser: full renderer engine for a 2D grid we can draw with ~30 primitives,
plus a heavy dependency and licence review burden. Svelte: excellent, but still a build-time
dependency on a framework compiler for a UI this small.

---

## ADR-002 — The simulation is a deterministic pure function of (config, seed, actions)
**Date:** 2026-10-16 · **Status:** Accepted

**Context.** The game is a *deduction* game: it must be fair (laws are stable and learnable),
testable (a headless harness can assert ecological outcomes), and affordable (no server).

**Decision.** Fixed timestep, seeded PRNG injected into every subsystem, no wall-clock/`Math.random`
in `core/`, instruments applied through auditable actions. `World` never reads the DOM.

**Consequences.** (+) Reproducible bug reports, meaningful automated ecology tests, ability to
re-simulate a sector for balancing without a browser, trivially portable. (−) All stochastic
behaviour must be threaded through the PRNG (discipline required); no "just call Math.random".

---

## ADR-003 — Ecosystems use mass-conserving resource transfer, not scripted population curves
**Date:** 2026-10-16 · **Status:** Accepted

**Context.** A deduction game only works if the world's behaviour is *caused* by its hidden laws. Any
scripted "population goes down here" would break the fairness invariant and rule 7 (no fake data).

**Decision.** Organisms deposit energy into per-species biomass fields each tick; consumers sample
those fields and physically remove the biomass they take (distributed over the prey individuals in
the same cell). Deaths are caused by energy, exposure, age or predation — never by a scripted event.
The player's instruments modify fields, which the organisms then *react* to.

**Consequences.** (+) Emergent boom/bust cycles, real over-grazing, real thermal-niche exclusion —
all of which are genuine, observable evidence. (−) The constant tuning burden is real; it is handled
by the headless balance harness (`tools/balance.ts`) run as part of `npm run balance`.

---

## ADR-004 — Dev/preview server binds 0.0.0.0 with host checking disabled
**Date:** 2026-10-16 · **Status:** Accepted

**Context.** The game is previewed through a container port-forwarding proxy with a generated host
name; the built game must also be drop-in deployable to portal sub-directories.

**Decision.** `server.host: true`, `allowedHosts: true`, `strictPort` on 5173, and `base: './'` for
the production bundle. No absolute URLs anywhere; all runtime fetches are relative (there are none
today — the game makes zero network requests).

**Consequences.** (+) The preview works through the proxy and the `dist/` folder works from a file
URL or any sub-path. (−) `allowedHosts: true` is a dev-only setting and is not a security concern
because the dev server serves only this static project.

---

## ADR-005 — Proposition options are generated from the real hidden parameters
**Date:** 2026-10-16 · **Status:** Accepted

**Context.** Multiple-choice deduction is only honest if the "correct" answer is the world's actual
parameter, and only fair if the right answer is distinguishably observable.

**Decision.** `content/laws.ts` builds each proposition *from* the species' trait block: the correct
option is computed from `tolerance.temperature.ideal` / `diet.prey` / measured reproduction gating,
and distractors are the sibling bands. A test (`tests/core/fairness.test.ts`) re-derives every
proposition from the config and asserts (a) exactly one option matches the parameters, (b) that
option is reachable with the sector's Charge budget using an in-world observation strategy.

**Consequences.** (+) Content can never drift out of sync with the simulation; adding a species
automatically adds learnable laws. (−) The authored text must stay generic enough to be generated
from parameters (handled by banded phrasing + species-code interpolation).

---

## ADR-006 — All audio and art are generated at runtime
**Date:** 2026-10-16 · **Status:** Accepted

**Context.** Zero budget for licensed assets; portals require a small download and proven IP chain.

**Decision.** Visuals are drawn with Canvas 2D primitives and CSS; audio is synthesised with the Web
Audio API (oscillator/noise SFX and an ambient drone bed). No binary assets are shipped.

**Consequences.** (+) Tiny build (~150 KB), no licensing surface, no loading screens, instant start.
(−) Aesthetic ceiling is lower than pre-rendered art — mitigated by a deliberate, high-contrast
"instrument readout" visual language that suits the fiction.

---

## ADR-007 — Accessibility is a first-class requirement, not a later pass
**Date:** 2026-10-16 · **Status:** Accepted

**Context.** The game is keyboard-playable and text-heavy by nature (it is about reading data), which
makes it unusually well suited to be playable by screen-reader and low-vision users — and portals
increasingly require it.

**Decision.** All UI is semantic DOM with ARIA roles; the canvas has a live text summary written to
an `aria-live` region; the world cursor is keyboard-driven; every instrument has a DOM button with
accessible name, cost and disabled reason; options for reduced motion, high contrast, colour-vision
palettes and UI scale are persisted.

**Consequences.** (+) The game is playable with a keyboard alone and comprehensible with a screen
reader; all panels are also testable in jsdom. (−) Every feature must ship with its DOM affordance
(first-class constraint on future work).

---

## ADR-008 — Fairness of the deduction layer is executable, not editorial
**Date:** 2026-10-16 · **Status:** Accepted

**Context.** The Codex propositions are generated from the simulation (ADR-005), but "generated from
real data" does not by itself mean "answerable by a player". During the first fairness pass three
distinct failure modes appeared in shipped content: a reproduction driver that won by 0.0 points (a
coin flip), a claimed tolerance band that no terrain in the sector could ever offer, and a species
that bred *outside* the band its own traits claim. Each was found by a human reading a report, which
does not scale and does not prevent a regression.

**Decision.** The fairness rules live in code (`src/content/law-fairness.ts`) with named thresholds,
and the *same* function is called by the test-suite and by the content audit tool (`npm run laws`).
A proposition ships only if: the correct option is measurably best (reproduction drivers must win by
≥ 8 points of growth loss), the sector can verify it (the band exists in the climate, or an instrument
in that sector can create it), the claim is realisable (fitness ≥ 0.6 inside the claimed band), the
observation does not contradict it (a species must breed inside its own tolerance), and the evidence
contains no non-numbers.

**Consequences.** (+) Content regressions are caught by `npm test`, not by play-testing. (+) The rules
are a documented artefact a reviewer can argue with. (−) Two propositions had to change to satisfy the
rules: ORP-2's `reproDriver` subject was retargeted and TAU-7's driver law was replaced by a tolerance
law, because in the deliberately clement final sector no factor wins by a fair margin. (−) Content
authoring is slower: a new species cannot be added to a sector without re-running the audit.

---

## ADR-009 — Carrion closes the nutrient loop; scavenging is role-limited
**Date:** 2026-10-16 · **Status:** Accepted

**Context.** Predators were dying of starvation at high fitness (0.9) with prey in sight, in 5 of 15
sector/seed combinations. Tracing showed the cause was the energy economy, not perception: a hunt
returns one prey's drained energy, and in a small sector the encounter rate is too low for that to
pay for metabolism. Two fixes were tried and rejected: making strikes non-lethal (removes the
predator's meaning) and letting predators browse any biomass field (they ate their ecosystem).

**Decision.** A fixed fraction (`DECOMPOSE_RATIO = 0.3`) of a dead organism's remaining energy returns
to its species' biomass field as a carcass, and scavenging (eating a mat that is not your prey) is
gated by trophic role: nothing for autotrophs, 0.5 for filter feeders (drifting detritus — their whole
lifestyle), 0.2 for carnivores (carrion, enough to survive a bad patch but not to raise a family).

**Consequences.** (+) Predators survive on kills *plus* carrion, and the reef's nutrient loop closes
visibly: matter that dies in the dark zone becomes food for the filter feeders. (+) Measured
extinction-free across 15 sector/seed runs. (−) One more tuned constant; it is documented here and in
the code, and the balance harness guards it.

---

## Repaired defects (kept for the record)
**Date:** 2026-10-16

Defects found and fixed while building the simulation and the deduction layer. Listed because each one
was silent — none of them threw, and the first three produced plausible-looking wrong answers.

1. **Field-distribution bins and values were on different scales.** `computeFieldDistributions` binned
   samples over the *physical* field limits while `binValue` reconstructed them over the *observed*
   range, so `factorLoss`/`analyseGating` integrated a weight against an unrelated temperature — the
   derivation behind every reproduction-driver law. Fixed by walking the climate twice: once to learn
   the range (pulses included), once to bin it. `tests/core/sector.test.ts` asserts weights sum to 1
   and `binValue` round-trips a value into the bin it came from.
2. **KEL-4's advertised pulse did nothing.** The `roof-flare` event sat on the permanent roof opening
   (light 0.96 of a 1.00 ceiling), so its +0.32 impulse was clamped away. Moved to the dark floor
   (13,28) and `validateSector` now rejects a pulse that cannot deliver at least half its magnitude.
3. **`nutrientBloom` reported the neighbourhood, not the deposit.** It returned the total biomass in
   the radius across *all* species; it now returns the delta for the species it was called on.
4. **`ScalarField.paint` mis-strided its output buffer** (`Math.min(a, a)` as a loop bound) and
   `stats()` handed out its mutable cache. Both fixed and covered by tests.
5. **`assertValidSector` did not list the problems** it found (they were only in the error context),
   and it never checked habitability, so a sector whose climate no roster species can survive on
   passed validation and started a doomed population. Both fixed.
6. **Public world methods failed silently on unknown species ids:** `fitnessAt` returned 0 ("dead
   zone"), `introduce` returned 0, `cull` removed nothing. All now throw.

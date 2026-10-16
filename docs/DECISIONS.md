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

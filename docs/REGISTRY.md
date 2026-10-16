# WORLDBUG — project registry

Living record of what exists, what is proven, and what is still open. Updated at the end of every
work session, per the project's working agreement. The source of truth for behaviour is the code; for
rules and rationale it is `docs/DESIGN.md`, `docs/ARCHITECTURE.md` and `docs/DECISIONS.md`.

**Status:** the game is **playable end to end in a browser**. The ecology core now has a validated
world/resource model, four starter strategies, explicit seven-phase turns, stable seeded replay and a
safe declarative rule engine; the 12-species campaign, Codex, renderer, UI, grading and persistence
remain under test. Remaining work is breadth of manual verification and balance — see *Open issues*.

---

## 1. What is implemented and verified

| Area | Modules | State | Verification |
|---|---|---|---|
| Deterministic RNG | `src/core/rng.ts` | Done | `tests/core/rng.test.ts` (14) |
| Numeric helpers | `src/core/math.ts` | Done | `tests/core/math.test.ts` (15) |
| Error taxonomy | `src/core/errors.ts` | Done | exercised across the suite |
| Scalar fields | `src/core/field.ts` | Done | `tests/core/field.test.ts` (21) |
| Fitness / tolerance and strategies | `src/core/sim/species.ts` | Done | `tests/core/species.test.ts` (17) |
| Validated world, climate, territory | `src/core/sim/sector.ts` | Done | `tests/core/sector.test.ts` (19), `tests/core/ecology.test.ts` |
| Water and mineral stocks | `src/core/sim/resources.ts` | Done | `tests/core/ecology.test.ts` |
| Safe ecological rule DSL | `src/core/sim/rules.ts` | Done | `tests/core/rules.test.ts` (5), domain malformed-input test |
| Seven-phase world simulation | `src/core/sim/world.ts` | Done | `tests/core/world.test.ts` (23), `tests/core/determinism.test.ts` (3) |
| Events, metrics, probes | `src/core/sim/events.ts`, `metrics.ts` | Done | via world/sector tests |
| Species catalogues (12 campaign + 4 starter strategies) | `src/content/species.ts`, `starter-ecosystem.ts` | Done | trait-range, ecology and viability tests |
| Campaign sectors (5) | `src/content/sectors.ts` | Done | validation + viability tests |
| Deduction layer | `src/content/laws.ts` | Done | `tests/core/laws.test.ts` (21) |
| Law fairness audit | `src/content/law-fairness.ts` | Done | same suite (ADR-008) |
| Domain contracts / imported-data validation | `src/domain/contracts.ts`, `validation.ts` | Done | `tests/domain/contracts.test.ts` (4) |
| Balance harness | `tools/balance.ts` | Done | `npm run balance` |
| Species tracer | `tools/trace.ts` | Done | `npm run trace` |
| Law audit | `tools/laws.ts` | Done | `npm run laws` |
| Observable store | `src/game/store.ts` | Done | exercised by every UI test |
| Instruments (10) | `src/game/instruments.ts` | Done | `tests/ui/app.test.ts` |
| Mission / session | `src/game/session.ts` | Done | `tests/ui/app.test.ts` |
| Grading (`DESIGN.md` §6) | `src/game/grading.ts` | Done | filing + report tests |
| Persistence (v1 save) | `src/game/persistence.ts` | Done | save, corrupt-save, blocked-storage tests |
| Audio (synth, no assets) | `src/game/audio.ts` | Done | no-op path + settings status |
| App state | `src/game/state.ts` | Done | via UI tests |
| Palettes / contrast | `src/render/palettes.ts` | Done | via renderer tests |
| Canvas renderer | `src/render/renderer.ts` | Done | `tests/render/renderer.test.ts` (9), including no gameplay mutation |
| UI shell + a11y | `src/ui/app.ts`, `ui/a11y.ts` | Done | `tests/ui/app.test.ts` (18) |
| Shell markup / boot | `index.html`, `src/main.ts`, `styles.css` | Done | mounted by the UI tests; real dev server exercised |

**Test totals:** 14 files, 186 tests (`npm test`, verified 2026-10-16). Typecheck and lint clean (0 errors, 0 warnings).

## 2. Evidence the world works

Executed against the current worktree for this update:

- `npx tsc --noEmit -p tsconfig.json` → clean.
- `npx eslint .` → clean (0 errors, 0 warnings).
- `npm run verify` → **186 passed / 14 files**, typecheck/lint clean, production build succeeded (five campaign viability runs included).
- `npm run balance -- 0 '' --seeds=3` → **no local extinctions** in 15 sector/seed runs after the phase refactor; every population stayed above zero through its survey horizon.
- `npm run laws` → zero unfair propositions across all five campaign sectors; the audit checks
  unambiguity, available instruments, in-band fitness, trophic measurements and observed viability.
- `npm run build` → `dist/index.html` 6.14 kB, CSS 6.77 kB, JS 147.79 kB (46.74 kB gzipped), 30 modules,
  zero external assets — the whole game is HTML + JS + CSS.
- `npm run dev` → Vite dev server on `0.0.0.0:5173`; `index.html`, `src/main.ts`, the UI modules and
  the stylesheet are all served (HTTP 200), so the game boots in a browser.

Per-sector survey results (own seed, no player intervention): FER-1 AUR-3/FER-7, KEL-4
KEL-2/VEL-5/ORS-9, VOX-9 VOX-1/SCU-4/MYC-8/GLI-3, ORP-2 ORP-6/KEL-2/CAL-5/GLI-3, TAU-7
AUR-3/KEL-2/FER-7/ORS-9/TAU-0 — all populations above zero, all with recorded births.

## 3. Content inventory

**Starter strategies (4):** PHY-1 photosynthetic producer, PRE-1 predator, DEC-1 decomposer (mineralizes
organic biomass), SYM-1 symbiont (mutual energy benefit with PHY-1). `ECO-0 Genesis Terrarium` is the
explicit validated headless template; the campaign roster remains separate.

**Campaign species (12):** AUR-3 Aurelia thermica (autotroph), FER-7 Ferrax repens (grazer), KEL-2 Kelpia
umbrosa (autotroph, dim/cold), VEL-5 Vellum vagans (grazer, migrator), ORS-9 Orsax vorax (predator),
VOX-1 Voxa lucida (autotroph, bright), SCU-4 Scuta (grazer, dim), MYC-8 Mycorrhiza pallens (filter,
aphotic), ORP-6 Orpa ustulata (autotroph, hot), CAL-5 Calyx fervens (grazer, `perish`), GLI-3 Glirra
(predator), TAU-0 Tauros invadens (invasive generalist).

**Sectors (5):** FER-1 Cinder Shelf (chapter 1, 2600 ticks), KEL-4 Vault Basin (2, 3000, `roof-flare`
pulse), VOX-9 Lumen Reef (3, 3200, four lumen domes), ORP-2 Ashfall (4, 3600, `meridian-surge` pulse),
TAU-7 Ghost Meridian (5, 3600, all ten instruments).

**Propositions:** 31 across the campaign (5/6/6/7/7), weights 0.6–1.4, Data Assist cost 3 Charge each.

## 4. Open issues

Ordered by what would stop a release first.

1. ~~**No runnable game yet.**~~ **Closed 2026-10-16.** `index.html`, `src/main.ts`, `src/ui/*`,
   `src/render/*` and `src/game/*` are implemented; `npm run dev` serves a playable game and the UI
   tests drive the real shell. Remaining gap: no browser engine is available in this environment, so
   the canvas/video path is verified by a recording 2D context rather than by a real screenshot, and
   frame pacing on low-end hardware is still unmeasured (see 8).
2. ~~**No persistence layer.**~~ **Closed 2026-10-16.** `src/game/persistence.ts` stores a versioned
   v1 record in `localStorage`, quarantines unusable records to `worldbug.save.corrupt`, degrades to a
   warning when storage is blocked or throws, and is covered by four tests.
3. ~~**No scoring/report screen.**~~ **Closed 2026-10-16.** `src/game/grading.ts` implements
   `DESIGN.md` §6 exactly; the report screen shows rank, score, correctness, conservation, efficiency,
   spent Charge, extinctions and a per-proposition debrief, and persists the rank.
4. ~~**`computeFieldDistributions` caches by `config.id`.**~~ **Closed 2026-10-16.** The cache is a
   `WeakMap` keyed by the config *object*, so two configurations sharing an id can never collide;
   `tests/core/sector.test.ts` covers exactly that case.
5. ~~**DOM tests are not written yet.**~~ **Closed 2026-10-16.** `tests/ui/app.test.ts` (18 tests)
   mounts the real `index.html` in jsdom and drives the game through its dispatch API;
   `tests/render/renderer.test.ts` (9 tests) drives the renderer against a recording 2D context and compares rendered/headless simulation state.
6. **Balance is measured on 3 seeds.** Extinction-free on the sector's own seed and two derived seeds;
   a wider sweep (`--seeds=20`) is recommended before release, and the harness exits non-zero on
   collapse so it can be wired into CI.
7. **Only FER-1 has been played through by hand** (and only the parts the UI tests exercise). Each
   sector's budget is now validated at import time (`startingCharge`, `startingIntegrity`,
   `biomassTarget` bands measured from real runs), but the *playability* of the later sectors — KEL-4
   and ORP-2 in particular — has not been confirmed by a human session.
8. **Throughput headroom.** After the phase refactor TAU-7 ran ~397–459 ticks/s in the three-seed
   balance sweep. The renderer measures its own frame cost and drops quality above 12 ms, but real
   device timings (and panel rebuild cost) have not been profiled in a browser.
9. **Shipped-string language undecided.** All code, comments and player-facing strings are currently
   English. If the game should ship in Italian, the strings need extracting into a single content
   module; this is cheap now and expensive later. Awaiting a decision that only the owner can make.
10. ~~**`renderWarning` is not surfaced in the UI yet.**~~ **Closed 2026-10-16.** A browser without
    canvas 2D now gets an explicit notice in the stage ("every reading is also shown as text"), the
    state records `renderWarning`, and the UI test asserts the notice appears.

## 5. Deliberate scope decisions recorded so far

- Zero runtime dependencies; all art and audio generated at runtime (ADR-001, ADR-006).
- No backend, no network calls, no AI APIs, no monetisation hooks in gameplay (ADR-002).
- Every law proposition is derived from the simulation and audited by code (ADR-005, ADR-008).
- Carrion closes the nutrient loop; scavenging is role-limited (ADR-009).
- `noUncheckedIndexedAccess` and `no-non-null-assertion` are both enforced; indexing is routed through
  bounds-checked helpers or explicit narrowing rather than assertions.
- The UI is DOM panes over a canvas, bound by one action dispatcher, with a signature-gated re-render
  (ADR-010); audio is synthesised and every node it starts is disposable (ADR-011).

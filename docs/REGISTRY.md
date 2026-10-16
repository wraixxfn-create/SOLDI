# WORLDBUG — project registry

Living record of what exists, what is proven, and what is still open. Updated at the end of every
work session, per the project's working agreement. The source of truth for behaviour is the code; for
rules and rationale it is `docs/DESIGN.md`, `docs/ARCHITECTURE.md` and `docs/DECISIONS.md`.

**Status:** simulation core, species catalogue, campaign sectors and the deduction layer are complete
and under test. The playable shell (renderer, UI, game loop, persistence) is **not built yet** — see
*Open issues* — so the project is not yet runnable in a browser.

---

## 1. What is implemented and verified

| Area | Modules | State | Verification |
|---|---|---|---|
| Deterministic RNG | `src/core/rng.ts` | Done | `tests/core/rng.test.ts` (14) |
| Numeric helpers | `src/core/math.ts` | Done | `tests/core/math.test.ts` (15) |
| Error taxonomy | `src/core/errors.ts` | Done | exercised across the suite |
| Scalar fields | `src/core/field.ts` | Done | `tests/core/field.test.ts` (21) |
| Fitness / tolerance law | `src/core/sim/species.ts` | Done | `tests/core/species.test.ts` (17) |
| Sector climate, terrain, validation | `src/core/sim/sector.ts` | Done | `tests/core/sector.test.ts` (18) |
| World simulation | `src/core/sim/world.ts` | Done | `tests/core/world.test.ts` (23) |
| Events, metrics, probes | `src/core/sim/events.ts`, `metrics.ts` | Done | via world/sector tests |
| Species catalogue (12) | `src/content/species.ts` | Done | trait-range + diet integrity tests |
| Campaign sectors (5) | `src/content/sectors.ts` | Done | validation + viability tests |
| Deduction layer | `src/content/laws.ts` | Done | `tests/core/laws.test.ts` (21) |
| Law fairness audit | `src/content/law-fairness.ts` | Done | same suite (ADR-008) |
| Balance harness | `tools/balance.ts` | Done | `npm run balance` |
| Species tracer | `tools/trace.ts` | Done | `npm run trace` |
| Law audit | `tools/laws.ts` | Done | `npm run laws` |
| Renderer, UI, game loop, save | — | **Not started** | — |

**Test totals:** 8 files, 135 tests (`npm test`). Typecheck and lint clean.

## 2. Evidence the world works

Executed, in the state committed with this document:

- `npx tsc --noEmit -p tsconfig.json` → clean.
- `npx eslint .` → clean (0 errors, 0 warnings).
- `npx vitest run` → **135 passed / 8 files**, 43 s (the five sector viability runs are ~29 s of that).
- `npm run balance -- 0 '' --seeds=3` → **no local extinctions** in 15 sector/seed runs, every species
  of every sector still alive at the end of its survey horizon.
- `npm run laws` → every proposition unambiguous, verifiable with the instruments the sector ships,
  and consistent with observed births (0 unfair).

Per-sector survey results (own seed, no player intervention): FER-1 AUR-3/FER-7, KEL-4
KEL-2/VEL-5/ORS-9, VOX-9 VOX-1/SCU-4/MYC-8/GLI-3, ORP-2 ORP-6/KEL-2/CAL-5/GLI-3, TAU-7
AUR-3/KEL-2/FER-7/ORS-9/TAU-0 — all populations above zero, all with recorded births.

## 3. Content inventory

**Species (12):** AUR-3 Aurelia thermica (autotroph), FER-7 Ferrax repens (grazer), KEL-2 Kelpia
umbrosa (autotroph, dim/cold), VEL-5 Vellum vagans (grazer, migrator), ORS-9 Orsax vorax (predator),
VOX-1 Voxa lucida (autotroph, bright), SCU-4 Scuta (grazer, dim), MYC-8 Mycorrhiza pallens (filter,
aphotic), ORP-6 Orpa ustulata (autotroph, hot), CAL-5 Calyx fervens (grazer, `perish`), GLI-3 Glirra
(predator), TAU-0 Tauros invadens (invasive generalist).

**Sectors (5):** FER-1 Cinder Shelf (chapter 1, 2600 ticks), KEL-4 Vault Basin (2, 3000, `roof-flare`
pulse), VOX-9 Lumen Reef (3, 3200, four lumen domes), ORP-2 Ashfall (4, 3600, `meridian-surge` pulse),
TAU-7 Ghost Meridian (5, 3600, all ten instruments).

**Propositions:** 31 across the campaign (5/6/6/7/7), weights 0.6–1.4, Data Assist cost 3 Charge each.

## 4. Open issues

Ordered by what blocks the deliverable first.

1. **No runnable game yet.** There is no `index.html`, no entry point, no renderer, no UI and no game
   loop: the project cannot be played in a browser. This is the next milestone and the largest
   remaining block of work (`src/game/*`, `src/render/*`, `src/ui/*`, `index.html`, `src/main.ts`).
2. **No persistence layer.** Save/restore of campaign progress and sector attempts is designed
   (ADR-004) but not implemented; localStorage adapter, schema versioning and migration are to do.
3. **No scoring/report screen.** The graded score, rank thresholds, conservation and efficiency terms
   exist in `docs/DESIGN.md` but not in code.
4. **`computeFieldDistributions` caches by `config.id`** in a module-level `Map` keyed only by string,
   so two different configurations sharing an id would collide. It is correct for the shipped content
   (ids are unique and content is static); switch to a `WeakMap` keyed by the config object before any
   dynamic or user-generated sector is possible.
5. **DOM tests are not written yet.** `jsdom` is installed and `vitest.config.ts` is configured for
   node; per-file `// @vitest-environment jsdom` is the intended pattern (Vitest 5 removed
   `environmentMatchGlobs`). Required before the UI is called done.
6. **Balance is measured on 3 seeds.** Extinction-free on the sector's own seed and two derived seeds;
   a wider sweep (`--seeds=20`) is recommended before release, and the harness exits non-zero on
   collapse so it can be wired into CI.
7. **Throughput headroom.** Heaviest sector (TAU-7) runs ~260–600 ticks/s under the balance harness,
   comfortably above the 60 ticks/s floor asserted in tests, but the renderer's budget per frame has
   not been measured yet (no renderer exists).
8. **Shipped-string language undecided.** All code, comments and player-facing strings are currently
   English. If the game should ship in Italian, the strings need extracting into a single content
   module; this is cheap now and expensive later. Awaiting a decision that only the owner can make.

## 5. Deliberate scope decisions recorded so far

- Zero runtime dependencies; all art and audio generated at runtime (ADR-001, ADR-006).
- No backend, no network calls, no AI APIs, no monetisation hooks in gameplay (ADR-002).
- Every law proposition is derived from the simulation and audited by code (ADR-005, ADR-008).
- Carrion closes the nutrient loop; scavenging is role-limited (ADR-009).
- `noUncheckedIndexedAccess` and `no-non-null-assertion` are both enforced; indexing is routed through
  bounds-checked helpers or explicit narrowing rather than assertions.

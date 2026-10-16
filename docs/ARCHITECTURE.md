# WORLDBUG — Architecture

> Reference for contributors. Complements `docs/DESIGN.md` (game rules) and `docs/REGISTRY.md`
> (status/tests/open issues). Architectural decisions are recorded as ADRs in `docs/DECISIONS.md`.

## 1. Shape of the system

```
                         ┌──────────────────────────────────────────────┐
                         │                    main.ts                   │
                         │  boot: config → store → UI → loop → save      │
                         └───────┬───────────────┬──────────────┬───────┘
                                 │               │              │
             ┌───────────────────▼──┐   ┌────────▼────────┐  ┌──▼─────────────┐
             │  core/  (pure, no DOM)│   │ ui/ (DOM only)  │  │ render/ (canvas)│
             │  rng · field · sim    │   │ panels, screens │  │ field+agent draw│
             │  events · metrics     │   │ dialogs, a11y   │  │ overlays, fx    │
             └───────────────────┬───┘   └────────┬────────┘  └──┬─────────────┘
                                 │                │              │
                        ┌────────▼────────────────▼──────────────▼────────┐
                        │        game/  orchestration & state             │
                        │ store · session · instruments · evidence ·      │
                        │ propositions · grading · persistence · audio    │
                        └─────────────────────────────────────────────────┘
```

Hard rules enforced by lint/test:

1. **`core/` never imports `ui/`, `render/` or `game/`.** It is deterministic, side-effect-free,
   testable in plain Node, and free of `window`/`document`.
2. **`ui/` never mutates simulation state.** It renders from the store and dispatches intents.
3. **`render/` is a pure function of a snapshot** it is handed; it owns no game logic and tolerates a
   missing 2D context (returns a descriptive status instead of throwing).
4. **All random numbers in `core/` come from the injected seeded PRNG** — never `Math.random`.

## 2. Modules

### `src/core/` — deterministic simulation
| File | Responsibility |
| --- | --- |
| `rng.ts` | `mulberry32` seeded PRNG + `Rng` helper (int, range, gauss, pick, fork). |
| `math.ts` | `clamp`, `lerp`, `smoothstep`, `bellFit`, `wrapIndex`, `mean`, safe division. |
| `field.ts` | `ScalarField` grid: bilinear sampling, diffusion, relaxation, radial pulses, statistics. |
| `sim/species.ts` | Species definitions (traits + *hidden law parameters*) and their derived descriptors. |
| `sim/sector.ts` | `SectorConfig` schema, terrain sources, `validateSector()` with actionable errors. |
| `sim/events.ts` | Bounded event log ring buffer with typed events and filtering. |
| `sim/world.ts` | `World`: agents, spatial hash, biomass fields, `step()` with all ecosystem rules. |
| `sim/metrics.ts` | Population/biomass sampling, probes, extinction detection, stability index. |

### `src/content/` — authored data
| File | Responsibility |
| --- | --- |
| `species.ts` | The species catalogue (names, codes, palettes, trait blocks). |
| `sectors.ts` | The five campaign sectors, fully configured and validated at import time. |
| `laws.ts` | Law proposition definitions per sector, derived from the real hidden parameters. |
| `tutorial.ts` | Scripted, non-blocking briefing steps for sector 1. |

### `src/game/` — orchestration
| File | Responsibility |
| --- | --- |
| `store.ts` | ~120-line observable store (`get`, `set`, `subscribe`, `select`). No framework. |
| `state.ts` | Application state tree + `createInitialState`, sector loading, tick accounting. |
| `session.ts` | Mission lifecycle: start, tick budget, speed control, filing, results, progression. |
| `instruments.ts` | Instrument catalogue, charge/integrity accounting, `applyInstrument()` validation. |
| `evidence.ts` | Derived statistics (with `n=`) computed from probes + event log for Data Assists. |
| `propositions.ts` | Proposition instances, answering, confidence, correctness resolution. |
| `grading.ts` | Report evaluation, score/rank computation, per-proposition feedback. |
| `persistence.ts` | Versioned `localStorage` save file, migration, corruption recovery. |
| `audio.ts` | Web Audio synthesised SFX/music beds; no assets; degrades silently when unavailable. |

### `src/render/` and `src/ui/`
* `render/renderer.ts` — `Renderer` class: layered canvas painting (terrain → fields → biomass →
  organisms → tools → cursor), DPR-aware sizing, adaptive quality, reduced-motion aware.
* `ui/app.ts` — builds the DOM shell once and re-renders panels from store slices.
* `ui/panels/*` — mission HUD, instrument bar, inspector, data/charts, codex, log, settings, help.
* `ui/screens.ts` — title, sector select, briefing, results, ending.
* `ui/a11y.ts` — live-region announcer, focus management, keyboard help, canvas text summary.

## 3. Data flow of one frame

```
loop(frame)                       session.tickDue()          world.step()
  ├─ accumulate real dt ─────────▶ ticks to run (speed) ─────▶ simulate
  ├─ if paused: run 0 ticks
  ├─ worldSnapshot = world.sample()  (population, fields extrema, probe readings)
  ├─ store.patch({ snapshot })  ──▶ subscribers: ui re-render (only dirty panels)
  └─ renderer.draw(snapshot, uiState)
```

Panels subscribe to *slices*; a DOM patch is skipped when the slice is unchanged (cheap reference
comparison), so a 60 fps render loop does not thrash the DOM.

## 4. Determinism and the fairness invariant

`World` is constructed from `(SectorConfig, seed, options)`. Instruments are applied through
`applyInstrument()` which returns a *new* log entry and mutates the world only through the same code
paths the test suite exercises. Because there is no wall-clock dependency, a test can run 20 000
ticks in milliseconds and assert ecological outcomes.

**Fairness invariant (tested):** for every proposition in every sector, the correct option is
entailed by the sector configuration, and a scripted "ideal scientist" strategy — one that observes
the field extremes and the event log, then applies the mirror instrument to probe a species' niche —
can distinguish the correct option from the distractors within the sector's Charge budget. The test
`tests/core/fairness.test.ts` asserts both halves of this for all five sectors.

## 5. Error handling policy

| Layer | Policy |
| --- | --- |
| `core/` | Validates inputs, throws typed `WorldBugError`s with actionable messages for programming errors; never throws for player-triggered edge cases (returns structured failures). |
| `game/` | Every player action returns `{ ok: true, … } \| { ok: false, reason }`; the UI shows the reason as a toast — no silent failures, no dead buttons. |
| `render/` | Missing 2D context, zero-sized canvas or lost context degrade to a status message; the DOM UI remains fully usable. |
| `audio/` | Any `AudioContext` failure disables audio and surfaces a notice in Settings. |
| `persistence/` | Corrupt/foreign save data is quarantined (`worldbug.save.corrupt`) and a clean profile is created; the player is told. |
| global | `main.ts` installs `window.onerror`/`unhandledrejection` handlers that show a recoverable error overlay with a "copy diagnostics" button instead of a blank screen. |

## 6. Build & distribution

* `npm run build` → `dist/` with a single relative-referenced bundle (`base: './'`), no network calls,
  no external fonts, no assets beyond HTML/CSS/JS/SVG-inline.
* `dist/` is zipped by `npm run package` into `worldbug-html5.zip` for portal submission, with a
  `PORTAL.md` checklist for the common HTML5 aggregators (responsive canvas, mute-on-blur,
  no external links during play, paused when hidden).

# WORLDBUG — Design Document (v1.0)

> Every mechanic described here is implemented in the shipping build. This document is the
> authoritative reference for the game's rules; `docs/ARCHITECTURE.md` covers how they are coded
> and `docs/REGISTRY.md` tracks implementation status, tests and open issues.

## 1. High concept

**WORLDBUG** is a single-player HTML5 game of *field science* set on alien biospheres whose rules
are unknown to the player. You are a Xenological Analyst of the *ISV Meridian* survey. You cannot
command the ecosystem: you can only **observe** it, **disturb** it with a strictly limited energy
budget, **deduce** the laws that govern it, and **file a Codex report** before the survey window
closes — without destroying the biosphere you are studying.

Three pillars, in tension with each other:

| Pillar | Player fantasy | System |
| --- | --- | --- |
| **Simulation** | "This world is really alive" | A deterministic agent + scalar-field ecosystem running hundreds of organisms with metabolism, tolerance, diet, reproduction and death. |
| **Deduction** | "I figured the world out" | Hidden per-species law parameters must be inferred from observed behaviour and experiments, then committed to a graded report. |
| **Strategy** | "I spent my budget wisely" | Charge is finite, disturbance costs Integrity, destructive experiments damage the ecosystem you are scored on preserving. |

## 2. Core loop

```
  ┌────────────┐   probes / scan    ┌────────────┐
  │  OBSERVE   │───────────────────▶│  EVIDENCE  │
  │ run sim    │                    │ auto log   │
  └────┬───────┘                    └─────┬──────┘
       │ instruments (Charge)            │
       ▼                                 ▼
  ┌────────────┐   analyse (Charge) ┌────────────┐
  │ EXPERIMENT │───────────────────▶│  HYPOTHESIS│
  └────┬───────┘                    └─────┬──────┘
       │ Integrity cost                  │ commit
       ▼                                 ▼
  ┌────────────┐                    ┌────────────┐
  │  BIOSPHERE │─── stability ─────▶│   REPORT   │──▶ rank S/A/B/C
  └────────────┘      score         └────────────┘
```

## 3. The simulation

### 3.1 Space and fields

* The sector is a `W × H` grid of cells (48×32 by default) rendered as a hexagon-free grid map.
* Three continuous scalar fields evolve every tick:
  * **Temperature** (K, 150–450 range),
  * **Humidity** (0–1),
  * **Light** (0–1).
* Terrain *sources* (thermal vents, cryo seeps, mist basins, crystal luminaries, shade canyons)
  push the fields toward a local target with radial falloff. Fields diffuse, then relax weakly
  toward the sector baseline. The result is a stable-but-heterogeneous environment: **geography is
  the first thing a player learns to read**.

### 3.2 Organisms

Each organism is an agent with continuous position, energy, age and per-species traits.
Every tick, in deterministic order:

1. **Sensing** — sample the three fields and the biomass of every diet species at its position.
2. **Fitness** — `fit = fitT × fitH × fitL`, where each term is a two-sided bell curve around the
   species' *hidden* ideal value. `0 ≤ fit ≤ 1`.
3. **Feeding**
   * *Producer*: gains energy from `fit` (photosynthesis analogue: light, temperature and moisture
     all matter).
   * *Consumer*: intake is limited by the *actual* biomass of its diet species in the cell, so
     depletion is physical, not scripted. Predators additionally record a **kill event** when they
     take prey individuals.
4. **Metabolism** — energy drains at a rate scaled by exposure (low `fit`), movement and age.
5. **Desperation movement** — an agent whose energy falls below its comfort threshold samples the
   fitness of its own cell vs. its neighbours (a real gradient estimate of the true fitness
   function) and moves upslope; otherwise it wanders with per-agent noise and species speed.
6. **Reproduction** — above an energy threshold, once mature and off cooldown, and only when the
   local food supply is not exhausted: the agent pays an energy cost and spawns an offspring with
   slight inherited trait variance.
7. **Death** — starvation (energy ≤ 0), exposure (sustained `fit` below the lethal threshold), old
   age (lifespan), or predation. Every death is logged **with its cause**: this is evidence.

Biomass is a real quantity: organisms deposit part of their energy into their species' biomass
field, and consumers remove it. Energy is not conserved perfectly (metabolism burns it) but mass
transfers are — over-grazing really does starve the producers.

### 3.3 Determinism

The whole simulation is a pure function of `(sectorConfig, seed, orderedActions)`:
a seeded PRNG (mulberry32) is the only randomness, the timestep is fixed, and there are no wall-clock
or `Math.random` dependencies. Replaying the same inputs yields the same world — this is what makes
the puzzle fair and the test suite meaningful.

## 4. Player capabilities

### 4.1 Survey tools (free, always available)

| Tool | Effect |
| --- | --- |
| **Field overlay** | Toggle temperature / humidity / light / biomass overlays; the temperature overlay is what makes "thermal niche" deduction possible. |
| **Organism scanner** | Click (or keyboard-cursor) any organism to open the Inspector: species, age, energy, current field readings at its position, its recent events. |
| **Probes** | Place up to `N` autonomous sensors; they sample the fields *and* count organisms of each species in a radius over time. Probe recordings are charted in the Data panel. |
| **Event log** | Chronological, filterable, per-species log of births, deaths (with cause), kills, grazing spikes and field pulses. |

### 4.2 Instruments (cost Charge; some cost Integrity)

| Instrument | Charge | Integrity | Effect |
| --- | --- | --- | --- |
| Thermal Pulse | 2 | 0 | +Δ temperature in a radius, decaying |
| Cryo Pulse | 2 | 0 | −Δ temperature |
| Humidifier | 2 | 0 | +Δ humidity |
| Desiccator | 2 | 0 | −Δ humidity |
| Illuminator | 2 | 0 | +Δ light |
| Umbra Field | 2 | 0 | −Δ light |
| Nutrient Bloom | 3 | 0 | Instant biomass injection for producers |
| Containment Barrier | 3 | 1 | Blocks movement across a line (repeatable, removable) |
| Cull Wave | 4 | 6 | Removes organisms in a radius (destructive) |
| Hatchery | 5 | 2 | Introduces individuals of a chosen species |

Disturbance decays back toward the baseline environment, so a pulse is a *measurement*, not a
permanent edit: the world answers the question and then heals.

### 4.3 Analysis (cost Charge)

For each open proposition the player may spend Charge on a **Data Assist**: the game runs the actual
statistics over everything recorded so far (probe samples + event log) and shows a real, derived
figure — e.g. *"Observed mean temperature at capture sites of AURELIA: 344 K (n=118); mean at
death-by-exposure sites: 233 K (n=37)."* Assists never contain the answer; they contain the data the
player could have collected manually, which keeps deduction in the player's hands while making the
puzzle solvable without note-taking tedium.

## 5. The deduction layer

Each sector declares a set of **law propositions** generated directly from the hidden simulation
parameters at sector-construction time:

* **Tolerance band** — "Species X thrives in *cold / temperate / hot* (resp. dry / balanced / wet,
  dark / dim / bright) conditions." The correct band is derived from the species' actual ideal value;
  distractors are the other bands.
* **Trophic link** — "Which species does X feed on?" Options: the real diet species, common decoys,
  and "X is a primary producer".
* **Vulnerability** — "Which species is X most dependent on?" (derived from the diet/predation graph).
* **Reproduction driver** — "X reproduces fastest when *light / moisture / warmth* is abundant."
  Derived by actually measuring, at sector-build time, which environment term gates its reproduction.
* **Stress response** — "When exposed to conditions it cannot tolerate, X *dies / migrates /
  stops reproducing*." Derived from the species' behavioural parameters.

Because propositions *are* the parameters, grading cannot lie, and every proposition is in principle
observable in-game (that is the fairness invariant asserted by the test suite).

A proposition is answered by picking one option (or "unknown"), and locked in with a confidence
marker. The report is filed when all propositions are answered or the survey window (tick limit)
expires; unanswered propositions score as incorrect.

## 6. Mission scoring

```
correctness  = weighted correct propositions / total        (0..1)
conservation = f(final biomass vs. target band, extinctions) (0..1)
efficiency   = 1 − spentCharge / initialCharge × 0.5         (0.5..1)
score        = 1000 × correctness^1.3 × (0.6 + 0.25·conservation + 0.15·efficiency)
rank         = S ≥ 900 · A ≥ 750 · B ≥ 550 · C otherwise
```

An ecosystem collapse (all species extinct) fails the sector regardless of the report: the survey
rejects a report filed over a dead world. Ranks gate progression: sector *n+1* unlocks after sector
*n* is filed with rank **C or better**.

## 7. Sectors (campaign)

| # | Name | Species | New mechanic |
| --- | --- | --- | --- |
| 1 | FER-1 «Cinder Shelf» | 2 (1 producer, 1 grazer) | Tutorial: reading fields, one tolerance law |
| 2 | KEL-4 «Vault Basin» | 3 (+1 predator) | Trophic links, kill evidence |
| 3 | VOX-9 «Lumen Reef» | 4 (+1 shade-dwelling filter) | Light as a niche axis, grazing pressure |
| 4 | ORP-2 «Ashfall» | 4 | Pulsing environment: a periodic heat surge changes what "thriving" means; migration laws |
| 5 | TAU-7 «Ghost Meridian» | 5 | Invasive species scenario: the player must diagnose a collapsing world |

Each sector also defines: grid size, baseline fields, terrain sources, initial populations, starting
Charge, survey window (ticks), conservation target (final biomass band) and the instrument set.

## 8. UX / accessibility

* **Layout** — three-pane desktop layout (left: instruments + mission; centre: world canvas; right:
  inspector / data / codex). Collapses to a stacked, tabbed layout on phones.
* **Input** — 100 % playable with mouse, touch and keyboard. Canvas cursor movement with arrow keys,
  `Enter` to act, `1`–`9` to select instruments, `Space` to pause, `,`/`.` to change speed, `?` for help.
* **Screen readers** — every readout in the Inspector/Data/Codex panels is real DOM text, updated
  through `aria-live` regions with conservative politeness. The canvas has an accessible text
  summary (population table + field extrema + cursor cell readings) so the game is playable without
  seeing the map.
* **Options** — reduced motion, high-contrast HUD, three colour-vision-safe palettes, UI scale,
  sound volume/mute (all audio is synthesised at runtime; no asset downloads), auto-pause on tab
  blur, and a "confirm destructive tools" toggle.
* **Performance** — simulation and rendering are decoupled; the renderer draws only visible layers,
  reuses offscreen buffers and skips effects under reduced motion. Target: 60 fps at 48×32 with 600
  organisms on a 2019-class laptop, degraded gracefully (adaptive quality) if frames run long.

## 9. Non-goals (v1.0)

* No backend, accounts, analytics, ads, monetisation, or AI services. The game is a static bundle.
* No multiplayer. No procedural campaign generation (sectors are authored, deterministic content).
* No external art/audio assets: all visuals are drawn with canvas primitives and all sound is
  synthesised with the Web Audio API, so the build has zero binary assets and zero licensing surface.

# WORLDBUG

An HTML5 browser game of alien-ecosystem simulation, scientific deduction and strategy. You are a
survey ecologist: read three environmental fields, watch a living world you did not author, intervene
with a limited budget, and file a Codex report stating the laws you believe govern it. You are graded
on whether you are right.

Everything in this repository is original, dependency-free at runtime, and generated in code — there
are no binary assets, no network calls and no external services.

## Requirements

- Node.js ≥ 22.22.2 (the tools use `node --experimental-strip-types`)
- A modern browser (Canvas 2D + Web Audio)

## Getting started

```bash
npm install
npm run dev        # dev server on http://0.0.0.0:5173
```

Then open the served address and press **Begin survey**. The game is fully playable: pick a sector,
observe, use instruments, answer the Codex propositions and file the report. Progress is saved in
`localStorage` (no account, no server).

Quick controls: `Space` play/pause · `1`–`0` instruments · arrows move the survey cursor (hold
`Shift` to pan) · `Enter` apply the selected instrument · `O` cycle overlay · `P` drop a probe ·
`R` recover a probe · `F` file the report · `?` help. Mouse, pen and touch all work on the map.

See `docs/REGISTRY.md` for exactly what is done, what is proven, and what is outstanding.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` over src, tests, tools and configs |
| `npm run lint` | ESLint (flat config, `no-explicit-any` and `no-non-null-assertion` are errors) |
| `npm test` | Vitest, single run |
| `npm run coverage` | Vitest with v8 coverage |
| `npm run check` | typecheck + lint + tests |
| `npm run verify` | `check` followed by a production build |
| `npm run balance -- [ticks] [SECTOR] [--seeds=N]` | Headless survey of every sector: populations, biomass, stability, deaths by cause, throughput. Exits non-zero if any species dies out. |
| `npm run trace -- <SECTOR> <SPECIES> [ticks] [interval] [seed]` | Per-species diagnosis: energy, fitness, local food, deaths by cause, intake shares. Use it when `balance` reports an extinction. |
| `npm run laws [-- --margins]` | Prints every Codex proposition with the measurements behind it and audits fairness. Exits non-zero on any unfair proposition. |

## Documentation

- `docs/DESIGN.md` — the game: loop, tools, instruments, scoring, campaign, accessibility.
- `docs/ARCHITECTURE.md` — layering, module responsibilities, performance and error policy.
- `docs/DECISIONS.md` — decision log (ADRs) and the record of repaired defects.
- `docs/REGISTRY.md` — implemented features, executed evidence, open issues.

## Project rules

Content is data, never prose: every law the game asks about is derived from the simulation and audited
in code (`src/content/law-fairness.ts`), so the Codex can never disagree with the world on screen. The
world is a pure function of `(sector configuration, species, seed, ordered player actions)` — there is
no `Math.random` anywhere in `src/core`, and the same seed always produces the same survey.

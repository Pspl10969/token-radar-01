# Token Launch Radar

[![Competition](https://make.fun/badge/token-radar-01.svg)](https://make.fun/c/token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/Pspl10969/token-radar-01/rank.svg)](https://make.fun/c/token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/Pspl10969/token-radar-01/reward.svg)](https://make.fun/c/token-radar-01)

A token launch radar for [make.fun's token-radar-01 bounty](https://make.fun/c/token-radar-01).
It reads the competition's sealed DefiLlama snapshot (758 protocols, fetched 2026-11-14),
finds the protocols that record no token yet and are not a wrapped, staked or bridged
product of one that already trades, ranks them by what their token launch would be worth,
and hands the reader a farm plan for every one of them.

The board covers the snapshot's whole 40-protocol watchlist and adds 138 early finds below
the $50M watchlist floor: 178 ranked rows. Protocols whose token already trades are never
ranked; the dashboard shows them apart, at the market's own market cap.

## The model

Implied value is built from the snapshot's own figures only — no protocol's name is an
input, and the same function scores every row:

```
implied = TVL x peer multiple x momentum x seasoning
```

- **Peer multiple** — what the market already pays for a dollar of TVL in the protocol's
  category: the median market-cap / TVL of that category's traded protocols in the same
  snapshot (market-wide median 0.17x). A category median is clamped to [0.03, 1.50], then
  shrunk toward the market median with weight n / (n + 9), so a category earns its own
  multiple only as its traded peers pile up. A category with no traded peer is priced at
  the market median.
- **Momentum** — the seven-day TVL change, clamped to [-50%, +100%], scaled by 0.35.
- **Seasoning** — how long the protocol has run with no token, from DefiLlama's first
  tracking date to the snapshot date: a factor rising from 0.80 to 1.20 over four years.

Each board row carries its three factors, so any rank can be re-derived by hand. The
dashboard's model sandbox lets a reader move the momentum and seasoning weights and watch
the board re-rank.

## The dashboard

`dashboard/` is a static page (no framework, no network): a sortable, filterable board
(search, category, chain, minimum TVL, watchlist-only), a detail view per protocol with
the model's factor breakdown and the farm plan, and an "Already trading" view of the
live-token protocols the multiples are read from. Every row's farm plan gives concrete
steps with what they cost and how long they take, derived from the protocol's category,
chains, TVL and age.

## Run it

Node.js 22.18 or later, standard library only:

```
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

This writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/` and
`out/dossier.json` (built with `vendor/makefun-board.ts`, the kit's vendored library).
The run is deterministic: the same snapshot always writes the same bytes.

## Layout

- `main.ts` — the program: snapshot in, board, data, dashboard, screenshots, dossier out.
- `lib/model.ts` — the valuation model, the board builder and the farm plans.
- `vendor/makefun-board.ts` — make.fun's dossier library, vendored from the kit.
- `dashboard/` — the page: `index.html`, `app.css`, `app.js`.
- `screenshots/` — the board, a detail view and a filtered view.

## License

MIT — see `LICENSE`.

---

*Submission note (not part of the entry): the rank and reward badge URLs above name this
entry's GitHub repository, `Pspl10969/token-radar-01`. The repository carries
`.makefun/owner.json`, naming the entrant account's wallet as the claim file requires.*

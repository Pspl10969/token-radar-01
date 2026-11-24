// Token radar model: one sealed snapshot in, one ranked board out.
//
// The question the board answers: if this protocol issued its token today, with its record
// exactly as the snapshot holds it, what would that token be worth? The model answers with
// the snapshot's own market, never with a list of names:
//
//   implied = TVL x peer_multiple x momentum x seasoning
//
// - peer_multiple: what the market already pays for a dollar of TVL in this protocol's
//   category. For every category, take the protocols in the snapshot whose token trades
//   (mcap_usd recorded) and use the median of their market-cap / TVL ratios. A category
//   median is first clamped to [0.03, 1.50] (one thin category's outlier cannot set the
//   price), then shrunk toward the whole market's median with weight n / (n + 9), so a
//   category earns its own multiple only as its traded peers pile up: one peer moves the
//   price a tenth of the way, fifteen peers most of it. A protocol whose category has no
//   traded peer at all is priced at the market median.
// - momentum: the seven-day TVL change, clamped to [-50, +100] percent, scaled by
//   MOMENTUM_WEIGHT. A protocol growing into its launch is worth more than one shrinking
//   into it; an unreported change counts as flat.
// - seasoning: how long the protocol has run at scale with no token, from listed_at to
//   the snapshot's as_of date. The factor rises linearly from SEASONING_BASE to
//   SEASONING_BASE + SEASONING_WEIGHT over SEASONING_DAYS: value left unclaimed for
//   years is worth more at launch than value that arrived last month. An unknown listing
//   date counts as the midpoint.
//
// The board covers the snapshot's whole watchlist (the floor, never a ceiling) and adds
// the strongest pre-token protocols below the floor that pass the same product filter
// the watchlist itself uses: no versioned pool names, no bridge / staking / restaking
// product categories, no wrapped or staked names, no exchange fronts. Those are products
// of tokens that already trade, not protocols waiting on a launch of their own.
// Protocols whose token already trades are never ranked: the dashboard shows them apart,
// at the market's own market cap.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and its sandbox may change. */
export interface ModelConstants {
  multiple_floor: number;
  multiple_cap: number;
  peer_shrinkage: number;
  momentum_weight: number;
  growth_floor: number;
  growth_cap: number;
  seasoning_base: number;
  seasoning_weight: number;
  seasoning_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  multiple_floor: 0.03,
  multiple_cap: 1.5,
  peer_shrinkage: 9,
  momentum_weight: 0.35,
  growth_floor: -50,
  growth_cap: 100,
  seasoning_base: 0.8,
  seasoning_weight: 0.4,
  seasoning_days: 1460,
  unknown_age_days: 730,
};

/** The model's version label: the dashboard names it and the board's rows carry it. */
export const MODEL_VERSION = 'peer-multiple-1';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 180;

/** How many live-token protocols the dashboard's live view carries, by market cap. */
export const LIVE_ROWS = 24;

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all in the snapshot. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are products of a token that already trades, never a launch of their own. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whole words that mark a wrapped or staked product of another protocol's token. */
const PRODUCT_WORDS = /\b(wrapped|staked|staking)\b/i;

/** Exchange names a product may front itself with. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Whether a pre-token record is a protocol waiting on its own launch, as opposed to a
 * wrapped, staked, bridged or versioned product of one whose token already trades.
 * The same filter the snapshot's watchlist was drawn with.
 */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (PRODUCT_WORDS.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return false;
  return true;
}

/** What the snapshot's market pays for a dollar of TVL, market-wide and per category. */
export interface PeerMultiples {
  market: number;
  byCategory: Map<string, { multiple: number; peers: number }>;
}

/**
 * The peer multiples, derived from the snapshot itself: for each category, the median
 * market-cap / TVL ratio of its traded protocols, shrunk toward the market median by
 * sample size and clamped. Categories with no traded peer fall back to the market median.
 */
export function peerMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): PeerMultiples {
  const clamp = (n: number): number => Math.min(model.multiple_cap, Math.max(model.multiple_floor, n));
  const traded = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const market = clamp(median(traded.map((p) => p.mcap_usd! / p.tvl_usd)));
  const ratios = new Map<string, number[]>();
  for (const p of traded) {
    if (p.category === null) continue;
    const list = ratios.get(p.category) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    ratios.set(p.category, list);
  }
  const byCategory = new Map<string, { multiple: number; peers: number }>();
  for (const [category, list] of ratios) {
    const categoryMedian = clamp(median(list));
    const shrunk = (list.length * categoryMedian + model.peer_shrinkage * market) / (list.length + model.peer_shrinkage);
    byCategory.set(category, { multiple: clamp(shrunk), peers: list.length });
  }
  return { market, byCategory };
}

/** The multiple one protocol is priced at, and how many traded peers stand behind it. */
function multipleFor(p: SnapshotProtocol, peers: PeerMultiples): { multiple: number; peerCount: number } {
  if (p.category !== null) {
    const entry = peers.byCategory.get(p.category);
    if (entry !== undefined) return { multiple: entry.multiple, peerCount: entry.peers };
  }
  return { multiple: peers.market, peerCount: 0 };
}

/** The three factors and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  peers: PeerMultiples,
  model: ModelConstants = MODEL,
): { implied: number; multiple: number; peerCount: number; growthPct: number; momentumMult: number; seasoningMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple, peerCount } = multipleFor(protocol, peers);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(protocol.change_7d, 0)));
  const momentumMult = 1 + (growthPct / 100) * model.momentum_weight;
  const ageForModel = Math.min(age ?? model.unknown_age_days, model.seasoning_days);
  const seasoningMult = model.seasoning_base + (ageForModel / model.seasoning_days) * model.seasoning_weight;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * momentumMult * seasoningMult));
  return { implied, multiple, peerCount, growthPct, momentumMult, seasoningMult, age };
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    version: string;
    peer_multiple: number;
    peer_count: number;
    growth_pct: number;
    momentum_multiplier: number;
    seasoning_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one board row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  peer_multiple: number;
  peer_count: number;
  growth_pct: number;
  momentum_multiplier: number;
  seasoning_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  market_multiple: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const peers = peerMultiples(snapshot, model);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it is ranked, whatever the filter says.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: launch candidates below the floor, strongest TVL first.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isLaunchCandidate(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const watchlist = new Set(snapshot.watchlist);
  const scored = [...chosen.values()].map((p) => ({ p, v: impliedValue(p, snapshot.as_of, peers, model) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    on_watchlist: watchlist.has(s.p.slug),
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    model: {
      version: MODEL_VERSION,
      peer_multiple: round4(s.v.multiple),
      peer_count: s.v.peerCount,
      growth_pct: s.v.growthPct,
      momentum_multiplier: round4(s.v.momentumMult),
      seasoning_multiplier: round4(s.v.seasoningMult),
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age),
  }));
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Roughly what one on-chain action costs in gas on a chain, in dollars. */
function gasFor(chain: string): number {
  if (chain === 'Ethereum') return 9;
  if (chain === 'Solana' || chain === 'Sui' || chain === 'Aptos') return 0.1;
  if (chain === 'Bitcoin') return 2;
  return 0.6;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 250_000_000) return 120;
  if (p.tvl_usd >= 50_000_000) return 80;
  return 50;
}

/** How many weeks to stay active, from the protocol's age: younger protocols get a longer window. */
function weeksFor(age: number | null): number {
  if (age === null) return 6;
  if (age < 365) return 8;
  if (age < 1095) return 6;
  return 4;
}

/** The core farming action for a category, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp')) return `Supply $${capital} of USDC to ${n} on ${chain}, then borrow about 30% against it and supply the borrow back, so both sides of the book carry your address`;
  if (c.includes('dex')) return `Swap about $${capital} through ${n} on ${chain} and park the proceeds in its deepest USDC pool as a liquidity position`;
  if (c.includes('bridge') || c.includes('cross chain')) return `Bridge $${capital} of USDC to ${chain} through ${n}, then use the bridged funds in one app on the far side instead of bridging straight back`;
  if (c.includes('restak') || c.includes('staking')) return `Stake $${capital} of the chain's staking asset through ${n} on ${chain} and hold the receipt token in the same wallet`;
  if (c.includes('derivative') || c.includes('perpetual')) return `Deposit $${capital} of USDC as margin on ${n} and hold one small hedged position open across the week`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('manager')) return `Deposit $${capital} into a ${n} vault on ${chain} and keep the vault shares untouched in the wallet`;
  if (c.includes('rwa')) return `Mint $${capital} of ${n}'s yield asset on ${chain} with USDC and hold it past the first distribution`;
  if (c.includes('basis') || c.includes('yield') || c.includes('farm')) return `Deposit $${capital} of USDC into ${n} on ${chain} and leave the position compounding in place`;
  if (c.includes('prediction')) return `Fund $${capital} and hold one position in a liquid market on ${n} until it settles`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${n} on ${chain} and hold the balance in the wallet`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${n} on ${chain} and keep the policy until it expires`;
  if (c.includes('launchpad')) return `Commit $${capital} to one open sale on ${n} and keep the allocation record in the wallet`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open in the same wallet`;
}

/** The second, different interaction a real user would make, by category. */
function secondActionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp')) return `Repay part of the borrow and borrow again once, so the wallet shows a full lend-borrow-repay cycle on ${n}`;
  if (c.includes('dex')) return `Make two swaps in different pairs on ${n} a few days apart, so the wallet reads as a trader and not a one-off`;
  if (c.includes('bridge') || c.includes('cross chain')) return `Bridge a smaller amount back through ${n} a week later, completing a round trip on ${chain}`;
  if (c.includes('derivative') || c.includes('perpetual')) return `Close the hedge and open a fresh one the following week, keeping margin on ${n} throughout`;
  if (c.includes('prediction')) return `Take a second position on a different market on ${n} once the first settles`;
  return `Add a small top-up deposit to ${n} in the second week, so the wallet shows repeat use rather than a single touch`;
}

/**
 * A protocol's farm plan: six steps, each an action with what it costs and how long it
 * takes. The plan is derived from the protocol's own record (category, chains, TVL, age),
 * never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const gas = gasFor(chain);
  const weeks = weeksFor(age);
  const gasText = gas < 1 ? 'under $1' : `about $${Math.round(gas)}`;
  const steps = [
    `Set up one fresh wallet for ${p.name} alone and keep its seed phrase offline on paper. Cost: nothing. Time: 5 minutes.`,
    `${actionFor(p, capital, chain)}. Cost: $${capital} of capital plus ${gasText} of gas. Time: 15 minutes to set up.`,
    `${secondActionFor(p, chain)}. Cost: ${gasText} of gas. Time: 10 minutes.`,
    `Repeat one qualifying action a week for ${weeks} weeks (a deposit, a swap, a vote or a claim), always from the same wallet. Cost: ${gasText} of gas a week. Time: 10 minutes a week for ${weeks} weeks.`,
    `Hold the position for the full ${weeks} weeks so the activity lands in several weekly snapshots, not one. Cost: the $${capital} stays in the position. Time: ${weeks} weeks.`,
    `Check ${p.name}'s own points or rewards page weekly and claim only from the link it publishes; never pay a fee to claim. Keep a log of the wallet, dates and transactions. Cost: nothing. Time: 5 minutes a week.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

/** The live-token protocols, by market cap, for the dashboard's live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const peers = peerMultiples(snapshot, model);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    market_multiple: round4(peers.market),
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: live.length,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      on_watchlist: r.on_watchlist,
      implied_value_usd: r.implied_value_usd,
      peer_multiple: r.model.peer_multiple,
      peer_count: r.model.peer_count,
      growth_pct: r.model.growth_pct,
      momentum_multiplier: r.model.momentum_multiplier,
      seasoning_multiplier: r.model.seasoning_multiplier,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows: the gate wants at least 100`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

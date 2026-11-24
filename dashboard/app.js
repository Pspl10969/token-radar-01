// Token Launch Radar — the page's whole logic. No framework, no fetch, no network:
// the dataset arrives as window.RADAR from data.js, written by main.ts from the same
// board the gate checks, so what the page shows and what board.json says cannot drift.
//
// State lives in the URL query (?cat=, ?detail=, ?watch=1, ?mw=, ?sw= ...), so every
// view — the board, a protocol's detail, a filtered board — is a link and a screenshot.

const R = window.RADAR;
const M = R.model;
const params = new URLSearchParams(location.search);

const state = {
  q: params.get('q') ?? '',
  cat: params.get('cat') ?? '',
  chain: params.get('chain') ?? '',
  min: Number(params.get('min') ?? 0),
  sort: params.get('sort') ?? 'implied',
  watch: params.get('watch') === '1',
  view: params.get('view') === 'live' ? 'live' : 'board',
  detail: params.get('detail') ?? '',
  mw: params.has('mw') ? Number(params.get('mw')) : M.momentum_weight,
  sw: params.has('sw') ? Number(params.get('sw')) : M.seasoning_weight,
};

const $ = (id) => document.getElementById(id);
const main = $('main');

function money(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

function pct(n) {
  if (n === null || n === undefined) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function ageText(days) {
  if (days === null || days === undefined) return 'unknown';
  if (days < 365) return `${days}d`;
  return `${(days / 365).toFixed(1)}y`;
}

/** The model's implied value for one row under sandbox weights mw and sw. Identical to
 *  lib/model.ts at the shipped weights, so the sandbox starts from the board itself. */
function implied(row, mw, sw) {
  const growth = Math.min(M.growth_cap, Math.max(M.growth_floor, row.growth_pct));
  const momentum = 1 + (growth / 100) * mw;
  const age = Math.min(row.age_days ?? M.unknown_age_days, M.seasoning_days);
  const seasoning = M.seasoning_base + (age / M.seasoning_days) * sw;
  return Math.max(1, Math.round(row.tvl_usd * row.peer_multiple * momentum * seasoning));
}

function syncUrl() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.cat) p.set('cat', state.cat);
  if (state.chain) p.set('chain', state.chain);
  if (state.min) p.set('min', String(state.min));
  if (state.sort !== 'implied') p.set('sort', state.sort);
  if (state.watch) p.set('watch', '1');
  if (state.view !== 'board') p.set('view', state.view);
  if (state.detail) p.set('detail', state.detail);
  if (state.mw !== M.momentum_weight) p.set('mw', String(state.mw));
  if (state.sw !== M.seasoning_weight) p.set('sw', String(state.sw));
  history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
}

function fillSelect(el, values, current, allLabel) {
  el.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = allLabel;
  el.appendChild(all);
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    el.appendChild(o);
  }
  el.value = current;
}

function renderMast() {
  const totalImplied = R.rows.reduce((s, r) => s + r.implied_value_usd, 0);
  const stats = [
    [String(R.board_size), 'protocols ranked'],
    [`${R.watchlist_size} / ${R.watchlist_size}`, 'watchlist covered'],
    [String(R.early_size), 'early finds below the floor'],
    [money(totalImplied), 'total implied launch value'],
    [`${R.market_multiple.toFixed(2)}x`, 'market median mcap / TVL'],
  ];
  $('mastStats').innerHTML = stats.map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
  $('sourceLine').textContent = `Snapshot: ${R.source} · as of ${R.as_of} · watchlist floor ${money(R.floor_usd)} · model ${R.model_version}`;
  $('modelText').textContent =
    `Implied value = TVL x peer multiple x momentum x seasoning. The peer multiple is what the snapshot's own ` +
    `market pays for a dollar of TVL in the protocol's category: the median market-cap / TVL of its traded peers ` +
    `(market median ${R.market_multiple.toFixed(2)}x), shrunk toward that median when a category has few peers and ` +
    `clamped to [${M.multiple_floor}, ${M.multiple_cap}]. Momentum scales the seven-day TVL change, clamped to ` +
    `[${M.growth_floor}%, +${M.growth_cap}%], by ${M.momentum_weight}. Seasoning rises from ${M.seasoning_base} to ` +
    `${(M.seasoning_base + M.seasoning_weight).toFixed(2)} over ${(M.seasoning_days / 365).toFixed(0)} years without a token. ` +
    `No protocol's name is an input: the same function scores every row.`;
}

function filteredRows() {
  let rows = R.rows.map((r) => ({ ...r, shown_implied: implied(r, state.mw, state.sw) }));
  if (state.watch) rows = rows.filter((r) => r.on_watchlist);
  if (state.cat) rows = rows.filter((r) => (r.category ?? '') === state.cat);
  if (state.chain) rows = rows.filter((r) => r.chains.includes(state.chain));
  if (state.min) rows = rows.filter((r) => r.tvl_usd >= state.min);
  if (state.q) {
    const q = state.q.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.slug.includes(q));
  }
  const by = {
    implied: (a, b) => b.shown_implied - a.shown_implied,
    tvl: (a, b) => b.tvl_usd - a.tvl_usd,
    change: (a, b) => (b.change_7d ?? -Infinity) - (a.change_7d ?? -Infinity),
    age: (a, b) => (b.age_days ?? -1) - (a.age_days ?? -1),
    ratio: (a, b) => b.shown_implied / b.tvl_usd - a.shown_implied / a.tvl_usd,
  }[state.sort];
  rows.sort(by || ((a, b) => b.shown_implied - a.shown_implied));
  rows.forEach((r, i) => { r.shown_rank = i + 1; });
  return rows;
}

function rowHtml(r) {
  const flag = r.on_watchlist ? '<span class="flag">WATCHLIST</span>' : '<span class="early-flag">EARLY</span>';
  const ratio = r.shown_implied / r.tvl_usd;
  const barW = Math.min(100, Math.round((ratio / 1.5) * 100));
  const chg = r.change_7d === null ? '—' : `<span class="${r.change_7d >= 0 ? 'up' : 'down'}">${pct(r.change_7d)}</span>`;
  return `<tr data-slug="${r.slug}">
    <td class="rank">${r.shown_rank}</td>
    <td><span class="pname">${r.name}</span>${flag}<br><span class="pslug">${r.slug}</span></td>
    <td>${r.category ?? '—'}</td>
    <td class="chains">${r.chains.join(', ')}</td>
    <td class="num">${money(r.tvl_usd)}</td>
    <td class="num">${chg}</td>
    <td class="num">${ageText(r.age_days)}</td>
    <td class="num"><b>${money(r.shown_implied)}</b></td>
    <td class="num"><span class="ratio"><span class="ratio-bar"><i style="width:${barW}%"></i></span>${ratio.toFixed(2)}x</span></td>
  </tr>`;
}

function renderBoard() {
  const rows = filteredRows();
  const parts = [`<p class="count-line">${rows.length} of ${R.board_size} ranked protocols shown` +
    (state.mw !== M.momentum_weight || state.sw !== M.seasoning_weight ? ' · sandbox weights applied, ranks are the page\u2019s own' : '') + `</p>`];
  if (rows.length === 0) {
    parts.push('<p class="empty">No protocol matches these filters. Loosen one and the radar sweeps again.</p>');
  } else {
    parts.push(`<table><thead><tr>
      <th>#</th><th>Protocol</th><th>Category</th><th>Chains</th>
      <th class="num">TVL</th><th class="num">7d</th><th class="num">Age</th>
      <th class="num">Implied value</th><th class="num">Implied / TVL</th>
    </tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table>`);
  }
  main.innerHTML = parts.join('');
  main.querySelectorAll('tr[data-slug]').forEach((tr) => {
    tr.addEventListener('click', () => { state.detail = tr.getAttribute('data-slug'); syncUrl(); render(); });
  });
}

function renderLive() {
  const rows = [...R.live].sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0));
  main.innerHTML = `<p class="count-line">These protocols' tokens already trade, so the radar does not rank them: ` +
    `it shows the market's own market cap, the same figures the peer multiples are read from.</p>` +
    `<table><thead><tr><th>Protocol</th><th>Category</th><th>Chains</th>` +
    `<th class="num">TVL</th><th class="num">7d</th><th class="num">Market cap</th><th class="num">Mcap / TVL</th></tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>
      <td><span class="pname">${r.name}</span><br><span class="pslug">${r.slug}</span></td>
      <td>${r.category ?? '—'}</td><td class="chains">${r.chains.join(', ')}</td>
      <td class="num">${money(r.tvl_usd)}</td>
      <td class="num">${r.change_7d === null ? '—' : `<span class="${r.change_7d >= 0 ? 'up' : 'down'}">${pct(r.change_7d)}</span>`}</td>
      <td class="num"><b>${money(r.mcap_usd)}</b></td>
      <td class="num">${r.mcap_usd && r.tvl_usd ? `${(r.mcap_usd / r.tvl_usd).toFixed(2)}x` : '—'}</td>
    </tr>`).join('')}</tbody></table>`;
}

function factorBar(label, mult, max, note) {
  const w = Math.max(2, Math.min(100, Math.round((mult / max) * 100)));
  return `<div class="factor"><span>${label}</span><span class="bar"><i style="width:${w}%"></i></span><span class="val">x${mult.toFixed(3)}</span></div>` +
    (note ? `<p class="factor-note">${note}</p>` : '');
}

function renderDetail(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  if (!r) { renderBoard(); return; }
  const shown = implied(r, state.mw, state.sw);
  const stats = [
    [money(r.tvl_usd), 'TVL'],
    [money(shown), 'implied launch value'],
    [`${(shown / r.tvl_usd).toFixed(2)}x`, 'implied / TVL'],
    [pct(r.change_7d), 'TVL change, 7d'],
    [ageText(r.age_days), 'tracked, no token'],
    [r.listed_at ?? '—', 'first tracked'],
  ];
  main.innerHTML = `
    <button class="back" id="backBtn" type="button">&larr; Back to the board</button>
    <div class="detail-head">
      <h2>${r.name}</h2>
      ${r.on_watchlist ? '<span class="flag">WATCHLIST</span>' : '<span class="early-flag">EARLY FIND</span>'}
      <span class="pslug">${r.slug} · board rank #${r.rank} · records no token</span>
    </div>
    <div class="detail-grid">${stats.map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('')}</div>
    <p class="count-line">Category: ${r.category ?? 'uncategorised'} · Chains: ${r.chains.join(', ') || 'none named'}</p>
    <section class="factors">
      <h3>Why this value — the model, factor by factor</h3>
      ${factorBar('Peer multiple', r.peer_multiple, M.multiple_cap, `What the market pays for $1 of TVL among ${r.category ?? 'its'} peers: ${r.peer_count} traded protocol${r.peer_count === 1 ? '' : 's'} stand${r.peer_count === 1 ? 's' : ''} behind this multiple.`)}
      ${factorBar('Momentum', 1 + (Math.min(M.growth_cap, Math.max(M.growth_floor, r.growth_pct)) / 100) * state.mw, 1.4, `Seven-day TVL change of ${pct(r.change_7d)}, clamped and scaled by the momentum weight (${state.mw}).`)}
      ${factorBar('Seasoning', M.seasoning_base + (Math.min(r.age_days ?? M.unknown_age_days, M.seasoning_days) / M.seasoning_days) * state.sw, 1.3, `${ageText(r.age_days)} tracked with no token: value left unclaimed seasons toward its launch.`)}
      <p class="factor-note">${money(r.tvl_usd)} TVL x the three factors = ${money(shown)} implied launch value under the weights now set.</p>
    </section>
    <section class="farm">
      <h3>Farm plan — before any token exists</h3>
      <ol>${r.farm_steps.map((s) => `<li>${s}</li>`).join('')}</ol>
    </section>`;
  $('backBtn').addEventListener('click', () => { state.detail = ''; syncUrl(); render(); });
}

function render() {
  $('viewBoard').classList.toggle('on', state.view === 'board');
  $('viewLive').classList.toggle('on', state.view === 'live');
  $('sandbox').style.display = state.view === 'board' ? '' : 'none';
  if (state.detail) renderDetail(state.detail);
  else if (state.view === 'live') renderLive();
  else renderBoard();
}

function bind() {
  const cats = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  fillSelect($('cat'), cats, state.cat, 'All categories');
  fillSelect($('chain'), chains, state.chain, 'All chains');
  $('q').value = state.q;
  $('min').value = String(state.min);
  $('sort').value = state.sort;
  $('watch').checked = state.watch;
  $('mw').value = String(state.mw);
  $('sw').value = String(state.sw);
  $('mwOut').textContent = state.mw.toFixed(2);
  $('swOut').textContent = state.sw.toFixed(2);

  $('q').addEventListener('input', (e) => { state.q = e.target.value; state.detail = ''; syncUrl(); render(); });
  $('cat').addEventListener('change', (e) => { state.cat = e.target.value; state.detail = ''; syncUrl(); render(); });
  $('chain').addEventListener('change', (e) => { state.chain = e.target.value; state.detail = ''; syncUrl(); render(); });
  $('min').addEventListener('change', (e) => { state.min = Number(e.target.value); state.detail = ''; syncUrl(); render(); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; state.detail = ''; syncUrl(); render(); });
  $('watch').addEventListener('change', (e) => { state.watch = e.target.checked; state.detail = ''; syncUrl(); render(); });
  $('viewBoard').addEventListener('click', () => { state.view = 'board'; state.detail = ''; syncUrl(); render(); });
  $('viewLive').addEventListener('click', () => { state.view = 'live'; state.detail = ''; syncUrl(); render(); });
  $('mw').addEventListener('input', (e) => { state.mw = Number(e.target.value); $('mwOut').textContent = state.mw.toFixed(2); syncUrl(); render(); });
  $('sw').addEventListener('input', (e) => { state.sw = Number(e.target.value); $('swOut').textContent = state.sw.toFixed(2); syncUrl(); render(); });
  $('resetModel').addEventListener('click', () => {
    state.mw = M.momentum_weight; state.sw = M.seasoning_weight;
    $('mw').value = String(state.mw); $('sw').value = String(state.sw);
    $('mwOut').textContent = state.mw.toFixed(2); $('swOut').textContent = state.sw.toFixed(2);
    syncUrl(); render();
  });
}

renderMast();
bind();
render();

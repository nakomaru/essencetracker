import { TYPE_ORDER, PRIORITY, defaultPriority, hasSecondary, solve } from './solver.js';
import { iconPath, typeIconPath } from './icons.js';

const PRIORITY_KEY = 'endfield_priorities_v5';
const EXCLUDED_KEY = 'endfield_excluded_locations_v1';
const PAGE_SIZE = 50;
const HITS_PREVIEW = 14;
const RARITIES = [6, 5, 4, 3];

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (stat) => stat.replace(/ Boost$/, '');

const state = {
  data: null,
  priorities: {},
  excluded: new Set(),
  query: '',
  rarities: new Set(RARITIES),
  rows: [],
  shown: PAGE_SIZE,
  pendingBulk: null,
};

function readStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode, blocked site data); selections then last for the session.
  }
}

function loadPriorities(weapons) {
  const saved = readStorage(PRIORITY_KEY) ?? {};
  const priorities = {};
  for (const w of weapons) {
    const previous = [w.name, ...(w.formerly ?? [])].map((n) => saved[n]).find((p) => p !== undefined);
    priorities[w.name] = [PRIORITY.SKIP, PRIORITY.TRACK, PRIORITY.STAR].includes(previous) ? previous : defaultPriority(w);
  }
  return priorities;
}

const savePriorities = () => writeStorage(PRIORITY_KEY, state.priorities);
const saveExcluded = () => writeStorage(EXCLUDED_KEY, [...state.excluded]);

/* Rendering helpers */

function icon(w, size = '') {
  return `<span class="wicon ${size} r${w.rarity}" data-initial="${esc(w.name[0])}"><img src="${esc(iconPath(w))}" alt="" loading="lazy"></span>`;
}

function statChips(w) {
  return `<span class="stat attr">${esc(short(w.attr_stat))}</span>`
    + (hasSecondary(w) ? `<span class="stat secondary">${esc(short(w.sec_stat))}</span>` : '')
    + `<span class="stat skill">${esc(w.skill_stat)}</span>`;
}

function fixedChip(option) {
  return `<span class="stat ${option.kind} fixed">${esc(short(option.stat))}</span>`;
}

function matchesQuery(w, q) {
  if (!q) return true;
  return [w.name, w.type, w.attr_stat, w.sec_stat, w.skill_stat, ...(w.formerly ?? [])].some((s) => s.toLowerCase().includes(q));
}

function visibleWeapons() {
  const q = state.query.trim().toLowerCase();
  return state.data.weapons.filter((w) => state.rarities.has(w.rarity) && matchesQuery(w, q));
}

/* Weapons pane */

function renderRarityFilter() {
  $('#rarity-filter').innerHTML = RARITIES.map((r) =>
    `<button type="button" class="chip-toggle r${r}" data-rarity="${r}" aria-pressed="${state.rarities.has(r)}">${r}&#9733;</button>`).join('');
}

function cardHtml(w) {
  const effect = w.skill_effect ? ` title="${esc(w.skill_effect)}"` : '';
  const p = state.priorities[w.name];
  return `<button type="button" class="card r${w.rarity}" data-name="${esc(w.name)}" data-p="${p}" aria-label="${esc(`${w.name}: ${priorityLabel(p)}`)}"${effect}>
    ${icon(w)}
    <span class="card-name">${esc(w.name)}</span>
    <span class="card-meta">${w.rarity}&#9733; ${esc(w.type)}</span>
    <span class="star" aria-hidden="true">&#9733;</span>
    <span class="stats">${statChips(w)}</span>
  </button>`;
}

function renderWeapons() {
  const shown = visibleWeapons();
  const html = TYPE_ORDER.map((type) => {
    const list = shown
      .filter((w) => w.type === type)
      .sort((a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name));
    if (list.length === 0) return '';
    return `<section>
      <h3 class="group-head"><img src="${esc(typeIconPath(type))}" alt="">${esc(type)}s<span class="count">${list.length}</span></h3>
      <div class="grid">${list.map(cardHtml).join('')}</div>
    </section>`;
  }).join('');
  $('#weapon-groups').innerHTML = html || '<p class="empty">No weapons match this filter.</p>';
}

function priorityLabel(p) {
  return p === PRIORITY.STAR ? 'priority' : p === PRIORITY.TRACK ? 'tracked' : 'skipped';
}

function updateCard(name) {
  const card = document.querySelector(`.card[data-name="${CSS.escape(name)}"]`);
  if (!card) return;
  card.dataset.p = state.priorities[name];
  card.setAttribute('aria-label', `${name}: ${priorityLabel(state.priorities[name])}`);
}

function renderTally() {
  const counts = [0, 0, 0];
  for (const p of Object.values(state.priorities)) counts[p]++;
  $('#tally').innerHTML =
    `<span class="p2"><b>${counts[PRIORITY.STAR]}</b>priority</span>`
    + `<span class="p1"><b>${counts[PRIORITY.TRACK]}</b>tracked</span>`
    + `<span class="p0"><b>${counts[PRIORITY.SKIP]}</b>skipped</span>`;
}

/* Locations */

function renderLocations() {
  const regions = {};
  for (const [name, pool] of Object.entries(state.data.alluvium)) (regions[pool.region] ??= []).push(name);
  $('#location-filter').innerHTML = Object.entries(regions).map(([region, names]) => `
    <div class="region">
      <div class="region-head">${esc(region)}
        <button type="button" data-region="${esc(region)}" data-on="true">all</button>
        <button type="button" data-region="${esc(region)}" data-on="false">none</button>
      </div>
      <div class="chip-group">${names.map((n) =>
        `<button type="button" class="chip-toggle" data-location="${esc(n)}" aria-pressed="${!state.excluded.has(n)}">${esc(n)}</button>`).join('')}
      </div>
    </div>`).join('');
  const total = Object.keys(state.data.alluvium).length;
  $('#location-count').textContent = `(${total - state.excluded.size} of ${total})`;
}

/* Results */

function recompute() {
  const enabled = new Set(Object.keys(state.data.alluvium).filter((n) => !state.excluded.has(n)));
  state.rows = solve(state.data, state.priorities, { locations: enabled, limit: Infinity });
  state.shown = PAGE_SIZE;
  renderResults();
  renderTally();
}

function engravingHtml(row) {
  const attrs = row.attrs.map((a) => `<span class="stat attr">${esc(short(a))}</span>`).join('');
  const free = row.freeAttrs ? `<span class="stat any" title="Any attribute works here">any${row.freeAttrs > 1 ? ` &times;${row.freeAttrs}` : ''}</span>` : '';
  const fixed = row.options.map(fixedChip).join('<span class="or">or</span>');
  return `${attrs}${free}<span class="sep" aria-hidden="true"></span>${fixed}`;
}

function resultHtml(row, i) {
  const preview = row.hits.slice(0, HITS_PREVIEW).map((h) =>
    `<span class="hit" data-p="${h.priority}">${icon(h.weapon, 'sm')}<span class="hit-name">${esc(h.weapon.name)}</span></span>`).join('');
  const more = row.hits.length > HITS_PREVIEW ? `<span class="hit">+${row.hits.length - HITS_PREVIEW} more</span>` : '';
  const total = row.starred + row.tracked;
  const score = (row.starred ? `<span class="p2" title="Priority weapons">${row.starred}</span>` : '')
    + `<span class="p1">${total} weapon${total > 1 ? 's' : ''}</span>`;
  return `<li><button type="button" class="result" data-row="${i}">
    <span class="result-head">
      <span class="rank">${i + 1}</span>
      <span class="loc">${esc(row.location)}</span>
      <span class="loc-region">${esc(row.region)}</span>
      <span class="score">${score}</span>
    </span>
    <span class="engraving">${engravingHtml(row)}</span>
    <span class="hits">${preview}${more}</span>
  </button></li>`;
}

function renderResults() {
  const { rows, shown } = state;
  const tracked = Object.values(state.priorities).some((p) => p > PRIORITY.SKIP);
  let html;
  if (!tracked) html = '<li class="empty">Nothing is tracked. Click weapons on the left to track them.</li>';
  else if (state.excluded.size === Object.keys(state.data.alluvium).length) html = '<li class="empty">All locations are hidden. Enable some under Locations.</li>';
  else if (rows.length === 0) html = '<li class="empty">No engraving can drop these weapons at the enabled locations.</li>';
  else html = rows.slice(0, shown).map(resultHtml).join('');
  $('#results').innerHTML = html;
  $('#more').hidden = rows.length <= shown;
  $('#more').textContent = `Show more (${rows.length - shown} left)`;
  $('#tab-count').textContent = rows.length ? `(${rows.length})` : '';
}

/* Detail dialog */

function rollText(roll) {
  return `<span class="stat ${roll.endsWith('Boost') ? 'secondary' : 'skill'}">${esc(short(roll))}</span>`;
}

function detailHtml(row) {
  const multi = row.options.length > 1;
  const attrList = row.attrs.map((a) => `<span class="stat attr">${esc(short(a))}</span>`).join(' ');
  const freeNote = row.freeAttrs ? ` plus any ${row.freeAttrs === 1 ? 'other attribute' : `${row.freeAttrs} others`}` : '';
  const fixedList = row.options.map(fixedChip).join(' <span class="or">or</span> ');

  const rows = row.hits.map((h) => {
    const w = h.weapon;
    const attr = `<span class="stat attr">${esc(short(w.attr_stat))}</span>`;
    const rolls = row.options.map((o) => {
      const other = h.rollFor[o.stat] === '' ? '' : ` <span class="or">+</span> ${rollText(h.rollFor[o.stat])}`;
      return `<div class="roll">${multi ? `${fixedChip(o)} <span class="or">&rarr;</span> ` : ''}${attr}${other}</div>`;
    }).join('');
    return `<tr data-p="${h.priority}">
      <td><div class="who">${icon(w, 'md')}<div><span class="name" title="${esc(w.skill_effect)}">${esc(w.name)}</span><small>${w.rarity}&#9733; ${esc(w.type)}</small></div></div></td>
      <td>${rolls}</td>
    </tr>`;
  }).join('');

  const untracked = row.options.map((o) => {
    if (o.untracked.length === 0) return '';
    const label = multi ? `with ${esc(short(o.stat))} fixed` : 'from this engraving';
    return `<details class="untracked"><summary>${o.untracked.length} skipped weapon${o.untracked.length > 1 ? 's' : ''} can also drop ${label}</summary>
      <ul>${o.untracked.map((u) => `<li>${esc(u.weapon.name)}</li>`).join('')}</ul></details>`;
  }).join('');

  return `<div class="detail-head">
      <h3 id="detail-title">${esc(row.location)} <span class="loc-region">${esc(row.region)}</span></h3>
      <button type="button" class="detail-close" aria-label="Close">&times;</button>
      <ol class="steps">
        <li>Engrave attributes ${attrList}${freeNote}</li>
        <li>Fix ${multi ? 'one of ' : ''}${fixedList}</li>
      </ol>
    </div>
    <div class="detail-body">
      <h4>Can drop (${row.hits.length})</h4>
      <table class="drop-table">
        <thead><tr><th>Weapon</th><th>Rolls needed</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${untracked}
    </div>`;
}

// Opening the detail view pushes a history entry so the browser back button closes it.
function openDetail(row) {
  const dialog = $('#detail');
  dialog.innerHTML = detailHtml(row);
  dialog.showModal();
  dialog.scrollTop = 0;
  history.pushState({ detail: true }, '');
}

/* Events */

function cyclePriority(name) {
  const next = { [PRIORITY.TRACK]: PRIORITY.STAR, [PRIORITY.STAR]: PRIORITY.SKIP, [PRIORITY.SKIP]: PRIORITY.TRACK };
  state.priorities[name] = next[state.priorities[name]];
  updateCard(name);
  savePriorities();
  recompute();
}

// Actions that change many weapons at once; each is confirmed before it applies.
const BULK_ACTIONS = {
  track: {
    title: 'Track shown weapons?',
    text: (n) => `Skipped weapons among the ${n} shown become tracked. Stars are kept.`,
    button: 'Track',
    scope: () => visibleWeapons(),
    next: (w, p) => (p === PRIORITY.SKIP ? PRIORITY.TRACK : p),
  },
  skip: {
    title: 'Skip shown weapons?',
    text: (n) => `All ${n} shown weapons become skipped, starred ones included.`,
    button: 'Skip',
    danger: true,
    scope: () => visibleWeapons(),
    next: () => PRIORITY.SKIP,
  },
  unstar: {
    title: 'Clear all stars?',
    text: () => 'Every starred weapon goes back to Track, including ones hidden by the filter.',
    button: 'Clear stars',
    scope: () => state.data.weapons,
    next: (w, p) => (p === PRIORITY.STAR ? PRIORITY.TRACK : p),
  },
  reset: {
    title: 'Reset all weapons?',
    text: () => '4–6★ weapons go back to Track and 3★ weapons to Skip. Stars are cleared.',
    button: 'Reset',
    danger: true,
    scope: () => state.data.weapons,
    next: (w) => defaultPriority(w),
  },
};

function bulkChanges(action) {
  const { scope, next } = BULK_ACTIONS[action];
  const changes = new Map();
  for (const w of scope()) {
    const p = next(w, state.priorities[w.name]);
    if (p !== state.priorities[w.name]) changes.set(w.name, p);
  }
  return changes;
}

function confirmBulk(action) {
  const def = BULK_ACTIONS[action];
  const changes = bulkChanges(action);
  const n = changes.size;
  $('#confirm-title').textContent = def.title;
  $('#confirm-text').textContent = def.text(def.scope().length);
  $('#confirm-count').textContent = n ? `${n} weapon${n > 1 ? 's' : ''} will change:` : 'No weapons would change.';
  $('#confirm-list').innerHTML = [...changes].map(([name, p]) =>
    `<li>${esc(name)} <span class="or">&rarr;</span> <span class="p${p}">${priorityLabel(p)}</span></li>`).join('');
  $('#confirm-list').hidden = n === 0;
  $('#confirm-ok').textContent = def.button;
  $('#confirm-ok').hidden = n === 0;
  $('#confirm-ok').classList.toggle('btn-danger', Boolean(def.danger));
  $('#confirm-ok').classList.toggle('btn-primary', !def.danger);
  $('#confirm-cancel').textContent = n ? 'Cancel' : 'Close';
  state.pendingBulk = action;
  $('#confirm').showModal();
}

function applyBulk(action) {
  // Recomputed at apply time so the confirmed list matches what changes.
  for (const [name, p] of bulkChanges(action)) state.priorities[name] = p;
  savePriorities();
  renderWeapons();
  recompute();
}

function bindEvents() {
  $('#weapon-groups').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) cyclePriority(card.dataset.name);
  });

  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderWeapons();
  });

  $('#rarity-filter').addEventListener('click', (e) => {
    const r = Number(e.target.closest('[data-rarity]')?.dataset.rarity);
    if (!r) return;
    if (state.rarities.has(r)) state.rarities.delete(r);
    else state.rarities.add(r);
    renderRarityFilter();
    renderWeapons();
  });

  document.querySelector('.bulk').addEventListener('click', (e) => {
    const action = e.target.closest('[data-bulk]')?.dataset.bulk;
    if (action) confirmBulk(action);
  });

  $('#confirm').addEventListener('close', () => {
    const action = state.pendingBulk;
    state.pendingBulk = null;
    if ($('#confirm').returnValue === 'confirm' && action) applyBulk(action);
    $('#confirm').returnValue = '';
  });

  $('#location-filter').addEventListener('click', (e) => {
    const loc = e.target.closest('[data-location]')?.dataset.location;
    const region = e.target.closest('[data-region]');
    if (loc) {
      if (state.excluded.has(loc)) state.excluded.delete(loc);
      else state.excluded.add(loc);
    } else if (region) {
      for (const [name, pool] of Object.entries(state.data.alluvium)) {
        if (pool.region !== region.dataset.region) continue;
        if (region.dataset.on === 'true') state.excluded.delete(name);
        else state.excluded.add(name);
      }
    } else {
      return;
    }
    saveExcluded();
    renderLocations();
    recompute();
  });

  $('#results').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-row]');
    if (btn) openDetail(state.rows[Number(btn.dataset.row)]);
  });

  $('#more').addEventListener('click', () => {
    state.shown += PAGE_SIZE;
    renderResults();
  });

  const detail = $('#detail');
  detail.addEventListener('click', (e) => {
    // Clicks on the backdrop target the dialog element itself.
    if (e.target === detail || e.target.closest('.detail-close')) detail.close();
  });
  detail.addEventListener('close', () => {
    if (history.state?.detail) history.back();
  });
  window.addEventListener('popstate', () => {
    if (detail.open) detail.close();
  });

  document.querySelector('.pane-tabs').addEventListener('click', (e) => {
    const pane = e.target.closest('[data-pane]')?.dataset.pane;
    if (!pane) return;
    document.querySelector('.layout').dataset.pane = pane;
    for (const b of document.querySelectorAll('.pane-tabs button')) b.setAttribute('aria-pressed', String(b.dataset.pane === pane));
    window.scrollTo({ top: 0 });
  });

  // Missing icons fall back to the weapon's initial.
  document.addEventListener('error', (e) => {
    if (e.target instanceof HTMLImageElement && e.target.closest('.wicon')) e.target.classList.add('broken');
  }, true);
}

async function main() {
  try {
    const res = await fetch('data.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    $('#weapon-groups').innerHTML = `<p class="empty">Could not load data.json (${esc(err.message)}). Serve this folder over HTTP rather than opening the file directly.</p>`;
    return;
  }
  state.priorities = loadPriorities(state.data.weapons);
  savePriorities();
  const excluded = readStorage(EXCLUDED_KEY);
  if (Array.isArray(excluded)) state.excluded = new Set(excluded.filter((n) => n in state.data.alluvium));

  renderRarityFilter();
  renderWeapons();
  renderLocations();
  bindEvents();
  recompute();
}

main();

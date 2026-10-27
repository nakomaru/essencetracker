import { TYPE_ORDER, PRIORITY, defaultPriority, hasSecondary, solve } from './solver.js';
import { iconPath, typeIconPath } from './icons.js';

// Saved selections are keyed by game id. The older keys held weapon and location names.
const PRIORITY_KEY = 'endfield_priorities_v6';
const EXCLUDED_KEY = 'endfield_excluded_locations_v2';
const FILTERS_KEY = 'endfield_filters_v1';
const LEGACY_PRIORITY_KEY = 'endfield_priorities_v5';
const LEGACY_EXCLUDED_KEY = 'endfield_excluded_locations_v1';
const PAGE_SIZE = 50;
const HITS_PREVIEW = 14;
const RARITIES = [6, 5, 4, 3];
const ANNOUNCED_NOTE = 'Announced, not yet released. Its stats come from preview game data and can change before release.';
const DEDUCED_LABELS = { skillName: 'Skill name', operators: 'Signature operator' };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const state = {
  data: null,
  weaponsById: new Map(),
  priorities: {},
  excluded: new Set(),
  query: '',
  rarities: new Set(RARITIES),
  showAnnounced: true,
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

// Looks up a saved value by id, or for legacy data by current or former name.
function savedValue(saved, legacy, entry) {
  if (saved) return saved[entry.id];
  return [entry.name, ...(entry.formerly ?? [])].map((n) => legacy?.[n]).find((v) => v !== undefined);
}

function loadPriorities(weapons) {
  const saved = readStorage(PRIORITY_KEY);
  const legacy = saved ? null : readStorage(LEGACY_PRIORITY_KEY);
  const valid = new Set(Object.values(PRIORITY));
  return Object.fromEntries(weapons.map((w) => {
    const p = savedValue(saved, legacy, w);
    return [w.id, valid.has(p) ? p : defaultPriority(w)];
  }));
}

function loadExcluded(locations) {
  const saved = readStorage(EXCLUDED_KEY);
  if (Array.isArray(saved)) return new Set(saved.filter((id) => locations.some((l) => l.id === id)));
  const legacy = readStorage(LEGACY_EXCLUDED_KEY);
  if (!Array.isArray(legacy)) return new Set();
  const names = Object.fromEntries(legacy.map((n) => [n, true]));
  return new Set(locations.filter((l) => savedValue(null, names, l)).map((l) => l.id));
}

function loadFilters() {
  const saved = readStorage(FILTERS_KEY);
  if (Array.isArray(saved?.rarities)) state.rarities = new Set(saved.rarities.filter((r) => RARITIES.includes(r)));
  if (typeof saved?.announced === 'boolean') state.showAnnounced = saved.announced;
}

const savePriorities = () => writeStorage(PRIORITY_KEY, state.priorities);
const saveExcluded = () => writeStorage(EXCLUDED_KEY, [...state.excluded]);
const saveFilters = () => writeStorage(FILTERS_KEY, { rarities: [...state.rarities], announced: state.showAnnounced });

/* Rendering helpers */

function icon(w, size = '') {
  return `<span class="wicon ${size} r${w.rarity}" data-initial="${esc(w.name[0])}"><img src="${esc(iconPath(w))}" alt="" loading="lazy"></span>`;
}

const statName = (id) => state.data.stats[id] ?? id;
const statChip = (kind, id, extra = '') => `<span class="stat ${kind}${extra}">${esc(statName(id))}</span>`;

function statChips(w) {
  return statChip('attr', w.attribute)
    + (hasSecondary(w) ? statChip('secondary', w.secondary) : '')
    + statChip('skill', w.skill);
}

const fixedChip = (option) => statChip(option.kind, option.stat, ' fixed');
const announcedTag = (w) => (w.announced ? `<span class="tag-announced" title="${esc(ANNOUNCED_NOTE)}">Announced</span>` : '');

// The skill effect first, then the signature operator. Announced weapons can
// predate their skill text; their caveats and any reviewed deductions follow,
// each with its basis.
function weaponTitle(w) {
  const skillName = w.deduced?.skillName?.value;
  const lines = [w.effect ?? (skillName ? `${skillName} (deduced name): skill text not published yet.` : 'Skill text not published yet.')];
  if (w.operators) lines.push('', `Signature operator: ${w.operators.join(', ')}`);
  if (w.announced) lines.push('', ANNOUNCED_NOTE);
  const deduced = Object.entries(w.deduced ?? {});
  if (deduced.length) {
    lines.push('', 'Deduced, not confirmed by the game data:');
    for (const [key, d] of deduced) lines.push(`${DEDUCED_LABELS[key] ?? key}: ${d.value}. ${d.basis}`);
  }
  return w.effect || w.announced || deduced.length ? lines.join('\n') : '';
}

function priorityLabel(p) {
  return p === PRIORITY.STAR ? 'priority' : p === PRIORITY.TRACK ? 'tracked' : 'skipped';
}

function matchesQuery(w, q) {
  if (!q) return true;
  const stats = [w.attribute, w.secondary, w.skill].filter(Boolean).map(statName);
  const operators = [...(w.operators ?? []), w.deduced?.operators?.value].filter(Boolean);
  return [w.name, w.type, ...stats, ...operators, ...(w.formerly ?? [])].some((s) => s.toLowerCase().includes(q));
}

// Each filter chip toggles one bucket: rarity chips cover released weapons,
// the Announced chip covers announced weapons of any rarity.
function visibleWeapons() {
  const q = state.query.trim().toLowerCase();
  return state.data.weapons.filter((w) =>
    (w.announced ? state.showAnnounced : state.rarities.has(w.rarity)) && matchesQuery(w, q));
}

/* Weapons pane */

function renderFilters() {
  $('#rarity-filter').innerHTML = RARITIES.map((r) =>
    `<button type="button" class="chip-toggle r${r}" data-rarity="${r}" aria-pressed="${state.rarities.has(r)}" title="Released ${r}&#9733; weapons">${r}&#9733;</button>`).join('');
  const announced = state.data.weapons.filter((w) => w.announced).length;
  $('#announced-filter').hidden = announced === 0;
  $('#announced-filter').innerHTML =
    `<button type="button" class="chip-toggle announced" aria-pressed="${state.showAnnounced}" title="${esc(ANNOUNCED_NOTE)}">Announced <span class="count">${announced}</span></button>`;
}

function cardHtml(w) {
  const title = weaponTitle(w);
  const p = state.priorities[w.id];
  return `<button type="button" class="card r${w.rarity}${w.announced ? ' announced' : ''}" data-id="${esc(w.id)}" data-p="${p}" aria-label="${esc(`${w.name}${w.announced ? ' (announced)' : ''}: ${priorityLabel(p)}`)}"${title ? ` title="${esc(title)}"` : ''}>
    ${icon(w)}
    <span class="card-name">${esc(w.name)}</span>
    <span class="card-meta">${w.rarity}&#9733; ${esc(w.type)}${announcedTag(w)}</span>
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

function updateCard(id) {
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.outerHTML = cardHtml(state.weaponsById.get(id));
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
  const regions = Map.groupBy(state.data.locations, (l) => l.region);
  $('#location-filter').innerHTML = [...regions].map(([region, locations]) => `
    <div class="region">
      <div class="region-head">${esc(region)}
        <button type="button" data-region="${esc(region)}" data-on="true">all</button>
        <button type="button" data-region="${esc(region)}" data-on="false">none</button>
      </div>
      <div class="chip-group">${locations.map((l) =>
        `<button type="button" class="chip-toggle" data-location="${esc(l.id)}" aria-pressed="${!state.excluded.has(l.id)}">${esc(l.name)}</button>`).join('')}
      </div>
    </div>`).join('');
  const total = state.data.locations.length;
  $('#location-count').textContent = `(${total - state.excluded.size} of ${total})`;
}

/* Results */

function recompute() {
  const enabled = new Set(state.data.locations.filter((l) => !state.excluded.has(l.id)).map((l) => l.id));
  state.rows = solve(state.data, state.priorities, { locations: enabled, limit: Infinity });
  state.shown = PAGE_SIZE;
  renderResults();
  renderTally();
}

function engravingHtml(row) {
  const attrs = row.attrs.map((a) => statChip('attr', a)).join('');
  const free = row.freeAttrs ? `<span class="stat any" title="Any attribute works here">any${row.freeAttrs > 1 ? ` &times;${row.freeAttrs}` : ''}</span>` : '';
  const fixed = row.options.map(fixedChip).join('<span class="or">or</span>');
  return `${attrs}${free}<span class="sep" aria-hidden="true"></span>${fixed}`;
}

function hitHtml(h) {
  const w = h.weapon;
  return `<span class="hit${w.announced ? ' announced' : ''}" data-p="${h.priority}"${w.announced ? ' title="Announced"' : ''}>${icon(w, 'sm')}<span class="hit-name">${esc(w.name)}</span></span>`;
}

function resultHtml(row, i) {
  const preview = row.hits.slice(0, HITS_PREVIEW).map(hitHtml).join('');
  const more = row.hits.length > HITS_PREVIEW ? `<span class="hit">+${row.hits.length - HITS_PREVIEW} more</span>` : '';
  const score = (row.starred ? `<span class="p2" title="Priority weapons">${row.starred}</span>` : '')
    + `<span class="p1">${plural(row.starred + row.tracked, 'weapon')}</span>`;
  return `<li><button type="button" class="result" data-row="${i}">
    <span class="result-head">
      <span class="rank">${i + 1}</span>
      <span class="loc">${esc(row.location.name)}</span>
      <span class="loc-region">${esc(row.location.region)}</span>
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
  else if (state.excluded.size === state.data.locations.length) html = '<li class="empty">All locations are hidden. Enable some under Locations.</li>';
  else if (rows.length === 0) html = '<li class="empty">No engraving can drop these weapons at the enabled locations.</li>';
  else html = rows.slice(0, shown).map(resultHtml).join('');
  $('#results').innerHTML = html;
  $('#more').hidden = rows.length <= shown;
  $('#more').textContent = `Show more (${rows.length - shown} left)`;
  $('#tab-count').textContent = rows.length ? `(${rows.length})` : '';
}

/* Detail dialog */

function detailHtml(row) {
  const multi = row.options.length > 1;
  const attrList = row.attrs.map((a) => statChip('attr', a)).join(' ');
  const freeNote = row.freeAttrs ? ` plus any ${row.freeAttrs === 1 ? 'other attribute' : `${row.freeAttrs} others`}` : '';
  const fixedList = row.options.map(fixedChip).join(' <span class="or">or</span> ');

  const rows = row.hits.map((h) => {
    const w = h.weapon;
    const rolls = row.options.map((o) => {
      const roll = h.rollFor[o.stat];
      // The second roll comes from the pool the fixed stat is not in.
      const other = roll === '' ? '' : ` <span class="or">+</span> ${statChip(o.kind === 'secondary' ? 'skill' : 'secondary', roll)}`;
      return `<div class="roll">${multi ? `${fixedChip(o)} <span class="or">&rarr;</span> ` : ''}${statChip('attr', w.attribute)}${other}</div>`;
    }).join('');
    const title = weaponTitle(w);
    return `<tr data-p="${h.priority}">
      <td><div class="who">${icon(w, 'md')}<div><span class="name"${title ? ` title="${esc(title)}"` : ''}>${esc(w.name)}</span><small>${w.rarity}&#9733; ${esc(w.type)}${announcedTag(w)}</small></div></div></td>
      <td>${rolls}</td>
    </tr>`;
  }).join('');

  const untracked = row.options.map((o) => {
    if (o.untracked.length === 0) return '';
    const label = multi ? `with ${esc(statName(o.stat))} fixed` : 'from this engraving';
    return `<details class="untracked"><summary>${plural(o.untracked.length, 'skipped weapon')} can also drop ${label}</summary>
      <ul>${o.untracked.map((u) => `<li>${esc(u.weapon.name)}</li>`).join('')}</ul></details>`;
  }).join('');

  return `<div class="detail-head">
      <h3 id="detail-title">${esc(row.location.name)} <span class="loc-region">${esc(row.location.region)}</span></h3>
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

function cyclePriority(id) {
  const next = { [PRIORITY.TRACK]: PRIORITY.STAR, [PRIORITY.STAR]: PRIORITY.SKIP, [PRIORITY.SKIP]: PRIORITY.TRACK };
  state.priorities[id] = next[state.priorities[id]];
  updateCard(id);
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
    const p = next(w, state.priorities[w.id]);
    if (p !== state.priorities[w.id]) changes.set(w.id, p);
  }
  return changes;
}

function confirmBulk(action) {
  const def = BULK_ACTIONS[action];
  const changes = bulkChanges(action);
  const n = changes.size;
  $('#confirm-title').textContent = def.title;
  $('#confirm-text').textContent = def.text(def.scope().length);
  $('#confirm-count').textContent = n ? `${plural(n, 'weapon')} will change:` : 'No weapons would change.';
  $('#confirm-list').innerHTML = [...changes].map(([id, p]) =>
    `<li>${esc(state.weaponsById.get(id).name)} <span class="or">&rarr;</span> <span class="p${p}">${priorityLabel(p)}</span></li>`).join('');
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
  for (const [id, p] of bulkChanges(action)) state.priorities[id] = p;
  savePriorities();
  renderWeapons();
  recompute();
}

function bindEvents() {
  $('#weapon-groups').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) cyclePriority(card.dataset.id);
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
    saveFilters();
    renderFilters();
    renderWeapons();
  });

  $('#announced-filter').addEventListener('click', (e) => {
    if (!e.target.closest('button')) return;
    state.showAnnounced = !state.showAnnounced;
    saveFilters();
    renderFilters();
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
    const id = e.target.closest('[data-location]')?.dataset.location;
    const region = e.target.closest('[data-region]');
    if (id) {
      if (state.excluded.has(id)) state.excluded.delete(id);
      else state.excluded.add(id);
    } else if (region) {
      for (const l of state.data.locations) {
        if (l.region !== region.dataset.region) continue;
        if (region.dataset.on === 'true') state.excluded.delete(l.id);
        else state.excluded.add(l.id);
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
  // history.back() settles asynchronously, so a dialog opened in the meantime
  // pushes its own entry; only an entry without a detail view closes it.
  window.addEventListener('popstate', () => {
    if (detail.open && !history.state?.detail) detail.close();
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

function renderSource() {
  const { repo, commit, date } = state.data.source;
  $('#source').innerHTML = `Game data from <a href="https://github.com/${esc(repo)}/tree/${esc(commit)}">${esc(repo)}</a>, as of ${esc(date)}.`;
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
  state.weaponsById = new Map(state.data.weapons.map((w) => [w.id, w]));
  state.priorities = loadPriorities(state.data.weapons);
  state.excluded = loadExcluded(state.data.locations);
  loadFilters();
  savePriorities();
  saveExcluded();

  renderSource();
  renderFilters();
  renderWeapons();
  renderLocations();
  bindEvents();
  recompute();
}

main();

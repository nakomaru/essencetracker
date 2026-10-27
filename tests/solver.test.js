// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { TYPE_ORDER, PRIORITY, defaultPriority, hasSecondary, requiredRoll, solve } from '../solver.js';
import { iconPath } from '../icons.js';

const root = new URL('../', import.meta.url);
const data = JSON.parse(readFileSync(new URL('data.json', root), 'utf8'));

const lookup = (list, name) => {
  const found = list.find((x) => x.name === name);
  assert.ok(found, `no ${name}`);
  return found;
};
const weapon = (name) => lookup(data.weapons, name);
const location = (name) => lookup(data.locations, name);
const stat = (name) => {
  const id = Object.keys(data.stats).find((k) => data.stats[k] === name);
  assert.ok(id, `no stat ${name}`);
  return id;
};

function trackOnly(names, starred = []) {
  const p = Object.fromEntries(data.weapons.map((w) => [w.id, PRIORITY.SKIP]));
  for (const n of names) p[weapon(n).id] = PRIORITY.TRACK;
  for (const n of starred) p[weapon(n).id] = PRIORITY.STAR;
  return p;
}

const fixedOptions = (pool) => [
  ...pool.secondary.map((s) => ({ kind: 'secondary', stat: s })),
  ...pool.skill.map((s) => ({ kind: 'skill', stat: s })),
];

// Every 3-attribute engraving at every location, scored independently of the solver.
function bruteForce(priorities) {
  const out = [];
  for (const pool of data.locations) {
    const a = pool.attribute;
    const combos = [];
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) for (let k = j + 1; k < a.length; k++) combos.push([a[i], a[j], a[k]]);
    for (const f of fixedOptions(pool)) for (const attrs of combos) {
      const hits = data.weapons.filter((w) => attrs.includes(w.attribute) && requiredRoll(w, pool, f) !== null && priorities[w.id] > 0);
      out.push({ location: pool.id, f, attrs, hits: new Set(hits.map((w) => w.id)),
        starred: hits.filter((w) => priorities[w.id] === PRIORITY.STAR).length,
        tracked: hits.filter((w) => priorities[w.id] === PRIORITY.TRACK).length });
    }
  }
  return out;
}

test('weapon data is complete and uses known stats', () => {
  const allAttributes = new Set(data.locations.flatMap((l) => l.attribute));
  const allSecondary = new Set(data.locations.flatMap((l) => l.secondary));
  const allSkills = new Set(data.locations.flatMap((l) => l.skill));
  for (const key of ['id', 'name']) {
    const values = data.weapons.map((w) => w[key]);
    assert.equal(new Set(values).size, values.length, `duplicate weapon ${key}`);
  }
  for (const w of data.weapons) {
    assert.ok(TYPE_ORDER.includes(w.type), `${w.name} type ${w.type}`);
    assert.ok([3, 4, 5, 6].includes(w.rarity), `${w.name} rarity`);
    assert.ok(allAttributes.has(w.attribute), `${w.name} attribute ${w.attribute}`);
    assert.equal(hasSecondary(w), w.rarity > 3, `${w.name}: only 3-star weapons lack a secondary`);
    if (hasSecondary(w)) assert.ok(allSecondary.has(w.secondary), `${w.name} secondary ${w.secondary}`);
    assert.ok(allSkills.has(w.skill), `${w.name} skill ${w.skill}`);
    // Announced weapons can predate their skill text.
    assert.ok(w.announced || w.effect, `${w.name} effect`);
    assert.ok(existsSync(new URL(iconPath(w), root)), `${w.name} icon ${iconPath(w)}`);
  }
});

test('every stat id in use has a name', () => {
  const used = [...data.locations.flatMap((l) => [...l.attribute, ...l.secondary, ...l.skill]),
    ...data.weapons.flatMap((w) => [w.attribute, w.secondary, w.skill]).filter(Boolean)];
  for (const id of used) assert.ok(data.stats[id], id);
});

test('former names never collide with current names', () => {
  for (const list of [data.weapons, data.locations]) {
    const names = new Set(list.map((x) => x.name));
    for (const x of list) for (const old of x.formerly ?? []) assert.ok(!names.has(old), old);
  }
});

test('every location offers 5 attributes, 8 secondary and 8 skill stats', () => {
  for (const l of data.locations) {
    assert.ok(l.region, `${l.name} region`);
    assert.equal(new Set(l.attribute).size, 5, `${l.name} attribute`);
    assert.equal(new Set(l.secondary).size, 8, `${l.name} secondary`);
    assert.equal(new Set(l.skill).size, 8, `${l.name} skill`);
  }
});

test('3-star weapons need no secondary roll when their skill is fixed', () => {
  const pool = location('The Hub');
  assert.equal(requiredRoll(weapon('Tarr 11'), pool, { kind: 'skill', stat: stat('Assault') }), '');
  assert.equal(requiredRoll(weapon('Tarr 11'), pool, { kind: 'secondary', stat: stat('ATK') }), stat('Assault'));
});

test('a 3-star row only offers fixing its skill when that skips the second roll', () => {
  const rows = solve(data, trackOnly(['Tarr 11']), { limit: Infinity });
  const hub = rows.find((r) => r.location.name === 'The Hub');
  assert.deepEqual(hub.options.map((o) => o.stat), [stat('Assault')]);
  // Power Plateau has no Assault in its pool, so Tarr 11 cannot drop there.
  assert.ok(!rows.some((r) => r.location.name === 'Power Plateau'));
});

test('a weapon cannot drop when its other stat is outside the pool', () => {
  // Wuling City has no Physical DMG secondary.
  const pool = location('Wuling City');
  assert.equal(requiredRoll(weapon('Eminent Repute'), pool, { kind: 'skill', stat: stat('Brutality') }), null);
});

test('a weapon cannot drop when its attribute is outside the pool', () => {
  const pool = { ...location('The Hub'), attribute: [stat('Strength')] };
  assert.equal(requiredRoll(weapon('Tarr 11'), pool, { kind: 'skill', stat: stat('Assault') }), null);
});

test('rows are unique per location and never strictly dominated within it', () => {
  const rows = solve(data, Object.fromEntries(data.weapons.map((w) => [w.id, defaultPriority(w)])), { limit: Infinity });
  const perLocation = Map.groupBy(rows, (r) => r.location.name);
  for (const [loc, locRows] of perLocation) {
    const sets = locRows.map((r) => new Set(r.hits.map((h) => h.weapon.id)));
    const keys = sets.map((s) => [...s].sort().join('|'));
    assert.equal(new Set(keys).size, keys.length, `${loc} has duplicate rows`);
    for (const a of sets) for (const b of sets) {
      assert.ok(!(a.size < b.size && [...a].every((x) => b.has(x))), `${loc} keeps a dominated row`);
    }
  }
});

test('each row is reproducible by every engraving it lists, with any free attribute', () => {
  const priorities = trackOnly(['Wedge', 'Grand Vision', 'Navigator', 'Clannibal', 'Twelve Questions', 'Farsight']);
  const rows = solve(data, priorities, { limit: Infinity });
  assert.ok(rows.length > 0);
  for (const r of rows) {
    const pool = r.location;
    const expected = new Set(r.hits.map((h) => h.weapon.id));
    const fillers = pool.attribute.filter((a) => !r.attrs.includes(a));
    for (const opt of r.options) for (const filler of fillers) {
      const attrs = r.freeAttrs ? [...r.attrs, filler] : r.attrs;
      const got = new Set(data.weapons
        .filter((w) => priorities[w.id] > 0 && attrs.includes(w.attribute) && requiredRoll(w, pool, opt) !== null)
        .map((w) => w.id));
      assert.deepEqual(got, expected, `${pool.name} ${opt.stat} ${attrs}`);
    }
  }
});

test('top row matches the best brute-force engraving', () => {
  for (const [tracked, starred] of [
    [['Wedge', 'Grand Vision', 'Twelve Questions', 'Navigator'], []],
    [data.weapons.filter((w) => w.rarity === 6).map((w) => w.name), ['Farsight', 'Phantom Pain']],
    [data.weapons.filter((w) => w.rarity >= 5).map((w) => w.name), []],
  ]) {
    const p = trackOnly(tracked, starred);
    const best = bruteForce(p).sort((a, b) => b.starred - a.starred || b.tracked - a.tracked)[0];
    const top = solve(data, p)[0];
    assert.deepEqual([top.starred, top.tracked], [best.starred, best.tracked]);
  }
});

test('no brute-force engraving beats every row at its location', () => {
  const p = trackOnly(data.weapons.filter((w) => w.rarity >= 5).map((w) => w.name));
  const rows = solve(data, p, { limit: Infinity });
  for (const e of bruteForce(p)) {
    if (e.hits.size === 0) continue;
    const covered = rows.some((r) => r.location.id === e.location && [...e.hits].every((id) => r.hits.some((h) => h.weapon.id === id)));
    assert.ok(covered, `${e.location} ${e.f.stat} ${e.attrs} is not covered`);
  }
});

test('starring a weapon keeps only rows that can drop it', () => {
  const rows = solve(data, trackOnly(data.weapons.map((w) => w.name), ['Lone Barge']), { limit: Infinity });
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(r.hits.some((h) => h.weapon.name === 'Lone Barge'));
});

test('location filter excludes locations', () => {
  const priorities = trackOnly(['Wedge']);
  const everywhere = new Set(solve(data, priorities, { limit: Infinity }).map((r) => r.location));
  assert.ok(everywhere.size > 1);
  const [kept] = everywhere;
  const rows = solve(data, priorities, { locations: new Set([kept.id]), limit: Infinity });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.location === kept));
});

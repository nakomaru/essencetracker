// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { ATTRIBUTES, TYPE_ORDER, PRIORITY, defaultPriority, hasSecondary, requiredRoll, solve } from '../solver.js';
import { iconPath } from '../icons.js';

const root = new URL('../', import.meta.url);
const data = JSON.parse(readFileSync(new URL('data.json', root), 'utf8'));
const byName = Object.fromEntries(data.weapons.map((w) => [w.name, w]));
const allSecondary = new Set(Object.values(data.alluvium).flatMap((l) => l.secondary));
const allSkills = new Set(Object.values(data.alluvium).flatMap((l) => l.skill));

function trackOnly(names, starred = []) {
  const p = Object.fromEntries(data.weapons.map((w) => [w.name, PRIORITY.SKIP]));
  for (const n of names) p[n] = PRIORITY.TRACK;
  for (const n of starred) p[n] = PRIORITY.STAR;
  return p;
}

// Every 3-attribute engraving at every location, scored like the original tracker.
function bruteForce(priorities) {
  const out = [];
  const combos = [];
  for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) for (let c = b + 1; c < 5; c++) combos.push([ATTRIBUTES[a], ATTRIBUTES[b], ATTRIBUTES[c]]);
  for (const [location, pool] of Object.entries(data.alluvium)) {
    const fixed = [...pool.secondary.map((stat) => ({ kind: 'secondary', stat })), ...pool.skill.map((stat) => ({ kind: 'skill', stat }))];
    for (const f of fixed) for (const attrs of combos) {
      const hits = data.weapons.filter((w) => attrs.includes(w.attr_stat) && requiredRoll(w, pool, f) !== null && priorities[w.name] > 0);
      out.push({ location, f, attrs, hits: new Set(hits.map((w) => w.name)),
        starred: hits.filter((w) => priorities[w.name] === PRIORITY.STAR).length,
        tracked: hits.filter((w) => priorities[w.name] === PRIORITY.TRACK).length });
    }
  }
  return out;
}

test('weapon data is complete and uses known stats', () => {
  const names = new Set();
  for (const w of data.weapons) {
    assert.ok(!names.has(w.name), `duplicate ${w.name}`);
    names.add(w.name);
    assert.ok(TYPE_ORDER.includes(w.type), `${w.name} type ${w.type}`);
    assert.ok([3, 4, 5, 6].includes(w.rarity), `${w.name} rarity`);
    assert.ok(ATTRIBUTES.includes(w.attr_stat), `${w.name} attr ${w.attr_stat}`);
    assert.equal(hasSecondary(w), w.rarity > 3, `${w.name}: only 3-star weapons lack a secondary`);
    if (hasSecondary(w)) assert.ok(allSecondary.has(w.sec_stat), `${w.name} secondary ${w.sec_stat}`);
    assert.ok(allSkills.has(w.skill_stat), `${w.name} skill ${w.skill_stat}`);
    assert.ok(w.skill_effect.length > 0, `${w.name} effect`);
    assert.ok(existsSync(new URL(iconPath(w), root)), `${w.name} icon ${iconPath(w)}`);
  }
});

test('former weapon names never collide with current names', () => {
  for (const w of data.weapons) for (const old of w.formerly ?? []) assert.ok(!byName[old], old);
});

test('every location offers 8 secondary and 8 skill stats', () => {
  for (const [name, pool] of Object.entries(data.alluvium)) {
    assert.ok(pool.region, `${name} region`);
    assert.equal(new Set(pool.secondary).size, 8, `${name} secondary`);
    assert.equal(new Set(pool.skill).size, 8, `${name} skill`);
  }
});

test('3-star weapons need no secondary roll when their skill is fixed', () => {
  const pool = data.alluvium['The Hub'];
  assert.equal(requiredRoll(byName['Tarr 11'], pool, { kind: 'skill', stat: 'Assault' }), '');
  assert.equal(requiredRoll(byName['Tarr 11'], pool, { kind: 'secondary', stat: 'Attack Boost' }), 'Assault');
});

test('a 3-star row only offers fixing its skill when that skips the second roll', () => {
  const rows = solve(data, trackOnly(['Tarr 11']), { limit: Infinity });
  const hub = rows.find((r) => r.location === 'The Hub');
  assert.deepEqual(hub.options.map((o) => o.stat), ['Assault']);
  // Power Plateau has no Assault in its pool, so Tarr 11 cannot drop there.
  assert.ok(!rows.some((r) => r.location === 'Power Plateau'));
});

test('a weapon cannot drop when its other stat is outside the pool', () => {
  // Wuling City has no Physical DMG Boost secondary.
  const pool = data.alluvium['Wuling City'];
  assert.equal(requiredRoll(byName['Eminent Repute'], pool, { kind: 'skill', stat: 'Brutality' }), null);
});

test('rows are unique per location and never strictly dominated within it', () => {
  const rows = solve(data, Object.fromEntries(data.weapons.map((w) => [w.name, defaultPriority(w)])), { limit: Infinity });
  const perLocation = {};
  for (const r of rows) (perLocation[r.location] ??= []).push(new Set(r.hits.map((h) => h.weapon.name)));
  for (const [loc, sets] of Object.entries(perLocation)) {
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
    const pool = data.alluvium[r.location];
    const expected = new Set(r.hits.map((h) => h.weapon.name));
    const fillers = ATTRIBUTES.filter((a) => !r.attrs.includes(a));
    for (const opt of r.options) for (const filler of fillers) {
      const attrs = r.freeAttrs ? [...r.attrs, filler] : r.attrs;
      const got = new Set(data.weapons
        .filter((w) => priorities[w.name] > 0 && attrs.includes(w.attr_stat) && requiredRoll(w, pool, opt) !== null)
        .map((w) => w.name));
      assert.deepEqual(got, expected, `${r.location} ${opt.stat} ${attrs}`);
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
    const covered = rows.some((r) => r.location === e.location && [...e.hits].every((n) => r.hits.some((h) => h.weapon.name === n)));
    assert.ok(covered, `${e.location} ${e.f.stat} ${e.attrs} is not covered`);
  }
});

test('starring a weapon keeps only rows that can drop it', () => {
  const rows = solve(data, trackOnly(data.weapons.map((w) => w.name), ['Lone Barge']), { limit: Infinity });
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(r.hits.some((h) => h.weapon.name === 'Lone Barge'));
});

test('location filter excludes locations', () => {
  const rows = solve(data, trackOnly(['Wedge']), { locations: new Set(['Snowy Forest']), limit: Infinity });
  assert.ok(rows.every((r) => r.location === 'Snowy Forest'));
});

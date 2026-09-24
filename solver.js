// Engraving solver for Severe Energy Alluvium runs.
//
// An engraving picks 3 of the 5 attribute stats plus one fixed stat from the
// location's pool (a secondary stat or a skill stat). Each Flawless Essence
// then rolls one of the 3 picked attributes, carries the fixed stat, and rolls
// the remaining stat from the location's pool. A weapon can drop from an
// engraving when its attribute is picked, its fixed-side stat equals the fixed
// stat, and its other stat is in the location's pool. Weapons without a
// secondary stat (3-star) accept any secondary.

export const ATTRIBUTES = ['Strength', 'Agility', 'Will', 'Intellect', 'Main Attribute'];
export const TYPE_ORDER = ['Greatsword', 'Handcannon', 'Arts Unit', 'Sword', 'Polearm'];
export const PRIORITY = { SKIP: 0, TRACK: 1, STAR: 2 };
const ENGRAVED_ATTRIBUTES = 3;

export const hasSecondary = (w) => w.sec_stat !== 'None';

export function defaultPriority(w) {
  return w.rarity === 3 ? PRIORITY.SKIP : PRIORITY.TRACK;
}

// Returns the stat that must roll for weapon `w` to drop, '' when no roll is
// needed, or null when `w` cannot drop from this location and fixed stat.
export function requiredRoll(w, pool, fixed) {
  if (fixed.kind === 'secondary') {
    if (hasSecondary(w) && w.sec_stat !== fixed.stat) return null;
    return pool.skill.includes(w.skill_stat) ? w.skill_stat : null;
  }
  if (w.skill_stat !== fixed.stat) return null;
  if (!hasSecondary(w)) return '';
  return pool.secondary.includes(w.sec_stat) ? w.sec_stat : null;
}

function combinations(items, k) {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items;
  return [...combinations(rest, k - 1).map((c) => [head, ...c]), ...combinations(rest, k)];
}

const isStrictSubset = (a, b) => a.size < b.size && [...a].every((x) => b.has(x));

// Builds one row per distinct set of tracked weapons an engraving can yield.
// Engravings that differ only in untracked outcomes or in which fixed stat is
// chosen collapse into one row with several `options`. Within a location, a
// row whose tracked set is a strict subset of another row's is dropped. When
// any weapon is starred, only rows yielding a starred weapon are kept.
export function solve(data, priorities, { locations = null, limit = 100 } = {}) {
  const priorityOf = (w) => priorities[w.name] ?? defaultPriority(w);
  const anyStarred = data.weapons.some((w) => priorityOf(w) === PRIORITY.STAR);
  const locationNames = Object.keys(data.alluvium);
  const rows = [];

  for (const [location, pool] of Object.entries(data.alluvium)) {
    if (locations && !locations.has(location)) continue;
    const byHits = new Map();
    const fixedOptions = [
      ...pool.secondary.map((stat) => ({ kind: 'secondary', stat })),
      ...pool.skill.map((stat) => ({ kind: 'skill', stat })),
    ];

    for (const fixed of fixedOptions) {
      const eligible = [];
      for (const w of data.weapons) {
        const roll = requiredRoll(w, pool, fixed);
        if (roll !== null) eligible.push({ weapon: w, roll, priority: priorityOf(w) });
      }
      const tracked = eligible.filter((e) => e.priority > PRIORITY.SKIP);
      if (tracked.length === 0) continue;

      const trackedAttrs = ATTRIBUTES.filter((a) => tracked.some((e) => e.weapon.attr_stat === a));
      const attrSets = trackedAttrs.length <= ENGRAVED_ATTRIBUTES
        ? [trackedAttrs]
        : combinations(trackedAttrs, ENGRAVED_ATTRIBUTES);

      for (const attrs of attrSets) {
        const hits = tracked
          .filter((e) => attrs.includes(e.weapon.attr_stat))
          .sort((a, b) => b.priority - a.priority || b.weapon.rarity - a.weapon.rarity || a.weapon.name.localeCompare(b.weapon.name));
        const untracked = eligible
          .filter((e) => e.priority === PRIORITY.SKIP && attrs.includes(e.weapon.attr_stat))
          .map((e) => ({ weapon: e.weapon, roll: e.roll }));
        const key = hits.map((e) => e.weapon.name).sort().join('|');
        const option = { ...fixed, untracked };
        const row = byHits.get(key);
        if (row) {
          row.options.push(option);
        } else {
          byHits.set(key, {
            location,
            region: pool.region,
            attrs,
            freeAttrs: ENGRAVED_ATTRIBUTES - attrs.length,
            options: [option],
            hits: hits.map(({ weapon, priority }) => ({ weapon, priority, rollFor: {} })),
            starred: hits.filter((e) => e.priority === PRIORITY.STAR).length,
            tracked: hits.filter((e) => e.priority === PRIORITY.TRACK).length,
          });
        }
        // The stat a weapon still needs to roll depends on which option is engraved.
        const entry = byHits.get(key);
        for (const h of hits) entry.hits.find((x) => x.weapon === h.weapon).rollFor[fixed.stat] = h.roll;
      }
    }

    const candidates = [...byHits.values()];
    // Options yielding the same weapons can still differ in rolls: fixing a
    // 3-star weapon's skill leaves nothing else to roll. Keep only the options
    // that leave the most weapons needing no second roll.
    for (const row of candidates) {
      const noRoll = (o) => row.hits.filter((h) => h.rollFor[o.stat] === '').length;
      const best = Math.max(...row.options.map(noRoll));
      row.options = row.options.filter((o) => noRoll(o) === best);
    }
    const hitSets = candidates.map((r) => new Set(r.hits.map((h) => h.weapon.name)));
    candidates.forEach((row, i) => {
      if (!hitSets.some((other, j) => j !== i && isStrictSubset(hitSets[i], other))) rows.push(row);
    });
  }

  return rows
    .filter((r) => !anyStarred || r.starred > 0)
    .sort((a, b) =>
      b.starred - a.starred ||
      b.tracked - a.tracked ||
      b.freeAttrs - a.freeAttrs ||
      locationNames.indexOf(a.location) - locationNames.indexOf(b.location))
    .slice(0, limit);
}

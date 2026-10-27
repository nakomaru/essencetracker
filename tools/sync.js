// Syncs data.json and weapon icons with the game data published by cmyyx/cep.
// Usage: node tools/sync.js [--dry-run]
//
// Every file is read from one cep commit, recorded in data.json as `source`.
// Weapons and locations are keyed by game id. A weapon or location whose
// English name changes keeps its old name under `formerly`, so saved
// selections and searches by the old name still find it. Weapons that cep
// marks as preview (announced, not yet released) get `announced: true`.
// Stats are stored as game ids; `stats` maps each id in use to its English name.
import { readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TYPE_ORDER } from '../solver.js';
import { iconPath } from '../icons.js';

const ROOT = new URL('..', import.meta.url);
const DATA = new URL('data.json', ROOT);
const REPO = 'cmyyx/cep';

const TYPE_NAMES = { 单手剑: 'Sword', 双手剑: 'Greatsword', 施术单元: 'Arts Unit', 长柄武器: 'Polearm', 手铳: 'Handcannon' };

// Reads `key: 'value'`, `key: null` and `key: 123` fields from one object literal on one line.
function fields(line) {
  const out = {};
  for (const [, key, str, other] of line.matchAll(/(\w+): (?:'([^']*)'|(null|\d+))/g)) {
    if (key in out) continue;
    out[key] = str ?? (other === 'null' ? null : Number(other));
  }
  return out;
}

// cep's src/data/weapons.ts holds one weapon object literal per line.
export function parseWeapons(ts) {
  const lines = ts.split('\n').filter((l) => /^\s*\{ id: '/.test(l));
  const split = lines.find((l) => !/\}\s*,?\s*$/.test(l));
  if (split) throw new Error(`weapons.ts: an entry spans several lines: ${split.trim()}`);
  return lines.map((line) => {
    const f = fields(line);
    return {
      id: f.id,
      iconId: f.iconId ?? f.id,
      rarity: f.rarity,
      type: f.type,
      attribute: f.primaryStat,
      secondary: f.elementalDamage,
      skill: f.specialAbility,
      preview: f.source === 'preview',
    };
  });
}

// cep's src/data/dungeons.ts lists each location's id and its attribute (s1),
// secondary (s2) and skill (s3) pools.
export function parseDungeons(ts) {
  const list = (s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return [...ts.matchAll(/id: '(world_energy_point_group\d+)'.*?s1Pool: \[(.*?)\].*?s2Pool: \[(.*?)\].*?s3Pool: \[(.*?)\]/gs)]
    .map(([, id, s1, s2, s3]) => ({ id, attribute: list(s1), secondary: list(s2), skill: list(s3) }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

// Turns game rich text such as `ATK <@ba.vup>+44.8%</>` into plain text.
// NFKC folds the fullwidth signs some lines use (＞) into ASCII.
export function plainText(s) {
  return s
    .normalize('NFKC')
    .replace(/<[@#$][^>]*>|<\/>/g, '')
    .replace(/(\d)\.0(?=\D|$)/g, '$1')
    .replace(/\n+/g, ' ')
    .trim();
}

export function skillEffect(texts, id) {
  const prefix = `weapon|${id}|skill|sk_`;
  const key = Object.keys(texts).find((k) => k.startsWith(prefix) && k.endsWith('|description') && k.split('|').length === 5);
  if (!key) return '';
  const name = texts[key.replace(/\|description$/, '|name')] ?? '';
  const text = plainText(texts[key]);
  return name ? `${name.replace(/^[^:]+:\s*/, '')}: ${text}` : text;
}

function translate(table, id, what) {
  const name = table[id];
  if (!name) throw new Error(`no English name for ${what} ${id}`);
  return name;
}

// Keeps `formerly` from the previous entry and adds its old name when the name changed.
function withHistory(entry, previous) {
  const formerly = new Set(previous?.formerly ?? []);
  if (previous && previous.name !== entry.name) formerly.add(previous.name);
  formerly.delete(entry.name);
  return formerly.size ? { ...entry, formerly: [...formerly] } : entry;
}

export function build(src, previous) {
  const stats = {};
  const stat = (id) => {
    stats[id] = translate(src.stats, id, 'stat');
    return id;
  };
  const oldWeapons = new Map((previous?.weapons ?? []).map((w) => [w.id, w]));
  const oldLocations = new Map((previous?.locations ?? []).map((l) => [l.id, l]));
  const skipped = [];
  const icons = new Map();

  const weapons = [];
  for (const w of parseWeapons(src.weaponsTs)) {
    if (!src.weaponNames[w.id]) {
      // Announcements published before the client tables have no English text yet.
      skipped.push(w.id);
      continue;
    }
    const type = TYPE_NAMES[w.type];
    if (!type) throw new Error(`unknown weapon type ${w.type} for ${w.id}`);
    const effect = skillEffect(src.texts, w.id);
    const entry = {
      id: w.id,
      name: src.weaponNames[w.id],
      type,
      rarity: w.rarity,
      attribute: stat(w.attribute),
      ...(w.secondary ? { secondary: stat(w.secondary) } : {}),
      skill: stat(w.skill),
      ...(effect ? { effect } : {}),
      ...(w.preview ? { announced: true } : {}),
    };
    weapons.push(withHistory(entry, oldWeapons.get(w.id)));
    icons.set(w.id, w.iconId);
  }
  weapons.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || b.rarity - a.rarity || a.name.localeCompare(b.name));

  // Each pool lists its stats in its own order; every pool follows the order
  // in which stats first appear across locations, so rows read consistently.
  const dungeons = parseDungeons(src.dungeonsTs);
  const rank = new Map();
  for (const d of dungeons) for (const id of [...d.attribute, ...d.secondary, ...d.skill]) if (!rank.has(id)) rank.set(id, rank.size);
  const ordered = (pool) => [...pool].sort((a, b) => rank.get(a) - rank.get(b)).map(stat);

  const locations = dungeons.map((d) => {
    const [region, name] = translate(src.dungeonNames, d.id, 'location').split('·');
    const entry = { id: d.id, name, region, attribute: ordered(d.attribute), secondary: ordered(d.secondary), skill: ordered(d.skill) };
    return withHistory(entry, oldLocations.get(d.id));
  });

  const sortedStats = Object.fromEntries(Object.entries(stats).sort(([a], [b]) => a.localeCompare(b)));
  return { data: { source: src.source, stats: sortedStats, locations, weapons }, icons, skipped };
}

// Lines describing what changed between two data sets.
export function changes(before, after) {
  const out = [];
  const diff = (kind, olds, news, keys) => {
    const byId = new Map(olds.map((x) => [x.id, x]));
    for (const n of news) {
      const o = byId.get(n.id);
      byId.delete(n.id);
      if (!o) {
        out.push(`NEW       ${kind} ${n.name}${n.announced ? ' (announced)' : ''}`);
        continue;
      }
      if (o.name !== n.name) out.push(`RENAMED   ${kind} ${o.name} -> ${n.name}`);
      if (o.announced && !n.announced) out.push(`RELEASED  ${kind} ${n.name}`);
      const changed = keys.filter((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k]));
      if (changed.length) out.push(`UPDATED   ${kind} ${n.name}: ${changed.join(', ')}`);
    }
    for (const o of byId.values()) out.push(`REMOVED   ${kind} ${o.name}`);
  };
  diff('weapon', before?.weapons ?? [], after.weapons, ['type', 'rarity', 'attribute', 'secondary', 'skill', 'effect']);
  diff('location', before?.locations ?? [], after.locations, ['region', 'attribute', 'secondary', 'skill']);
  for (const [id, name] of Object.entries(after.stats)) {
    const old = before?.stats?.[id];
    if (old && old !== name) out.push(`RENAMED   stat ${old} -> ${name}`);
  }
  return out;
}

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: { 'User-Agent': 'endfield-essence-tracker-sync' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res[as]();
}

export async function fetchSources() {
  const commit = await get(`https://api.github.com/repos/${REPO}/commits/main`, 'json');
  const raw = (path, as) => get(`https://raw.githubusercontent.com/${REPO}/${commit.sha}/${path}`, as);
  const [weaponsTs, dungeonsTs, weaponNames, stats, dungeonNames, texts] = await Promise.all([
    raw('src/data/weapons.ts'),
    raw('src/data/dungeons.ts'),
    raw('src/generated/i18n/weapons/en.json', 'json'),
    raw('src/generated/i18n/gemStats/en.json', 'json'),
    raw('src/generated/i18n/dungeons/en.json', 'json'),
    raw('src/generated/i18n/wikiData/en.json', 'json'),
  ]);
  const source = { repo: REPO, commit: commit.sha, date: commit.commit.committer.date.slice(0, 10) };
  return { source, weaponsTs, dungeonsTs, weaponNames, stats, dungeonNames, texts, raw };
}

const exists = (url) => access(url).then(() => true, () => false);

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const previous = (await exists(DATA)) ? JSON.parse(await readFile(DATA, 'utf8')) : null;
  const src = await fetchSources();
  const { data: next, icons, skipped } = build(src, previous);
  console.log(`cep ${next.source.commit.slice(0, 7)} (${next.source.date})`);
  for (const line of changes(previous, next)) console.log(line);
  for (const id of skipped) console.log(`SKIPPED   weapon ${id} (no English name yet)`);

  const missingIcons = [];
  for (const w of next.weapons) if (!(await exists(new URL(iconPath(w), ROOT)))) missingIcons.push(w);
  for (const w of missingIcons) {
    if (dryRun) {
      console.log(`ICON      ${w.name} (missing)`);
      continue;
    }
    const bytes = Buffer.from(await src.raw(`public/images/weapon/${icons.get(w.id)}.avif`, 'arrayBuffer'));
    await writeFile(new URL(iconPath(w), ROOT), bytes);
    console.log(`ICON      ${w.name}: downloaded`);
  }
  if (dryRun) return;
  await writeFile(DATA, `${JSON.stringify(next, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

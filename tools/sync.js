// Syncs data.json and weapon icons with the game data published by cmyyx/cep.
// Usage: node tools/sync.js [--dry-run]
//
// Every file is read from one cep commit, recorded in data.json as `source`.
// Weapons and locations are keyed by game id. A weapon or location whose
// English name changes keeps its old name under `formerly`, so saved
// selections and searches by the old name still find it. Weapons that cep
// marks as preview (announced, not yet released) get `announced: true`, and
// weapons cep links to operators list their English names under `operators`.
// Stats are stored as game ids; `stats` maps each id in use to its English name.
//
// When cep lacks a weapon's skill text or an operator's English name, the
// sync also reads the game's text tables from cmyyx/cep-assets: operator
// names are looked up there, and deduce.js proposes deductions from them.
// Only deductions with an accepted verdict in tools/deductions.json are published.
import { readFile, writeFile, readdir, rm, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TYPE_ORDER } from '../solver.js';
import { iconPath, avatarPath } from '../icons.js';
import { candidates, applyVerdicts, hasGaps } from './deduce.js';

const ROOT = new URL('..', import.meta.url);
const DATA = new URL('data.json', ROOT);
const VERDICTS = new URL('tools/deductions.json', ROOT);
const REPO = 'cmyyx/cep';
const TEXT_REPO = 'cmyyx/cep-assets';
// Folders holding only synced images; files nothing references are removed.
const IMAGE_DIRS = ['images/weapons', 'images/operators'];

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
      chars: [...(line.match(/chars: \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]),
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

// Turns game rich text such as `ATK <@ba.vup>+44.8%</>` into plain text,
// keeping the game's line breaks. NFKC folds the fullwidth signs some lines use (＞) into ASCII.
export function plainText(s) {
  return s
    .normalize('NFKC')
    .replace(/<[@#$][^>]*>|<\/>/g, '')
    .replace(/(\d)\.0(?=\D|$)/g, '$1')
    .replace(/[ \t]*\n+[ \t]*/g, '\n')
    .trim();
}

// The max-rank skill of a weapon: its name without the "Stat: " prefix, and its text.
export function skillText(texts, id) {
  const prefix = `weapon|${id}|skill|sk_`;
  const key = Object.keys(texts).find((k) => k.startsWith(prefix) && k.endsWith('|description') && k.split('|').length === 5);
  if (!key) return null;
  const name = (texts[key.replace(/\|description$/, '|name')] ?? '').replace(/^[^:]+:\s*/, '');
  return { name, text: plainText(texts[key]) };
}

// cep's avatar file suffixes for the Endministrator's variants.
const VARIANT_AVATARS = { 女: 'female', 男: 'male' };

// Resolves the Chinese operator names cep links to a weapon into
// { id, name, avatars } entries. The English name comes from cep's character
// tables, else from the game text as the English text under the one text id
// holding the Chinese name. Avatars are cep image names: the character id, or
// for an operator not yet in the character tables, cep's preview avatar.
// cep lists the Endministrator as 管理员(女) and 管理员(男), one operator with
// a variant avatar each; id is absent for operators without a character id.
export function resolveOperators(chars, src, gameText) {
  const idByZh = new Map(Object.entries(src.charNamesZh).map(([id, zh]) => [zh, id]));
  const byName = new Map();
  const unresolved = [];
  for (const zh of chars) {
    const [, base, variant] = zh.match(/^(.*?)(?:\((.)\))?$/);
    const id = idByZh.get(base);
    const ids = gameText?.idsByZh.get(base) ?? [];
    const name = src.charNamesEn[id] ?? (ids.length === 1 ? gameText.en[ids[0]] : undefined);
    if (!name) {
      unresolved.push(zh);
      continue;
    }
    const avatar = id ? (VARIANT_AVATARS[variant] ? `${id}-${VARIANT_AVATARS[variant]}` : id) : src.previewAvatars[base];
    const entry = byName.get(name) ?? { ...(id ? { id } : {}), name, avatars: [] };
    if (avatar && !entry.avatars.includes(avatar)) entry.avatars.push(avatar);
    byName.set(name, entry);
  }
  return { resolved: [...byName.values()], unresolved };
}

export function indexGameText(en, zh) {
  const idsByZh = new Map();
  for (const [id, text] of Object.entries(zh)) {
    if (!idsByZh.has(text)) idsByZh.set(text, []);
    idsByZh.get(text).push(id);
  }
  return { en, zh, idsByZh };
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

// `src.gameText`, from indexGameText, is optional; without it operators cep does not name stay unresolved.
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
  const unresolvedOperators = new Map();

  const weapons = [];
  for (const w of parseWeapons(src.weaponsTs)) {
    if (!src.weaponNames[w.id]) {
      // Announcements published before the client tables have no English text yet.
      skipped.push(w.id);
      continue;
    }
    const type = TYPE_NAMES[w.type];
    if (!type) throw new Error(`unknown weapon type ${w.type} for ${w.id}`);
    const skill = skillText(src.texts, w.id);
    const operators = resolveOperators(w.chars, src, src.gameText);
    if (operators.unresolved.length) unresolvedOperators.set(w.id, operators.unresolved);
    const entry = {
      id: w.id,
      name: src.weaponNames[w.id],
      type,
      rarity: w.rarity,
      attribute: stat(w.attribute),
      ...(w.secondary ? { secondary: stat(w.secondary) } : {}),
      skill: stat(w.skill),
      ...(operators.resolved.length ? { operators: operators.resolved } : {}),
      ...(skill?.name ? { skillName: skill.name } : {}),
      ...(skill?.text ? { effect: skill.text } : {}),
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
  return { data: { source: src.source, stats: sortedStats, locations, weapons }, icons, skipped, unresolvedOperators };
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
        for (const [key, d] of Object.entries(n.deduced ?? {})) out.push(`DEDUCED   ${kind} ${n.name}: ${key} ${d.value}`);
        continue;
      }
      if (o.name !== n.name) out.push(`RENAMED   ${kind} ${o.name} -> ${n.name}`);
      if (o.announced && !n.announced) out.push(`RELEASED  ${kind} ${n.name}`);
      for (const [key, d] of Object.entries(n.deduced ?? {})) {
        if (o.deduced?.[key]?.value !== d.value) out.push(`DEDUCED   ${kind} ${n.name}: ${key} ${d.value}`);
      }
      const changed = keys.filter((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k]));
      if (changed.length) out.push(`UPDATED   ${kind} ${n.name}: ${changed.join(', ')}`);
    }
    for (const o of byId.values()) out.push(`REMOVED   ${kind} ${o.name}`);
  };
  diff('weapon', before?.weapons ?? [], after.weapons, ['type', 'rarity', 'attribute', 'secondary', 'skill', 'operators', 'skillName', 'effect']);
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

const latestCommit = (repo) => get(`https://api.github.com/repos/${repo}/commits/HEAD`, 'json');

export async function fetchSources() {
  const commit = await latestCommit(REPO);
  const raw = (path, as) => get(`https://raw.githubusercontent.com/${REPO}/${commit.sha}/${path}`, as);
  const [weaponsTs, dungeonsTs, weaponNames, stats, dungeonNames, texts, charNamesZh, charNamesEn, previewAvatars] = await Promise.all([
    raw('src/data/weapons.ts'),
    raw('src/data/dungeons.ts'),
    raw('src/generated/i18n/weapons/en.json', 'json'),
    raw('src/generated/i18n/gemStats/en.json', 'json'),
    raw('src/generated/i18n/dungeons/en.json', 'json'),
    raw('src/generated/i18n/wikiData/en.json', 'json'),
    raw('src/generated/i18n/characters/zh-CN.json', 'json'),
    raw('src/generated/i18n/characters/en.json', 'json'),
    raw('src/generated/data/wiki/preview-character-avatars.json', 'json'),
  ]);
  const source = { repo: REPO, commit: commit.sha, date: commit.commit.committer.date.slice(0, 10) };
  return { source, weaponsTs, dungeonsTs, weaponNames, stats, dungeonNames, texts, charNamesZh, charNamesEn, previewAvatars, raw };
}

// The game's full text tables, split into chunks listed in the repo's manifest.
async function fetchGameText(locales) {
  const commit = await latestCommit(TEXT_REPO);
  const raw = (path) => get(`https://raw.githubusercontent.com/${TEXT_REPO}/${commit.sha}/${path}`, 'json');
  const manifest = await raw('manifest.json');
  const tables = await Promise.all(locales.map(async (locale) =>
    Object.assign({}, ...(await Promise.all(manifest.locales[locale].chunks.map((c) => raw(c.file)))))));
  return { commit: commit.sha, tables };
}

// Every weapon skill name cep links to a weapon, as "Stat: Name".
export function knownSkillNames(texts) {
  return Object.entries(texts)
    .filter(([key]) => /^weapon\|[^|]+\|skill\|sk_[^|]+\|name$/.test(key))
    .map(([, name]) => name);
}

const exists = (url) => access(url).then(() => true, () => false);

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const previous = (await exists(DATA)) ? JSON.parse(await readFile(DATA, 'utf8')) : null;
  const verdicts = JSON.parse(await readFile(VERDICTS, 'utf8'));
  const src = await fetchSources();
  let built = build(src, previous);
  console.log(`cep ${src.source.commit.slice(0, 7)} (${src.source.date})`);
  let proposed = [];
  if (built.unresolvedOperators.size || hasGaps(built.data)) {
    const text = await fetchGameText(['en', 'zh-CN']);
    console.log(`cep-assets ${text.commit.slice(0, 7)} (game text)`);
    src.gameText = indexGameText(...text.tables);
    src.source = { ...src.source, text: { repo: TEXT_REPO, commit: text.commit } };
    built = build(src, previous);
    proposed = candidates(built.data, { en: text.tables[0], zh: text.tables[1], knownSkillNames: knownSkillNames(src.texts) });
  }
  const { icons, skipped, unresolvedOperators } = built;
  const { data: next, report } = applyVerdicts(built.data, proposed, verdicts);

  for (const line of changes(previous, next)) console.log(line);
  for (const line of report) console.log(line);
  for (const id of skipped) console.log(`SKIPPED   weapon ${id} (no English name yet)`);
  for (const [id, names] of unresolvedOperators) console.log(`UNNAMED   weapon ${id}: operator ${names.join(', ')} has no English name`);
  for (const dir of IMAGE_DIRS) await mkdir(new URL(`${dir}/`, ROOT), { recursive: true });

  // Every image data.json references, as local path -> cep path.
  const images = new Map(next.weapons.map((w) => [iconPath(w), `public/images/weapon/${icons.get(w.id)}.avif`]));
  for (const w of next.weapons) {
    for (const o of w.operators ?? []) for (const a of o.avatars) images.set(avatarPath(a), `public/images/characters/${a}.avif`);
  }
  for (const [path, remote] of images) {
    if (await exists(new URL(path, ROOT))) continue;
    if (dryRun) {
      console.log(`IMAGE     ${path} (missing)`);
      continue;
    }
    await writeFile(new URL(path, ROOT), Buffer.from(await src.raw(remote, 'arrayBuffer')));
    console.log(`IMAGE     ${path}: downloaded`);
  }
  for (const dir of IMAGE_DIRS) {
    for (const file of await readdir(new URL(`${dir}/`, ROOT))) {
      const path = `${dir}/${file}`;
      if (images.has(path)) continue;
      console.log(`IMAGE     ${path}: ${dryRun ? 'unused' : 'removed, unused'}`);
      if (!dryRun) await rm(new URL(path, ROOT));
    }
  }
  if (dryRun) return;
  await writeFile(DATA, `${JSON.stringify(next, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

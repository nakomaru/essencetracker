// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWeapons, parseDungeons, plainText, skillText, resolveOperators, indexGameText, build, changes } from '../tools/sync.js';

const WEAPONS_TS = `export const weapons: Weapon[] = [
  // ===== 六星 =====
  { id: 'wpn_sword_0025', name: '唤月', rarity: 6, type: '单手剑', primaryStat: 'gat_passive_attr_will', elementalDamage: 'gat_passive_attr_atk', specialAbility: 'gst_passive_magabn', chars: ['明河'], source: 'preview' },
  { id: 'wpn_claym_0018', name: '玉中身', rarity: 6, type: '双手剑', primaryStat: 'gat_passive_attr_wisd', elementalDamage: 'gat_passive_attr_icedam', specialAbility: 'gst_passive_keyword', acquisitionSources: [{ categoryId: 'gacha', sourceId: 'weaponbox_1_6_1' }], chars: ['祀'] },
  { id: 'wpn_sword_0003', iconId: 'wpn_sword_0003', name: '塔尔11', rarity: 3, type: '单手剑', primaryStat: 'gat_passive_attr_main', elementalDamage: null, specialAbility: 'gst_passive_force', chars: [] }
]`;

const DUNGEONS_TS = `export const dungeons = [
  {
    id: 'world_energy_point_group10',
    name: '武陵·应龙关',
    s1Pool: ['gat_passive_attr_will', 'gat_passive_attr_wisd', 'gat_passive_attr_main'],
    s2Pool: ['gat_passive_attr_atk', 'gat_passive_attr_icedam'],
    s3Pool: ['gst_passive_magabn', 'gst_passive_keyword', 'gst_passive_force'],
  },
  {
    id: 'world_energy_point_group02',
    name: '四号谷地·源石研究园',
    s1Pool: ['gat_passive_attr_will'],
    s2Pool: ['gat_passive_attr_atk'],
    s3Pool: ['gst_passive_force'],
  }
]`;

const SOURCES = {
  source: { repo: 'cmyyx/cep', commit: 'abc', date: '2026-10-21' },
  weaponsTs: WEAPONS_TS,
  dungeonsTs: DUNGEONS_TS,
  weaponNames: { wpn_sword_0025: 'Lunar Calling', wpn_claym_0018: 'Jade Vessel', wpn_sword_0003: 'Tarr 11' },
  dungeonNames: { world_energy_point_group10: 'Wuling·Yinglung Pass', world_energy_point_group02: 'Valley IV·Originium Science Park' },
  stats: {
    gat_passive_attr_will: 'Will', gat_passive_attr_wisd: 'Intellect', gat_passive_attr_main: 'Main Attribute',
    gat_passive_attr_atk: 'ATK', gat_passive_attr_icedam: 'Cryo DMG',
    gst_passive_magabn: 'Infliction', gst_passive_keyword: 'Efficacy', gst_passive_force: 'Assault',
  },
  charNamesZh: { chr_0036_jsspsi: '祀', chr_9000_endmin: '管理员' },
  charNamesEn: { chr_0036_jsspsi: 'Si', chr_9000_endmin: 'Endministrator' },
  previewAvatars: { 明河: 'preview-2503' },
  texts: {
    'weapon|wpn_claym_0018|skill|sk_wpn_claym_0018|name': 'Efficacy: Dabbles of Ink',
    'weapon|wpn_claym_0018|skill|sk_wpn_claym_0018|description': 'ATK <@ba.vup>+44.8%</>.\nDMG Taken <@ba.vup>+21.0%</> for 30s.',
    'weapon|wpn_claym_0018|skill|sk_wpn_claym_0018|level|1': 'ATK <@ba.vup>+10.0%</>.',
    'weapon|wpn_sword_0003|skill|sk_wpn_sword_0003|name': 'Assault: Armament Prep',
    'weapon|wpn_sword_0003|skill|sk_wpn_sword_0003|description': 'ATK <@ba.vup>+34</> when HP ＞ 50%.',
  },
};

test('parseWeapons reads one entry per line, with null secondaries and preview flags', () => {
  const [lunar, jade, tarr] = parseWeapons(WEAPONS_TS);
  assert.deepEqual(lunar, {
    id: 'wpn_sword_0025', iconId: 'wpn_sword_0025', rarity: 6, type: '单手剑',
    attribute: 'gat_passive_attr_will', secondary: 'gat_passive_attr_atk', skill: 'gst_passive_magabn', preview: true, chars: ['明河'],
  });
  assert.equal(jade.preview, false);
  assert.equal(tarr.secondary, null);
});

test('parseWeapons refuses entries split across lines', () => {
  assert.throws(() => parseWeapons("[\n  { id: 'a',\n    rarity: 6 },\n]"), /spans several lines/);
});

test('parseDungeons reads all three pools and orders by group number', () => {
  const [first, second] = parseDungeons(DUNGEONS_TS);
  assert.equal(first.id, 'world_energy_point_group02');
  assert.deepEqual(second.attribute, ['gat_passive_attr_will', 'gat_passive_attr_wisd', 'gat_passive_attr_main']);
  assert.deepEqual(second.skill, ['gst_passive_magabn', 'gst_passive_keyword', 'gst_passive_force']);
});

test('plainText strips markup, trailing .0 and fullwidth signs, keeping line breaks', () => {
  assert.equal(plainText('ATK <@ba.vup>+44.0%</>. \n\n<#ba.guard>Protected</> ＞ 2.05'), 'ATK +44%.\nProtected > 2.05');
});

test('skillText reads the max-rank description and the skill name', () => {
  assert.deepEqual(skillText(SOURCES.texts, 'wpn_claym_0018'), { name: 'Dabbles of Ink', text: 'ATK +44.8%.\nDMG Taken +21% for 30s.' });
  assert.equal(skillText(SOURCES.texts, 'wpn_sword_0025'), null);
});

test('build keys entries by game id and names the stats it uses', () => {
  const { data, icons } = build(SOURCES, null);
  assert.equal(icons.get('wpn_sword_0003'), 'wpn_sword_0003');
  assert.deepEqual(data.weapons.map((w) => w.name), ['Jade Vessel', 'Lunar Calling', 'Tarr 11']);
  const lunar = data.weapons.find((w) => w.id === 'wpn_sword_0025');
  assert.equal(lunar.announced, true);
  assert.equal(lunar.skillName, undefined);
  assert.equal(lunar.effect, undefined);
  assert.equal(data.weapons.find((w) => w.name === 'Jade Vessel').skillName, 'Dabbles of Ink');
  assert.equal(data.weapons.find((w) => w.name === 'Tarr 11').secondary, undefined);
  assert.deepEqual(data.locations.map((l) => [l.name, l.region]), [['Originium Science Park', 'Valley IV'], ['Yinglung Pass', 'Wuling']]);
  assert.equal(data.stats.gat_passive_attr_atk, 'ATK');
});

test('resolveOperators folds the Endministrator variants into one operator with an avatar each', () => {
  assert.deepEqual(resolveOperators(['管理员(女)', '管理员(男)'], SOURCES), {
    resolved: [{ id: 'chr_9000_endmin', name: 'Endministrator', avatars: ['chr_9000_endmin-female', 'chr_9000_endmin-male'] }],
    unresolved: [],
  });
  assert.deepEqual(resolveOperators(['祀', '明河'], SOURCES), {
    resolved: [{ id: 'chr_0036_jsspsi', name: 'Si', avatars: ['chr_0036_jsspsi'] }],
    unresolved: ['明河'],
  });
});

test('resolveOperators names other operators from the game text, with their preview avatar', () => {
  const gameText = indexGameText({ 7: 'Argent Flow', 8: 'Milky Way', 9: 'Other' }, { 7: '明河', 8: '银河', 9: '银河' });
  assert.deepEqual(resolveOperators(['明河'], SOURCES, gameText), { resolved: [{ name: 'Argent Flow', avatars: ['preview-2503'] }], unresolved: [] });
  // A Chinese name under several text ids has no single English name.
  assert.deepEqual(resolveOperators(['银河'], SOURCES, gameText), { resolved: [], unresolved: ['银河'] });
});

test('build lists named operators and returns the ones it cannot name', () => {
  const { data, unresolvedOperators } = build(SOURCES, null);
  assert.deepEqual(data.weapons.find((w) => w.name === 'Jade Vessel').operators.map((o) => o.name), ['Si']);
  assert.equal(data.weapons.find((w) => w.name === 'Lunar Calling').operators, undefined);
  assert.deepEqual([...unresolvedOperators], [['wpn_sword_0025', ['明河']]]);
  const withText = build({ ...SOURCES, gameText: indexGameText({ 7: 'Argent Flow' }, { 7: '明河' }) }, null);
  assert.deepEqual(withText.data.weapons.find((w) => w.name === 'Lunar Calling').operators.map((o) => o.name), ['Argent Flow']);
  assert.equal(withText.unresolvedOperators.size, 0);
});

test('build records renames under formerly', () => {
  const first = build(SOURCES, null).data;
  const renamed = { ...SOURCES, weaponNames: { ...SOURCES.weaponNames, wpn_sword_0003: 'Tarr XI' } };
  const second = build(renamed, first).data;
  assert.deepEqual(second.weapons.find((w) => w.id === 'wpn_sword_0003').formerly, ['Tarr 11']);
  // Renaming back drops the current name from formerly.
  const third = build(SOURCES, second).data;
  assert.deepEqual(third.weapons.find((w) => w.id === 'wpn_sword_0003').formerly, ['Tarr XI']);
});

test('build skips weapons without an English name', () => {
  const { skipped } = build({ ...SOURCES, weaponNames: { wpn_claym_0018: 'Jade Vessel', wpn_sword_0003: 'Tarr 11' } }, null);
  assert.deepEqual(skipped, ['wpn_sword_0025']);
});

test('changes reports releases', () => {
  const before = build(SOURCES, null).data;
  const released = build({ ...SOURCES, weaponsTs: WEAPONS_TS.replace(", source: 'preview'", '') }, before).data;
  assert.deepEqual(changes(before, released), ['RELEASED  weapon Lunar Calling']);
});

// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { candidates, applyVerdicts, hasGaps } from '../tools/deduce.js';

const stats = { gst_passive_magabn: 'Infliction', gst_passive_force: 'Assault' };
const weapon = (id, extra) => ({ id, name: id, skill: 'gst_passive_magabn', ...extra });
const data = (...weapons) => ({ stats, weapons });

const facts = (extra = {}) => ({
  en: { 1: 'Infliction: Known Skill', 2: 'Infliction: Coursing Stars', 4: 'Assault: Other' },
  zh: { 1: '附术·已知', 2: '附术·垂星渡野' },
  knownSkillNames: ['Infliction: Known Skill'],
  ...extra,
});

test('proposes the one unclaimed skill name for the one weapon without a skill name', () => {
  const found = candidates(data(weapon('old', { skillName: 'Known Skill' }), weapon('new', { announced: true })), facts());
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'new');
  assert.equal(found[0].value, 'Coursing Stars');
  assert.match(found[0].evidence, /附术·垂星渡野/);
});

test('proposes no skill name when the evidence is not unique', () => {
  const twoWeapons = data(weapon('new'), weapon('other'));
  assert.deepEqual(candidates(twoWeapons, facts()), []);
  const twoNames = facts({ en: { ...facts().en, 5: 'Infliction: Second Name' } });
  assert.deepEqual(candidates(data(weapon('new')), twoNames), []);
});

const proposed = [{ id: 'new', key: 'skillName', value: 'Coursing Stars', evidence: 'e' }];
const accepted = { new: { skillName: { value: 'Coursing Stars', verdict: 'accepted', basis: 'b', review: 'r' } } };

test('publishes an accepted verdict the rules still support, without its review notes', () => {
  const { data: out, report } = applyVerdicts(data(weapon('new')), proposed, accepted);
  assert.deepEqual(out.weapons[0].deduced, { skillName: { value: 'Coursing Stars', basis: 'b' } });
  assert.deepEqual(report, []);
});

test('reports candidates without a verdict and publishes nothing', () => {
  const { data: out, report } = applyVerdicts(data(weapon('new')), proposed, {});
  assert.equal(out.weapons[0].deduced, undefined);
  assert.match(report[0], /^CANDIDATE .*Coursing Stars.*needs a verdict/);
});

test('holds back a verdict the rules no longer support', () => {
  const { data: out, report } = applyVerdicts(data(weapon('new')), [], accepted);
  assert.equal(out.weapons[0].deduced, undefined);
  assert.match(report[0], /^REVIEW .*rules now propose nothing/);
});

test('publishes nothing for a rejected verdict', () => {
  const rejected = { new: { skillName: { ...accepted.new.skillName, verdict: 'rejected' } } };
  const { data: out, report } = applyVerdicts(data(weapon('new')), proposed, rejected);
  assert.equal(out.weapons[0].deduced, undefined);
  assert.deepEqual(report, []);
});

test('reports a deduction whose gap the game data has filled', () => {
  const released = data(weapon('new', { skillName: 'Coursing Stars' }));
  const { data: out, report } = applyVerdicts(released, [], accepted);
  assert.equal(out.weapons[0].deduced, undefined);
  assert.match(report[0], /^RESOLVED .*is Coursing Stars in the game data.*retire the verdict/);
  assert.equal(hasGaps(released), false);
  assert.equal(hasGaps(data(weapon('new'))), true);
});

test('every verdict on file is complete', () => {
  const verdicts = JSON.parse(readFileSync(new URL('../tools/deductions.json', import.meta.url), 'utf8'));
  for (const [id, keys] of Object.entries(verdicts)) {
    for (const [key, v] of Object.entries(keys)) {
      assert.ok(['accepted', 'rejected'].includes(v.verdict), `${id} ${key} verdict`);
      for (const field of ['value', 'basis', 'review']) assert.ok(v[field], `${id} ${key} ${field}`);
    }
  }
});

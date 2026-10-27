// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { candidates, applyVerdicts, hasGaps } from '../tools/deduce.js';

const stats = { gst_passive_magabn: 'Infliction', gst_passive_force: 'Assault' };
const weapon = (id, extra) => ({ id, name: id, skill: 'gst_passive_magabn', ...extra });
const data = (...weapons) => ({ stats, weapons });

const facts = (extra = {}) => ({
  en: { 1: 'Infliction: Known Skill', 2: 'Infliction: Coursing Stars', 3: 'Argent Flow', 4: 'Assault: Other' },
  zh: { 1: '附术·已知', 2: '附术·垂星渡野', 3: '明河' },
  knownSkillNames: ['Infliction: Known Skill'],
  unresolvedOperators: new Map([['new', ['明河']]]),
  ...extra,
});

test('proposes the one unclaimed skill name for the one weapon missing skill text', () => {
  const found = candidates(data(weapon('old', { effect: 'Known Skill: ...' }), weapon('new', { announced: true })), facts());
  const name = found.find((c) => c.key === 'skillName');
  assert.equal(name.id, 'new');
  assert.equal(name.value, 'Coursing Stars');
  assert.match(name.evidence, /附术·垂星渡野/);
});

test('proposes no skill name when the evidence is not unique', () => {
  const twoWeapons = data(weapon('new', { announced: true }), weapon('other', { announced: true }));
  assert.ok(!candidates(twoWeapons, facts()).some((c) => c.key === 'skillName'));
  const twoNames = facts({ en: { ...facts().en, 5: 'Infliction: Second Name' } });
  assert.ok(!candidates(data(weapon('new', { announced: true })), twoNames).some((c) => c.key === 'skillName'));
});

test('proposes operator names only when the Chinese name has one English rendering', () => {
  const one = candidates(data(weapon('new', { announced: true })), facts());
  assert.equal(one.find((c) => c.key === 'operators').value, 'Argent Flow');
  const ambiguous = facts({ zh: { ...facts().zh, 9: '明河' }, en: { ...facts().en, 9: 'Milky Way' } });
  assert.ok(!candidates(data(weapon('new', { announced: true })), ambiguous).some((c) => c.key === 'operators'));
});

const proposed = [{ id: 'new', key: 'skillName', value: 'Coursing Stars', evidence: 'e' }];
const accepted = { new: { skillName: { value: 'Coursing Stars', verdict: 'accepted', basis: 'b', review: 'r' } } };
const noGaps = { unresolvedOperators: new Map() };

test('publishes an accepted verdict the rules still support, without its review notes', () => {
  const { data: out, report } = applyVerdicts(data(weapon('new', { announced: true })), proposed, accepted, noGaps);
  assert.deepEqual(out.weapons[0].deduced, { skillName: { value: 'Coursing Stars', basis: 'b' } });
  assert.deepEqual(report, []);
});

test('reports candidates without a verdict and publishes nothing', () => {
  const { data: out, report } = applyVerdicts(data(weapon('new', { announced: true })), proposed, {}, noGaps);
  assert.equal(out.weapons[0].deduced, undefined);
  assert.match(report[0], /^CANDIDATE .*Coursing Stars.*needs a verdict/);
});

test('holds back a verdict the rules no longer support', () => {
  const { data: out, report } = applyVerdicts(data(weapon('new', { announced: true })), [], accepted, noGaps);
  assert.equal(out.weapons[0].deduced, undefined);
  assert.match(report[0], /^REVIEW .*rules now propose nothing/);
});

test('publishes nothing for a rejected verdict', () => {
  const rejected = { new: { skillName: { ...accepted.new.skillName, verdict: 'rejected' } } };
  const { data: out, report } = applyVerdicts(data(weapon('new', { announced: true })), proposed, rejected, noGaps);
  assert.equal(out.weapons[0].deduced, undefined);
  assert.deepEqual(report, []);
});

test('reports a deduction whose gap the game data has filled', () => {
  const released = data(weapon('new', { effect: 'Coursing Stars: ...' }));
  const { data: out, report } = applyVerdicts(released, [], accepted, noGaps);
  assert.equal(out.weapons[0].deduced, undefined);
  assert.match(report[0], /^RESOLVED .*retire the verdict/);
  assert.equal(hasGaps(released, noGaps), false);
  assert.equal(hasGaps(released, { unresolvedOperators: new Map([['new', ['明河']]]) }), true);
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

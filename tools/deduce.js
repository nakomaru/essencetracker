// Deductions fill gaps in the mechanically synced data that the game data
// holds the answer to but does not link. The rules here only propose
// candidates with their evidence; a reviewer reads them and records a verdict
// in deductions.json. A deduction is published under the weapon's `deduced`
// only while its gap remains, its verdict is "accepted", and the rules still
// propose the same value.
//
// `facts` holds:
//   en, zh               game text tables (text id -> string) in English and Chinese
//   knownSkillNames      every weapon skill name cep links to a weapon, as "Stat: Name"
//   unresolvedOperators  weapon id -> Chinese names of linked operators that cep's
//                        character tables do not name in English
// `gaps` holds unresolvedOperators alone, for checking gaps without the text tables.

// Weapons without skill text: a weapon skill name in the game text that no
// weapon claims, under the same skill stat as exactly one such weapon.
function skillName(data, facts) {
  const out = [];
  const claimed = new Set(facts.knownSkillNames);
  const pending = data.weapons.filter((w) => !w.effect);
  for (const [skill, weapons] of Map.groupBy(pending, (w) => w.skill)) {
    const prefix = `${data.stats[skill]}: `;
    const unclaimed = new Set(Object.values(facts.en).filter((t) => t.startsWith(prefix) && !claimed.has(t)));
    if (weapons.length !== 1 || unclaimed.size !== 1) continue;
    const [name] = unclaimed;
    const zh = Object.keys(facts.en).filter((id) => facts.en[id] === name).map((id) => facts.zh[id]).find(Boolean);
    out.push({
      id: weapons[0].id,
      value: name.slice(prefix.length),
      evidence: `only unclaimed ${data.stats[skill]} weapon skill name in the game text${zh ? ` (${zh})` : ''}; only ${data.stats[skill]} weapon without skill text`,
    });
  }
  return out;
}

// Linked operators cep's character tables do not name yet: the English text
// under the text ids holding each Chinese name.
function operators(data, facts) {
  const out = [];
  for (const w of data.weapons.filter((x) => facts.unresolvedOperators.has(x.id))) {
    const names = facts.unresolvedOperators.get(w.id).map((zh) => {
      const english = new Set(Object.keys(facts.zh).filter((id) => facts.zh[id] === zh && facts.en[id]).map((id) => facts.en[id]));
      return english.size === 1 ? { zh, en: [...english][0] } : null;
    });
    if (names.length === 0 || names.includes(null)) continue;
    out.push({
      id: w.id,
      value: names.map((n) => n.en).join(', '),
      evidence: `cep links ${names.map((n) => n.zh).join(', ')}; same text id in English`,
    });
  }
  return out;
}

// Each rule, and whether its gap is still open for a weapon.
const RULES = {
  skillName: { propose: skillName, open: (w) => !w.effect },
  operators: { propose: operators, open: (w, gaps) => gaps.unresolvedOperators.has(w.id) },
};

// Whether any rule has a gap to work on, so the text tables are only fetched when needed.
export const hasGaps = (data, gaps) => data.weapons.some((w) => Object.values(RULES).some((r) => r.open(w, gaps)));

export function candidates(data, facts) {
  return Object.entries(RULES).flatMap(([key, rule]) => rule.propose(data, facts).map((c) => ({ key, ...c })));
}

// Publishes accepted verdicts that the rules still support. Returns the data
// and report lines for candidates without a verdict, verdicts the rules no
// longer support, and deductions whose gap the game data has since filled.
export function applyVerdicts(data, proposed, verdicts, gaps) {
  const report = [];
  const byKey = new Map(proposed.map((c) => [`${c.id}|${c.key}`, c]));
  const weapons = data.weapons.map(({ deduced, ...w }) => {
    const published = {};
    for (const [key, rule] of Object.entries(RULES)) {
      const verdict = verdicts[w.id]?.[key];
      const candidate = byKey.get(`${w.id}|${key}`);
      if (!rule.open(w, gaps)) {
        if (verdict) report.push(`RESOLVED  weapon ${w.name}: ${key} has game data now (deduced ${verdict.value}); retire the verdict`);
        continue;
      }
      if (!verdict) {
        if (candidate) report.push(`CANDIDATE weapon ${w.name}: ${key} ${candidate.value} (${candidate.evidence}); needs a verdict`);
        continue;
      }
      if (candidate?.value !== verdict.value) {
        report.push(`REVIEW    weapon ${w.name}: ${key} verdict ${verdict.value}, rules now propose ${candidate?.value ?? 'nothing'}`);
        continue;
      }
      if (verdict.verdict === 'accepted') published[key] = { value: verdict.value, basis: verdict.basis };
    }
    return Object.keys(published).length ? { ...w, deduced: published } : w;
  });
  return { data: { ...data, weapons }, report };
}

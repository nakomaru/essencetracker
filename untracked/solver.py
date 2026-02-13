
import json
from itertools import combinations

def solve():
    with open('data.json', 'r', encoding='utf-8') as f:
        data = json.load(f)
    with open('inventory.json', 'r', encoding='utf-8') as f:
        inventory = json.load(f)

    weapons = data['weapons']
    locations = data['alluvium']
    attributes = ['Strength', 'Agility', 'Will', 'Intellect', 'Main Attribute']

    # Assign priorities based on projectgoal.txt
    for w in weapons:
        inv = inventory.get(w['name'], {'weapon_count': 0, 'essence_count': 0, 'desired': False})
        wc = inv.get('weapon_count', 0)
        ec = inv.get('essence_count', 0)
        desired = inv.get('desired', False)
        
        if desired:
            priority = 5
        elif ec == 0 and wc > 0:
            priority = 4
        elif ec == 0 and wc == 0:
            priority = 3
        elif ec > 0 and wc > ec:
            priority = 2
        elif ec > 0 and wc == ec:
            priority = 1
        else:
            priority = 1
        
        w['priority'] = priority

    results = []

    attr_combos = list(combinations(attributes, 3))

    for loc_name, loc_data in locations.items():
        loc_sec = set(loc_data['secondary'])
        loc_skill = set(loc_data['skill'])
        
        # 16 possible selections: 8 Secondary Stats, 8 Skill Stats
        selections = []
        for s in loc_sec:
            selections.append(('secondary', s))
        for k in loc_skill:
            selections.append(('skill', k))

        for sel_type, sel_val in selections:
            for attr_sel in attr_combos:
                valid_outcomes = []
                
                for w in weapons:
                    if w['priority'] <= 1:
                        continue
                        
                    if w['attr_stat'] not in attr_sel:
                        continue
                    
                    if sel_type == 'secondary':
                        # If we pick a Secondary, the weapon must match that secondary 
                        # AND its skill must be in the location's skill pool.
                        if w['sec_stat'] == sel_val and w['skill_stat'] in loc_skill:
                            valid_outcomes.append(w)
                    else:
                        # If we pick a Skill, the weapon must match that skill
                        # AND its secondary must be in the location's secondary pool.
                        if w['skill_stat'] == sel_val and w['sec_stat'] in loc_sec:
                            valid_outcomes.append(w)
                
                if valid_outcomes:
                    score = sum(w['priority'] for w in valid_outcomes)
                    distinct_attrs = len(set(w['attr_stat'] for w in valid_outcomes))
                    results.append({
                        'location': loc_name,
                        'selection': f"{'/'.join(attr_sel)} + {sel_val}",
                        'valid_count': len(valid_outcomes),
                        'score': score,
                        'distinct_attrs': distinct_attrs,
                        'outcomes': [w['name'] for w in valid_outcomes],
                        'priorities': [w['priority'] for w in valid_outcomes]
                    })

    # Ranking:
    # 1. valid_count (touches most unobtained)
    # 2. score (sum of priorities)
    # 3. distinct_attrs (tiebreaker)
    results.sort(key=lambda x: (x['valid_count'], x['score'], x['distinct_attrs']), reverse=True)

    print(f"{'Location':<25} | {'Selection':<55} | {'Count':<5} | {'Score':<5} | {'Attr':<4} | Outcomes")
    print("-" * 140)
    # Only show top 100
    seen_selections = set()
    output_count = 0
    for r in results:
        sel_key = (r['location'], r['selection'])
        if sel_key in seen_selections:
            continue
        seen_selections.add(sel_key)
        
        outcomes_str = ", ".join([f"{n}(P{p})" for n, p in zip(r['outcomes'], r['priorities'])])
        print(f"{r['location']:<25} | {r['selection']:<55} | {r['valid_count']:<5} | {r['score']:<5} | {r['distinct_attrs']:<4} | {outcomes_str}")
        output_count += 1
        if output_count >= 100:
            break

if __name__ == '__main__':
    solve()

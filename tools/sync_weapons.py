"""Sync weapons in data.json with the Endfield Talos Wiki (endfield.wiki.gg).

Fetches every page in Category:Weapons, reads the essence stats from the
{{Weapon skill}} template, reads max-rank stat values and skill text from the
rendered page, then merges the result into data.json and downloads any
missing weapon icons into images/.

Existing entries are updated in place and keep any extra keys (such as
"formerly"). Weapons missing from the wiki are reported, never deleted.

Location pools (data.json "alluvium") are maintained by hand: the wiki lists
each location's skill pool but not its secondary pool.

Usage: python tools/sync_weapons.py [--dry-run]
"""

import argparse
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data.json"
IMAGES = ROOT / "images"
API = "https://endfield.wiki.gg/api.php"
HEADERS = {"User-Agent": "endfield-essence-tracker-sync (github.com/nakomaru/essencetracker)"}

TYPE_ORDER = ["Greatsword", "Handcannon", "Arts Unit", "Sword", "Polearm"]
TYPE_NAMES = {"Great Sword": "Greatsword"}
SECONDARY_NAMES = {
    "ATK": "Attack Boost",
    "HP": "HP Boost",
    "ULT Efficiency": "Ultimate Gain Boost",
    "Critical Rate": "Critical Rate Boost",
    "Arts Intensity": "Arts Intensity Boost",
    "Treatment Efficiency": "Treatment Efficiency Boost",
}
FIELD_ORDER = ["name", "type", "rarity", "attr_stat", "attr_val", "sec_stat", "sec_val", "skill_stat", "skill_effect"]


def api(**params):
    url = API + "?" + urllib.parse.urlencode({**params, "format": "json"})
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS)) as r:
        return json.load(r)


def weapon_titles():
    res = api(action="query", list="categorymembers", cmtitle="Category:Weapons", cmlimit="500", cmnamespace="0")
    return [m["title"] for m in res["query"]["categorymembers"] if m["title"] != "Weapon"]


def page_text(title):
    """Returns (wikitext, rendered plain text) for a page."""
    res = api(action="parse", page=title, prop="wikitext|text", redirects="1")["parse"]
    rendered = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", res["text"]["*"], flags=re.S)
    rendered = html.unescape(re.sub(r"<[^>]+>", " ", rendered))
    rendered = re.sub(r"\s+", " ", rendered)
    rendered = re.sub(r" ([,.%])", r"\1", rendered)
    return res["wikitext"]["*"], rendered


def strip_grade(stat):
    return re.sub(r"\s*\[[SML]\]", "", stat).strip()


def tidy_effect(text):
    text = text.strip().lstrip(". ").strip()
    text = text.replace("＞", ">").replace("≥", ">=").replace("×", "x")
    text = re.sub(r"(\d+)\.00(?!\d)", r"\1", text)
    text = re.sub(r"\s*x\s*(?=Stacks|Wielder|\d)", " x ", text)
    text = re.sub(r"\[\s+", "[", text)
    return re.sub(r"\s+\]", "]", text)


def parse_weapon(title):
    wikitext, rendered = page_text(title)
    rarity = int(re.search(r"\|rarity\s*=\s*(\d)", wikitext).group(1))
    wtype = re.search(r"\|type\s*=\s*([^\n|}]+)", wikitext).group(1).strip()
    parts = re.search(r"\{\{Weapon skill\|([^}]*)\}\}", wikitext).group(1).split("|")
    # parts: [type, attribute, (secondary,) "Skill: Skill Name"]; 3-star weapons have no secondary.
    attr = strip_grade(parts[1])
    secondary = strip_grade(parts[2]) if len(parts) == 4 else None
    skill_stat, skill_name = (s.strip() for s in parts[-1].split(":", 1))

    start = rendered.find("Weapon Skills Ability Rank")
    section = rendered[start:rendered.find("Basic Info", start)]
    # Each rank opens with "<attribute> +N [<secondary label> +N]"; the last rank holds max values.
    stat_line = r"(%s) \+([\d.]+)" % re.escape(attr)
    if secondary:
        stat_line += r" ([A-Za-z ]+?) \+([\d.]+)%?"
    ranks = list(re.finditer(stat_line, section, re.I))
    if not ranks:
        raise ValueError("no skill ranks found")
    top = ranks[-1]

    return {
        "name": title,
        "type": TYPE_NAMES.get(wtype, wtype),
        "rarity": rarity,
        "attr_stat": attr,
        "attr_val": float(top.group(2)),
        "sec_stat": SECONDARY_NAMES.get(secondary, f"{secondary} Boost") if secondary else "None",
        "sec_val": round(float(top.group(4)), 1) if secondary else 0,
        "skill_stat": skill_stat,
        "skill_effect": f"{skill_name}: {tidy_effect(section[top.end():])}",
    }


def icon_filename(name):
    return "weapon_" + re.sub(r"[:']", "", name.lower()).replace(" ", "_") + ".png"


def download_icon(name):
    title = "File:" + name.replace(":", "") + " icon.png"
    pages = api(action="query", prop="imageinfo", iiprop="url", titles=title)["query"]["pages"]
    info = next(iter(pages.values())).get("imageinfo")
    if not info:
        return False
    with urllib.request.urlopen(urllib.request.Request(info[0]["url"], headers=HEADERS)) as r:
        (IMAGES / icon_filename(name)).write_bytes(r.read())
    return True


def sort_key(w):
    return (TYPE_ORDER.index(w["type"]), -w["rarity"], w["name"].lower())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="report changes without writing files")
    args = parser.parse_args()

    data = json.loads(DATA.read_text(encoding="utf-8"))
    current = {w["name"]: w for w in data["weapons"]}
    for w in data["weapons"]:
        for old in w.get("formerly", []):
            current[old] = w

    merged, seen, failures = {}, set(), []
    for title in weapon_titles():
        try:
            fresh = parse_weapon(title)
        except Exception as e:  # a malformed page must not abort the whole sync
            failures.append(f"{title}: {e}")
            continue
        old = current.get(title)
        if old is None:
            print(f"NEW      {title}")
            entry = fresh
        else:
            seen.add(id(old))
            changed = [k for k in FIELD_ORDER if old.get(k) != fresh[k]]
            if changed:
                print(f"UPDATED  {title}: {', '.join(changed)}")
            entry = {**old, **fresh}
        merged[entry["name"]] = {k: entry[k] for k in FIELD_ORDER} | {k: v for k, v in entry.items() if k not in FIELD_ORDER}
        time.sleep(0.2)

    for w in data["weapons"]:
        if id(w) not in seen and w["name"] not in merged:
            print(f"KEPT     {w['name']} (not found on the wiki)")
            merged[w["name"]] = w

    for f in failures:
        print(f"FAILED   {f}", file=sys.stderr)

    data["weapons"] = sorted(merged.values(), key=sort_key)
    missing_icons = [n for n in merged if not (IMAGES / icon_filename(n)).exists()]
    if args.dry_run:
        for n in missing_icons:
            print(f"ICON     {n} (missing)")
        return 1 if failures else 0

    DATA.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for n in missing_icons:
        print(f"ICON     {n}: {'downloaded' if download_icon(n) else 'not found on the wiki'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

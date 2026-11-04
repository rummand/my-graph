"""Check that every `sync` phrase in script.json is found in its scene's captions (build/plan.json). python3 checksync.py"""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
plan = json.load(open(os.path.join(HERE, "build", "plan.json")))
bad = 0
for s in plan["segments"]:
    caps = [c["t"].lower() for c in s["caps"]]
    items = []
    for k in ("points", "moves", "lines", "rows", "phones"):
        items += [x for x in s.get(k) or [] if isinstance(x, dict)]
    if isinstance(s.get("sub"), dict): items.append(s["sub"])
    for it in items:
        if it.get("sync") and not any(it["sync"].lower() in c for c in caps):
            bad += 1; print(f'{s["id"]}: no caption has "{it["sync"]}"')
print("ok" if not bad else f"{bad} missing")

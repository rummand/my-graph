#!/usr/bin/env python3
"""Keeps MyGraphMac/Resources/Mac.xcstrings in step with the L("…") calls in the Mac sources.

    python3 scripts/strings.py            # adds new keys, removes unused ones, lists keys without Danish
    python3 scripts/strings.py --check    # exit 1 when a key has no Danish translation

Interpolations become the format specifiers String(localized:) uses: %lld for whole numbers, %@ for text. Which
expressions are numbers is decided by name (see NUMERIC); keep those names when adding strings.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CATALOG = os.path.join(ROOT, "MyGraphMac", "Resources", "Mac.xcstrings")
NUMERIC = re.compile(r"(^n$|^waiting$|count$|lastSent$|\.waiting$|^r\.waiting$|^chats\.count$)")


def swift_files():
    for base in ("MyGraphMac",):
        for d, _, files in os.walk(os.path.join(ROOT, base)):
            for f in files:
                if f.endswith(".swift"):
                    yield os.path.join(d, f)


def literal_end(s, i):
    """Index just past the closing quote of the Swift string literal starting at s[i] == '"'."""
    j = i + 1
    while j < len(s):
        c = s[j]
        if c == "\\":
            if s[j + 1] == "(":
                depth, k = 1, j + 2
                while depth:
                    if s[k] == "(":
                        depth += 1
                    elif s[k] == ")":
                        depth -= 1
                    elif s[k] == '"':
                        k = literal_end(s, k) - 1
                    k += 1
                j = k
                continue
            j += 2
            continue
        if c == '"':
            return j + 1
        j += 1
    raise ValueError("unterminated literal")


def to_key(lit):
    out, j = [], 0
    body = lit[1:-1]
    while j < len(body):
        c = body[j]
        if c == "\\" and body[j + 1] == "(":
            depth, k = 1, j + 2
            while depth:
                if body[k] == "(":
                    depth += 1
                elif body[k] == ")":
                    depth -= 1
                elif body[k] == '"':
                    k = literal_end(body, k) - 1
                k += 1
            expr = body[j + 2 : k - 1].strip()
            out.append("%lld" if NUMERIC.search(expr) else "%@")
            j = k
            continue
        if c == "\\":
            nxt = body[j + 1]
            out.append({"n": "\n", "t": "\t", '"': '"', "\\": "\\"}.get(nxt, nxt))
            j += 2
            continue
        out.append(c)
        j += 1
    return "".join(out)


def keys():
    found = {}
    pat = re.compile(r'(?<![A-Za-z0-9_])L\(\s*"')
    pat2 = re.compile(r'LocalizedStringResource\(\s*"')
    for path in swift_files():
        s = open(path, encoding="utf-8").read()
        for p in (pat, pat2):
            for m in p.finditer(s):
                start = m.end() - 1
                end = literal_end(s, start)
                found.setdefault(to_key(s[start:end]), os.path.relpath(path, ROOT))
    return found


def main():
    found = keys()
    cat = json.load(open(CATALOG, encoding="utf-8")) if os.path.exists(CATALOG) else {"sourceLanguage": "en", "strings": {}, "version": "1.0"}
    strings = cat.setdefault("strings", {})
    extra = {}
    if len(sys.argv) > 2 and sys.argv[1] == "--merge":
        extra = json.load(open(sys.argv[2], encoding="utf-8"))
    for k in list(strings):
        if k not in found:
            del strings[k]
    missing = []
    for k in sorted(found):
        entry = strings.setdefault(k, {})
        if k in extra:
            entry["localizations"] = {"da": {"stringUnit": {"state": "translated", "value": extra[k]}}}
        if not entry.get("localizations", {}).get("da"):
            missing.append(k)
    cat["strings"] = dict(sorted(strings.items()))
    if "--check" not in sys.argv:
        with open(CATALOG, "w", encoding="utf-8") as f:
            json.dump(cat, f, ensure_ascii=False, indent=2, sort_keys=False)
            f.write("\n")
    for k in missing:
        print("missing da:", json.dumps(k, ensure_ascii=False), "(" + found[k] + ")")
    print(f"{len(found)} keys, {len(missing)} without Danish")
    if "--check" in sys.argv and missing:
        sys.exit(1)


if __name__ == "__main__":
    main()

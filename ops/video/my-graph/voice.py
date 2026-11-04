"""Voice "My Graph, explained": python3 ops/video/my-graph/voice.py

After Blip's ops/video/voice.py (itself after Nexus's ops/video-1131): Kokoro on the Mac's local audio server
(http://127.0.0.1:8093/v1/audio/speech, mlx-community/Kokoro-82M-bf16). Each sentence is spoken on its own, trimmed of
the silence Kokoro leaves around it, and joined with a fixed pause, so every sentence's start and end is known
exactly and the captions are timed from the real audio. Inside a sentence a caption breaks at `|` (or at commas and
colons, at most 9 words) and is timed by its share of the sentence's letters.

Writes build/audio/<id>.wav and build/plan.json. Sentences are cached by their words in build/audio/sentences/, so a
changed line is the only one voiced again.

    python3 ops/video/my-graph/voice.py
    AUDIO_URL=http://127.0.0.1:8093/v1/audio/speech python3 ops/video/my-graph/voice.py
"""
import array, hashlib, json, os, re, subprocess, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.environ.get("BUILD", os.path.join(HERE, "build"))
CACHE = os.path.join(BUILD, "audio", "sentences")
URL = os.environ.get("AUDIO_URL", "http://127.0.0.1:8093/v1/audio/speech")
FFMPEG = os.environ.get("FFMPEG", "/opt/homebrew/bin/ffmpeg")
RATE = 24000
GAP = 0.36          # between sentences
THRESH = 300        # 16-bit amplitude counted as sound
script = json.load(open(os.path.join(HERE, "script.json")))
os.makedirs(os.path.join(BUILD, "audio"), exist_ok=True)
os.makedirs(CACHE, exist_ok=True)


def sentences(text):
    # a `|` may sit between sentences; never split after a title ("Ms. Karen Hansen" is one sentence)
    return [s for s in re.split(r"(?<!\bMs\.)(?<!\bMr\.)(?<!\bDr\.)(?<=[.?!])(?:\s*\|)?\s+(?=[A-Z\"“])", text.strip()) if s]


def spoken(s):
    return re.sub(r"\s*\|\s*", " ", s).strip()


def said(s):
    # `sayAs` tells the voice how to say a word the captions keep as written ("Aula" -> "Owla")
    for k, v in script.get("sayAs", {}).items():
        s = re.sub(r"(?<![\w-])" + re.escape(k) + r"(?![\w-])", v, s)
    return s


def chunks(sentence):
    if "|" in sentence:  # the script marks its own caption breaks
        return [p.strip() for p in sentence.split("|") if p.strip()]
    parts = re.split(r"(?<=[,:;])\s+", sentence)
    out = []
    soft = {"with", "and", "from", "that", "of", "to", "in", "on", "for", "are", "is", "or", "but", "so", "when", "where", "which", "who"}
    for p in parts:
        w = p.split()
        while len(w) > 9:
            # split near the middle, before a joining word when there is one
            mid = len(w) // 2
            k = sorted(range(3, len(w) - 2), key=lambda k: (w[k].lower() not in soft, abs(k - mid)))[0]
            out.append(" ".join(w[:k])); w = w[k:]
        if w:
            if out and len(w) <= 2 and len(out[-1].split()) <= 6:
                out[-1] += " " + " ".join(w)
            else:
                out.append(" ".join(w))
    if len(out) > 1 and len(out[0].split()) <= 2 and len(out[0].split()) + len(out[1].split()) <= 9:
        out[1] = out[0] + " " + out[1]; out = out[1:]
    return out


def speak(text, path):
    body = json.dumps({"model": script["model"], "input": text, "voice": script["voice"],
                       "response_format": "wav", "speed": script["speed"]}).encode()
    req = urllib.request.Request(URL, data=body, headers={"content-type": "application/json"})
    raw = urllib.request.urlopen(req, timeout=300).read()
    tmp = path + ".src.wav"
    open(tmp, "wb").write(raw)
    pcm = subprocess.run([FFMPEG, "-v", "error", "-i", tmp, "-f", "s16le", "-ac", "1", "-ar", str(RATE), "-"],
                         capture_output=True, check=True).stdout
    os.remove(tmp)
    a = array.array("h"); a.frombytes(pcm)
    i = next((k for k, v in enumerate(a) if abs(v) > THRESH), 0)
    j = len(a) - next((k for k, v in enumerate(reversed(a)) if abs(v) > THRESH), 0)
    i = max(0, i - int(0.03 * RATE)); j = min(len(a), j + int(0.08 * RATE))
    a = a[i:j]
    open(path, "wb").write(a.tobytes())
    return len(a) / RATE


plan = {"segments": []}
for seg in script["segments"]:
    out = array.array("h"); caps = []; t = 0.0
    for n, s in enumerate(sentences(seg["say"])):
        key = hashlib.sha1(f'{script["voice"]}|{script["speed"]}|{said(spoken(s))}'.encode()).hexdigest()[:12]
        p = os.path.join(CACHE, f"{key}.pcm")
        if not os.path.exists(p):
            speak(said(spoken(s)), p)
        a = array.array("h"); a.frombytes(open(p, "rb").read())
        if n:
            out.extend([0] * int(GAP * RATE)); t += GAP
        d = len(a) / RATE
        cs = chunks(s); total = sum(len(c) for c in cs); u = t
        for c in cs:
            dur = d * len(c) / total
            caps.append({"t": c, "a": round(u, 3), "b": round(u + dur, 3)}); u += dur
        out.extend(a); t += d
    wav = os.path.join(BUILD, "audio", f'{seg["id"]}.wav')
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "s16le", "-ar", str(RATE), "-ac", "1", "-i", "-", wav],
                   input=out.tobytes(), check=True)
    plan["segments"].append({**seg, "say": spoken(seg["say"]), "audio": round(t, 3), "caps": caps})
    print(f'{seg["id"]:16s} {t:6.2f}s  {len(spoken(seg["say"]).split())} words', flush=True)

json.dump(plan, open(os.path.join(BUILD, "plan.json"), "w"), indent=1, ensure_ascii=False)
words = sum(len(spoken(s["say"]).split()) for s in script["segments"])
print(f"voice {sum(s['audio'] for s in plan['segments'])/60:.2f} min, {words} words", file=sys.stderr)

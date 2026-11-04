// Render "My Graph, explained" (after Blip's ops/video/render.mjs, itself after Nexus's ops/video-1131): every frame is
// drawn by the browser (scenes.html, window.seek(t)), shot 30 times a second by Playwright's Chromium into ffmpeg.
//
//   node ops/video/my-graph/shots.mjs              # the screens (needs My Graph running on :3917)
//   python3 ops/video/my-graph/voice.py            # build/audio/*.wav, build/plan.json (needs the audio server on :8093)
//   nice -n 10 node ops/video/my-graph/render.mjs  # build/seg/*.mp4 -> build/my-graph-explained.mp4 (+ .srt, .vtt, poster, chapters)
//   STILLS=1 node ops/video/my-graph/render.mjs    # three PNGs per scene instead, to look at first
//   ONLY=04-steps,04-web node ops/video/my-graph/render.mjs   # re-render these scenes, then join everything again
//   JOIN=1 node ops/video/my-graph/render.mjs      # only join the scenes already rendered
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build");
const FFMPEG = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const SCRIPT = JSON.parse(fs.readFileSync(path.join(HERE, "script.json"), "utf8"));
const OUT = SCRIPT.out;
const FPS = 30;
const plan = JSON.parse(fs.readFileSync(path.join(BUILD, "plan.json"), "utf8"));

// Holds around the voice, per kind of scene: [before it speaks, after it stops].
const HOLD = { title: [3.2, 1.6], chapter: [0.8, 1.3], screen: [1.0, 1.2], phones: [1.2, 1.6], statement: [1.0, 2.0], close: [1.0, 4.0] };
const timing = {};
let clock = 0;
for (const s of plan.segments) {
  const [lead, tail] = s.hold ?? HOLD[s.scene];
  const frames = Math.round((lead + s.audio + tail) * FPS);
  timing[s.id] = { lead, duration: frames / FPS, frames, start: clock };
  clock += frames / FPS;
}
fs.writeFileSync(path.join(BUILD, "timing.json"), JSON.stringify(timing, null, 1));
console.log(`planned ${(clock / 60).toFixed(2)} min, ${plan.segments.length} scenes`);

const TYPES = { ".html": "text/html", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg" };
const server = http.createServer((req, res) => {
  const p = path.join(HERE, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(HERE) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}/scenes.html`;

const run = (args) => { const r = spawnSync(FFMPEG, ["-v", "error", "-y", ...args], { stdio: "inherit" }); if (r.status) throw new Error("ffmpeg " + args.join(" ")); };
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
fs.mkdirSync(path.join(BUILD, "seg"), { recursive: true });
fs.mkdirSync(path.join(BUILD, "stills"), { recursive: true });

if (!process.env.JOIN) {
  const browser = await chromium.launch();   // one Chromium at a time, kind to the Mac
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("page:", e.message));
  for (const s of plan.segments) {
    if (only && !only.includes(s.id)) continue;
    await page.goto(`${base}?seg=${s.id}`);
    await page.evaluate(() => window.ready);
    const { frames, lead, duration } = timing[s.id];
    if (process.env.STILLS) {
      const ts = process.env.AT ? process.env.AT.split(",").map(Number) : [lead + s.audio * 0.2, lead + s.audio * 0.6, duration - 1.0];
      for (const t of ts) {
        await page.evaluate((t) => window.seek(t), t);
        await page.screenshot({ path: path.join(BUILD, "stills", `${s.id}-${t.toFixed(1)}.png`) });
      }
      console.log("stills", s.id);
      continue;
    }
    const out = path.join(BUILD, "seg", `${s.id}.mp4`);
    const ff = spawn(FFMPEG, ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), out], { stdio: ["pipe", "inherit", "inherit"] });
    const t0 = Date.now();
    for (let f = 0; f < frames; f++) {
      await page.evaluate((t) => window.seek(t), f / FPS);
      const buf = await page.screenshot({ type: "jpeg", quality: 92 });
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    }
    ff.stdin.end();
    await new Promise((r) => ff.on("close", r));
    console.log(`${s.id.padEnd(16)} ${duration.toFixed(2)}s  ${frames} frames  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  await browser.close();
}
server.close();
if (process.env.STILLS) process.exit(0);
const missing = plan.segments.filter((s) => !fs.existsSync(path.join(BUILD, "seg", `${s.id}.mp4`)));
if (missing.length) { console.log("not joined yet, scenes missing:", missing.map((s) => s.id).join(" ")); process.exit(0); }

// Sound: each scene's voice after its lead, padded to the scene's exact length; one track at -16 LUFS.
const ins = [], fc = [];
plan.segments.forEach((s, i) => {
  const { lead, duration } = timing[s.id];
  ins.push("-i", path.join(BUILD, "audio", `${s.id}.wav`));
  fc.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(lead * 1000)}:all=1,apad,atrim=0:${duration.toFixed(4)}[a${i}]`);
});
fc.push(plan.segments.map((_, i) => `[a${i}]`).join("") + `concat=n=${plan.segments.length}:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`);
run([...ins, "-filter_complex", fc.join(";"), "-map", "[aout]", "-c:a", "pcm_s16le", path.join(BUILD, "voice.wav")]);

// Captions: an SRT (sidecar and soft track) and a WebVTT for the web player.
const stamp = (x, sep) => { const ms = Math.round(x * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`; };
const cues = [];
for (const s of plan.segments) {
  const { start, lead } = timing[s.id];
  s.caps.forEach((c, i) => {
    const next = s.caps[i + 1];
    const end = next && next.a - c.b < .5 ? next.a : c.b + .25;
    cues.push({ a: start + lead + c.a, b: start + lead + end, t: c.t, seg: s.id });
  });
}
fs.writeFileSync(path.join(BUILD, `${OUT}.srt`), cues.map((c, i) => `${i + 1}\n${stamp(c.a, ",")} --> ${stamp(c.b, ",")}\n${c.t}\n`).join("\n"));
fs.writeFileSync(path.join(BUILD, `${OUT}.vtt`), "WEBVTT\n\n" + cues.map((c) => `${stamp(c.a, ".")} --> ${stamp(c.b, ".")}\n${c.t}\n`).join("\n"));

// Chapters: where each chapter card starts (and the opening at 0).
const chapters = plan.segments.filter((s) => s.scene === "chapter").map((s) => ({ id: s.chapter, title: s.title, start: +timing[s.id].start.toFixed(2) }));
fs.writeFileSync(path.join(BUILD, `${OUT}-chapters.json`), JSON.stringify({ title: SCRIPT.title, duration: +clock.toFixed(2), chapters }, null, 1));
const meta = [";FFMETADATA1", `title=${SCRIPT.title}`];
const marks = [{ title: "Opening", start: 0 }, ...chapters];
// Timebase 1/1000000: ffmpeg 9 mangles chapters given in milliseconds, and 1/48000000 overflows past ~45 s.
const TB = 1e6;
marks.forEach((c, i) => meta.push("[CHAPTER]", `TIMEBASE=1/${TB}`, `START=${Math.round(c.start * TB)}`, `END=${Math.round((marks[i + 1]?.start ?? clock) * TB)}`, `title=${c.title}`));
fs.writeFileSync(path.join(BUILD, "chapters.ffmeta"), meta.join("\n") + "\n");

const list = path.join(BUILD, "seg", "list.txt");
fs.writeFileSync(list, plan.segments.map((s) => `file '${path.join(BUILD, "seg", s.id + ".mp4")}'`).join("\n") + "\n");
const final = path.join(BUILD, `${OUT}.mp4`);
const joined = path.join(BUILD, "joined.mp4");
run(["-f", "concat", "-safe", "0", "-i", list, "-i", path.join(BUILD, "voice.wav"), "-i", path.join(BUILD, `${OUT}.srt`),
  "-map", "0:v", "-map", "1:a", "-map", "2:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-c:s", "mov_text",
  "-metadata:s:s:0", "language=eng", "-metadata:s:a:0", "language=eng", "-t", clock.toFixed(3), joined]);
// Chapters are NOT embedded: ffmpeg 9.0's MP4 muxer writes its QuickTime chapter track at a 48 MHz timescale, so any
// chapter longer than ~44.7 s overflows ("Application provided duration … is invalid") and players get garbage.
// The chapters live in <out>-chapters.json (the web player) and chapters.ffmeta; when ffmpeg is fixed, add
// `"-f", "ffmetadata", "-i", chapters.ffmeta, "-map_chapters", "1"` here.
run(["-i", joined, "-map", "0:v", "-map", "0:a", "-map", "0:s", "-map_chapters", "-1", "-c", "copy",
  "-metadata", `title=${SCRIPT.title}`, "-movflags", "+faststart", final]);
fs.rmSync(joined);

// Poster: the frame the script names.
const pst = timing[SCRIPT.poster.seg];
run(["-ss", (pst.start + SCRIPT.poster.at).toFixed(2), "-i", final, "-frames:v", "1", path.join(BUILD, `${OUT}-poster.png`)]);
console.log("done", final, (fs.statSync(final).size / 1e6).toFixed(1), "MB", (clock / 60).toFixed(2), "min");

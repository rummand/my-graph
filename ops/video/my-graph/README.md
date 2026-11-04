# My Graph, explained

The film behind Documentation in the app (`/docs`, `/docs/video`): about 16 minutes, English, every part of My Graph
with the demo family. Built the way Blip makes its films (`~/_code/blip/blip/ops/video`), which in turn follows Nexus's
house format (`~/_code/Nexus/ops/video-1131/video_script.md`): a script of segments, Kokoro for the voice, every frame
drawn by the browser, ffmpeg to join it, −16 LUFS, a soft subtitle track and a sidecar SRT.

## Files

- `script.json`: the film. Each segment has a `scene` (`title`, `chapter`, `screen`, `phones`, `statement`, `close`),
  its words on screen (`title`, `points`, `lines`, `rows`) and what is said (`say`; `|` marks a caption break). A
  point's `sync` is a phrase from the voice; it appears when the voice gets there. A `screen` names a screenshot
  (`shot`) and its camera `moves`: each move zooms to a `view` (`[x, y, width]` in the page's CSS pixels, or a mark's
  name) and draws a cobalt `box` around a mark or a rectangle. `sayAs` tells the voice how to say a word the captions
  keep as written (Aula, Bellahøj, mux).
- `da.json`: the Danish words for the written guides (title and text per segment).
- `shots.mjs`: signs in to a running My Graph as Anna (Mikkel for the Danish screens), opens every screen the film
  uses and saves it at 2x to `build/shots/<name>.png` with `<name>.json` holding the marks (boxes of named elements).
  The demo household is shared with the end-to-end tests, so rows they leave behind are hidden before each picture,
  and every picture checks the language and theme (another session may switch Anna's settings mid-run).
- `ios/`: the iPhone app's screens, from the iOS work.
- `voice.py`: Kokoro (`mlx-community/Kokoro-82M-bf16`, `af_heart`, speed 0.9) through the local audio server
  (`http://127.0.0.1:8093/v1/audio/speech`), one sentence at a time, trimmed and joined with a fixed pause, so the
  captions are timed from the real audio. Writes `build/audio/<id>.wav` and `build/plan.json`. Sentences are cached by
  their words, so a changed line is the only one voiced again.
- `scenes.html`: the scenes, in DESIGN.md's look (lichen ground, ink, cobalt, Schibsted Grotesk, the family's own
  colours). `scenes.html?seg=<id>` builds one scene and `window.seek(t)` draws it at second `t`.
- `render.mjs`: timing (holds per kind of scene), 30 frames a second from Playwright's Chromium into ffmpeg, the voice
  track at −16 LUFS, captions (SRT and WebVTT, plus a soft track in the MP4), chapters (`-chapters.json`), the MP4
  and the poster. Chapters are not embedded in the MP4: ffmpeg 9.0's MP4 muxer overflows chapters longer than ~45 s
  (see the comment in `render.mjs`).
- `checksync.py`: checks that every `sync` phrase is in its scene's captions (run it after `voice.py`).
- `guides.mjs`: makes the app's Documentation data from the film: `src/lib/docs/film.ts` (files, chapters, transcript,
  the media allow-list), `src/lib/docs/guides-{en,da}.ts` (the guides' words), and `build/docs/` (every file the media
  route serves). `--local` copies them into the local `DOCS_MEDIA_DIR`.
- `publish.mjs`: uploads `build/docs/` to a running server through `POST /api/docs/media`.

Everything in `build/` is git-ignored.

## Make it

```sh
node ops/video/my-graph/shots.mjs                  # needs My Graph on http://localhost:3917 (BASE=… otherwise)
python3 ops/video/my-graph/voice.py                # needs the audio server on 127.0.0.1:8093
python3 ops/video/my-graph/checksync.py
STILLS=1 node ops/video/my-graph/render.mjs        # three PNGs per scene in build/stills/, to look at first
nice -n 10 node ops/video/my-graph/render.mjs      # about an hour on the Mac Studio, one Chromium at a time
node ops/video/my-graph/guides.mjs --local         # app data + local media; then /docs/video plays on :3917
```

Re-render one chapter: change its segments in `script.json`, then

```sh
python3 ops/video/my-graph/voice.py                # only changed sentences are voiced again
ONLY=04-steps,04-web nice -n 10 node ops/video/my-graph/render.mjs   # those scenes, then join everything again
node ops/video/my-graph/guides.mjs --local
```

If a line's length changed, every later scene moves: the join, captions, chapters and transcript are all rebuilt from
the new timing, so nothing else needs re-rendering. One screen again: `ONLY=today node ops/video/my-graph/shots.mjs`.

## Publish

The server keeps the media in `DOCS_MEDIA_DIR` (default `<UPLOAD_DIR>/docs`, on Railway `/data/uploads/docs` on the
volume) and accepts uploads only with `Authorization: Bearer $DOCS_UPLOAD_TOKEN` (16 characters or more), for the
allow-listed names in `src/lib/docs/film.ts`.

```sh
railway variables --set DOCS_UPLOAD_TOKEN=$(openssl rand -hex 24)   # once; the app redeploys
DOCS_UPLOAD_TOKEN=… node ops/video/my-graph/publish.mjs https://web-production-1858e.up.railway.app
```

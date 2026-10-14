# Audio credits

- `engine_loop.wav` — "Racing car engine sound loops" (loop_0) by **domasx2**,
  https://opengameart.org/node/5633 — **CC0** (public domain dedication).
  Cut from a public-domain race car recording. Pitched in real time by the game.

- `radio/en/*.mp3` — team radio voice, English: generated with **Kokoro-82M**
  (hexgrad, **Apache-2.0**), voice `bm_george`, by `scripts/radio/generate.py`.
- `radio/ko/*.mp3` — team radio voice, Korean: generated with **MeloTTS**
  (MyShell.ai, **MIT**), speaker `KR`, by the same script.
  No real F1 radio recordings are used. The radio beeps, band filter and static are
  synthesized at runtime.

- `b206/*` — the players' own recordings (b206 voice pack): `engine.mp3` is the
  engine loop while the pack is on, the `.m4a` clips are the extra team radio
  shouts. Not redistributable third-party material; supplied by the project owner.

Everything else (tyre squeal, wind, synth layers) is synthesized at runtime with the Web Audio API.

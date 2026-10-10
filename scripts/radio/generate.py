"""
Records the team radio clips with open-source TTS, run once at development
time (the game only plays the files, the same on every device):

    # English: Kokoro-82M (Apache-2.0), British male voice bm_george
    python -m venv .tmp/tts && .tmp/tts/Scripts/pip install kokoro soundfile
    .tmp/tts/Scripts/python scripts/radio/generate.py en

    # Korean: MeloTTS (MIT), Python 3.10; on Windows its g2pkk wants the
    # 'eunjeon' package (needs a compiler): scripts/radio/eunjeon.py stands in
    # (mecab-python3 + python-mecab-ko-dic, installed with --no-deps)
    PYTHONPATH=scripts/radio .tmp/melo/python scripts/radio/generate.py ko

Clips: every fixed piece of text in src/audio/radio-lines.json (the text
between {placeholders}), the numbers 0-99 and "point". File name =
public/audio/radio/<lang>/<fnv1a("<lang>:<text>")>.mp3, the same key the
game computes (src/audio/TeamRadio.ts). Existing files are kept, so only new
lines are recorded; files no line uses any more are removed.
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
LANG = sys.argv[1] if len(sys.argv) > 1 else 'en'
OUT = ROOT / 'public' / 'audio' / 'radio' / LANG
SR_OUT = 22050

EN_ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split()
EN_TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split()
KO_DIGITS = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구']


def number_text(n: int) -> str:
    if LANG == 'en':
        if n < 20:
            return EN_ONES[n]
        t, u = divmod(n, 10)
        return EN_TENS[t - 2] + ('' if u == 0 else ' ' + EN_ONES[u])
    if n == 0:
        return '영'
    t, u = divmod(n, 10)
    return ('' if t == 0 else ('' if t == 1 else KO_DIGITS[t]) + '십') + KO_DIGITS[u]


def chunk_key(text: str) -> str:
    """Same as clipText() in TeamRadio.ts: trimmed, no leading punctuation."""
    return re.sub(r'^[\s.,!?]+', '', text).strip()


def fnv1a(s: str) -> str:
    h = 0x811C9DC5
    for b in s.encode('utf-8'):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f'{h:08x}'


def clips() -> list[str]:
    data = json.loads((ROOT / 'src' / 'audio' / 'radio-lines.json').read_text(encoding='utf-8'))
    out: list[str] = []
    for line in data['lines'].values():
        for piece in re.split(r'\{\w+\}', line[LANG]):
            k = chunk_key(piece)
            if k and k not in out:
                out.append(k)
    out.append(data['point'][LANG])
    out += [number_text(n) for n in range(100)]
    return out


def tidy(audio: np.ndarray, sr: int) -> np.ndarray:
    """Trims leading / trailing silence, normalizes, resamples to SR_OUT."""
    audio = audio.astype(np.float32)
    level = np.abs(audio)
    on = np.where(level > 0.02 * level.max())[0]
    if len(on):
        pad = int(0.03 * sr)
        audio = audio[max(on[0] - pad, 0): on[-1] + pad]
    audio = audio / max(np.abs(audio).max(), 1e-6) * 0.9
    if sr != SR_OUT:
        t = np.arange(0, len(audio) * SR_OUT / sr) * sr / SR_OUT
        audio = np.interp(t, np.arange(len(audio)), audio).astype(np.float32)
    return audio


def synth():
    if LANG == 'en':
        from kokoro import KPipeline
        pipe = KPipeline(lang_code='b')
        return lambda text: (np.concatenate([a.numpy() if hasattr(a, 'numpy') else a for _, _, a in pipe(text, voice='bm_george', speed=1.05)]), 24000)
    from melo.api import TTS
    model = TTS(language='KR', device='cpu')
    spk = model.hps.data.spk2id['KR']
    return lambda text: (model.tts_to_file(text, spk, None, speed=1.1, quiet=True), model.hps.data.sampling_rate)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    wanted = {f'{fnv1a(LANG + ":" + t)}.mp3' for t in clips()}
    for f in OUT.glob('*.mp3'):
        if f.name not in wanted:
            f.unlink()
            print('  removed unused', f.name)
    todo = [t for t in clips() if not (OUT / f'{fnv1a(LANG + ":" + t)}.mp3').exists()]
    print(f'{LANG}: {len(todo)} clips to record')
    if not todo:
        return
    say = synth()
    for text in todo:
        audio, sr = say(text)
        sf.write(OUT / f'{fnv1a(LANG + ":" + text)}.mp3', tidy(np.asarray(audio), sr), SR_OUT, format='MP3')
        print(' ', text)


if __name__ == '__main__':
    main()

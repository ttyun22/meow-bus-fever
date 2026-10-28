#!/usr/bin/env python3
"""Generate the local, royalty-free looping BGM for 猫咪巴士大疏通.

No external samples or links are used: every note is synthesized here with
plain Python math.  The result is a bright, bouncy 16-bar cartoon loop
(114 BPM, C major pentatonic) written to assets/bgm-cat-bus.wav.

Run:
    python3 tools/generate-bgm.py

The file is mono / 22.05 kHz / 16-bit so it stays small enough for an H5
game while still keeping the glockenspiel and shaker crisp.
"""
from __future__ import annotations

import math
import random
import struct
import wave
from pathlib import Path

SR = 22050
BPM = 114
BEAT = 60.0 / BPM
BAR = BEAT * 4
BARS = 16
LOOP = BARS * BAR
TAIL = 2.0
TOTAL = LOOP + TAIL
N = int(TOTAL * SR)

random.seed(20261026)

buf = [0.0] * N


def midi_hz(note: float) -> float:
    return 440.0 * (2.0 ** ((note - 69.0) / 12.0))


def add(when: float, samples: list[float], gain: float = 1.0) -> None:
    start = int(when * SR)
    if start >= N:
        return
    end = min(N, start + len(samples))
    for i in range(start, end):
        buf[i] += samples[i - start] * gain


def pluck(freq: float, dur: float = 0.42, bright: float = 0.55) -> list[float]:
    """A soft toy-ukulele / pizzicato pluck (additive, gentle attack)."""
    n = int(dur * SR)
    out = [0.0] * n
    harmonics = (
        (1.0, 0.68, 4.6),
        (2.0, 0.28, 7.0),
        (3.0, 0.12 * bright, 10.0),
        (4.0, 0.06 * bright, 14.0),
    )
    phases = [random.random() * math.tau for _ in harmonics]
    for i in range(n):
        t = i / SR
        attack = min(1.0, t * 900.0)
        s = 0.0
        for (mult, amp, decay), phase in zip(harmonics, phases):
            s += amp * math.sin(math.tau * freq * mult * t + phase) * math.exp(-t * decay)
        out[i] = s * attack
    # Very short fade-out to avoid a click at the buffer end.
    fade = min(n, int(0.006 * SR))
    for i in range(fade):
        out[n - fade + i] *= 1.0 - i / fade
    return out


def marimba(freq: float, dur: float = 0.34) -> list[float]:
    """Round wooden mallet tone: fundamental + strong 4th partial."""
    n = int(dur * SR)
    out = [0.0] * n
    for i in range(n):
        t = i / SR
        attack = min(1.0, t * 1500.0)
        s = (
            math.sin(math.tau * freq * t) * math.exp(-t * 6.5)
            + 0.32 * math.sin(math.tau * freq * 3.95 * t) * math.exp(-t * 13.0)
            + 0.10 * math.sin(math.tau * freq * 9.1 * t) * math.exp(-t * 24.0)
        )
        out[i] = s * attack
    return out


def glock(freq: float, dur: float = 0.55) -> list[float]:
    """Bright toy glockenspiel: sine partials with fast metallic decay."""
    n = int(dur * SR)
    out = [0.0] * n
    for i in range(n):
        t = i / SR
        attack = min(1.0, t * 2200.0)
        s = (
            math.sin(math.tau * freq * t) * math.exp(-t * 4.5)
            + 0.35 * math.sin(math.tau * freq * 2.76 * t) * math.exp(-t * 8.0)
            + 0.14 * math.sin(math.tau * freq * 5.40 * t) * math.exp(-t * 15.0)
        )
        out[i] = s * attack
    return out


def bass(freq: float, dur: float = 0.30) -> list[float]:
    """Warm, short bass note; low-passed by using only low harmonics."""
    n = int(dur * SR)
    out = [0.0] * n
    for i in range(n):
        t = i / SR
        attack = min(1.0, t * 700.0)
        s = (
            math.sin(math.tau * freq * t) * math.exp(-t * 7.5)
            + 0.30 * math.sin(math.tau * freq * 2.0 * t) * math.exp(-t * 11.0)
            + 0.08 * math.sin(math.tau * freq * 3.0 * t) * math.exp(-t * 16.0)
        )
        out[i] = s * attack
    return out


def shaker(dur: float = 0.055) -> list[float]:
    n = int(dur * SR)
    out = [0.0] * n
    prev = 0.0
    for i in range(n):
        t = i / SR
        white = random.uniform(-1.0, 1.0)
        # One-pole difference = bright, airy high-passed noise.
        hp = white - prev * 0.85
        prev = white
        out[i] = hp * math.exp(-t * 72.0)
    return out


def woodblock(freq: float = 1180.0, dur: float = 0.07) -> list[float]:
    n = int(dur * SR)
    out = [0.0] * n
    for i in range(n):
        t = i / SR
        s = math.sin(math.tau * freq * t) * math.exp(-t * 55.0)
        s += 0.18 * random.uniform(-1.0, 1.0) * math.exp(-t * 90.0)
        out[i] = s
    return out


def kick(dur: float = 0.20) -> list[float]:
    n = int(dur * SR)
    out = [0.0] * n
    phase = 0.0
    for i in range(n):
        t = i / SR
        freq = 92.0 * math.exp(-t * 13.0) + 44.0
        phase += math.tau * freq / SR
        out[i] = math.sin(phase) * math.exp(-t * 15.0)
    return out


# ---------------------------------------------------------------- harmony
# 16 bars: C / Am / F / G, then C / Em / F / G, repeated with a lift.
PROGRESSION = [
    ("C", 48, [60, 64, 67, 72]),
    ("Am", 45, [57, 60, 64, 69]),
    ("F", 41, [53, 57, 60, 65]),
    ("G", 43, [55, 59, 62, 67]),
    ("C", 48, [60, 64, 67, 72]),
    ("Em", 40, [52, 55, 59, 64]),
    ("F", 41, [53, 57, 60, 65]),
    ("G", 43, [55, 59, 62, 67]),
    ("C", 48, [60, 64, 67, 72]),
    ("Am", 45, [57, 60, 64, 69]),
    ("F", 41, [53, 57, 60, 65]),
    ("G", 43, [55, 59, 62, 67]),
    ("C", 48, [60, 64, 67, 72]),
    ("Em", 40, [52, 55, 59, 64]),
    ("F", 41, [53, 57, 60, 65]),
    ("G", 43, [55, 59, 62, 67]),
]

# Cheerful 8-beat melody cells (beat within the bar, MIDI note).
MELODY = [
    # bars 1-4: the main "cat bus" hook
    [(0.0, 72), (0.5, 76), (1.0, 79), (1.5, 76), (2.0, 74), (2.5, 72), (3.5, 74)],
    [(0.0, 69), (0.5, 72), (1.0, 76), (1.5, 72), (2.0, 74), (2.5, 76), (3.0, 79)],
    [(0.0, 72), (0.5, 77), (1.0, 81), (1.5, 79), (2.0, 77), (2.5, 76), (3.0, 74)],
    [(0.0, 74), (0.5, 79), (1.0, 83), (1.5, 81), (2.0, 79), (2.5, 77), (3.0, 74)],
    # bars 5-8: answer phrase, a little higher and lighter
    [(0.0, 76), (0.5, 79), (1.0, 84), (1.5, 79), (2.0, 76), (2.5, 74), (3.0, 72)],
    [(0.0, 76), (0.5, 79), (1.0, 83), (1.5, 79), (2.0, 76), (2.5, 74), (3.0, 71)],
    [(0.0, 77), (0.5, 81), (1.0, 84), (1.5, 81), (2.0, 79), (2.5, 77), (3.0, 76)],
    [(0.0, 79), (0.5, 83), (1.0, 86), (1.5, 83), (2.0, 81), (2.5, 79), (3.0, 74)],
    # bars 9-12: playful B section with space for the percussion
    [(0.0, 84), (0.5, 81), (1.0, 79), (1.5, 76), (2.0, 79), (2.5, 81), (3.0, 84)],
    [(0.0, 81), (0.5, 76), (1.0, 72), (1.5, 76), (2.0, 79), (2.5, 76), (3.0, 72)],
    [(0.0, 77), (0.5, 81), (1.0, 84), (1.5, 86), (2.0, 84), (2.5, 81), (3.0, 77)],
    [(0.0, 79), (0.5, 83), (1.0, 86), (1.5, 88), (2.0, 86), (2.5, 83), (3.0, 79)],
    # bars 13-16: resolve back into the loop
    [(0.0, 72), (0.5, 76), (1.0, 79), (1.5, 76), (2.0, 74), (2.5, 72), (3.0, 76)],
    [(0.0, 76), (0.5, 79), (1.0, 83), (1.5, 79), (2.0, 76), (2.5, 74), (3.0, 71)],
    [(0.0, 77), (0.5, 81), (1.0, 84), (1.5, 81), (2.0, 79), (2.5, 77), (3.0, 74)],
    [(0.0, 79), (0.5, 83), (1.0, 86), (1.5, 83), (2.0, 79), (2.5, 74), (3.0, 72)],
]

for bar, ((name, root, chord_notes), melody) in enumerate(zip(PROGRESSION, MELODY)):
    base = bar * BAR
    # Bass: root on 1, fifth pickup on 3, little bounce on the "and" of 2.
    add(base + 0.0, bass(midi_hz(root), 0.38), 0.50)
    add(base + 1.5, bass(midi_hz(root + 7), 0.20), 0.24)
    add(base + 2.0, bass(midi_hz(root), 0.32), 0.40)
    add(base + 3.5, bass(midi_hz(root + 12), 0.18), 0.22)

    # Ukulele-style offbeat chord stabs (never on every beat: leaves air).
    for beat in (0.5, 2.5):
        for j, note in enumerate(chord_notes):
            add(base + beat + j * 0.012, pluck(midi_hz(note), 0.30, 0.42), 0.075)
    if bar % 2 == 1:
        for j, note in enumerate(chord_notes[1:]):
            add(base + 3.5 + j * 0.012, pluck(midi_hz(note), 0.24, 0.36), 0.050)

    # Melody: marimba in the low register, glockenspiel sparkle on top.
    for idx, (beat, note) in enumerate(melody):
        is_peak = note >= 79
        add(
            base + beat,
            marimba(midi_hz(note - 12), 0.30 if is_peak else 0.26),
            0.25 if is_peak else 0.20,
        )
        if idx % 2 == 0 or is_peak:
            add(base + beat + 0.004, glock(midi_hz(note), 0.42), 0.085)

    # Percussion: soft kick, wood tick, airy shaker.
    if bar % 2 == 0:
        add(base + 0.0, kick(0.18), 0.28)
        add(base + 2.0, kick(0.16), 0.22)
    else:
        add(base + 1.0, kick(0.15), 0.16)
        add(base + 3.0, kick(0.14), 0.15)
    add(base + 1.0, woodblock(1160, 0.06), 0.11)
    add(base + 3.0, woodblock(980, 0.055), 0.09)
    for beat in (0.5, 1.5, 2.5, 3.5):
        add(base + beat, shaker(), 0.045 if beat in (1.5, 3.5) else 0.06)

# Fold the tail back over the start so reverb / note decays cross the loop
# boundary seamlessly instead of being cut off.
loop_n = int(LOOP * SR)
tail_n = N - loop_n
for i in range(tail_n):
    buf[i] += buf[loop_n + i]
out = buf[:loop_n]

# Gentle bus compressor-ish soft clip and normalize.
peak = max(0.0001, max(abs(x) for x in out))
scale = 0.86 / peak
out = [math.tanh(x * scale * 1.08) for x in out]

# 5 ms fade at the very edges (still seamless when both sides are faded).
fade_n = int(0.005 * SR)
for i in range(fade_n):
    g = i / fade_n
    out[i] *= g
    out[loop_n - 1 - i] *= g

path = Path(__file__).resolve().parent.parent / "assets" / "bgm-cat-bus.wav"
path.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(path), "wb") as wf:
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(SR)
    frames = bytearray()
    for x in out:
        frames += struct.pack("<h", max(-32768, min(32767, int(x * 32767))))
    wf.writeframes(frames)

print(f"wrote {path}  ({path.stat().st_size / 1024:.0f} KiB, {LOOP:.2f}s loop)")
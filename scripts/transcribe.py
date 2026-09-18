#!/usr/bin/env python3
"""Bounded local faster-whisper entry point for WhatsApp voice input."""
import argparse
import json
import os
from pathlib import Path
import sys

os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')

LABEL = 'Локальный распознаватель речи'
LANGUAGES = {'ru', 'sr'}
SAMPLE_RATE = 16000
ALLOWED_FORMATS = {'matroska', 'webm', 'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'ogg', 'wav'}


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')))


def reject(code=1):
    raise SystemExit(code)


def parse_args():
    parser = argparse.ArgumentParser(description='Local bounded speech-to-text helper.')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--audio')
    parser.add_argument('--language', choices=sorted(LANGUAGES))
    parser.add_argument('--max-duration-seconds', type=int, default=60)
    parser.add_argument('--compute-type', choices=['int8'], default='int8')
    parser.add_argument('--beam-size', type=int, default=3)
    parser.add_argument('--cpu-threads', type=int, default=2)
    return parser.parse_args()


def check_model_dir(path):
    model_dir = Path(path)
    if not model_dir.is_dir():
        return False
    # A CTranslate2 Whisper directory should be complete before service start.
    # tokenizer.json avoids faster-whisper falling back to a tokenizer download.
    required = {'model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt'}
    return all((model_dir / name).is_file() for name in required)


def decode_audio(path, maximum):
    try:
        import av
        import numpy as np
        from av.audio.resampler import AudioResampler
    except Exception:
        reject()

    chunks = []
    samples_seen = 0
    max_samples = maximum * SAMPLE_RATE
    resampler = AudioResampler(format='s16', layout='mono', rate=SAMPLE_RATE)

    def collect(frames):
        nonlocal samples_seen
        if frames is None:
            return
        if not isinstance(frames, list):
            frames = [frames]
        for frame in frames:
            data = frame.to_ndarray().reshape(-1)
            samples_seen += int(data.shape[0])
            if samples_seen > max_samples:
                reject()
            chunks.append(data.astype('float32') / 32768.0)

    try:
        with av.open(str(path), mode='r', options={'protocol_whitelist': 'file'}) as container:
            names = set((container.format.name or '').split(','))
            if not names.intersection(ALLOWED_FORMATS):
                reject()
            streams = [stream for stream in container.streams if stream.type == 'audio']
            if not streams:
                reject()
            for packet in container.demux(streams):
                for frame in packet.decode():
                    collect(resampler.resample(frame))
            collect(resampler.resample(None))
    except Exception:
        reject()

    if samples_seen <= 0:
        reject()
    return np.concatenate(chunks)


def transcribe(args):
    model_dir = Path(args.model_dir)
    audio = Path(args.audio) if args.audio else None
    if (not check_model_dir(model_dir) or audio is None or not audio.is_file()
            or args.language not in LANGUAGES
            or not (1 <= args.max_duration_seconds <= 60)
            or not (1 <= args.beam_size <= 5)
            or not (1 <= args.cpu_threads <= 4)):
        reject()

    waveform = decode_audio(audio, args.max_duration_seconds)

    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(
            str(model_dir),
            device='cpu',
            compute_type=args.compute_type,
            cpu_threads=args.cpu_threads,
            num_workers=1,
            local_files_only=True,
        )
        segments, _ = model.transcribe(
            waveform,
            language=args.language,
            task='transcribe',
            beam_size=args.beam_size,
            vad_filter=True,
            vad_parameters={'min_silence_duration_ms': 500},
            condition_on_previous_text=False,
        )
        text = ' '.join(segment.text.strip() for segment in segments).strip()
    except Exception:
        reject()

    if not text or len(text) > 4000:
        reject()
    emit({'text': text})


def main():
    args = parse_args()
    if args.check:
        if not check_model_dir(args.model_dir):
            emit({'ready': False, 'label': LABEL, 'reason': 'model_unavailable'})
            return
        try:
            import av  # noqa: F401
            import faster_whisper  # noqa: F401
        except Exception:
            emit({'ready': False, 'label': LABEL, 'reason': 'runtime_unavailable'})
            return
        emit({'ready': True, 'label': LABEL, 'reason': None})
        return
    transcribe(args)


if __name__ == '__main__':
    main()

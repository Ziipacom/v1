"""Offline source separation for a worker-authorized, staged media range."""

from dataclasses import dataclass
from hashlib import file_digest
import os
from pathlib import Path
import re
import subprocess
from typing import Callable
import wave


STEMS = ('vocals', 'drums', 'bass', 'other')
SAMPLE_RATE = 44_100
MAX_REGION_MS = 30_000
MIN_REGION_MS = 1_000
MAX_PCM_BYTES = SAMPLE_RATE * 4 * MAX_REGION_MS // 1000 + 4096
MAX_STAGED_BYTES = 100 * 1024 * 1024
CONTAINERS = {
    'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'mov',
    'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/ogg': 'ogg',
    'video/mp4': 'mov', 'video/quicktime': 'mov', 'video/webm': 'matroska',
}


class StemError(RuntimeError):
    """Safe, user-independent failure message for a separation job."""


@dataclass(frozen=True)
class StemModel:
    python: Path
    weights: Path
    weights_sha256: str

    def verified_name(self) -> str:
        match = re.fullmatch(r'([a-f0-9]{8})(?:-[a-f0-9]{8})?\.th', self.weights.name)
        if not match or not re.fullmatch(r'[a-f0-9]{64}', self.weights_sha256):
            raise StemError('The stem model pin is invalid.')
        if not self.python.is_absolute() or not self.python.is_file():
            raise StemError('The stem worker runtime is unavailable.')
        if (not self.weights.is_absolute() or self.weights.is_symlink()
                or not self.weights.is_file() or not 0 < self.weights.stat().st_size <= 1024**3):
            raise StemError('The stem model is unavailable.')
        # Demucs indexes models by the first part of the filename. A second
        # candidate with the same signature must never shadow the pinned file.
        if (list(self.weights.parent.glob(f'{match[1]}*.th')) != [self.weights]
                or any(self.weights.with_name(match[1] + suffix).exists() for suffix in ('.yaml', '.yml'))):
            raise StemError('The stem model repository has conflicting weights.')
        if sha256(self.weights) != self.weights_sha256:
            raise StemError('The stem model weights failed integrity validation.')
        return match[1]


@dataclass(frozen=True)
class StemAsset:
    name: str
    path: Path
    frames: int
    sha256: str


@dataclass(frozen=True)
class StemResult:
    source_sha256: str
    model_sha256: str
    start_ms: int
    duration_ms: int
    assets: tuple[StemAsset, ...]


def sha256(path: Path) -> str:
    with path.open('rb') as input_file:
        return file_digest(input_file, 'sha256').hexdigest()


def _frames(path: Path) -> int:
    if path.is_symlink() or not path.is_file() or not 44 <= path.stat().st_size <= MAX_PCM_BYTES:
        raise StemError('A stem has missing or oversized audio.')
    try:
        with wave.open(str(path), 'rb') as source:
            frames = source.getnframes()
            if (source.getframerate() != SAMPLE_RATE or source.getnchannels() != 2
                    or source.getsampwidth() != 2 or source.getcomptype() != 'NONE'
                    or not 0 < frames <= SAMPLE_RATE * MAX_REGION_MS // 1000):
                raise StemError('A stem is not stereo PCM on the expected sample clock.')
            remaining = frames
            while remaining:
                count = min(remaining, SAMPLE_RATE)
                if len(source.readframes(count)) != count * 4:
                    raise StemError('A stem WAV is truncated.')
                remaining -= count
            return frames
    except (EOFError, wave.Error) as exc:
        raise StemError('A stem WAV could not be decoded.') from exc


def _run_model(command: list[str], workspace: Path) -> None:
    env = {key: os.environ[key] for key in ('PATH', 'SYSTEMROOT', 'WINDIR') if key in os.environ}
    env.update(OMP_NUM_THREADS='2', MKL_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2',
               HF_HUB_OFFLINE='1', HOME=str(workspace), USERPROFILE=str(workspace),
               PYTHONNOUSERSITE='1')
    try:
        subprocess.run(command, cwd=workspace, env=env, stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=240, check=True)
    except (OSError, subprocess.SubprocessError) as exc:
        raise StemError('Stem separation could not finish.') from exc


def separate_stems(
    model: StemModel,
    workspace: Path,
    source: Path,
    *,
    content_type: str,
    start_ms: int,
    duration_ms: int,
    ffmpeg: str,
    run_media: Callable[[list[str], Path, float], None],
) -> StemResult:
    """Normalize one licensed range and run a pinned local Demucs model.

    The caller authorizes the range and materializes the file before calling.
    This function returns private worker artifacts. It does not grant access
    to the source, publish media, allocate a payout, or call a network API.
    """
    if (type(start_ms) is not int or start_ms < 0 or start_ms > 30 * 60 * 1000
            or type(duration_ms) is not int or not MIN_REGION_MS <= duration_ms <= MAX_REGION_MS):
        raise StemError('Choose a source range between 1 and 30 seconds.')
    container = CONTAINERS.get(content_type)
    if not container:
        raise StemError('Choose a supported audio or video source.')
    workspace = workspace.resolve(strict=True)
    if (source.is_symlink() or not source.is_file()
            or source.resolve().parent != workspace
            or not 0 < source.stat().st_size <= MAX_STAGED_BYTES):
        raise StemError('The stem source must be a bounded, staged media file.')
    source = source.resolve()
    name = model.verified_name()
    # Each invocation gets its own directory. In particular a failed job
    # cannot mistake stale output from a prior attempt for fresh stems.
    attempt = workspace / 'stems-work'
    attempt.mkdir(exist_ok=False)
    normalized = attempt / 'clip.wav'
    processed = attempt / 'output'
    expected_source_digest = sha256(source)
    run_media([
        ffmpeg, '-hide_banner', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file',
        '-ss', f'{start_ms / 1000:.3f}', '-f', container, '-i', str(source), '-t', f'{duration_ms / 1000:.3f}',
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '2', '-ar', str(SAMPLE_RATE),
        '-c:a', 'pcm_s16le', str(normalized),
    ], attempt, 45)
    frames = _frames(normalized)
    if abs(frames - round(duration_ms * SAMPLE_RATE / 1000)) > SAMPLE_RATE // 20:
        raise StemError('The selected audio range is incomplete.')
    _run_model([
        str(model.python), '-I', '-m', 'demucs.separate', '--name', name,
        '--repo', str(model.weights.parent), '--device', 'cpu', '--segment', '7',
        '--shifts', '0', '--jobs', '1', '--out', str(processed), str(normalized),
    ], attempt)
    folder = processed / name / normalized.stem
    if not folder.is_dir() or not folder.resolve().is_relative_to(attempt):
        raise StemError('The stem model returned an unexpected output path.')
    assets = []
    for stem in STEMS:
        path = folder / f'{stem}.wav'
        if _frames(path) != frames:
            raise StemError('Stem output lengths do not align.')
        assets.append(StemAsset(stem, path, frames, sha256(path)))
    if sha256(source) != expected_source_digest:
        raise StemError('The staged source changed during separation.')
    return StemResult(expected_source_digest, model.weights_sha256, start_ms, duration_ms, tuple(assets))

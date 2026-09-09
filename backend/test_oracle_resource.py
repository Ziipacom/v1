"""Opt-in 256 MiB scratch / 1 GiB worker acceptance check, generated media only."""
import os
from pathlib import Path
import struct
import time

import pytest

import app  # Register models before renderer imports; never start the API.
import render_services as render


def fill(handle, count):
    chunk = bytes(1024 * 1024)
    while count:
        size = min(len(chunk), count)
        handle.write(chunk[:size])
        count -= size


@pytest.mark.skipif(os.environ.get('ZIIPA_ORACLE_RESOURCE_TEST') != '1', reason='Opt-in Oracle max-input tmpfs acceptance check')
def test_two_maximum_inputs_and_90_second_effects_fit_private_scratch(tmp_path):
    ffmpeg, _, _ = render.runtime_paths()
    work = tmp_path / 'oracle-inputs'
    work.mkdir()
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1', '-filter_complex_threads', '1',
        '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=90',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=90',
        '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-b:v', '1000k', '-maxrate', '1000k', '-bufsize', '2000k',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '90', '-f', 'mp4', 'source.bin'], work, 180)
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1',
        '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=90',
        '-c:a', 'pcm_s16le', '-f', 'wav', 'music.bin'], work, 30)
    # Valid ignored container chunks make both files exactly the admitted 100 MiB
    # maximum. Write real pages rather than sparse holes to charge tmpfs memory.
    source, music = work / 'source.bin', work / 'music.bin'
    remaining = render.MAX_INPUT_BYTES - source.stat().st_size
    assert remaining >= 8
    with source.open('ab') as handle:
        handle.write(struct.pack('>I4s', remaining, b'free'))
        fill(handle, remaining - 8)
    remaining = render.MAX_INPUT_BYTES - music.stat().st_size
    assert remaining >= 8 and remaining % 2 == 0
    with music.open('r+b') as handle:
        handle.seek(4)
        handle.write(struct.pack('<I', render.MAX_INPUT_BYTES - 8))
        handle.seek(0, 2)
        handle.write(struct.pack('<4sI', b'JUNK', remaining - 8))
        fill(handle, remaining - 8)
    assert source.stat().st_size == music.stat().st_size == render.MAX_INPUT_BYTES
    snapshot = {'source': {'content_type': 'video/mp4'}, 'audio': {'content_type': 'audio/wav'},
                'edit': {'trim_start': 0, 'trim_end': 90,
                         'overlays': [{'text': 'Ziipa café 100 MiB input test', 'position': 'center', 'theme': 'purple'}],
                         'captions': [{'start': n, 'end': n + 1.5, 'text': f'Caption café {n}'} for n in range(0, 90, 2)],
                         'soundtrack': {'start': 0, 'volume': 0.5}}}
    started = time.monotonic()
    output, duration = render.render_files(snapshot, work)
    assert abs(duration - 90) < 0.15 and 0 < output.stat().st_size < render.MAX_OUTPUT_BYTES
    scratch_bytes = sum(path.stat().st_size for path in work.iterdir() if path.is_file())
    assert scratch_bytes < 256 * 1024**2
    print(f'Oracle scratch acceptance: {time.monotonic() - started:.2f}s, {scratch_bytes} scratch bytes')
    peak = Path('/sys/fs/cgroup/memory.peak')
    if peak.exists():
        print(f'Whole-container memory peak: {peak.read_text().strip()} bytes')

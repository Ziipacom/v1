"""Opt-in 256 MiB scratch / 1 GiB worker acceptance check, generated media only."""
import os
import array
from contextlib import contextmanager
import math
from pathlib import Path
import struct
import tempfile
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


@contextmanager
def maximum_inputs(tmp_path, *, caption_band=False):
    # Remove each test's own scratch before the next case. Otherwise two valid
    # 200MiB fixtures would coexist in the intentionally256MiB filesystem.
    with tempfile.TemporaryDirectory(prefix='oracle-inputs-', dir=tmp_path) as temporary:
        work = Path(temporary)
        generate_maximum_inputs(work, caption_band=caption_band)
        yield work


def generate_maximum_inputs(work, *, caption_band=False):
    ffmpeg, _, _ = render.runtime_paths()
    source_filter = 'testsrc2=s=1280x720:r=30:d=90'
    if caption_band:
        # The majority remains real720p motion. A static lower band lets the
        # test distinguish baked timed captions from unrelated motion changes.
        source_filter += ',drawbox=x=0:y=ih*0.78:w=iw:h=ih*0.22:color=blue:t=fill'
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1', '-filter_complex_threads', '1',
        '-f', 'lavfi', '-i', source_filter,
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


def legacy_snapshot():
    return {'schema': 1, 'source': {'content_type': 'video/mp4'}, 'audio': {'content_type': 'audio/wav'},
                'edit': {'trim_start': 0, 'trim_end': 90,
                         'overlays': [{'text': 'Ziipa café 100 MiB input test', 'position': 'center', 'theme': 'purple'}],
                         'captions': [{'start': n, 'end': n + 1.5, 'text': f'Caption café {n}'} for n in range(0, 90, 2)],
                         'soundtrack': {'start': 0, 'volume': 0.5}}}


def report(work, started, label):
    scratch_bytes = sum(path.stat().st_size for path in work.iterdir() if path.is_file())
    assert scratch_bytes < 256 * 1024**2
    print(f'Oracle {label} acceptance: {time.monotonic() - started:.2f}s, {scratch_bytes} scratch bytes')
    print(f'Rendered MP4 bytes: {(work / "output.mp4").stat().st_size}')
    peak = Path('/sys/fs/cgroup/memory.peak')
    if peak.exists():
        print(f'Whole-container memory peak: {peak.read_text().strip()} bytes')


@pytest.mark.skipif(os.environ.get('ZIIPA_ORACLE_RESOURCE_TEST') != '1', reason='Opt-in Oracle max-input tmpfs acceptance check')
def test_two_maximum_inputs_and_90_second_effects_fit_private_scratch(tmp_path):
    with maximum_inputs(tmp_path) as work:
        started = time.monotonic()
        output, duration = render.render_files(legacy_snapshot(), work)
        assert abs(duration - 90) < 0.15 and 0 < output.stat().st_size < render.MAX_OUTPUT_BYTES
        report(work, started, 'legacy scratch')


def frame(ffmpeg, work, name, when, *, source=False):
    command = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1',
        '-protocol_whitelist', 'file', '-ss', f'{when:.6f}', '-f', 'mov',
        '-i', 'source.bin' if source else 'output.mp4']
    if source:
        command += ['-vf', 'hue=s=0,setsar=1,fps=30,format=yuv420p']
    command += ['-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', name]
    render._run(command, work, 15)
    data = (work / name).read_bytes()
    assert len(data) == 1280 * 720 * 3
    return data


@pytest.mark.skipif(os.environ.get('ZIIPA_ORACLE_RESOURCE_TEST') != '1', reason='Opt-in Oracle12region native-capacity check')
def test_twelve_regions_with_speed_reorder_repeat_and_baked_media_fit_private_scratch(tmp_path):
    with maximum_inputs(tmp_path, caption_band=True) as work:
        ffmpeg, _, _ = render.runtime_paths()
        snapshot = legacy_snapshot()
        snapshot['schema'] = 2
        # Each quartet outputs30seconds:14.4+7.2+4.8+3.6. Reordering and
        # repetition are deliberate; source regions never total over90output.
        regions = [(70, .5), (0, 1), (35, 1.5), (15, 2)] * 3
        clips = [{'id': f'capacity_{i}', 'start': start, 'end': start + 7.2, 'speed': speed}
                 for i, (start, speed) in enumerate(regions)]
        snapshot['edit'].update(timeline={'version': 1, 'clips': clips}, visual_effect='mono')
        started = time.monotonic()
        output, duration = render.render_files(snapshot, work)
        assert abs(duration - 90) < .15 and 0 < output.stat().st_size < render.MAX_OUTPUT_BYTES
        _, streams = render._probe(output, 'video/mp4')
        assert any(s['codec_type'] == 'audio' for s in streams)
        video = next(s for s in streams if s['codec_type'] == 'video')
        assert (video['width'], video['height']) == (1280, 720)

        on = frame(ffmpeg, work, 'on.rgb', .3)
        off = frame(ffmpeg, work, 'off.rgb', 1.8)
        repeated = frame(ffmpeg, work, 'repeat.rgb', 30.3)
        # Output0.3 atspeed.5 maps to source70.1333 on the30fps sample grid.
        source_time = 70 + math.floor(.3 * 30 * .5) / 30
        reference = frame(ffmpeg, work, 'source-reference.rgb', source_time, source=True)
        top = 1280 * 120 * 3  # Excludes overlay and captions.
        reference_error = sum(abs(a - b) for a, b in zip(on[:top], reference[:top])) / top
        repeat_error = sum(abs(a - b) for a, b in zip(on[:top], repeated[:top])) / top
        assert reference_error < 12 and repeat_error < 12
        print(f'Actual decoded frame mean absolute error: source={reference_error:.3f}, repeat={repeat_error:.3f}')
        channels = [on[channel:top:3] for channel in range(3)]
        assert sum(abs(a - b) for a, b in zip(channels[0], channels[1])) / len(channels[0]) < 3
        assert sum(abs(a - b) for a, b in zip(channels[1], channels[2])) / len(channels[0]) < 3
        bottom = 1280 * 580 * 3
        assert sum(abs(a - b) for a, b in zip(on[bottom:], off[bottom:])) > 10000
        center = on[1280 * 270 * 3:1280 * 450 * 3]
        assert sum(abs(center[i] - center[i + 1]) > 20 for i in range(0, len(center), 3)) > 1000

        render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1',
            '-protocol_whitelist', 'file', '-ss', '0.2', '-i', 'output.mp4', '-t', '1',
            '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'mix.pcm'], work, 15)
        samples = array.array('h', (work / 'mix.pcm').read_bytes())
        assert len(samples) == 48000
        def amplitude(frequency):
            sine = sum(value * math.sin(2 * math.pi * frequency * index / 48000)
                for index, value in enumerate(samples))
            cosine = sum(value * math.cos(2 * math.pi * frequency * index / 48000)
                for index, value in enumerate(samples))
            return math.hypot(sine, cosine) / len(samples)
        original, music = amplitude(440), amplitude(880)
        assert original > 100 and music > 100
        print(f'Actual mixed PCM amplitude: 440Hz={original:.1f}, 880Hz={music:.1f}')
        report(work, started, '12region schema2')

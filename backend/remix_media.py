"""Fixed, offline two-input Remix graphs. Authority is rechecked by the worker."""
from __future__ import annotations

import math
from pathlib import Path
import uuid

REMIX_SCHEMA = 4
REMIX_MODES = ('stitch', 'split_screen', 'use_sound')
VIDEO_TYPES = {'video/mp4', 'video/quicktime', 'video/webm'}
AUDIO_TYPES = {'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg'}


class RemixMediaError(RuntimeError):
    """Fixed user-facing failures; never include paths, provider data or graphs."""


def validate_remix_snapshot(snapshot):
    """Fail closed before reading any file; no caller-provided filter expression."""
    from render_services import MAX_INPUT_BYTES
    if snapshot.get('schema') != REMIX_SCHEMA or type(snapshot.get('schema')) is not int:
        raise RemixMediaError('This Remix needs the current render worker.')
    remix, edit = snapshot.get('remix'), snapshot.get('edit')
    if not isinstance(remix, dict) or remix.get('mode') not in REMIX_MODES or not isinstance(edit, dict):
        raise RemixMediaError('Choose a supported Remix mode and save it again.')
    empty = {'trim_start': 0, 'trim_end': None, 'captions': [], 'overlays': [],
             'soundtrack': None, 'timeline': None, 'visual_effect': 'none'}
    if snapshot.get('audio') is not None or any(key not in empty or value != empty[key] for key, value in edit.items()):
        raise RemixMediaError('Render a simple Remix first. Additional editor effects can be added to its saved output.')
    if not {'trim_start', 'trim_end', 'captions', 'overlays', 'soundtrack'}.issubset(edit):
        raise RemixMediaError('The saved Remix edit is incomplete.')
    for key in ('source_start', 'source_seconds'):
        value = remix.get(key)
        if type(value) not in (int, float) or not math.isfinite(value):
            raise RemixMediaError('Choose a finite source clip range.')
    if not 0 <= remix['source_start'] <= 86400 or not 0.2 <= remix['source_seconds'] <= 30 or remix['source_start'] + remix['source_seconds'] > 86400:
        raise RemixMediaError('Choose a source clip lasting 0.2–30 seconds inside the original.')
    if remix['mode'] == 'stitch' and not 1 <= remix['source_seconds'] <= 5:
        raise RemixMediaError('Stitch uses a source clip lasting 1–5 seconds.')
    if (type(remix.get('source_owner_id')) is not int or remix['source_owner_id'] <= 0 or
            type(remix.get('policy_revision')) is not int or remix['policy_revision'] < 0):
        raise RemixMediaError('The saved Remix authority is invalid. Review the source again.')
    for descriptor, types in ((snapshot.get('source'), VIDEO_TYPES),
                              (remix.get('source'), VIDEO_TYPES | AUDIO_TYPES if remix['mode'] == 'use_sound' else VIDEO_TYPES)):
        if not isinstance(descriptor, dict) or descriptor.get('content_type') not in types:
            raise RemixMediaError('Choose a supported source and an owned video response.')
        try:
            if str(uuid.UUID(descriptor['id'])) != descriptor['id']:
                raise ValueError()
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            raise RemixMediaError('The saved Remix media reference is invalid.') from exc
        if type(descriptor.get('size')) is not int or not 0 < descriptor['size'] <= MAX_INPUT_BYTES:
            raise RemixMediaError('Each Remix input must be nonempty and no larger than 100 MB.')


def _video(streams):
    value = next((row for row in streams if row.get('codec_type') == 'video'), None)
    if value is None or any(not 2 <= int(value.get(key, 0)) <= 4096 for key in ('width', 'height')):
        raise RemixMediaError('The Remix video dimensions exceed the supported source limit.')
    return value


def _display_size(video):
    width, height = video['width'], video['height']
    try:
        numerator, denominator = map(float, video.get('sample_aspect_ratio', '1:1').split(':'))
        ratio = numerator / denominator
        if math.isfinite(ratio) and ratio > 0:
            width *= ratio
    except (ValueError, ZeroDivisionError, TypeError, AttributeError):
        pass
    return width, height


def render_remix(snapshot: dict, work: Path):
    from render_services import (FORMATS, MAX_DURATION, MAX_OUTPUT_BYTES, config,
                                 runtime_paths, _probe, _run)
    validate_remix_snapshot(snapshot)
    remix = snapshot['remix']
    response_duration, response_streams = _probe(work / 'source.bin', snapshot['source']['content_type'])
    parent_duration, parent_streams = _probe(work / 'remix-source.bin', remix['source']['content_type'])
    response_video = _video(response_streams)
    mode, start, selected = remix['mode'], remix['source_start'], remix['source_seconds']
    if start >= parent_duration or start + selected > parent_duration + 0.05:
        raise RemixMediaError('The selected source clip no longer fits the actual media.')
    selected = min(selected, parent_duration - start)
    if mode != 'use_sound':
        _video(parent_streams)
    parent_audio = any(row.get('codec_type') == 'audio' for row in parent_streams)
    response_audio = any(row.get('codec_type') == 'audio' for row in response_streams)
    if mode == 'use_sound' and not parent_audio:
        raise RemixMediaError('Use Sound needs an authorized source with an audio track.')
    length = selected + response_duration if mode == 'stitch' else min(selected, response_duration)
    if not 0.2 <= length <= MAX_DURATION:
        raise RemixMediaError('The completed Remix must last at most 90 seconds. Shorten your response.')
    display_width, display_height = _display_size(response_video)
    scale = min(1, 1280 / max(display_width, display_height), 720 / min(display_width, display_height))
    width, height = (max(2, int(value * scale) // 2 * 2) for value in (display_width, display_height))
    if mode == 'split_screen':
        width, height = 1280, 720
    ffmpeg, _, _ = runtime_paths()
    command = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-max_alloc', '67108864',
               '-filter_threads', '1', '-threads', '1', '-protocol_whitelist', 'file', '-ss', f'{start:.6f}',
               '-t', f'{selected:.6f}', '-f', FORMATS[remix['source']['content_type']], '-i', 'remix-source.bin',
               '-threads', '1', '-protocol_whitelist', 'file', '-t', f'{min(response_duration, MAX_DURATION):.6f}',
               '-f', FORMATS[snapshot['source']['content_type']], '-i', 'source.bin']
    graph = []

    def video(index, label, duration, w=width, h=height):
        graph.append(f'[{index}:v:0]trim=duration={duration:.6f},setpts=PTS-STARTPTS,'
                     f"scale=w='max(2,trunc(min({w},{h}*dar)/2)*2)':"
                     f"h='max(2,trunc(min({h},{w}/dar)/2)*2)',setsar=1,"
                     f'pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,format=yuv420p[{label}]')

    def audio(index, present, label, duration):
        prefix = f'[{index}:a:0]atrim=duration={duration:.6f},asetpts=PTS-STARTPTS' if present else 'anullsrc=r=48000:cl=stereo'
        graph.append(prefix + f',aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration={duration:.6f}[{label}]')

    if mode == 'stitch':
        video(0, 'parentv', selected); video(1, 'responsev', response_duration)
        audio(0, parent_audio, 'parenta', selected); audio(1, response_audio, 'responsea', response_duration)
        graph.append('[parentv][parenta][responsev][responsea]concat=n=2:v=1:a=1[vout][aout]')
    elif mode == 'split_screen':
        video(0, 'parentv', length, width // 2, height); video(1, 'responsev', length, width // 2, height)
        audio(0, parent_audio, 'parenta', length); audio(1, response_audio, 'responsea', length)
        graph.extend(['[parentv][responsev]hstack=inputs=2[vout]',
                      '[parenta][responsea]amix=inputs=2:duration=first:weights=0.5 0.5:normalize=0[aout]'])
    else:
        video(1, 'vout', length)
        audio(0, True, 'parenta', length); audio(1, response_audio, 'responsea', length)
        graph.append('[parenta][responsea]amix=inputs=2:duration=first:weights=0.7 0.3:normalize=0[aout]')
    filters = ';'.join(graph)
    (work / 'filters.txt').write_text(filters, encoding='utf-8')
    command += ['-filter_complex_threads', '1', '-filter_complex', filters, '-map', '[vout]', '-map', '[aout]',
                '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23',
                '-x264-params', 'rc-lookahead=0:sync-lookahead=0:mbtree=0:ref=1:threads=1',
                '-maxrate', '1800k', '-bufsize', '3600k', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
                '-t', f'{length:.6f}', '-fs', str(MAX_OUTPUT_BYTES), '-map_metadata', '-1', '-map_chapters', '-1',
                '-movflags', '+faststart', '-f', 'mp4', 'output.mp4']
    _run(command, work, min(max(config.timeout_seconds, 10), 240))
    output = work / 'output.mp4'
    actual, streams = _probe(output, 'video/mp4')
    actual_video = _video(streams)
    if not 0 < output.stat().st_size < MAX_OUTPUT_BYTES or abs(actual - length) > 0.25 or (actual_video['width'], actual_video['height']) != (width, height) or not any(row.get('codec_type') == 'audio' for row in streams):
        raise RemixMediaError('The Remix output was incomplete or exceeded its render limits.')
    return output, actual

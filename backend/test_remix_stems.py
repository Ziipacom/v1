from pathlib import Path
import shutil
import subprocess
import sys
import wave

import pytest

import remix_stems as stems


def source_file(path):
    with wave.open(str(path), 'wb') as writer:
        writer.setnchannels(2)
        writer.setsampwidth(2)
        writer.setframerate(stems.SAMPLE_RATE)
        writer.writeframes(b'\x00\x01\x00\x01' * stems.SAMPLE_RATE)
        writer.writeframes(b'\x00\x02\x00\x02' * stems.SAMPLE_RATE)


def model_file(directory):
    weights = directory / '01234567-89abcdef.th'
    weights.write_bytes(b'synthetic model digest fixture')
    return stems.StemModel(Path(sys.executable), weights, stems.sha256(weights))


def run_media(command, directory, timeout):
    subprocess.run(command, cwd=directory, timeout=timeout, check=True, capture_output=True)


def run_protocol_fixture(monkeypatch, bad_stem=None):
    def model(command, _directory):
        assert command[1:4] == ['-I', '-m', 'demucs.separate']
        assert '--repo' in command and '--device' in command and 'cpu' in command
        input_path = Path(command[-1])
        folder = Path(command[command.index('--out') + 1]) / '01234567' / 'clip'
        folder.mkdir(parents=True)
        for name in stems.STEMS:
            target = folder / f'{name}.wav'
            if name == bad_stem:
                target.write_bytes(input_path.read_bytes()[:-12])
            else:
                shutil.copyfile(input_path, target)
    monkeypatch.setattr(stems, '_run_model', model)


@pytest.mark.parametrize('bad_stem', [None, 'bass'])
def test_normalizes_only_the_selected_range_and_checks_four_worker_outputs(tmp_path, monkeypatch, bad_stem):
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        pytest.skip('ffmpeg is unavailable')
    source = tmp_path / 'input.wav'
    source_file(source)
    model = model_file(tmp_path)
    run_protocol_fixture(monkeypatch, bad_stem)
    options = dict(content_type='audio/wav', start_ms=1000, duration_ms=1000, ffmpeg=ffmpeg, run_media=run_media)
    if bad_stem:
        with pytest.raises(stems.StemError, match='truncated'):
            stems.separate_stems(model, tmp_path, source, **options)
        return
    result = stems.separate_stems(model, tmp_path, source, **options)
    assert result.source_sha256 == stems.sha256(source)
    assert result.model_sha256 == model.weights_sha256
    assert [asset.name for asset in result.assets] == list(stems.STEMS)
    for asset in result.assets:
        assert asset.frames == stems.SAMPLE_RATE
        with wave.open(str(asset.path), 'rb') as audio:
            assert audio.readframes(1) == b'\x00\x02\x00\x02'


def test_does_not_run_unpinned_or_ambiguous_weights(tmp_path):
    model = model_file(tmp_path)
    assert model.verified_name() == '01234567'
    conflicting_file = tmp_path / '01234567.th'
    conflicting_file.write_bytes(b'another checkpoint')
    with pytest.raises(stems.StemError, match='conflicting'):
        model.verified_name()
    conflicting_file.unlink()
    model.weights.write_bytes(b'replaced checkpoint')
    with pytest.raises(stems.StemError, match='integrity'):
        model.verified_name()


def test_rejects_outside_workspace_and_excessive_range(tmp_path):
    workspace = tmp_path / 'job'
    workspace.mkdir()
    source = tmp_path / 'outside.wav'
    source_file(source)
    model = model_file(tmp_path)
    with pytest.raises(stems.StemError, match='staged media file'):
        stems.separate_stems(model, workspace, source, content_type='audio/wav', start_ms=0, duration_ms=1000,
                             ffmpeg='unused', run_media=run_media)
    with pytest.raises(stems.StemError, match='between 1 and 30 seconds'):
        stems.separate_stems(model, workspace, source, content_type='audio/wav', start_ms=0, duration_ms=60_000,
                             ffmpeg='unused', run_media=run_media)

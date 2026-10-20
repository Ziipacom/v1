"""Versioned, bounded source-region edits. No user-supplied FFmpeg expressions."""
from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

VisualEffect = Literal['none', 'vivid', 'mono', 'warm', 'cool', 'fade', 'cinema']
MAX_CLIPS = 12
MAX_TIMELINE_SECONDS = 90
EFFECT_FILTERS = {
    'none': (),
    'vivid': ('eq=contrast=1.10:saturation=1.30:brightness=0.01',),
    'mono': ('hue=s=0',),
    'warm': ('colorbalance=rs=0.08:bs=-0.06:rm=0.04:bm=-0.03',),
    'cool': ('colorbalance=rs=-0.05:bs=0.08:rm=-0.02:bm=0.04',),
    'fade': ('eq=contrast=0.85:brightness=0.06:saturation=0.80',),
    'cinema': ('eq=contrast=1.15:saturation=0.82:brightness=-0.015',),
}


class TimelineClip(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    start: float = Field(ge=0, le=86400)
    end: float = Field(gt=0, le=86400)
    speed: Literal[0.5, 1, 1.5, 2] = 1

    @field_validator('start', 'end', 'speed', mode='before')
    @classmethod
    def numbers_only(cls, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError('Timeline times and speed must be finite numbers')
        return value

    @model_validator(mode='after')
    def ordered(self):
        if self.end - self.start < 0.2 - 1e-9:
            raise ValueError('Each timeline region must contain at least 0.2 source seconds')
        return self


class TimelineEdit(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    version: Literal[1]
    clips: list[TimelineClip] = Field(min_length=1, max_length=MAX_CLIPS)

    @field_validator('version', mode='before')
    @classmethod
    def version_number(cls, value):
        if type(value) is not int or value != 1:
            raise ValueError('Only timeline version 1 is supported')
        return value

    @model_validator(mode='after')
    def bounded(self):
        if len({clip.id for clip in self.clips}) != len(self.clips):
            raise ValueError('Timeline clip identifiers must be unique')
        if self.duration > MAX_TIMELINE_SECONDS + 1e-6:
            raise ValueError('The edited timeline must not exceed 90 seconds')
        return self

    @property
    def duration(self):
        return sum((clip.end - clip.start) / clip.speed for clip in self.clips)


def checked_timeline(value, source_duration):
    """Revalidate persisted snapshots against the actual probed source."""
    timeline = TimelineEdit.model_validate(value)
    if not math.isfinite(source_duration) or source_duration <= 0:
        raise ValueError('The source duration is invalid')
    if any(clip.end > source_duration + 0.05 or clip.start >= source_duration for clip in timeline.clips):
        raise ValueError('Timeline regions must stay inside the source media')
    if any(min(clip.end, source_duration) - clip.start < 0.2 - 1e-9 for clip in timeline.clips):
        raise ValueError('Timeline regions must contain at least 0.2 actual source seconds')
    # Media probes may differ by a few milliseconds. Clamp only the already
    # admitted 50-ms tail tolerance so output duration follows actual samples.
    return TimelineEdit(version=1, clips=[clip.model_copy(update={'end': min(clip.end, source_duration)})
                                        for clip in timeline.clips])


def sequence_captions(captions, timeline):
    """Explicit source transcript -> output-clock mapping for reviewed captions."""
    edit = TimelineEdit.model_validate(timeline)
    result, offset = [], 0.0
    for clip in edit.clips:
        for cue in captions:
            start, end = max(clip.start, cue['start']), min(clip.end, cue['end'])
            if end > start:
                result.append({'start': offset + (start - clip.start) / clip.speed,
                               'end': offset + (end - clip.start) / clip.speed, 'text': cue['text']})
        offset += (clip.end - clip.start) / clip.speed
    return sorted(result, key=lambda cue: (cue['start'], cue['end']))

"""Owner-approved fan-out over the existing Livepeer relay. Secrets stay off receipts."""
import asyncio
from datetime import datetime, timedelta, timezone
import time
from typing import Literal
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, SecretStr, StrictBool, ValidationError
from sqlalchemy import DateTime, ForeignKey, String, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import Base, User, current_user, db, guard
import live_api as live
from live_manual_destinations import ManualLiveError, manual_ingest
import live_network_adapters as adapters
import social_publishing as publishing


router = APIRouter(prefix='/api/live', dependencies=[Depends(live.no_store)])
NETWORKS = {
    'twitch': ('Twitch', 'connected', 'https://dashboard.twitch.tv/'),
    'youtube': ('YouTube', 'connected', 'https://studio.youtube.com/'),
    'facebook': ('Facebook Pages', 'connected', 'https://www.facebook.com/live/producer/'),
    'instagram': ('Instagram', 'manual', 'https://www.instagram.com/'),
    'tiktok': ('TikTok', 'manual', 'https://livecenter.tiktok.com/producer'),
    'bluesky': ('Bluesky', 'link_only', 'https://bsky.app/'),
}
MANAGED = frozenset(('youtube', 'facebook'))
RESERVATION_SECONDS = 90


class NetworkDestination(Base):
    __tablename__ = 'live_network_destinations'
    stream_id: Mapped[str] = mapped_column(ForeignKey('live_streams.id', ondelete='CASCADE'), primary_key=True)
    provider: Mapped[str] = mapped_column(String(16), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    phase: Mapped[str] = mapped_column(String(20), default='selected')
    channel_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    grant_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    relay_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    event_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    ingest_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    relay_uncertain: Mapped[bool] = mapped_column(default=False)
    event_uncertain: Mapped[bool] = mapped_column(default=False)
    setup_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DestinationSelection(BaseModel):
    model_config = ConfigDict(extra='forbid', hide_input_in_errors=True)
    provider: Literal['twitch', 'youtube', 'facebook', 'instagram', 'tiktok']
    enabled: StrictBool
    consent: StrictBool = False
    expected_target_id: str | None = Field(default=None, max_length=100)
    ingest_url: SecretStr | None = Field(default=None, max_length=2048)
    stream_key: SecretStr | None = Field(default=None, max_length=2048)


def rows_for(session, row):
    return {dest.provider: dest for dest in session.scalars(select(NetworkDestination).where(
        NetworkDestination.owner_id == row.owner_id, NetworkDestination.stream_id == row.id,
    ).order_by(NetworkDestination.provider)).all()}


def is_enabled(provider):
    return provider == 'twitch' or bool(getattr(live.config, f'live_{provider}_enabled', False))


def require_relay_slot(session, row, provider):
    destinations = {name for name, dest in rows_for(session, row).items() if dest.phase != 'ended'}
    twitch = session.get(live.TwitchDestination, row.id)
    if twitch and twitch.status != 'detached':
        destinations.add('twitch')
    if len(destinations | {provider}) > live.config.live_max_external_destinations:
        raise HTTPException(409, 'This broadcast reached its free beta destination limit. Remove a destination first.')


def verify_attached_relays(session, row, upstream):
    approved = {dest.relay_id for dest in rows_for(session, row).values()
                if dest.phase == 'ready' and dest.relay_id}
    twitch = session.get(live.TwitchDestination, row.id)
    if twitch and twitch.status == 'configured' and twitch.target_id:
        live.require_current_twitch_grant(session, row.owner_id, twitch.channel_id)
        approved.add(twitch.target_id)
    attached = {target['id'] for target in live.multistream_targets(upstream)}
    if attached != approved or len(attached) > live.config.live_max_external_destinations:
        raise HTTPException(409, 'The streaming service destinations differ from your approved selection. Review them before starting.')


def channel_for(session, owner_id, provider):
    grant = publishing.grant_for(session, owner_id, provider)
    if not grant or grant.status != 'authorized' or not grant.selected_target_id:
        return None, None
    channel = next((target for target in grant.targets if target.get('id') == grant.selected_target_id), None)
    return (grant, channel) if channel else (None, None)


def scope_ready(provider, tokens, target_id):
    if provider == 'youtube':
        return adapters.youtube_live_granted(tokens)
    page_tokens = tokens.get('page_tokens')
    return isinstance(page_tokens, dict) and bool(page_tokens.get(target_id))


def require_grant(session, dest, *, cleanup=False):
    grant = publishing.grant_for(session, dest.owner_id, dest.provider)
    if (not grant or grant.id != dest.grant_id or not dest.channel_id
            or (not cleanup and (grant.status != 'authorized' or grant.selected_target_id != dest.channel_id))):
        raise HTTPException(409, 'The broadcast channel authorization changed. Review the destination and reconnect.')
    tokens = publishing.decrypt_tokens(grant)
    if not scope_ready(dest.provider, tokens, dest.channel_id):
        raise HTTPException(409, 'This account needs live streaming permission. Reauthorize it in Connected Networks.')
    return grant, tokens


def require_private_prepare(session, row):
    from account_services import AccountState, PrivacyInput
    live.public_action_owner(session, row.owner_id)
    account = session.get(AccountState, row.owner_id, populate_existing=True)
    if PrivacyInput(**(account.privacy or {}) if account else {}).profile_visibility != 'public':
        raise HTTPException(409, 'Public broadcasting requires a public Ziipa profile.')
    if row.publish_enabled or row.status != 'prepared' or not row.provider_id:
        raise HTTPException(409, 'Choose destinations before starting a prepared broadcast.')


async def attach_relay(session, row, dest, url):
    require_private_prepare(session, row)
    raw = await live.read_provider_stream(row)
    if not raw or not raw['suspended'] or raw['isActive']:
        raise HTTPException(409, 'The provider session must remain suspended during destination setup.')
    if len(live.multistream_targets(raw)) >= live.config.live_max_external_destinations:
        raise HTTPException(409, 'The relay reached its free beta destination limit.')
    # The interval between the reservation and its receipt is ambiguous on a crash.
    # Do not repeat POST after an ambiguous response.
    dest.relay_uncertain = True
    session.commit()
    row = live.owned(session, row.id, session.get(User, dest.owner_id))
    try:
        require_private_prepare(session, row)
        if dest.provider in MANAGED:
            require_grant(session, dest)
    except HTTPException:
        dest.relay_uncertain = False
        raise
    created = await live.provider_request('POST', '/multistream/target', {
        'name': f'ziipa-{dest.provider}-{row.id}', 'url': url,
    })
    dest.relay_id = live.checked_uuid(created.get('id'))
    dest.relay_uncertain = False
    stream_id, owner_id = row.id, row.owner_id
    session.commit()
    row = live.owned(session, stream_id, session.get(User, owner_id))
    require_private_prepare(session, row)
    if dest.provider in MANAGED:
        require_grant(session, dest)
    raw = await live.read_provider_stream(row)
    if not raw or not raw['suspended'] or raw['isActive']:
        raise HTTPException(409, 'The provider session changed during destination setup.')
    targets = [target for target in live.multistream_targets(raw) if target['id'] != dest.relay_id]
    if len(targets) >= live.config.live_max_external_destinations:
        raise HTTPException(409, 'The relay reached its free beta destination limit.')
    targets.append({'id': dest.relay_id, 'profile': '720p', 'videoOnly': False})
    await live.provider_request('PATCH', '/stream/' + row.provider_id, {'multistream': {'targets': targets}})
    verified = await live.read_provider_stream(row)
    if not verified or not verified['suspended'] or not any(
            target['id'] == dest.relay_id for target in live.multistream_targets(verified)):
        raise HTTPException(502, 'The streaming service did not confirm the relay target.')
    dest.phase, dest.setup_at = 'ready', None
    session.commit()


def setup_in_progress(dest):
    if dest.phase != 'preparing' or not dest.setup_at:
        return False
    stamp = dest.setup_at if dest.setup_at.tzinfo else dest.setup_at.replace(tzinfo=timezone.utc)
    return live.now() - stamp <= timedelta(seconds=RESERVATION_SECONDS)


async def cleanup_tokens(session, dest, replacement):
    if replacement is not None:
        return replacement
    _, tokens = require_grant(session, dest, cleanup=True)
    if (dest.provider != 'youtube' or tokens.get('expires_at', 0) > time.time() + 60
            or not tokens.get('refresh_token')):
        return tokens
    # Refresh for this single close operation. The shared publishing refresh
    # commits its session, which would release the broadcast/privacy locks.
    try:
        async with asyncio.timeout(8), publishing.api_client() as client:
            status, fresh = await publishing.provider_json(client, 'POST', publishing.TOKEN_URL, data={
                'grant_type': 'refresh_token', 'client_id': publishing.config.youtube_client_id,
                'client_secret': publishing.config.youtube_client_secret, 'refresh_token': tokens['refresh_token'],
            })
    except (TimeoutError, publishing.ProviderFailure):
        raise HTTPException(502, 'YouTube could not renew its authorization to end this broadcast.') from None
    if status != 200 or not isinstance(fresh.get('access_token'), str):
        raise HTTPException(409, 'Reconnect the same YouTube channel to confirm the broadcast ended.')
    updated = {**tokens, 'access_token': fresh['access_token']}
    if isinstance(fresh.get('scope'), str):
        updated['scope'] = fresh['scope'].split()
    if not scope_ready('youtube', updated, dest.channel_id):
        raise HTTPException(409, 'Reconnect YouTube with its live broadcasting permission.')
    return updated


async def cleanup_destination(session, row, dest, *, keep_receipt=False, replacement=None):
    if setup_in_progress(dest):
        raise HTTPException(409, 'Destination setup is still settling. Retry removal shortly.')
    if dest.relay_id:
        raw = await live.read_provider_stream(row) if row.provider_id else None
        if raw:
            targets = live.multistream_targets(raw)
            kept = [target for target in targets if target['id'] != dest.relay_id]
            if kept != targets:
                await live.provider_request('PATCH', '/stream/' + row.provider_id, {'multistream': {'targets': kept}})
                checked = await live.read_provider_stream(row)
                if checked and any(target['id'] == dest.relay_id for target in live.multistream_targets(checked)):
                    raise HTTPException(502, 'Relay removal could not be confirmed. Retry ending the broadcast.')
        await live.provider_request('DELETE', '/multistream/target/' + live.checked_uuid(dest.relay_id), allow_missing=True)
        dest.relay_id = None
    if dest.event_id or dest.ingest_id:
        try:
            tokens = await cleanup_tokens(session, dest, replacement)
            await adapters.end(dest.provider, tokens, dest.channel_id, dest.event_id, dest.ingest_id,
                               settings=publishing.config)
        except (HTTPException, adapters.LiveNetworkError):
            raise HTTPException(502, f'Check that the event ended on {NETWORKS[dest.provider][0]}, then retry.') from None
        dest.event_id = dest.ingest_id = None
    if dest.relay_uncertain or dest.event_uncertain:
        raise HTTPException(503, 'A provider setup response was lost. An operator must reconcile the saved destination before reusing it.')
    if keep_receipt:
        dest.phase, dest.setup_at = 'ended', None
    else:
        session.delete(dest)


async def cleanup_broadcast_destinations(session, row):
    failure = None
    for dest in rows_for(session, row).values():
        if dest.phase != 'ended':
            try:
                await cleanup_destination(session, row, dest, keep_receipt=True)
            except HTTPException as exc:
                failure = exc
    if failure:
        raise failure


async def detach_owner_destinations(owner_id, providers, session, *, authorization=None, targets=()):
    """Detach before a channel grant is replaced or revoked. Caller commits."""
    destinations = session.scalars(select(NetworkDestination).where(
        NetworkDestination.owner_id == owner_id, NetworkDestination.provider.in_(providers),
        NetworkDestination.phase != 'ended',
    ).order_by(NetworkDestination.stream_id, NetworkDestination.provider)).all()
    for dest in destinations:
        row = session.scalar(select(live.LiveStream).where(live.LiveStream.id == dest.stream_id,
                                  live.LiveStream.owner_id == owner_id).with_for_update())
        if row:
            # A successful reconnect can close the old event if the newly
            # authenticated grant controls that exact destination.
            replacement = authorization if (authorization and authorization.get('provider') == dest.provider
                and any(target.get('id') == dest.channel_id for target in targets)
                and scope_ready(dest.provider, authorization, dest.channel_id)) else None
            await cleanup_destination(session, row, dest, replacement=replacement)


async def prepare_connected(session, row, user, dest):
    stream_id, owner_id, provider = row.id, row.owner_id, dest.provider
    grant, _ = require_grant(session, dest)
    async with publishing.api_client() as client:
        await publishing.access_token(session, grant, client)
    row = live.owned(session, stream_id, user)
    require_private_prepare(session, row)
    dest = rows_for(session, row).get(provider)
    if not dest or dest.phase != 'selected' or not is_enabled(provider):
        raise HTTPException(409, 'The live destination changed. Review your selection before retrying.')
    _, tokens = require_grant(session, dest)
    dest.phase, dest.setup_at, dest.event_uncertain = 'preparing', live.now(), True
    session.commit()

    async def checkpoint(event_id, stream_id_at_network):
        dest.event_id, dest.ingest_id = event_id, stream_id_at_network
        session.commit()
        latest = live.owned(session, stream_id, user)
        require_private_prepare(session, latest)
        require_grant(session, dest)

    try:
        row = live.owned(session, stream_id, user)
        require_private_prepare(session, row)
        _, tokens = require_grant(session, dest)
    except HTTPException:
        dest.phase, dest.setup_at, dest.event_uncertain = 'error', None, False
        session.commit()
        raise
    try:
        async with asyncio.timeout(18):
            result = await adapters.prepare(provider, tokens, dest.channel_id, row.title, row.description,
                                            settings=publishing.config, checkpoint=checkpoint)
        dest.event_uncertain = False
        dest.event_id, dest.ingest_id = result['event_id'], result.get('stream_id')
        await attach_relay(session, row, dest, result['ingest_url'])
    except (HTTPException, adapters.LiveNetworkError, TimeoutError) as exc:
        if isinstance(exc, adapters.LiveNetworkError):
            dest.event_uncertain = bool(getattr(exc, 'uncertain', False))
        dest.phase, dest.setup_at = 'error', None
        session.commit()
        if isinstance(exc, adapters.LiveNetworkError):
            raise HTTPException(409, str(exc)) from None
        raise HTTPException(502, f'{NETWORKS[provider][0]} could not finish setup. Review or remove that destination before starting.') from None


async def prepare_for_start(row, user, session):
    stream_id = row.id
    destinations = rows_for(session, row)
    if not destinations:
        return row
    for dest in destinations.values():
        if dest.phase not in ('ready', 'selected') or not is_enabled(dest.provider):
            raise HTTPException(409, f'Resolve or remove {NETWORKS[dest.provider][0]} before starting the broadcast.')
        if dest.provider in MANAGED:
            require_grant(session, dest)
    if any(dest.phase == 'selected' for dest in destinations.values()):
        require_private_prepare(session, row)
        upstream = await live.read_provider_stream(row)
        if not upstream or not upstream['suspended'] or upstream['isActive']:
            raise HTTPException(409, 'The provider session must be suspended before starting selected destinations.')
        verify_attached_relays(session, row, upstream)
    for provider in destinations:
        row = live.owned(session, stream_id, user)
        dest = rows_for(session, row).get(provider)
        if not dest or dest.phase not in ('ready', 'selected'):
            raise HTTPException(409, 'Destinations changed. Review them before starting.')
        if dest.phase == 'selected':
            await prepare_connected(session, row, user, dest)
    row = live.owned(session, stream_id, user)
    latest = rows_for(session, row)
    if set(latest) != set(destinations) or any(dest.phase != 'ready' or not is_enabled(dest.provider) for dest in latest.values()):
        raise HTTPException(409, 'Destinations changed. Review them before starting.')
    if not row.publish_enabled:
        require_private_prepare(session, row)
    for dest in latest.values():
        if dest.provider in MANAGED:
            require_grant(session, dest)
    return row


def receipt(provider, mode, status, detail, *, enabled=False, can_enable=False,
            can_disable=False, target_id=None, target_name=None, verified_at=None):
    name, _, url = NETWORKS.get(provider, ('Ziipa', 'built_in', None))
    return {'provider': provider, 'name': name, 'mode': mode, 'status': status, 'detail': detail,
            'enabled': enabled, 'can_enable': can_enable, 'can_disable': can_disable,
            'target_id': target_id, 'target_name': target_name, 'verified_at': verified_at,
            **({'setup_url': url} if url else {})}


async def observed_status(provider, tokens, target, event_id, ingest_id):
    try:
        async with asyncio.timeout(5):
            if provider == 'twitch':
                from twitch_publishing_adapter import channel_status, TwitchError
                try:
                    async with publishing.api_client() as client:
                        observed = await channel_status(tokens, target, client, publishing.config)
                    return 'live' if observed.get('is_live') is True else 'starting'
                except TwitchError:
                    return 'unknown'
            return await adapters.status(provider, tokens, target, event_id, ingest_id,
                                         settings=publishing.config)
    except (adapters.LiveNetworkError, TimeoutError):
        return 'unknown'


async def destination_snapshot(session, row, *, observe=False):
    public_ready = live.is_fresh(row) and row.status == 'live' and bool(row.playback_url) and row.publish_enabled
    output = [receipt('ziipa', 'built_in', 'live' if public_ready else 'ended' if row.status == 'ended' else
                      'starting' if row.publish_enabled else 'ready', 'Public Live Feed', enabled=True,
                      verified_at=row.checked_at if public_ready else None)]
    editable = row.status == 'prepared' and not row.publish_enabled
    active = bool(row.publish_enabled and row.status not in ('ending', 'ended'))
    saved = rows_for(session, row)
    twitch = session.get(live.TwitchDestination, row.id)
    probes = []
    for provider, (name, mode, _) in NETWORKS.items():
        dest = saved.get(provider)
        if provider == 'twitch' and twitch and twitch.status != 'detached':
            dest = twitch
        grant, target = channel_for(session, row.owner_id, provider) if mode == 'connected' else (None, None)
        target_id = dest.channel_id if dest is not None else (target or {}).get('id')
        target_name = (target or {}).get('name') if target_id == (target or {}).get('id') else None
        ready = is_enabled(provider) and live.configured()
        tokens = None
        if grant and ready:
            try:
                candidate = publishing.decrypt_tokens(grant)
                if provider == 'twitch' or scope_ready(provider, candidate, target_id):
                    tokens = candidate
            except HTTPException:
                pass
        if dest is not None:
            phase = dest.status if provider == 'twitch' else dest.phase
            status, detail = 'ready', f'{name} is selected for this broadcast.'
            if phase == 'ended':
                status = 'ended'
                detail = ('Relay stopped. Confirm the session ended in its producer dashboard.' if mode == 'manual'
                          else 'This broadcast has ended on this destination.')
            elif phase not in ('ready', 'selected', 'configured'):
                status, detail = ('starting', f'Preparing {name}.') if provider != 'twitch' and setup_in_progress(dest) else (
                    'error', f'{name} setup or cleanup needs attention. Remove it or retry ending the broadcast.')
            elif active:
                status, detail = 'verification_unavailable', f'Check {name} for public playback.'
                if mode == 'connected' and row.status == 'awaiting_media':
                    status, detail = 'starting', 'Waiting for incoming media and destination confirmation.'
                if (observe and mode == 'connected' and tokens and target and target['id'] == target_id
                        and time.time() < tokens.get('expires_at', 0)
                        and ((provider == 'twitch' and public_ready) or (provider in MANAGED and dest.event_id))):
                    event_id, ingest_id = (None, None) if provider == 'twitch' else (dest.event_id, dest.ingest_id)
                    binding = dest.target_id if provider == 'twitch' else (dest.relay_id, event_id)
                    probes.append((len(output), binding, grant.id,
                                   observed_status(provider, tokens, target_id, event_id, ingest_id)))
            output.append(receipt(provider, mode, status, detail, enabled=phase != 'ended',
                          can_disable=phase != 'ended', target_id=target_id, target_name=target_name))
        elif mode == 'link_only':
            output.append(receipt(provider, mode, 'unavailable', 'Share a watch link on Bluesky once Ziipa is live.'))
        elif not ready:
            output.append(receipt(provider, mode, 'unavailable', f'{name} live setup is pending for this beta.'))
        elif mode == 'manual':
            output.append(receipt(provider, mode, 'off', f'Use the stream URL and key from your eligible {name} account. '
                                  'Complete any required Go Live or Stop step in its producer dashboard.', can_enable=editable))
        elif target and (tokens or provider == 'twitch'):
            output.append(receipt(provider, mode, 'off', f'Choose this {name} destination before going live.',
                                  can_enable=editable, target_id=target_id, target_name=target_name))
        else:
            output.append(receipt(provider, mode, 'setup_required', f'Connect or reauthorize {name} and select your channel.',
                                  target_id=target_id, target_name=target_name))
    if probes:
        # Do not retain account locks while performing status reads. Revalidate the
        # owning broadcast and destinations before disclosing transient live status.
        row_id, owner_id = row.id, row.owner_id
        session.commit()
        observed = await asyncio.gather(*(probe for _, _, _, probe in probes))
        current = session.get(live.LiveStream, row_id, populate_existing=True)
        if current and current.owner_id == owner_id and current.publish_enabled:
            current_targets = rows_for(session, current)
            for (index, binding, grant_id, _), status in zip(probes, observed, strict=True):
                item = output[index]
                provider = item['provider']
                dest = session.get(live.TwitchDestination, row_id, populate_existing=True) if provider == 'twitch' else current_targets.get(provider)
                grant, target = channel_for(session, owner_id, provider)
                if not dest or not grant or grant.id != grant_id or not target or target['id'] != item['target_id'] or dest.channel_id != item['target_id']:
                    continue
                current_binding = dest.target_id if provider == 'twitch' else (dest.relay_id, dest.event_id)
                if current_binding != binding:
                    continue
                if status in ('live', 'starting', 'ended'):
                    item['status'] = status
                    item['verified_at'] = live.now()
                    item['detail'] = {'live': 'Twitch reports the channel is live. Check that its video matches this broadcast.' if provider == 'twitch'
                                      else f'{item["name"]} reports that this broadcast is live.',
                                      'starting': f'{item["name"]} has not confirmed live playback.',
                                      'ended': f'{item["name"]} reports that the event ended.'}[status]
        elif current and current.owner_id == owner_id:
            return await destination_snapshot(session, current)
    return {'destinations': output, 'max_external_destinations': live.config.live_max_external_destinations}


@router.get('/streams/{stream_id}/destinations', dependencies=[Depends(guard)])
async def list_destinations(stream_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    row = live.owned(session, stream_id, user)
    return await destination_snapshot(session, row, observe=True)


async def selection_input(request):
    body = bytearray()
    try:
        async with asyncio.timeout(5):
            async for chunk in request.stream():
                if len(body) + len(chunk) > 8192:
                    raise HTTPException(413, 'The destination request exceeds the size limit.')
                body.extend(chunk)
        return DestinationSelection.model_validate_json(body)
    except TimeoutError:
        raise HTTPException(408, 'The destination request timed out.') from None
    except (ValidationError, ValueError):
        raise HTTPException(422, 'Provide valid live destination settings.') from None


@router.post('/streams/{stream_id}/destinations/selection', dependencies=[Depends(guard)])
async def select_destination(stream_id: uuid.UUID, request: Request, user: User = Depends(current_user),
                             session: Session = Depends(db)):
    data = await selection_input(request)
    row = live.owned(session, stream_id, user)
    provider = data.provider
    if provider == 'twitch':
        try:
            twitch = live.TwitchDestinationInput(enabled=data.enabled, consent=data.consent,
                                               expected_target_id=data.expected_target_id)
        except ValidationError:
            raise HTTPException(422, 'Select a valid Twitch channel.') from None
        await live.set_twitch_destination(stream_id, twitch, user, session)
        return await destination_snapshot(session, live.owned(session, stream_id, user))
    dest = rows_for(session, row).get(provider)
    if not data.enabled:
        try:
            if dest:
                await cleanup_destination(session, row, dest)
            session.commit()
        except HTTPException:
            # Persist confirmed relay cleanup if only the final provider end failed.
            if dest and not setup_in_progress(dest):
                dest.phase = 'error'
                session.commit()
            raise
        return await destination_snapshot(session, live.owned(session, stream_id, user))
    require_private_prepare(session, row)
    live.require_provider()
    if not is_enabled(provider):
        raise HTTPException(409, f'{NETWORKS[provider][0]} is not enabled for this beta.')
    if not data.consent:
        raise HTTPException(422, 'Approve transmitting this broadcast and its audio to the chosen destination.')
    require_relay_slot(session, row, provider)
    if dest:
        if dest.phase in ('ready', 'selected') and dest.channel_id == data.expected_target_id:
            return await destination_snapshot(session, row)
        raise HTTPException(409, 'Remove the previous destination selection before replacing it.')
    dest = NetworkDestination(stream_id=row.id, owner_id=row.owner_id, provider=provider)
    if provider in MANAGED:
        grant, channel = channel_for(session, row.owner_id, provider)
        if not grant or not data.expected_target_id or channel['id'] != data.expected_target_id:
            raise HTTPException(409, 'Select the authorized channel in Connected Networks before proceeding.')
        dest.grant_id, dest.channel_id = grant.id, channel['id']
        require_grant(session, dest)
        session.add(dest)
        session.commit()
    else:
        try:
            url = manual_ingest(provider, data.ingest_url.get_secret_value() if data.ingest_url else '',
                                data.stream_key.get_secret_value() if data.stream_key else '')
        except ManualLiveError as exc:
            raise HTTPException(422, str(exc)) from None
        dest.phase, dest.setup_at = 'preparing', live.now()
        session.add(dest)
        try:
            await attach_relay(session, row, dest, url)
        except HTTPException:
            dest.phase, dest.setup_at = 'error', None
            session.commit()
            raise HTTPException(502, 'The relay setup could not be confirmed. Review or remove the destination before retrying.') from None
    return await destination_snapshot(session, live.owned(session, stream_id, user))

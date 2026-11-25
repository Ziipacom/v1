-- PostgreSQL 17 reference schema. Review in a disposable database before
-- translating into an Alembic revision. Requires public.users(id integer).

BEGIN;

CREATE SCHEMA ziipa_live;
REVOKE ALL ON SCHEMA ziipa_live FROM PUBLIC;

CREATE TABLE ziipa_live.broadcasts (
    owner_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    manifest_revision integer NOT NULL DEFAULT 1 CHECK (manifest_revision > 0),
    state text NOT NULL DEFAULT 'draft' CHECK (state IN (
        'draft', 'scheduled', 'preflight', 'awaiting_media', 'live',
        'failover_hold', 'winding_down', 'post_processing', 'archived', 'cancelled', 'failed'
    )),
    state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, id),
    UNIQUE (id)
);

CREATE TABLE ziipa_live.manifest_revisions (
    owner_id integer NOT NULL,
    broadcast_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
    title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 140),
    scheduled_at timestamptz,
    calendar_occurrence_key text,
    record_private boolean NOT NULL DEFAULT false,
    make_private_clip_drafts boolean NOT NULL DEFAULT false,
    media_policy jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(media_policy) = 'object'),
    canonical_sha256 bytea NOT NULL CHECK (octet_length(canonical_sha256) = 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, broadcast_id, revision),
    FOREIGN KEY (owner_id, broadcast_id) REFERENCES ziipa_live.broadcasts ON DELETE CASCADE,
    CHECK (NOT make_private_clip_drafts OR record_private)
);

ALTER TABLE ziipa_live.broadcasts ADD CONSTRAINT broadcast_current_manifest
    FOREIGN KEY (owner_id, id, manifest_revision)
    REFERENCES ziipa_live.manifest_revisions (owner_id, broadcast_id, revision)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX manifest_schedule ON ziipa_live.manifest_revisions (scheduled_at, broadcast_id)
    WHERE scheduled_at IS NOT NULL;

CREATE TABLE ziipa_live.destination_revisions (
    owner_id integer NOT NULL,
    broadcast_id uuid NOT NULL,
    manifest_revision integer NOT NULL,
    destination_id uuid NOT NULL DEFAULT gen_random_uuid(),
    platform text NOT NULL,
    target_ref text NOT NULL, -- Opaque server-owned target, never a stream key or URL.
    variant text NOT NULL CHECK (variant IN ('landscape', 'portrait')),
    audio_mix text NOT NULL,
    required_for_live boolean NOT NULL DEFAULT false,
    metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
    PRIMARY KEY (owner_id, broadcast_id, manifest_revision, destination_id),
    FOREIGN KEY (owner_id, broadcast_id, manifest_revision)
        REFERENCES ziipa_live.manifest_revisions ON DELETE CASCADE,
    UNIQUE (owner_id, broadcast_id, manifest_revision, platform, target_ref)
);

CREATE TABLE ziipa_live.broadcast_runs (
    owner_id integer NOT NULL,
    broadcast_id uuid NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    manifest_revision integer NOT NULL,
    phase text NOT NULL CHECK (phase IN ('armed', 'closing', 'closed')),
    armed_at timestamptz NOT NULL,
    armed_until timestamptz NOT NULL CHECK (armed_until > armed_at),
    closed_at timestamptz,
    PRIMARY KEY (owner_id, broadcast_id, generation),
    UNIQUE (owner_id, broadcast_id, generation, manifest_revision),
    FOREIGN KEY (owner_id, broadcast_id, manifest_revision)
        REFERENCES ziipa_live.manifest_revisions ON DELETE CASCADE,
    CHECK ((phase = 'closed') = (closed_at IS NOT NULL))
);

CREATE UNIQUE INDEX one_nonclosed_live_run ON ziipa_live.broadcast_runs (owner_id, broadcast_id)
    WHERE phase IN ('armed', 'closing');

CREATE TABLE ziipa_live.destination_status (
    owner_id integer NOT NULL,
    broadcast_id uuid NOT NULL,
    generation bigint NOT NULL,
    manifest_revision integer NOT NULL,
    destination_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN (
        'provisioning', 'ready', 'sending', 'playable', 'degraded', 'stopping', 'stopped', 'unknown', 'failed'
    )),
    observation_seq bigint NOT NULL DEFAULT 0 CHECK (observation_seq >= 0),
    observed_at timestamptz NOT NULL,
    playback_verified_at timestamptz,
    provider_binding_ref text,
    evidence_code text NOT NULL,
    PRIMARY KEY (owner_id, broadcast_id, generation, destination_id),
    FOREIGN KEY (owner_id, broadcast_id, generation, manifest_revision)
        REFERENCES ziipa_live.broadcast_runs (owner_id, broadcast_id, generation, manifest_revision) ON DELETE CASCADE,
    FOREIGN KEY (owner_id, broadcast_id, manifest_revision, destination_id)
        REFERENCES ziipa_live.destination_revisions ON DELETE CASCADE,
    CHECK (state <> 'playable' OR playback_verified_at IS NOT NULL),
    CHECK (playback_verified_at IS NULL OR playback_verified_at <= observed_at)
);

CREATE TABLE ziipa_live.commands (
    owner_id integer NOT NULL,
    broadcast_id uuid NOT NULL,
    command_id uuid NOT NULL,
    request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
    applied_state_version bigint NOT NULL CHECK (applied_state_version >= 0),
    response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
    committed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, broadcast_id, command_id),
    FOREIGN KEY (owner_id, broadcast_id) REFERENCES ziipa_live.broadcasts ON DELETE CASCADE
);

-- Durable intent/result for a provider call with an uncertain outcome.
CREATE TABLE ziipa_live.provider_operations (
    owner_id integer NOT NULL,
    broadcast_id uuid NOT NULL,
    generation bigint NOT NULL,
    manifest_revision integer NOT NULL,
    destination_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    operation_kind text NOT NULL CHECK (operation_kind IN ('provision', 'start', 'stop', 'revoke_ingest')),
    request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
    status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_flight', 'applied', 'unknown', 'rejected', 'cancelled')),
    provider_receipt_ref text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, broadcast_id, generation, operation_id),
    FOREIGN KEY (owner_id, broadcast_id, generation, manifest_revision)
        REFERENCES ziipa_live.broadcast_runs (owner_id, broadcast_id, generation, manifest_revision) ON DELETE CASCADE,
    FOREIGN KEY (owner_id, broadcast_id, manifest_revision, destination_id)
        REFERENCES ziipa_live.destination_revisions ON DELETE CASCADE
);

-- Signature verification precedes this insert. Resolve owner and occurrence
-- through the adapter before emitting domain events. An unbound row may hold
-- minimal asset/stream references only; never retain the raw webhook here.
CREATE TABLE ziipa_live.provider_inbox (
    provider text NOT NULL,
    subscription_ref text NOT NULL,
    delivery_id text NOT NULL,
    owner_id integer REFERENCES public.users(id) ON DELETE CASCADE,
    binding_sha256 bytea NOT NULL CHECK (octet_length(binding_sha256) = 32),
    kind text NOT NULL,
    safe_payload jsonb NOT NULL CHECK (jsonb_typeof(safe_payload) = 'object'),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processed', 'ignored', 'quarantined')),
    available_at timestamptz NOT NULL DEFAULT now(),
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, subscription_ref, delivery_id)
);

CREATE INDEX provider_inbox_due ON ziipa_live.provider_inbox (available_at, received_at)
    WHERE state = 'pending';

CREATE TABLE ziipa_live.media_artifacts (
    owner_id integer NOT NULL,
    broadcast_id uuid NOT NULL,
    generation bigint NOT NULL,
    artifact_id uuid NOT NULL DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('master', 'stem', 'marker_index', 'clip')),
    source_artifact_id uuid,
    object_key text NOT NULL UNIQUE, -- Private object-store key, never a signed URL.
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    byte_size bigint NOT NULL CHECK (byte_size > 0),
    committed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, broadcast_id, generation, artifact_id),
    FOREIGN KEY (owner_id, broadcast_id, generation) REFERENCES ziipa_live.broadcast_runs ON DELETE CASCADE,
    FOREIGN KEY (owner_id, broadcast_id, generation, source_artifact_id)
        REFERENCES ziipa_live.media_artifacts ON DELETE CASCADE,
    CHECK (source_artifact_id IS DISTINCT FROM artifact_id)
);

CREATE UNIQUE INDEX one_master_per_run ON ziipa_live.media_artifacts (owner_id, broadcast_id, generation)
    WHERE kind = 'master';

-- Append-only, except for owner erasure or retention maintenance. Body is
-- CloudEvents data; dispatchers serialize envelope columns separately.
CREATE TABLE ziipa_live.events (
    source text NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    owner_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    broadcast_id uuid,
    state_version bigint CHECK (state_version >= 0),
    generation bigint CHECK (generation > 0),
    event_type text NOT NULL,
    subject text NOT NULL,
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
    PRIMARY KEY (source, id),
    UNIQUE (owner_id, source, id),
    FOREIGN KEY (owner_id, broadcast_id) REFERENCES ziipa_live.broadcasts ON DELETE CASCADE,
    FOREIGN KEY (owner_id, broadcast_id, generation) REFERENCES ziipa_live.broadcast_runs ON DELETE CASCADE,
    CHECK (broadcast_id IS NOT NULL OR (state_version IS NULL AND generation IS NULL))
);

CREATE INDEX events_broadcast_history ON ziipa_live.events (owner_id, broadcast_id, recorded_at, id);

CREATE UNIQUE INDEX one_state_event_per_version ON ziipa_live.events (owner_id, broadcast_id, state_version)
    WHERE event_type = 'com.ziipa.broadcast.state.changed.v1';

ALTER TABLE ziipa_live.events ADD CONSTRAINT state_event_has_revision CHECK (
    event_type <> 'com.ziipa.broadcast.state.changed.v1'
    OR (broadcast_id IS NOT NULL AND state_version IS NOT NULL)
);

CREATE TABLE ziipa_live.event_deliveries (
    owner_id integer NOT NULL,
    event_source text NOT NULL,
    event_id uuid NOT NULL,
    consumer text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 12),
    lease_token uuid,
    lease_until timestamptz,
    last_code text CHECK (last_code ~ '^[a-z0-9_]{1,64}$'),
    finished_at timestamptz,
    PRIMARY KEY (event_source, event_id, consumer),
    FOREIGN KEY (owner_id, event_source, event_id) REFERENCES ziipa_live.events (owner_id, source, id) ON DELETE CASCADE,
    CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
    CHECK (status = 'pending' OR lease_token IS NULL),
    CHECK ((status = 'pending') = (finished_at IS NULL))
);

CREATE INDEX event_deliveries_due ON ziipa_live.event_deliveries (consumer, next_attempt_at, event_source, event_id)
    WHERE status = 'pending';

CREATE TABLE ziipa_live.consumer_receipts (
    owner_id integer NOT NULL,
    consumer text NOT NULL,
    event_source text NOT NULL,
    event_id uuid NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_source, event_id),
    FOREIGN KEY (owner_id, event_source, event_id) REFERENCES ziipa_live.events (owner_id, source, id) ON DELETE CASCADE
);

-- Commit these claims before I/O. The same query reclaims expired leases.
CREATE FUNCTION ziipa_live.claim_deliveries(p_consumer text, p_limit integer DEFAULT 16)
RETURNS SETOF ziipa_live.event_deliveries
LANGUAGE sql VOLATILE AS $$
    WITH due AS (
        SELECT d.event_source, d.event_id, d.consumer
        FROM ziipa_live.event_deliveries d
        WHERE d.consumer = p_consumer AND d.status = 'pending' AND d.attempts < 12
          AND d.next_attempt_at <= statement_timestamp()
          AND (d.lease_until IS NULL OR d.lease_until <= statement_timestamp())
        ORDER BY d.next_attempt_at, d.event_source, d.event_id
        LIMIT least(64, greatest(0, coalesce(p_limit, 0)))
        FOR UPDATE SKIP LOCKED
    )
    UPDATE ziipa_live.event_deliveries d
    SET attempts = d.attempts + 1, lease_token = gen_random_uuid(),
        lease_until = statement_timestamp() + interval '30 seconds',
        next_attempt_at = statement_timestamp() + interval '30 seconds'
    FROM due
    WHERE (d.event_source, d.event_id, d.consumer) = (due.event_source, due.event_id, due.consumer)
    RETURNING d.*;
$$;

-- A stale token cannot overwrite a newer claim. Complete DB-local effects and
-- this acknowledgement in the same transaction; roll back if it returns false.
CREATE FUNCTION ziipa_live.finish_delivery(
    p_consumer text, p_source text, p_event_id uuid, p_lease_token uuid,
    p_outcome text, p_code text DEFAULT NULL, p_retry_at timestamptz DEFAULT NULL
)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    WITH finished AS (
        UPDATE ziipa_live.event_deliveries d
        SET status = CASE
                WHEN p_outcome = 'delivered' THEN 'delivered'
                WHEN p_outcome = 'dead' OR d.attempts >= 12 THEN 'dead'
                ELSE 'pending'
            END,
            finished_at = CASE WHEN p_outcome <> 'retry' OR d.attempts >= 12 THEN statement_timestamp() END,
            next_attempt_at = greatest(statement_timestamp() + interval '1 second', p_retry_at),
            last_code = p_code, lease_token = NULL, lease_until = NULL
        WHERE (d.consumer, d.event_source, d.event_id) = (p_consumer, p_source, p_event_id)
          AND d.status = 'pending' AND d.lease_token = p_lease_token
          AND d.lease_until > statement_timestamp()
          AND p_outcome IN ('delivered', 'dead', 'retry')
          AND (p_outcome <> 'retry' OR p_retry_at IS NOT NULL)
        RETURNING 1
    )
    SELECT EXISTS (SELECT FROM finished);
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ziipa_live FROM PUBLIC;

COMMIT;

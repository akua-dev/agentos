CREATE FUNCTION agentos.provider_budget_rate_class_limits(p_rate_class text)
RETURNS TABLE (
  "requestWindowMillis" bigint,
  "tokenWindowMillis" bigint,
  "spendWindowMillis" bigint,
  "maximumRequests" bigint,
  "maximumConcurrent" bigint,
  "maximumTokens" bigint,
  "maximumSpendMicros" bigint,
  "reservationTtlMillis" bigint
)
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT
    limits."requestWindowMillis",
    limits."tokenWindowMillis",
    limits."spendWindowMillis",
    limits."maximumRequests",
    limits."maximumConcurrent",
    limits."maximumTokens",
    limits."maximumSpendMicros",
    limits."reservationTtlMillis"
    FROM (VALUES
      ('disabled', 60000::bigint, 60000::bigint, 3600000::bigint,
        0::bigint, 0::bigint, 0::bigint, 0::bigint, 900000::bigint),
      ('low', 60000::bigint, 60000::bigint, 3600000::bigint,
        12::bigint, 2::bigint, 100000::bigint, 1000000::bigint,
        900000::bigint),
      ('standard', 60000::bigint, 60000::bigint, 3600000::bigint,
        60::bigint, 8::bigint, 1000000::bigint, 10000000::bigint,
        900000::bigint),
      ('high', 60000::bigint, 60000::bigint, 3600000::bigint,
        300::bigint, 32::bigint, 10000000::bigint, 100000000::bigint,
        900000::bigint)
    ) AS limits(
      rate_class, "requestWindowMillis", "tokenWindowMillis",
      "spendWindowMillis", "maximumRequests", "maximumConcurrent",
      "maximumTokens", "maximumSpendMicros", "reservationTtlMillis"
    )
   WHERE limits.rate_class = p_rate_class
$$;

COMMENT ON FUNCTION agentos.provider_budget_rate_class_limits(text) IS
  'Captain-platform v1 registry for deterministic request, concurrency, token and spend classes. Permissions and binding overrides can only select or tighten these finite classes.';

CREATE FUNCTION agentos.valid_provider_budget_target(p_target jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE p_target ->> 'kind'
    WHEN 'binding' THEN
      p_target - ARRAY['kind', 'bindingId'] = '{}'::jsonb
      AND p_target ?& ARRAY['kind', 'bindingId']
      AND p_target ->> 'bindingId' ~ '^binding_[0-9a-f]{32}$'
    WHEN 'profile' THEN
      p_target - ARRAY['kind', 'profileId', 'profileVersion'] = '{}'::jsonb
      AND p_target ?& ARRAY['kind', 'profileId', 'profileVersion']
      AND p_target ->> 'profileId' ~ '^[a-z][a-z0-9-]{0,62}$'
      AND p_target ->> 'profileVersion' ~ '^[1-9][0-9]*$'
    WHEN 'capability' THEN
      p_target - ARRAY['kind', 'provider', 'capability'] = '{}'::jsonb
      AND p_target ?& ARRAY['kind', 'provider', 'capability']
      AND p_target ->> 'provider' IN ('github', 'openai')
      AND p_target ->> 'capability' IN (
        'github.actions.dispatch', 'github.actions.read',
        'github.contents.write', 'github.issue.read', 'github.issue.write',
        'github.project.read', 'github.project.write',
        'github.pull_request.read', 'github.pull_request.write',
        'github.repository.read', 'openai.models.read',
        'openai.responses.compact', 'openai.responses.create',
        'provider.secret.use'
      )
    WHEN 'route' THEN
      p_target - ARRAY[
        'kind', 'provider', 'capability', 'resource', 'environment'
      ] = '{}'::jsonb
      AND p_target ?& ARRAY[
        'kind', 'provider', 'capability', 'resource', 'environment'
      ]
      AND p_target ->> 'provider' IN ('github', 'openai')
      AND p_target ->> 'capability' IN (
        'github.actions.dispatch', 'github.actions.read',
        'github.contents.write', 'github.issue.read', 'github.issue.write',
        'github.project.read', 'github.project.write',
        'github.pull_request.read', 'github.pull_request.write',
        'github.repository.read', 'openai.models.read',
        'openai.responses.compact', 'openai.responses.create',
        'provider.secret.use'
      )
      AND agentos.valid_authorization_resource(p_target -> 'resource')
      AND (
        p_target -> 'environment' = 'null'::jsonb
        OR (
          jsonb_typeof(p_target -> 'environment') = 'string'
          AND p_target ->> 'environment'
            ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
          AND length(p_target ->> 'environment') <= 63
        )
      )
    ELSE false
  END
$$;

CREATE TABLE agentos.provider_budget_counters (
  budget_key text NOT NULL CHECK (budget_key ~ '^budget_[0-9a-f]{64}$'),
  dimension text NOT NULL CHECK (dimension IN ('request', 'token', 'spend')),
  window_started_at_millis bigint NOT NULL
    CHECK (window_started_at_millis >= 0),
  window_ends_at_millis bigint NOT NULL,
  consumed bigint NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  rate_class text NOT NULL
    CHECK (agentos.access_rate_class_rank(rate_class) IS NOT NULL),
  updated_at timestamp with time zone NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (budget_key, dimension, window_started_at_millis),
  CHECK (window_ends_at_millis > window_started_at_millis)
);

CREATE TABLE agentos.provider_budget_reservations (
  decision_ref text PRIMARY KEY
    CHECK (decision_ref ~ '^decision_[0-9a-f]{32}$'),
  budget_key text NOT NULL CHECK (budget_key ~ '^budget_[0-9a-f]{64}$'),
  binding_id text NOT NULL REFERENCES agentos.access_bindings(binding_id)
    ON DELETE RESTRICT,
  subject jsonb NOT NULL CHECK (agentos.valid_access_subject(subject)),
  provider text NOT NULL CHECK (provider IN ('github', 'openai')),
  credential_domain text NOT NULL
    CHECK (
      credential_domain ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
      AND length(credential_domain) <= 63
    ),
  capability text NOT NULL,
  resource jsonb NOT NULL
    CHECK (agentos.valid_authorization_resource(resource)),
  environment text,
  rate_class text NOT NULL
    CHECK (agentos.access_rate_class_rank(rate_class) IS NOT NULL),
  correlation_id text NOT NULL
    CHECK (correlation_id ~ '^corr_[0-9a-f]{32}$'),
  reserved_at_millis bigint NOT NULL CHECK (reserved_at_millis >= 0),
  lease_expires_at_millis bigint NOT NULL,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'settled')),
  forward_outcome text CHECK (
    forward_outcome IS NULL OR forward_outcome IN (
      'completed', 'cancelled', 'provider_rejected', 'transport_failed'
    )
  ),
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cached_input_tokens bigint
    CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  spend_micros bigint CHECK (spend_micros IS NULL OR spend_micros >= 0),
  settled_at_millis bigint CHECK (
    settled_at_millis IS NULL OR settled_at_millis >= reserved_at_millis
  ),
  created_at timestamp with time zone NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamp with time zone NOT NULL DEFAULT transaction_timestamp(),
  CHECK (lease_expires_at_millis > reserved_at_millis),
  CHECK (
    (state = 'active' AND forward_outcome IS NULL
      AND input_tokens IS NULL AND output_tokens IS NULL
      AND cached_input_tokens IS NULL AND spend_micros IS NULL
      AND settled_at_millis IS NULL)
    OR
    (state = 'settled' AND forward_outcome IS NOT NULL
      AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
      AND cached_input_tokens IS NOT NULL AND spend_micros IS NOT NULL
      AND cached_input_tokens <= input_tokens
      AND settled_at_millis IS NOT NULL)
  )
);

CREATE INDEX provider_budget_reservations_active_idx
  ON agentos.provider_budget_reservations (
    budget_key, lease_expires_at_millis
  ) WHERE state = 'active';

CREATE TABLE agentos.provider_budget_overrides (
  override_id text PRIMARY KEY
    CHECK (override_id ~ '^override_[0-9a-f]{32}$'),
  target jsonb NOT NULL CHECK (agentos.valid_provider_budget_target(target)),
  rate_class text NOT NULL
    CHECK (agentos.access_rate_class_rank(rate_class) IS NOT NULL),
  expires_at_millis bigint CHECK (expires_at_millis IS NULL OR expires_at_millis >= 0),
  state text NOT NULL CHECK (state IN ('active', 'revoked')),
  created_by_agent_id uuid NOT NULL REFERENCES agentos.agents(id)
    ON DELETE RESTRICT,
  created_at timestamp with time zone NOT NULL DEFAULT transaction_timestamp(),
  revoked_at timestamp with time zone,
  CHECK (
    (state = 'active' AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE TABLE agentos.provider_budget_control_operations (
  operation_id uuid PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('set', 'revoke')),
  override_id text NOT NULL REFERENCES agentos.provider_budget_overrides(override_id)
    ON DELETE RESTRICT,
  actor_agent_id uuid NOT NULL REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  service_account_uid uuid NOT NULL,
  correlation_id text NOT NULL CHECK (correlation_id ~ '^corr_[0-9a-f]{32}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  reason_code text NOT NULL CHECK (reason_code IN (
    'least_privilege', 'operator_request', 'incident_response', 'break_glass'
  )),
  created_at timestamp with time zone NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE agentos.provider_budget_control_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE
    REFERENCES agentos.provider_budget_control_operations(operation_id)
    ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('set', 'revoke')),
  override_id text NOT NULL,
  target_kind text NOT NULL
    CHECK (target_kind IN ('binding', 'profile', 'capability', 'route')),
  rate_class text NOT NULL
    CHECK (agentos.access_rate_class_rank(rate_class) IS NOT NULL),
  actor_agent_id uuid NOT NULL REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  service_account_uid uuid NOT NULL,
  correlation_id text NOT NULL CHECK (correlation_id ~ '^corr_[0-9a-f]{32}$'),
  reason_code text NOT NULL CHECK (reason_code IN (
    'least_privilege', 'operator_request', 'incident_response', 'break_glass'
  )),
  recorded_at timestamp with time zone NOT NULL DEFAULT transaction_timestamp()
);

CREATE FUNCTION agentos.reserve_provider_budget(
  p_decision_ref text,
  p_budget_key text,
  p_binding_id text,
  p_subject jsonb,
  p_provider text,
  p_credential_domain text,
  p_capability text,
  p_resource jsonb,
  p_environment text,
  p_rate_class text,
  p_correlation_id text,
  p_now_millis bigint
)
RETURNS TABLE (
  "outcome" text,
  "effectiveRateClass" text,
  "retryAtMillis" double precision,
  "requestWindowEndsAtMillis" double precision,
  "tokenWindowEndsAtMillis" double precision,
  "spendWindowEndsAtMillis" double precision,
  "leaseExpiresAtMillis" double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_binding agentos.access_bindings%ROWTYPE;
  v_profile_permissions jsonb;
  v_ceiling_permissions jsonb;
  v_profile_matches integer;
  v_ceiling_matches integer;
  v_ceiling_rate text;
  v_effective_rate text := p_rate_class;
  v_override_rank smallint;
  v_limits record;
  v_request_start bigint;
  v_token_start bigint;
  v_spend_start bigint;
  v_request_end bigint;
  v_token_end bigint;
  v_spend_end bigint;
  v_request_consumed bigint;
  v_token_consumed bigint;
  v_spend_consumed bigint;
  v_active_concurrent bigint;
  v_concurrency_retry bigint;
  v_retry bigint;
  v_existing agentos.provider_budget_reservations%ROWTYPE;
BEGIN
  IF p_decision_ref !~ '^decision_[0-9a-f]{32}$'
     OR p_budget_key !~ '^budget_[0-9a-f]{64}$'
     OR p_binding_id !~ '^binding_[0-9a-f]{32}$'
     OR NOT agentos.valid_access_subject(p_subject)
     OR p_provider NOT IN ('github', 'openai')
     OR p_credential_domain !~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
     OR length(p_credential_domain) > 63
     OR NOT agentos.valid_authorization_resource(p_resource)
     OR agentos.access_rate_class_rank(p_rate_class) IS NULL
     OR p_correlation_id !~ '^corr_[0-9a-f]{32}$'
     OR p_now_millis IS NULL OR p_now_millis < 0 THEN
    RAISE EXCEPTION 'invalid provider budget reservation';
  END IF;

  SELECT reservation.* INTO v_existing
    FROM agentos.provider_budget_reservations AS reservation
   WHERE reservation.decision_ref = p_decision_ref
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.budget_key <> p_budget_key
       OR v_existing.binding_id <> p_binding_id
       OR v_existing.subject <> p_subject
       OR v_existing.provider <> p_provider
       OR v_existing.credential_domain <> p_credential_domain
       OR v_existing.capability <> p_capability
       OR v_existing.resource <> p_resource
       OR v_existing.environment IS DISTINCT FROM p_environment
       OR v_existing.correlation_id <> p_correlation_id THEN
      RAISE EXCEPTION 'provider budget decision reference conflicts';
    END IF;
    SELECT * INTO v_limits
      FROM agentos.provider_budget_rate_class_limits(v_existing.rate_class);
    v_request_end := v_existing.reserved_at_millis - mod(
      v_existing.reserved_at_millis, v_limits."requestWindowMillis"
    ) + v_limits."requestWindowMillis";
    v_token_end := v_existing.reserved_at_millis - mod(
      v_existing.reserved_at_millis, v_limits."tokenWindowMillis"
    ) + v_limits."tokenWindowMillis";
    v_spend_end := v_existing.reserved_at_millis - mod(
      v_existing.reserved_at_millis, v_limits."spendWindowMillis"
    ) + v_limits."spendWindowMillis";
    RETURN QUERY SELECT
      'reserved'::text, v_existing.rate_class, NULL::double precision,
      v_request_end::double precision, v_token_end::double precision,
      v_spend_end::double precision,
      v_existing.lease_expires_at_millis::double precision;
    RETURN;
  END IF;

  SELECT binding.*
    INTO v_binding
    FROM agentos.access_bindings AS binding
    JOIN agentos.access_profiles AS profile
      ON profile.profile_id = binding.profile_id
     AND profile.profile_version = binding.profile_version
    JOIN agentos.access_profile_heads AS head
      ON head.profile_id = profile.profile_id
     AND head.profile_version = profile.profile_version
    JOIN agentos.access_ceilings AS ceiling
      ON ceiling.ceiling_id = binding.ceiling_id
     AND ceiling.revision = binding.ceiling_revision
     AND ceiling.state = 'active'
     AND ceiling.effective_at_millis <= p_now_millis
   WHERE binding.binding_id = p_binding_id
     AND binding.subject = p_subject
     AND binding.state = 'active'
     AND binding.created_at_millis <= p_now_millis
     AND (binding.expires_at_millis IS NULL
       OR binding.expires_at_millis > p_now_millis)
     AND NOT EXISTS (
       SELECT 1 FROM agentos.access_ceilings AS pending
        WHERE pending.ceiling_id = binding.ceiling_id
          AND pending.state = 'pending'
     )
     AND NOT EXISTS (
       SELECT 1 FROM agentos.access_control_operations AS operation
        WHERE operation.phase IN ('prepared', 'verified')
          AND (
            (operation.target_type = 'binding'
              AND operation.target_id = binding.binding_id)
            OR (operation.target_type = 'profile'
              AND operation.target_id = binding.profile_id)
            OR (operation.target_type = 'ceiling'
              AND operation.target_id = binding.ceiling_id)
            OR operation.subjects @> jsonb_build_array(binding.subject)
          )
     );
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'rate_class_disabled'::text, 'disabled'::text, NULL::double precision,
      NULL::double precision, NULL::double precision, NULL::double precision,
      NULL::double precision;
    RETURN;
  END IF;

  SELECT profile.permissions, ceiling.permissions
    INTO v_profile_permissions, v_ceiling_permissions
    FROM agentos.access_profiles AS profile
    JOIN agentos.access_ceilings AS ceiling
      ON ceiling.ceiling_id = v_binding.ceiling_id
     AND ceiling.revision = v_binding.ceiling_revision
   WHERE profile.profile_id = v_binding.profile_id
     AND profile.profile_version = v_binding.profile_version;

  SELECT count(*)::integer
    INTO v_profile_matches
    FROM jsonb_array_elements(v_profile_permissions) AS item(permission)
   WHERE item.permission ->> 'capability' = p_capability
     AND item.permission -> 'resource' = p_resource
     AND item.permission -> 'environment' IS NOT DISTINCT FROM
       coalesce(to_jsonb(p_environment), 'null'::jsonb)
     AND item.permission ->> 'rateClass' = p_rate_class
     AND (item.permission -> 'expiresAtMillis' = 'null'::jsonb
       OR (item.permission ->> 'expiresAtMillis')::bigint > p_now_millis);
  SELECT count(*)::integer, min(item.permission ->> 'rateClass')
    INTO v_ceiling_matches, v_ceiling_rate
    FROM jsonb_array_elements(v_ceiling_permissions) AS item(permission)
   WHERE item.permission ->> 'capability' = p_capability
     AND item.permission -> 'resource' = p_resource
     AND item.permission -> 'environment' IS NOT DISTINCT FROM
       coalesce(to_jsonb(p_environment), 'null'::jsonb)
     AND (item.permission -> 'expiresAtMillis' = 'null'::jsonb
       OR (item.permission ->> 'expiresAtMillis')::bigint > p_now_millis);
  IF v_profile_matches <> 1 OR v_ceiling_matches <> 1
     OR agentos.access_rate_class_rank(p_rate_class) >
        agentos.access_rate_class_rank(v_ceiling_rate) THEN
    RETURN QUERY SELECT
      'rate_class_disabled'::text, 'disabled'::text, NULL::double precision,
      NULL::double precision, NULL::double precision, NULL::double precision,
      NULL::double precision;
    RETURN;
  END IF;

  SELECT min(agentos.access_rate_class_rank(override_value.rate_class))
    INTO v_override_rank
    FROM agentos.provider_budget_overrides AS override_value
   WHERE override_value.state = 'active'
     AND (override_value.expires_at_millis IS NULL
       OR override_value.expires_at_millis > p_now_millis)
     AND CASE override_value.target ->> 'kind'
       WHEN 'binding' THEN
         override_value.target ->> 'bindingId' = p_binding_id
       WHEN 'profile' THEN
         override_value.target ->> 'profileId' = v_binding.profile_id
         AND (override_value.target ->> 'profileVersion')::integer =
           v_binding.profile_version
       WHEN 'capability' THEN
         override_value.target ->> 'provider' = p_provider
         AND override_value.target ->> 'capability' = p_capability
       WHEN 'route' THEN
         override_value.target ->> 'provider' = p_provider
         AND override_value.target ->> 'capability' = p_capability
         AND override_value.target -> 'resource' = p_resource
         AND override_value.target -> 'environment' IS NOT DISTINCT FROM
           coalesce(to_jsonb(p_environment), 'null'::jsonb)
       ELSE false
     END;
  IF v_override_rank IS NOT NULL
     AND v_override_rank < agentos.access_rate_class_rank(v_effective_rate) THEN
    v_effective_rate := CASE v_override_rank
      WHEN 0 THEN 'disabled'
      WHEN 1 THEN 'low'
      WHEN 2 THEN 'standard'
      WHEN 3 THEN 'high'
    END;
  END IF;

  SELECT * INTO v_limits
    FROM agentos.provider_budget_rate_class_limits(v_effective_rate);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider budget rate class is unavailable';
  END IF;
  IF v_limits."maximumRequests" = 0
     OR v_limits."maximumConcurrent" = 0
     OR v_limits."maximumTokens" = 0
     OR v_limits."maximumSpendMicros" = 0 THEN
    RETURN QUERY SELECT
      'rate_class_disabled'::text, v_effective_rate, NULL::double precision,
      NULL::double precision, NULL::double precision, NULL::double precision,
      NULL::double precision;
    RETURN;
  END IF;

  v_request_start := p_now_millis - mod(p_now_millis, v_limits."requestWindowMillis");
  v_token_start := p_now_millis - mod(p_now_millis, v_limits."tokenWindowMillis");
  v_spend_start := p_now_millis - mod(p_now_millis, v_limits."spendWindowMillis");
  v_request_end := v_request_start + v_limits."requestWindowMillis";
  v_token_end := v_token_start + v_limits."tokenWindowMillis";
  v_spend_end := v_spend_start + v_limits."spendWindowMillis";

  INSERT INTO agentos.provider_budget_counters (
    budget_key, dimension, window_started_at_millis, window_ends_at_millis,
    consumed, rate_class
  ) VALUES
    (p_budget_key, 'request', v_request_start, v_request_end, 0, v_effective_rate),
    (p_budget_key, 'token', v_token_start, v_token_end, 0, v_effective_rate),
    (p_budget_key, 'spend', v_spend_start, v_spend_end, 0, v_effective_rate)
  ON CONFLICT (budget_key, dimension, window_started_at_millis) DO NOTHING;

  SELECT counter.consumed INTO v_request_consumed
    FROM agentos.provider_budget_counters AS counter
   WHERE counter.budget_key = p_budget_key
     AND counter.dimension = 'request'
     AND counter.window_started_at_millis = v_request_start
   FOR UPDATE;
  SELECT counter.consumed INTO v_token_consumed
    FROM agentos.provider_budget_counters AS counter
   WHERE counter.budget_key = p_budget_key
     AND counter.dimension = 'token'
     AND counter.window_started_at_millis = v_token_start
   FOR UPDATE;
  SELECT counter.consumed INTO v_spend_consumed
    FROM agentos.provider_budget_counters AS counter
   WHERE counter.budget_key = p_budget_key
     AND counter.dimension = 'spend'
     AND counter.window_started_at_millis = v_spend_start
   FOR UPDATE;

  IF v_token_consumed >= v_limits."maximumTokens"
     OR v_spend_consumed >= v_limits."maximumSpendMicros" THEN
    v_retry := 0;
    IF v_token_consumed >= v_limits."maximumTokens" THEN
      v_retry := greatest(v_retry, v_token_end);
    END IF;
    IF v_spend_consumed >= v_limits."maximumSpendMicros" THEN
      v_retry := greatest(v_retry, v_spend_end);
    END IF;
    RETURN QUERY SELECT
      'budget_exhausted'::text, v_effective_rate, v_retry::double precision,
      v_request_end::double precision, v_token_end::double precision,
      v_spend_end::double precision, NULL::double precision;
    RETURN;
  END IF;

  SELECT count(*)::bigint, min(reservation.lease_expires_at_millis)
    INTO v_active_concurrent, v_concurrency_retry
    FROM agentos.provider_budget_reservations AS reservation
   WHERE reservation.budget_key = p_budget_key
     AND reservation.state = 'active'
     AND reservation.lease_expires_at_millis > p_now_millis;
  IF v_request_consumed >= v_limits."maximumRequests"
     OR v_active_concurrent >= v_limits."maximumConcurrent" THEN
    v_retry := p_now_millis;
    IF v_request_consumed >= v_limits."maximumRequests" THEN
      v_retry := greatest(v_retry, v_request_end);
    END IF;
    IF v_active_concurrent >= v_limits."maximumConcurrent" THEN
      v_retry := greatest(v_retry, coalesce(v_concurrency_retry, p_now_millis));
    END IF;
    RETURN QUERY SELECT
      'rate_limited'::text, v_effective_rate, v_retry::double precision,
      v_request_end::double precision, v_token_end::double precision,
      v_spend_end::double precision, NULL::double precision;
    RETURN;
  END IF;

  UPDATE agentos.provider_budget_counters
     SET consumed = consumed + 1,
         rate_class = v_effective_rate,
         updated_at = transaction_timestamp()
   WHERE budget_key = p_budget_key
     AND dimension = 'request'
     AND window_started_at_millis = v_request_start;
  INSERT INTO agentos.provider_budget_reservations (
    decision_ref, budget_key, binding_id, subject, provider,
    credential_domain, capability, resource, environment, rate_class,
    correlation_id, reserved_at_millis, lease_expires_at_millis
  ) VALUES (
    p_decision_ref, p_budget_key, p_binding_id, p_subject, p_provider,
    p_credential_domain, p_capability, p_resource, p_environment,
    v_effective_rate, p_correlation_id, p_now_millis,
    p_now_millis + v_limits."reservationTtlMillis"
  );
  RETURN QUERY SELECT
    'reserved'::text, v_effective_rate, NULL::double precision,
    v_request_end::double precision, v_token_end::double precision,
    v_spend_end::double precision,
    (p_now_millis + v_limits."reservationTtlMillis")::double precision;
END;
$$;

CREATE FUNCTION agentos.settle_provider_budget(
  p_decision_ref text,
  p_subject jsonb,
  p_forward_outcome text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cached_input_tokens bigint,
  p_spend_micros bigint,
  p_settled_at_millis bigint
)
RETURNS TABLE (
  "outcome" text,
  "forwardOutcome" text,
  "inputTokens" double precision,
  "outputTokens" double precision,
  "cachedInputTokens" double precision,
  "spendMicros" double precision,
  "settledAtMillis" double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_reservation agentos.provider_budget_reservations%ROWTYPE;
  v_limits record;
  v_token_start bigint;
  v_spend_start bigint;
BEGIN
  IF p_decision_ref !~ '^decision_[0-9a-f]{32}$'
     OR NOT agentos.valid_access_subject(p_subject)
     OR p_forward_outcome NOT IN (
       'completed', 'cancelled', 'provider_rejected', 'transport_failed'
     )
     OR p_input_tokens IS NULL OR p_input_tokens < 0
     OR p_output_tokens IS NULL OR p_output_tokens < 0
     OR p_cached_input_tokens IS NULL OR p_cached_input_tokens < 0
     OR p_cached_input_tokens > p_input_tokens
     OR p_spend_micros IS NULL OR p_spend_micros < 0
     OR p_settled_at_millis IS NULL OR p_settled_at_millis < 0 THEN
    RAISE EXCEPTION 'invalid provider budget settlement';
  END IF;
  SELECT reservation.* INTO v_reservation
    FROM agentos.provider_budget_reservations AS reservation
   WHERE reservation.decision_ref = p_decision_ref
   FOR UPDATE;
  IF NOT FOUND OR v_reservation.subject <> p_subject THEN
    RAISE EXCEPTION 'provider budget settlement is unauthorized';
  END IF;
  IF v_reservation.state = 'settled' THEN
    IF v_reservation.forward_outcome <> p_forward_outcome
       OR v_reservation.input_tokens <> p_input_tokens
       OR v_reservation.output_tokens <> p_output_tokens
       OR v_reservation.cached_input_tokens <> p_cached_input_tokens
       OR v_reservation.spend_micros <> p_spend_micros
       OR v_reservation.settled_at_millis <> p_settled_at_millis THEN
      RAISE EXCEPTION 'provider budget settlement conflicts';
    END IF;
    RETURN QUERY SELECT
      'settled'::text, v_reservation.forward_outcome,
      v_reservation.input_tokens::double precision,
      v_reservation.output_tokens::double precision,
      v_reservation.cached_input_tokens::double precision,
      v_reservation.spend_micros::double precision,
      v_reservation.settled_at_millis::double precision;
    RETURN;
  END IF;
  IF p_settled_at_millis < v_reservation.reserved_at_millis THEN
    RAISE EXCEPTION 'provider budget settlement predates reservation';
  END IF;
  SELECT * INTO v_limits
    FROM agentos.provider_budget_rate_class_limits(v_reservation.rate_class);
  v_token_start := p_settled_at_millis -
    mod(p_settled_at_millis, v_limits."tokenWindowMillis");
  v_spend_start := p_settled_at_millis -
    mod(p_settled_at_millis, v_limits."spendWindowMillis");
  INSERT INTO agentos.provider_budget_counters (
    budget_key, dimension, window_started_at_millis, window_ends_at_millis,
    consumed, rate_class
  ) VALUES
    (v_reservation.budget_key, 'token', v_token_start,
      v_token_start + v_limits."tokenWindowMillis", 0,
      v_reservation.rate_class),
    (v_reservation.budget_key, 'spend', v_spend_start,
      v_spend_start + v_limits."spendWindowMillis", 0,
      v_reservation.rate_class)
  ON CONFLICT (budget_key, dimension, window_started_at_millis) DO NOTHING;
  UPDATE agentos.provider_budget_counters
     SET consumed = consumed + p_input_tokens + p_output_tokens,
         updated_at = transaction_timestamp()
   WHERE budget_key = v_reservation.budget_key
     AND dimension = 'token'
     AND window_started_at_millis = v_token_start;
  UPDATE agentos.provider_budget_counters
     SET consumed = consumed + p_spend_micros,
         updated_at = transaction_timestamp()
   WHERE budget_key = v_reservation.budget_key
     AND dimension = 'spend'
     AND window_started_at_millis = v_spend_start;
  UPDATE agentos.provider_budget_reservations
     SET state = 'settled', forward_outcome = p_forward_outcome,
         input_tokens = p_input_tokens, output_tokens = p_output_tokens,
         cached_input_tokens = p_cached_input_tokens,
         spend_micros = p_spend_micros,
         settled_at_millis = p_settled_at_millis,
         updated_at = transaction_timestamp()
   WHERE decision_ref = p_decision_ref;
  RETURN QUERY SELECT
    'settled'::text, p_forward_outcome,
    p_input_tokens::double precision, p_output_tokens::double precision,
    p_cached_input_tokens::double precision, p_spend_micros::double precision,
    p_settled_at_millis::double precision;
END;
$$;

CREATE FUNCTION agentos.mutate_provider_budget_override(
  p_operation_id uuid,
  p_action text,
  p_override_id text,
  p_target jsonb,
  p_rate_class text,
  p_expires_at_millis bigint,
  p_reason_code text,
  p_correlation_id text,
  p_request_digest text,
  p_service_account_uid uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.require_first_mate_access_actor();
  v_existing_operation agentos.provider_budget_control_operations%ROWTYPE;
  v_existing_override agentos.provider_budget_overrides%ROWTYPE;
BEGIN
  SELECT operation.* INTO v_existing_operation
    FROM agentos.provider_budget_control_operations AS operation
   WHERE operation.operation_id = p_operation_id;
  IF FOUND THEN
    IF v_existing_operation.action = p_action
       AND v_existing_operation.override_id = p_override_id
       AND v_existing_operation.actor_agent_id = v_actor_id
       AND v_existing_operation.request_digest = p_request_digest THEN
      SELECT override_value.state INTO STRICT v_existing_override.state
        FROM agentos.provider_budget_overrides AS override_value
       WHERE override_value.override_id = p_override_id;
      RETURN v_existing_override.state;
    END IF;
    RAISE EXCEPTION 'provider budget control operation conflicts';
  END IF;
  IF p_action NOT IN ('set', 'revoke')
     OR p_override_id !~ '^override_[0-9a-f]{32}$'
     OR NOT agentos.valid_provider_budget_target(p_target)
     OR agentos.access_rate_class_rank(p_rate_class) IS NULL
     OR p_expires_at_millis IS NOT NULL AND p_expires_at_millis < 0
     OR p_reason_code NOT IN (
       'least_privilege', 'operator_request', 'incident_response', 'break_glass'
     )
     OR (p_reason_code = 'break_glass' AND p_action <> 'revoke')
     OR p_correlation_id !~ '^corr_[0-9a-f]{32}$'
     OR p_request_digest !~ '^[0-9a-f]{64}$'
     OR p_service_account_uid IS NULL THEN
    RAISE EXCEPTION 'invalid provider budget control operation';
  END IF;
  IF p_target ->> 'kind' = 'binding' AND NOT EXISTS (
    SELECT 1 FROM agentos.access_bindings AS binding
     WHERE binding.binding_id = p_target ->> 'bindingId'
  ) THEN
    RAISE EXCEPTION 'provider budget target does not exist';
  END IF;
  SELECT override_value.* INTO v_existing_override
    FROM agentos.provider_budget_overrides AS override_value
   WHERE override_value.override_id = p_override_id
   FOR UPDATE;
  IF p_action = 'set' THEN
    IF FOUND THEN
      RAISE EXCEPTION 'provider budget override identity already exists';
    END IF;
    INSERT INTO agentos.provider_budget_overrides (
      override_id, target, rate_class, expires_at_millis, state,
      created_by_agent_id
    ) VALUES (
      p_override_id, p_target, p_rate_class, p_expires_at_millis, 'active',
      v_actor_id
    );
  ELSE
    IF NOT FOUND OR v_existing_override.state <> 'active'
       OR v_existing_override.target <> p_target
       OR v_existing_override.rate_class <> p_rate_class
       OR v_existing_override.expires_at_millis
          IS DISTINCT FROM p_expires_at_millis THEN
      RAISE EXCEPTION 'provider budget override revocation requires exact state';
    END IF;
    UPDATE agentos.provider_budget_overrides
       SET state = 'revoked', revoked_at = transaction_timestamp()
     WHERE override_id = p_override_id;
  END IF;
  INSERT INTO agentos.provider_budget_control_operations (
    operation_id, action, override_id, actor_agent_id, service_account_uid,
    correlation_id, request_digest, reason_code
  ) VALUES (
    p_operation_id, p_action, p_override_id, v_actor_id,
    p_service_account_uid, p_correlation_id, p_request_digest, p_reason_code
  );
  INSERT INTO agentos.provider_budget_control_audit (
    operation_id, action, override_id, target_kind, rate_class,
    actor_agent_id, service_account_uid, correlation_id, reason_code
  ) VALUES (
    p_operation_id, p_action, p_override_id, p_target ->> 'kind',
    p_rate_class, v_actor_id, p_service_account_uid, p_correlation_id,
    p_reason_code
  );
  PERFORM pg_notify('agentos_access_control', p_operation_id::text);
  RETURN CASE WHEN p_action = 'set' THEN 'active' ELSE 'revoked' END;
END;
$$;

CREATE FUNCTION agentos.protect_provider_budget_override()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF NEW.override_id IS DISTINCT FROM OLD.override_id
     OR NEW.target IS DISTINCT FROM OLD.target
     OR NEW.rate_class IS DISTINCT FROM OLD.rate_class
     OR NEW.expires_at_millis IS DISTINCT FROM OLD.expires_at_millis
     OR NEW.created_by_agent_id IS DISTINCT FROM OLD.created_by_agent_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.state <> 'active' OR NEW.state <> 'revoked'
     OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'invalid provider budget override transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_budget_overrides_protect
BEFORE UPDATE ON agentos.provider_budget_overrides
FOR EACH ROW EXECUTE FUNCTION agentos.protect_provider_budget_override();
CREATE TRIGGER provider_budget_overrides_no_delete
BEFORE DELETE ON agentos.provider_budget_overrides
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_access_control_history_mutation();
CREATE TRIGGER provider_budget_control_operations_no_mutation
BEFORE UPDATE OR DELETE ON agentos.provider_budget_control_operations
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_access_control_history_mutation();
CREATE TRIGGER provider_budget_control_audit_no_mutation
BEFORE UPDATE OR DELETE ON agentos.provider_budget_control_audit
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_access_control_history_mutation();

REVOKE ALL ON TABLE agentos.provider_budget_counters FROM PUBLIC;
REVOKE ALL ON TABLE agentos.provider_budget_reservations FROM PUBLIC;
REVOKE ALL ON TABLE agentos.provider_budget_overrides FROM PUBLIC;
REVOKE ALL ON TABLE agentos.provider_budget_control_operations FROM PUBLIC;
REVOKE ALL ON TABLE agentos.provider_budget_control_audit FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.provider_budget_rate_class_limits(text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.valid_provider_budget_target(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.reserve_provider_budget(
  text, text, text, jsonb, text, text, text, jsonb, text, text, text, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.settle_provider_budget(
  text, jsonb, text, bigint, bigint, bigint, bigint, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.mutate_provider_budget_override(
  uuid, text, text, jsonb, text, bigint, text, text, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.protect_provider_budget_override() FROM PUBLIC;

CREATE OR REPLACE FUNCTION agentos.configure_egress_authorizer_privileges(
  p_database_role name
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_role oid;
  v_has_dangerous_attributes boolean;
BEGIN
  IF session_user <> current_user THEN
    RAISE EXCEPTION 'egress authorizer privileges require the schema owner';
  END IF;
  SELECT role.oid,
         role.rolsuper OR role.rolcreaterole OR role.rolcreatedb
           OR role.rolreplication OR role.rolbypassrls
    INTO v_role, v_has_dangerous_attributes
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = p_database_role;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'egress authorizer database role does not exist';
  END IF;
  IF v_has_dangerous_attributes THEN
    RAISE EXCEPTION 'egress authorizer database role is privileged';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.member = v_role
  ) THEN
    RAISE EXCEPTION 'egress authorizer database role must not inherit roles';
  END IF;
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA agentos FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA agentos FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA agentos FROM %I',
    p_database_role
  );
  EXECUTE format('GRANT USAGE ON SCHEMA agentos TO %I', p_database_role);
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION agentos.read_egress_workload_agents(text, text), agentos.read_egress_assignments(uuid), agentos.read_egress_policy_snapshots(jsonb), agentos.reserve_provider_budget(text,text,text,jsonb,text,text,text,jsonb,text,text,text,bigint), agentos.settle_provider_budget(text,jsonb,text,bigint,bigint,bigint,bigint,bigint) TO %I',
    p_database_role
  );
END;
$$;

CREATE FUNCTION agentos.configure_provider_budget_control_privileges(
  p_database_role name,
  p_agent_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF session_user <> current_user THEN
    RAISE EXCEPTION 'provider budget privilege configuration requires schema owner';
  END IF;
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION agentos.mutate_provider_budget_override(uuid,text,text,jsonb,text,bigint,text,text,text,uuid) FROM %I',
    p_database_role
  );
  IF p_agent_role = 'first_mate' THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION agentos.mutate_provider_budget_override(uuid,text,text,jsonb,text,bigint,text,text,text,uuid) TO %I',
      p_database_role
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION agentos.configure_provider_budget_control_privileges(
  name, text
) FROM PUBLIC;

DO $$
DECLARE
  v_agent record;
BEGIN
  FOR v_agent IN
    SELECT agent.database_role, agent.role FROM agentos.agents AS agent
     WHERE agent.database_role IS NOT NULL
  LOOP
    PERFORM agentos.configure_provider_budget_control_privileges(
      v_agent.database_role, v_agent.role
    );
  END LOOP;
END;
$$;

CREATE FUNCTION agentos.configure_provider_budget_control_for_agent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF NEW.database_role IS NOT NULL THEN
    PERFORM agentos.configure_provider_budget_control_privileges(
      NEW.database_role, NEW.role
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION agentos.configure_provider_budget_control_for_agent()
  FROM PUBLIC;

CREATE TRIGGER agents_configure_provider_budget_control
AFTER INSERT OR UPDATE OF database_role, role ON agentos.agents
FOR EACH ROW EXECUTE FUNCTION agentos.configure_provider_budget_control_for_agent();

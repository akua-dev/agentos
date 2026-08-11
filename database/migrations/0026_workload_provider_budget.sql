ALTER TABLE agentos.provider_budget_reservations
  ALTER COLUMN binding_id DROP NOT NULL,
  ALTER COLUMN subject DROP NOT NULL,
  ADD COLUMN workload_principal jsonb,
  ADD COLUMN model text,
  ADD COLUMN effective_limits jsonb,
  ADD COLUMN effective_pricing jsonb,
  ADD COLUMN policy_expires_at_millis bigint,
  ADD COLUMN reserved_tokens bigint CHECK (reserved_tokens > 0),
  ADD COLUMN reserved_spend_micros bigint CHECK (reserved_spend_micros > 0),
  ADD COLUMN token_window_started_at_millis bigint,
  ADD COLUMN spend_window_started_at_millis bigint,
  ADD COLUMN attempted_at_millis bigint CHECK (attempted_at_millis >= 0);

ALTER TABLE agentos.provider_budget_reservations
  DROP CONSTRAINT provider_budget_reservations_subject_check,
  ADD CONSTRAINT provider_budget_reservations_subject_check CHECK (
    subject IS NULL OR agentos.valid_access_subject(subject)
  );

ALTER TABLE agentos.provider_budget_reservations
  ADD CONSTRAINT provider_budget_reservation_authority_check CHECK (
    (binding_id IS NOT NULL AND subject IS NOT NULL
      AND workload_principal IS NULL AND model IS NULL
      AND effective_limits IS NULL AND effective_pricing IS NULL
      AND policy_expires_at_millis IS NULL)
    OR
    (binding_id IS NULL AND subject IS NULL
      AND workload_principal IS NOT NULL AND model IS NOT NULL
      AND effective_limits IS NOT NULL AND effective_pricing IS NOT NULL
      AND policy_expires_at_millis IS NOT NULL)
  );

CREATE FUNCTION agentos.valid_workload_budget_principal(p_value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = agentos, pg_temp AS $$
  SELECT jsonb_typeof(p_value) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(p_value)) = 9
    AND p_value ->> 'kind' = 'kubernetes_workload'
    AND p_value ->> 'namespace' ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
    AND length(p_value ->> 'namespace') <= 63
    AND p_value ->> 'serviceAccountName' ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
    AND length(p_value ->> 'serviceAccountName') <= 63
    AND length(p_value ->> 'serviceAccountUid') BETWEEN 1 AND 128
    AND p_value ->> 'podName' ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
    AND length(p_value ->> 'podName') <= 63
    AND length(p_value ->> 'podUid') BETWEEN 1 AND 128
    AND jsonb_typeof(p_value -> 'policyRevision') = 'number'
    AND (p_value ->> 'policyRevision')::bigint > 0
    AND p_value ->> 'policyResourceVersion' ~ '^[1-9][0-9]*$'
    AND p_value ->> 'hermesProfile' ~ '^[a-z][a-z0-9._-]*$'
    AND length(p_value ->> 'hermesProfile') <= 96
$$;

CREATE FUNCTION agentos.valid_workload_budget_limits(p_value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = agentos, pg_temp AS $$
  SELECT jsonb_typeof(p_value) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(p_value)) = 7
    AND p_value ?& ARRAY[
      'requestWindowMillis', 'maximumRequests', 'maximumConcurrent',
      'tokenWindowMillis', 'maximumTokens', 'spendWindowMillis',
      'maximumSpendMicros'
    ]
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p_value) AS item
       WHERE jsonb_typeof(item.value) <> 'number'
          OR item.value::text !~ '^[1-9][0-9]*$'
    )
$$;

CREATE FUNCTION agentos.reserve_workload_provider_budget(
  p_decision_ref text, p_budget_key text, p_correlation_id text,
  p_principal jsonb, p_provider text, p_credential_domain text,
  p_capability text, p_resource jsonb, p_environment text, p_model text,
  p_rate_class text, p_limits jsonb, p_pricing jsonb,
  p_policy_expires_at_millis bigint,
  p_requested_tokens bigint, p_requested_spend_micros bigint, p_now_millis bigint
)
RETURNS TABLE (
  "outcome" text, "effectiveRateClass" text, "retryAtMillis" double precision,
  "requestWindowEndsAtMillis" double precision,
  "tokenWindowEndsAtMillis" double precision,
  "spendWindowEndsAtMillis" double precision,
  "leaseExpiresAtMillis" double precision
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agentos, pg_temp AS $$
DECLARE
  v_existing agentos.provider_budget_reservations%ROWTYPE;
  v_request_start bigint; v_token_start bigint; v_spend_start bigint;
  v_request_end bigint; v_token_end bigint; v_spend_end bigint;
  v_request_consumed bigint; v_token_consumed bigint; v_spend_consumed bigint;
  v_token_reserved bigint; v_spend_reserved bigint;
  v_active_concurrent bigint; v_concurrency_retry bigint; v_retry bigint;
  v_lease_expires bigint;
BEGIN
  IF p_decision_ref !~ '^decision_[0-9a-f]{32}$'
    OR p_budget_key !~ '^budget_[0-9a-f]{64}$'
    OR p_correlation_id !~ '^corr_[0-9a-f]{32}$'
    OR NOT agentos.valid_workload_budget_principal(p_principal)
    OR p_provider <> 'openai' OR p_credential_domain <> 'openai-responses'
    OR p_capability NOT IN ('openai.responses.create', 'openai.responses.compact')
    OR p_resource <> jsonb_build_object('kind', 'provider_service',
      'provider', 'openai', 'service', 'responses')
    OR p_environment IS NULL
    OR p_environment !~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
    OR length(p_environment) > 63
    OR p_model !~ '^[a-z0-9][a-z0-9._:-]*$' OR length(p_model) > 128
    OR p_rate_class NOT IN ('low', 'standard', 'high')
    OR NOT agentos.valid_workload_budget_limits(p_limits)
    OR jsonb_typeof(p_pricing) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_pricing)) <> 3
    OR NOT p_pricing ?& ARRAY['version','inputMicrosPerMillionTokens','outputMicrosPerMillionTokens']
    OR EXISTS (SELECT 1 FROM jsonb_each(p_pricing) item
      WHERE jsonb_typeof(item.value) <> 'number'
        OR item.value::text !~ '^[1-9][0-9]*$')
    OR p_requested_tokens IS NULL OR p_requested_tokens <= 0
    OR p_requested_tokens > (p_limits ->> 'maximumTokens')::bigint
    OR p_requested_spend_micros IS NULL OR p_requested_spend_micros <= 0
    OR p_requested_spend_micros > (p_limits ->> 'maximumSpendMicros')::bigint
    OR p_policy_expires_at_millis IS NULL OR p_now_millis IS NULL
    OR p_now_millis < 0 OR p_policy_expires_at_millis <= p_now_millis THEN
    RAISE EXCEPTION 'invalid workload provider budget reservation';
  END IF;

  SELECT reservation.* INTO v_existing
    FROM agentos.provider_budget_reservations AS reservation
   WHERE reservation.decision_ref = p_decision_ref FOR UPDATE;
  IF FOUND THEN
    IF v_existing.budget_key <> p_budget_key
      OR v_existing.correlation_id <> p_correlation_id
      OR v_existing.workload_principal <> p_principal
      OR v_existing.provider <> p_provider
      OR v_existing.credential_domain <> p_credential_domain
      OR v_existing.capability <> p_capability
      OR v_existing.resource <> p_resource
      OR v_existing.environment IS DISTINCT FROM p_environment
      OR v_existing.model <> p_model OR v_existing.rate_class <> p_rate_class
      OR v_existing.effective_limits <> p_limits
      OR v_existing.effective_pricing <> p_pricing
      OR v_existing.reserved_tokens <> p_requested_tokens
      OR v_existing.reserved_spend_micros <> p_requested_spend_micros
      OR v_existing.policy_expires_at_millis <> p_policy_expires_at_millis THEN
      RAISE EXCEPTION 'workload provider budget decision reference conflicts';
    END IF;
    IF v_existing.state <> 'active' OR v_existing.attempted_at_millis IS NOT NULL
      OR v_existing.lease_expires_at_millis <= p_now_millis
      OR v_existing.policy_expires_at_millis <= p_now_millis THEN
      RAISE EXCEPTION 'workload provider budget reservation is not active';
    END IF;
    RETURN QUERY SELECT 'reserved'::text, v_existing.rate_class,
      NULL::double precision,
      (v_existing.reserved_at_millis - mod(v_existing.reserved_at_millis,
        (p_limits ->> 'requestWindowMillis')::bigint)
        + (p_limits ->> 'requestWindowMillis')::bigint)::double precision,
      (v_existing.reserved_at_millis - mod(v_existing.reserved_at_millis,
        (p_limits ->> 'tokenWindowMillis')::bigint)
        + (p_limits ->> 'tokenWindowMillis')::bigint)::double precision,
      (v_existing.reserved_at_millis - mod(v_existing.reserved_at_millis,
        (p_limits ->> 'spendWindowMillis')::bigint)
        + (p_limits ->> 'spendWindowMillis')::bigint)::double precision,
      v_existing.lease_expires_at_millis::double precision;
    RETURN;
  END IF;

  v_request_start := p_now_millis - mod(p_now_millis,
    (p_limits ->> 'requestWindowMillis')::bigint);
  v_token_start := p_now_millis - mod(p_now_millis,
    (p_limits ->> 'tokenWindowMillis')::bigint);
  v_spend_start := p_now_millis - mod(p_now_millis,
    (p_limits ->> 'spendWindowMillis')::bigint);
  v_request_end := v_request_start + (p_limits ->> 'requestWindowMillis')::bigint;
  v_token_end := v_token_start + (p_limits ->> 'tokenWindowMillis')::bigint;
  v_spend_end := v_spend_start + (p_limits ->> 'spendWindowMillis')::bigint;
  v_lease_expires := least(p_policy_expires_at_millis, p_now_millis + 900000);

  INSERT INTO agentos.provider_budget_counters
    (budget_key, dimension, window_started_at_millis, window_ends_at_millis,
     consumed, rate_class)
  VALUES
    (p_budget_key, 'request', v_request_start, v_request_end, 0, p_rate_class),
    (p_budget_key, 'token', v_token_start, v_token_end, 0, p_rate_class),
    (p_budget_key, 'spend', v_spend_start, v_spend_end, 0, p_rate_class)
  ON CONFLICT (budget_key, dimension, window_started_at_millis) DO NOTHING;
  SELECT consumed INTO v_request_consumed FROM agentos.provider_budget_counters
   WHERE budget_key = p_budget_key AND dimension = 'request'
     AND window_started_at_millis = v_request_start FOR UPDATE;
  SELECT consumed INTO v_token_consumed FROM agentos.provider_budget_counters
   WHERE budget_key = p_budget_key AND dimension = 'token'
     AND window_started_at_millis = v_token_start FOR UPDATE;
  SELECT consumed INTO v_spend_consumed FROM agentos.provider_budget_counters
   WHERE budget_key = p_budget_key AND dimension = 'spend'
     AND window_started_at_millis = v_spend_start FOR UPDATE;

  SELECT coalesce(sum(reserved_tokens), 0) INTO v_token_reserved
    FROM agentos.provider_budget_reservations
   WHERE budget_key = p_budget_key AND state = 'active'
     AND (attempted_at_millis IS NOT NULL OR lease_expires_at_millis > p_now_millis)
     AND token_window_started_at_millis = v_token_start;
  SELECT coalesce(sum(reserved_spend_micros), 0) INTO v_spend_reserved
    FROM agentos.provider_budget_reservations
   WHERE budget_key = p_budget_key AND state = 'active'
     AND (attempted_at_millis IS NOT NULL OR lease_expires_at_millis > p_now_millis)
     AND spend_window_started_at_millis = v_spend_start;

  IF v_token_consumed + v_token_reserved + p_requested_tokens >
      (p_limits ->> 'maximumTokens')::bigint
    OR v_spend_consumed + v_spend_reserved + p_requested_spend_micros >
      (p_limits ->> 'maximumSpendMicros')::bigint THEN
    v_retry := greatest(
      CASE WHEN v_token_consumed + v_token_reserved > 0
        THEN v_token_end ELSE 0 END,
      CASE WHEN v_spend_consumed + v_spend_reserved > 0
        THEN v_spend_end ELSE 0 END);
    RETURN QUERY SELECT 'budget_exhausted'::text, p_rate_class,
      v_retry::double precision, v_request_end::double precision,
      v_token_end::double precision, v_spend_end::double precision,
      NULL::double precision;
    RETURN;
  END IF;
  SELECT count(*)::bigint, min(lease_expires_at_millis)
    INTO v_active_concurrent, v_concurrency_retry
    FROM agentos.provider_budget_reservations
   WHERE budget_key = p_budget_key AND state = 'active'
     AND (attempted_at_millis IS NOT NULL OR lease_expires_at_millis > p_now_millis);
  IF v_request_consumed >= (p_limits ->> 'maximumRequests')::bigint
    OR v_active_concurrent >= (p_limits ->> 'maximumConcurrent')::bigint THEN
    v_retry := greatest(
      CASE WHEN v_request_consumed >= (p_limits ->> 'maximumRequests')::bigint
        THEN v_request_end ELSE p_now_millis END,
      CASE WHEN v_active_concurrent >= (p_limits ->> 'maximumConcurrent')::bigint
        THEN coalesce(v_concurrency_retry, p_now_millis) ELSE p_now_millis END);
    RETURN QUERY SELECT 'rate_limited'::text, p_rate_class,
      v_retry::double precision, v_request_end::double precision,
      v_token_end::double precision, v_spend_end::double precision,
      NULL::double precision;
    RETURN;
  END IF;

  UPDATE agentos.provider_budget_counters SET consumed = consumed + 1,
    updated_at = transaction_timestamp()
   WHERE budget_key = p_budget_key AND dimension = 'request'
     AND window_started_at_millis = v_request_start;
  INSERT INTO agentos.provider_budget_reservations (
    decision_ref, budget_key, workload_principal, provider, credential_domain,
    capability, resource, environment, model, rate_class, effective_limits,
    effective_pricing,
    policy_expires_at_millis, correlation_id, reserved_at_millis,
    lease_expires_at_millis, reserved_tokens, reserved_spend_micros,
    token_window_started_at_millis, spend_window_started_at_millis
  ) VALUES (
    p_decision_ref, p_budget_key, p_principal, p_provider, p_credential_domain,
    p_capability, p_resource, p_environment, p_model, p_rate_class, p_limits,
    p_pricing,
    p_policy_expires_at_millis, p_correlation_id, p_now_millis, v_lease_expires,
    p_requested_tokens, p_requested_spend_micros, v_token_start, v_spend_start
  );
  RETURN QUERY SELECT 'reserved'::text, p_rate_class, NULL::double precision,
    v_request_end::double precision, v_token_end::double precision,
    v_spend_end::double precision, v_lease_expires::double precision;
END;
$$;

REVOKE ALL ON FUNCTION agentos.valid_workload_budget_principal(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.valid_workload_budget_limits(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.reserve_workload_provider_budget(
  text,text,text,jsonb,text,text,text,jsonb,text,text,text,jsonb,jsonb,bigint,bigint,bigint,bigint
) FROM PUBLIC;

CREATE FUNCTION agentos.validate_workload_provider_budget(
  p_decision_ref text, p_correlation_id text, p_principal jsonb,
  p_provider text, p_credential_domain text, p_capability text,
  p_resource jsonb, p_model text, p_rate_class text, p_limits jsonb,
  p_pricing jsonb, p_requested_tokens bigint, p_requested_spend_micros bigint,
  p_expires_at_millis bigint, p_now_millis bigint
)
RETURNS TABLE ("outcome" text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = agentos, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  IF p_decision_ref !~ '^decision_[0-9a-f]{32}$'
    OR p_correlation_id !~ '^corr_[0-9a-f]{32}$'
    OR jsonb_typeof(p_principal) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_principal)) <> 6
    OR p_provider <> 'openai' OR p_credential_domain <> 'openai-responses'
    OR p_capability NOT IN ('openai.responses.create', 'openai.responses.compact')
    OR NOT agentos.valid_workload_budget_limits(p_limits)
    OR jsonb_typeof(p_pricing) <> 'object'
    OR p_requested_tokens <= 0 OR p_requested_spend_micros <= 0
    OR p_now_millis IS NULL OR p_now_millis < 0 THEN
    RAISE EXCEPTION 'invalid workload provider budget validation';
  END IF;
  SELECT count(*)::integer INTO v_count
    FROM agentos.provider_budget_reservations AS reservation
   WHERE reservation.decision_ref = p_decision_ref
     AND reservation.correlation_id = p_correlation_id
     AND reservation.workload_principal
       - 'serviceAccountUid' - 'podName' - 'podUid' = p_principal
     AND reservation.provider = p_provider
     AND reservation.credential_domain = p_credential_domain
     AND reservation.capability = p_capability
     AND reservation.resource = p_resource
     AND reservation.model = p_model
     AND reservation.rate_class = p_rate_class
     AND reservation.effective_limits = p_limits
     AND reservation.effective_pricing = p_pricing
     AND reservation.reserved_tokens = p_requested_tokens
     AND reservation.reserved_spend_micros = p_requested_spend_micros
     AND reservation.policy_expires_at_millis = p_expires_at_millis
     AND reservation.state = 'active'
     AND reservation.attempted_at_millis IS NULL
     AND reservation.lease_expires_at_millis > p_now_millis
     AND reservation.policy_expires_at_millis > p_now_millis;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'workload provider budget reservation unavailable';
  END IF;
  UPDATE agentos.provider_budget_reservations
     SET attempted_at_millis = p_now_millis, updated_at = transaction_timestamp()
   WHERE decision_ref = p_decision_ref AND state = 'active'
     AND attempted_at_millis IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'workload provider budget attempt already claimed';
  END IF;
  RETURN QUERY SELECT 'attempted'::text;
END;
$$;

REVOKE ALL ON FUNCTION agentos.validate_workload_provider_budget(
  text,text,jsonb,text,text,text,jsonb,text,text,jsonb,jsonb,bigint,bigint,bigint,bigint
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION agentos.configure_egress_authorizer_privileges(
  p_database_role name
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = agentos, pg_temp AS $$
DECLARE v_role oid; v_dangerous boolean;
BEGIN
  IF session_user <> current_user THEN
    RAISE EXCEPTION 'egress authorizer privileges require the schema owner';
  END IF;
  SELECT oid, rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication
      OR rolbypassrls INTO v_role, v_dangerous
    FROM pg_catalog.pg_roles WHERE rolname = p_database_role;
  IF v_role IS NULL OR v_dangerous THEN
    RAISE EXCEPTION 'egress authorizer database role is unavailable or privileged';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = v_role) THEN
    RAISE EXCEPTION 'egress authorizer database role must not inherit roles';
  END IF;
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA agentos FROM %I', p_database_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA agentos FROM %I', p_database_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA agentos FROM %I', p_database_role);
  EXECUTE format('GRANT USAGE ON SCHEMA agentos TO %I', p_database_role);
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION agentos.read_egress_workload_agents(text,text), agentos.read_egress_assignments(uuid), agentos.read_egress_policy_snapshots(jsonb), agentos.reserve_workload_provider_budget(text,text,text,jsonb,text,text,text,jsonb,text,text,text,jsonb,jsonb,bigint,bigint,bigint,bigint), agentos.validate_workload_provider_budget(text,text,jsonb,text,text,text,jsonb,text,text,jsonb,jsonb,bigint,bigint,bigint,bigint), agentos.settle_provider_budget_for_provider(text,text,text,text,bigint,bigint,bigint,bigint,bigint) TO %I',
    p_database_role);
END;
$$;

CREATE OR REPLACE FUNCTION agentos.settle_provider_budget_for_provider(
  p_decision_ref text, p_provider text, p_credential_domain text,
  p_forward_outcome text, p_input_tokens bigint, p_output_tokens bigint,
  p_cached_input_tokens bigint, p_spend_micros bigint,
  p_settled_at_millis bigint
)
RETURNS TABLE (
  "outcome" text, "forwardOutcome" text, "inputTokens" double precision,
  "outputTokens" double precision, "cachedInputTokens" double precision,
  "spendMicros" double precision, "settledAtMillis" double precision
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agentos, pg_temp AS $$
DECLARE
  v_reservation agentos.provider_budget_reservations%ROWTYPE;
  v_token_start bigint; v_spend_start bigint;
  v_calculated_spend bigint;
BEGIN
  IF p_decision_ref !~ '^decision_[0-9a-f]{32}$'
    OR p_provider NOT IN ('github', 'openai')
    OR p_credential_domain !~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
    OR length(p_credential_domain) > 63
    OR p_forward_outcome NOT IN
      ('completed', 'cancelled', 'provider_rejected', 'transport_failed')
    OR p_input_tokens IS NULL OR p_input_tokens < 0
    OR p_output_tokens IS NULL OR p_output_tokens < 0
    OR p_cached_input_tokens IS NULL OR p_cached_input_tokens < 0
    OR p_cached_input_tokens > p_input_tokens
    OR p_spend_micros IS NULL OR p_spend_micros < 0
    OR p_settled_at_millis IS NULL OR p_settled_at_millis < 0 THEN
    RAISE EXCEPTION 'invalid provider budget provider settlement';
  END IF;
  SELECT reservation.* INTO v_reservation
    FROM agentos.provider_budget_reservations AS reservation
   WHERE reservation.decision_ref = p_decision_ref FOR UPDATE;
  IF NOT FOUND OR v_reservation.provider <> p_provider
    OR v_reservation.credential_domain <> p_credential_domain THEN
    RAISE EXCEPTION 'provider budget provider settlement is unauthorized';
  END IF;
  IF v_reservation.workload_principal IS NULL THEN
    RETURN QUERY SELECT * FROM agentos.settle_provider_budget(
      p_decision_ref, v_reservation.subject, p_forward_outcome,
      p_input_tokens, p_output_tokens, p_cached_input_tokens, p_spend_micros,
      p_settled_at_millis);
    RETURN;
  END IF;
  v_calculated_spend := ceil((
    p_input_tokens::numeric * (v_reservation.effective_pricing ->> 'inputMicrosPerMillionTokens')::numeric +
    p_output_tokens::numeric * (v_reservation.effective_pricing ->> 'outputMicrosPerMillionTokens')::numeric
  ) / 1000000)::bigint;
  IF p_spend_micros <> v_calculated_spend THEN
    RAISE EXCEPTION 'provider budget settlement pricing conflicts';
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
    RETURN QUERY SELECT 'settled'::text, v_reservation.forward_outcome,
      v_reservation.input_tokens::double precision,
      v_reservation.output_tokens::double precision,
      v_reservation.cached_input_tokens::double precision,
      v_reservation.spend_micros::double precision,
      v_reservation.settled_at_millis::double precision;
    RETURN;
  END IF;
  IF v_reservation.state <> 'active'
    OR v_reservation.attempted_at_millis IS NULL THEN
    RAISE EXCEPTION 'provider budget reservation has no claimed attempt';
  END IF;
  IF p_settled_at_millis < v_reservation.reserved_at_millis THEN
    RAISE EXCEPTION 'provider budget settlement predates reservation';
  END IF;
  IF p_input_tokens + p_output_tokens > v_reservation.reserved_tokens
    OR p_spend_micros > v_reservation.reserved_spend_micros THEN
    RAISE EXCEPTION 'provider budget settlement exceeds reservation';
  END IF;
  v_token_start := v_reservation.token_window_started_at_millis;
  v_spend_start := v_reservation.spend_window_started_at_millis;
  INSERT INTO agentos.provider_budget_counters
    (budget_key, dimension, window_started_at_millis, window_ends_at_millis,
     consumed, rate_class)
  VALUES
    (v_reservation.budget_key, 'token', v_token_start,
      v_token_start + (v_reservation.effective_limits ->> 'tokenWindowMillis')::bigint,
      0, v_reservation.rate_class),
    (v_reservation.budget_key, 'spend', v_spend_start,
      v_spend_start + (v_reservation.effective_limits ->> 'spendWindowMillis')::bigint,
      0, v_reservation.rate_class)
  ON CONFLICT (budget_key, dimension, window_started_at_millis) DO NOTHING;
  UPDATE agentos.provider_budget_counters
     SET consumed = consumed + p_input_tokens + p_output_tokens,
         updated_at = transaction_timestamp()
   WHERE budget_key = v_reservation.budget_key AND dimension = 'token'
     AND window_started_at_millis = v_token_start;
  UPDATE agentos.provider_budget_counters
     SET consumed = consumed + p_spend_micros,
         updated_at = transaction_timestamp()
   WHERE budget_key = v_reservation.budget_key AND dimension = 'spend'
     AND window_started_at_millis = v_spend_start;
  UPDATE agentos.provider_budget_reservations SET state = 'settled',
    forward_outcome = p_forward_outcome, input_tokens = p_input_tokens,
    output_tokens = p_output_tokens, cached_input_tokens = p_cached_input_tokens,
    spend_micros = p_spend_micros, settled_at_millis = p_settled_at_millis,
    updated_at = transaction_timestamp()
   WHERE decision_ref = p_decision_ref;
  RETURN QUERY SELECT 'settled'::text, p_forward_outcome,
    p_input_tokens::double precision, p_output_tokens::double precision,
    p_cached_input_tokens::double precision, p_spend_micros::double precision,
    p_settled_at_millis::double precision;
END;
$$;

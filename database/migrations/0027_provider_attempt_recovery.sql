ALTER TABLE agentos.provider_budget_reservations
  ADD COLUMN attempt_lease_expires_at_millis bigint
    CHECK (attempt_lease_expires_at_millis IS NULL OR attempt_lease_expires_at_millis >= 0);

CREATE OR REPLACE FUNCTION agentos.validate_workload_provider_budget(
  p_decision_ref text, p_correlation_id text, p_principal jsonb,
  p_provider text, p_credential_domain text, p_capability text,
  p_resource jsonb, p_model text, p_rate_class text, p_limits jsonb,
  p_pricing jsonb, p_requested_tokens bigint, p_requested_spend_micros bigint,
  p_expires_at_millis bigint, p_now_millis bigint
)
RETURNS TABLE ("outcome" text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agentos, pg_temp AS $$
DECLARE v_reservation agentos.provider_budget_reservations%ROWTYPE;
BEGIN
  SELECT reservation.* INTO v_reservation
    FROM agentos.provider_budget_reservations reservation
   WHERE reservation.decision_ref = p_decision_ref FOR UPDATE;
  IF NOT FOUND OR v_reservation.correlation_id <> p_correlation_id
    OR v_reservation.workload_principal - 'serviceAccountUid' - 'podName' - 'podUid' <> p_principal
    OR v_reservation.provider <> p_provider
    OR v_reservation.credential_domain <> p_credential_domain
    OR v_reservation.capability <> p_capability OR v_reservation.resource <> p_resource
    OR v_reservation.model <> p_model OR v_reservation.rate_class <> p_rate_class
    OR v_reservation.effective_limits <> p_limits OR v_reservation.effective_pricing <> p_pricing
    OR v_reservation.reserved_tokens <> p_requested_tokens
    OR v_reservation.reserved_spend_micros <> p_requested_spend_micros
    OR v_reservation.policy_expires_at_millis <> p_expires_at_millis
    OR v_reservation.state <> 'active' OR v_reservation.attempted_at_millis IS NOT NULL
    OR v_reservation.lease_expires_at_millis <= p_now_millis
    OR v_reservation.policy_expires_at_millis <= p_now_millis THEN
    RAISE EXCEPTION 'workload provider budget reservation unavailable';
  END IF;
  UPDATE agentos.provider_budget_reservations SET attempted_at_millis = p_now_millis,
    attempt_lease_expires_at_millis = p_now_millis + 900000,
    updated_at = transaction_timestamp()
   WHERE decision_ref = p_decision_ref;
  RETURN QUERY SELECT 'attempted'::text;
END;
$$;

ALTER FUNCTION agentos.settle_provider_budget_for_provider(
  text,text,text,text,bigint,bigint,bigint,bigint,bigint
) RENAME TO settle_provider_budget_for_provider_timestamped;

CREATE FUNCTION agentos.settle_provider_budget_for_provider(
  p_decision_ref text, p_provider text, p_credential_domain text,
  p_forward_outcome text, p_input_tokens bigint, p_output_tokens bigint,
  p_cached_input_tokens bigint, p_spend_micros bigint, p_settled_at_millis bigint
)
RETURNS TABLE (
  "outcome" text, "forwardOutcome" text, "inputTokens" double precision,
  "outputTokens" double precision, "cachedInputTokens" double precision,
  "spendMicros" double precision, "settledAtMillis" double precision
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agentos, pg_temp AS $$
DECLARE v_row agentos.provider_budget_reservations%ROWTYPE;
BEGIN
  SELECT reservation.* INTO v_row FROM agentos.provider_budget_reservations reservation
   WHERE decision_ref = p_decision_ref FOR UPDATE;
  IF FOUND AND v_row.state = 'settled' THEN
    IF v_row.provider <> p_provider OR v_row.credential_domain <> p_credential_domain
      OR v_row.forward_outcome <> p_forward_outcome
      OR v_row.input_tokens <> p_input_tokens OR v_row.output_tokens <> p_output_tokens
      OR v_row.cached_input_tokens <> p_cached_input_tokens
      OR v_row.spend_micros <> p_spend_micros THEN
      RAISE EXCEPTION 'provider budget settlement conflicts';
    END IF;
    RETURN QUERY SELECT 'settled'::text, v_row.forward_outcome,
      v_row.input_tokens::double precision, v_row.output_tokens::double precision,
      v_row.cached_input_tokens::double precision, v_row.spend_micros::double precision,
      v_row.settled_at_millis::double precision;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM agentos.settle_provider_budget_for_provider_timestamped(
    p_decision_ref,p_provider,p_credential_domain,p_forward_outcome,p_input_tokens,
    p_output_tokens,p_cached_input_tokens,p_spend_micros,p_settled_at_millis);
END;
$$;

REVOKE ALL ON FUNCTION agentos.settle_provider_budget_for_provider(
  text,text,text,text,bigint,bigint,bigint,bigint,bigint
) FROM PUBLIC;

ALTER FUNCTION agentos.reserve_workload_provider_budget(
  text,text,text,jsonb,text,text,text,jsonb,text,text,text,jsonb,jsonb,
  bigint,bigint,bigint,bigint
) RENAME TO reserve_workload_provider_budget_unreconciled;

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
BEGIN
  PERFORM * FROM agentos.recover_expired_workload_provider_attempts(p_now_millis, 100);
  RETURN QUERY SELECT * FROM agentos.reserve_workload_provider_budget_unreconciled(
    p_decision_ref,p_budget_key,p_correlation_id,p_principal,p_provider,
    p_credential_domain,p_capability,p_resource,p_environment,p_model,p_rate_class,
    p_limits,p_pricing,p_policy_expires_at_millis,p_requested_tokens,
    p_requested_spend_micros,p_now_millis);
END;
$$;

CREATE FUNCTION agentos.renew_workload_provider_attempt(
  p_decision_ref text, p_provider text, p_credential_domain text,
  p_now_millis bigint
)
RETURNS TABLE ("outcome" text, "leaseExpiresAtMillis" double precision)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agentos, pg_temp AS $$
DECLARE v_attempted bigint; v_lease bigint;
BEGIN
  SELECT attempted_at_millis, attempt_lease_expires_at_millis
    INTO v_attempted, v_lease FROM agentos.provider_budget_reservations
   WHERE decision_ref = p_decision_ref AND state = 'active'
     AND provider = p_provider AND credential_domain = p_credential_domain
   FOR UPDATE;
  IF NOT FOUND OR v_attempted IS NULL OR v_lease <= p_now_millis
    OR p_now_millis >= v_attempted + 900000 THEN
    RAISE EXCEPTION 'provider attempt lease unavailable';
  END IF;
  v_lease := least(v_attempted + 900000, p_now_millis + 60000);
  UPDATE agentos.provider_budget_reservations
     SET attempt_lease_expires_at_millis = v_lease, updated_at = transaction_timestamp()
   WHERE decision_ref = p_decision_ref;
  RETURN QUERY SELECT 'renewed'::text, v_lease::double precision;
END;
$$;

CREATE FUNCTION agentos.recover_expired_workload_provider_attempts(
  p_now_millis bigint, p_limit integer
)
RETURNS TABLE ("outcome" text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agentos, pg_temp AS $$
DECLARE v_row agentos.provider_budget_reservations%ROWTYPE; v_count integer := 0;
BEGIN
  IF p_now_millis < 0 OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid provider attempt recovery';
  END IF;
  FOR v_row IN SELECT reservation.* FROM agentos.provider_budget_reservations reservation
    WHERE state = 'active' AND attempted_at_millis IS NOT NULL
      AND (attempt_lease_expires_at_millis IS NULL
        OR attempt_lease_expires_at_millis <= p_now_millis)
    ORDER BY attempt_lease_expires_at_millis NULLS FIRST, decision_ref
    LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE agentos.provider_budget_counters SET consumed = consumed + v_row.reserved_tokens,
      updated_at = transaction_timestamp()
     WHERE budget_key = v_row.budget_key AND dimension = 'token'
       AND window_started_at_millis = v_row.token_window_started_at_millis;
    UPDATE agentos.provider_budget_counters SET consumed = consumed + v_row.reserved_spend_micros,
      updated_at = transaction_timestamp()
     WHERE budget_key = v_row.budget_key AND dimension = 'spend'
       AND window_started_at_millis = v_row.spend_window_started_at_millis;
    UPDATE agentos.provider_budget_reservations SET state = 'settled',
      forward_outcome = 'transport_failed', input_tokens = reserved_tokens,
      output_tokens = 0, cached_input_tokens = 0,
      spend_micros = reserved_spend_micros, settled_at_millis = p_now_millis,
      updated_at = transaction_timestamp()
     WHERE decision_ref = v_row.decision_ref AND state = 'active';
    v_count := v_count + 1;
  END LOOP;
  IF v_count = 0 THEN RETURN QUERY SELECT 'unchanged'::text;
  ELSE RETURN QUERY SELECT 'recovered'::text; END IF;
END;
$$;

REVOKE ALL ON FUNCTION agentos.renew_workload_provider_attempt(text,text,text,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.recover_expired_workload_provider_attempts(bigint,integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION agentos.configure_egress_authorizer_privileges(p_database_role name)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = agentos, pg_temp AS $$
DECLARE v_role oid; v_dangerous boolean;
BEGIN
  IF session_user <> current_user THEN RAISE EXCEPTION 'egress authorizer privileges require the schema owner'; END IF;
  SELECT oid, rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls
    INTO v_role, v_dangerous FROM pg_catalog.pg_roles WHERE rolname = p_database_role;
  IF v_role IS NULL OR v_dangerous OR EXISTS
    (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = v_role) THEN
    RAISE EXCEPTION 'egress authorizer database role is unavailable or privileged';
  END IF;
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA agentos FROM %I', p_database_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA agentos FROM %I', p_database_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA agentos FROM %I', p_database_role);
  EXECUTE format('GRANT USAGE ON SCHEMA agentos TO %I', p_database_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION agentos.read_egress_workload_agents(text,text), agentos.read_egress_assignments(uuid), agentos.read_egress_policy_snapshots(jsonb), agentos.reserve_workload_provider_budget(text,text,text,jsonb,text,text,text,jsonb,text,text,text,jsonb,jsonb,bigint,bigint,bigint,bigint), agentos.validate_workload_provider_budget(text,text,jsonb,text,text,text,jsonb,text,text,jsonb,jsonb,bigint,bigint,bigint,bigint), agentos.settle_provider_budget_for_provider(text,text,text,text,bigint,bigint,bigint,bigint,bigint), agentos.renew_workload_provider_attempt(text,text,text,bigint), agentos.recover_expired_workload_provider_attempts(bigint,integer) TO %I', p_database_role);
END;
$$;

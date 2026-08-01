CREATE FUNCTION agentos.settle_provider_budget_for_provider(
  p_decision_ref text,
  p_provider text,
  p_credential_domain text,
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
BEGIN
  IF p_decision_ref !~ '^decision_[0-9a-f]{32}$'
     OR p_provider NOT IN ('github', 'openai')
     OR p_credential_domain
       !~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
     OR length(p_credential_domain) > 63 THEN
    RAISE EXCEPTION 'invalid provider budget provider settlement';
  END IF;

  SELECT reservation.* INTO v_reservation
    FROM agentos.provider_budget_reservations AS reservation
   WHERE reservation.decision_ref = p_decision_ref
   FOR UPDATE;
  IF NOT FOUND
     OR v_reservation.provider <> p_provider
     OR v_reservation.credential_domain <> p_credential_domain THEN
    RAISE EXCEPTION 'provider budget provider settlement is unauthorized';
  END IF;

  RETURN QUERY
  SELECT * FROM agentos.settle_provider_budget(
    p_decision_ref,
    v_reservation.subject,
    p_forward_outcome,
    p_input_tokens,
    p_output_tokens,
    p_cached_input_tokens,
    p_spend_micros,
    p_settled_at_millis
  );
END;
$$;

COMMENT ON FUNCTION agentos.settle_provider_budget_for_provider(
  text, text, text, text, bigint, bigint, bigint, bigint, bigint
) IS
  'Settles one exact durable reservation for its provider credential domain without accepting or disclosing the authorized Mate or Assignment subject.';

REVOKE ALL ON FUNCTION agentos.settle_provider_budget_for_provider(
  text, text, text, text, bigint, bigint, bigint, bigint, bigint
) FROM PUBLIC;

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
    'GRANT EXECUTE ON FUNCTION agentos.read_egress_workload_agents(text, text), agentos.read_egress_assignments(uuid), agentos.read_egress_policy_snapshots(jsonb), agentos.reserve_provider_budget(text,text,text,jsonb,text,text,text,jsonb,text,text,text,bigint), agentos.settle_provider_budget_for_provider(text,text,text,text,bigint,bigint,bigint,bigint,bigint) TO %I',
    p_database_role
  );
END;
$$;

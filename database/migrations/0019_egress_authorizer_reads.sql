CREATE FUNCTION agentos.read_egress_workload_agents(
  p_kubernetes_namespace text,
  p_kubernetes_pod text
)
RETURNS TABLE (
  "agentId" text,
  role text,
  fleet text,
  domain text,
  "kubernetesNamespace" text,
  "kubernetesPod" text,
  "lifecycleStatus" text,
  "retiredAtMillis" double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF p_kubernetes_namespace IS NULL
     OR p_kubernetes_namespace !~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
     OR length(p_kubernetes_namespace) > 63
     OR p_kubernetes_pod IS NULL
     OR p_kubernetes_pod !~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
     OR length(p_kubernetes_pod) > 63 THEN
    RAISE EXCEPTION 'invalid Kubernetes workload locator';
  END IF;

  RETURN QUERY
  SELECT DISTINCT
    agent.id::text,
    agent.role,
    binding.subject ->> 'fleet',
    binding.subject ->> 'domain',
    agent.kubernetes_namespace,
    agent.kubernetes_pod,
    agent.lifecycle_status,
    CASE
      WHEN agent.retired_at IS NULL THEN NULL
      ELSE floor(extract(epoch FROM agent.retired_at) * 1000)::double precision
    END
  FROM agentos.agents AS agent
  JOIN agentos.access_bindings AS binding
    ON binding.state = 'active'
   AND (
     binding.expires_at_millis IS NULL
     OR binding.expires_at_millis >
       floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
   )
   AND (
     (
       binding.subject ->> 'kind' = 'mate'
       AND binding.subject ->> 'agentId' = agent.id::text
     )
     OR (
       binding.subject ->> 'kind' = 'assignment'
       AND EXISTS (
         SELECT 1
         FROM agentos.task_assignments AS assignment
         WHERE assignment.id::text = binding.subject ->> 'assignmentId'
           AND assignment.agent_id = agent.id
           AND assignment.ended_at IS NULL
       )
     )
   )
  WHERE agent.kubernetes_namespace = p_kubernetes_namespace
    AND agent.kubernetes_pod = p_kubernetes_pod
  ORDER BY agent.id::text, binding.subject ->> 'fleet',
    binding.subject ->> 'domain';
END;
$$;

COMMENT ON FUNCTION agentos.read_egress_workload_agents(text, text) IS
  'Exact provider-authorizer workload lookup. Fleet and domain come only from a live access binding; ambiguous scopes remain distinct and fail closed in the caller.';

CREATE FUNCTION agentos.read_egress_assignments(p_agent_id uuid)
RETURNS TABLE (
  "assignmentId" text,
  "agentId" text,
  status text,
  "endedAtMillis" double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  SELECT
    assignment.id::text,
    assignment.agent_id::text,
    assignment.status,
    CASE
      WHEN assignment.ended_at IS NULL THEN NULL
      ELSE floor(extract(epoch FROM assignment.ended_at) * 1000)::double precision
    END
  FROM agentos.task_assignments AS assignment
  WHERE assignment.agent_id = p_agent_id
    AND assignment.ended_at IS NULL
  ORDER BY assignment.id
$$;

COMMENT ON FUNCTION agentos.read_egress_assignments(uuid) IS
  'Exact provider-authorizer lookup of current Assignment candidates for one Agent.';

CREATE FUNCTION agentos.read_egress_policy_snapshots(p_subject jsonb)
RETURNS TABLE (
  "bindingId" text,
  "bindingSubject" jsonb,
  "bindingCreatedAtMillis" double precision,
  "bindingExpiresAtMillis" double precision,
  "bindingState" text,
  "profileId" text,
  "profileVersion" integer,
  "previousProfileVersion" integer,
  "profileTargetScope" jsonb,
  "profilePermissions" jsonb,
  "profileCeilingId" text,
  "profileCeilingRevision" integer,
  "profileHeadVersion" integer,
  "bindingCeilingId" text,
  "bindingCeilingRevision" integer,
  "ceilingScope" jsonb,
  "ceilingEffectiveAtMillis" double precision,
  "ceilingPermissions" jsonb,
  "ceilingState" text,
  "pendingCeilingRevision" integer,
  "operationInProgress" boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF NOT agentos.valid_access_subject(p_subject) THEN
    RAISE EXCEPTION 'invalid egress authorization subject';
  END IF;

  RETURN QUERY
  SELECT
    binding.binding_id,
    binding.subject,
    binding.created_at_millis::double precision,
    binding.expires_at_millis::double precision,
    binding.state,
    profile.profile_id,
    profile.profile_version,
    profile.previous_profile_version,
    profile.target_scope,
    profile.permissions,
    profile.ceiling_id,
    profile.ceiling_revision,
    head.profile_version,
    binding.ceiling_id,
    binding.ceiling_revision,
    ceiling.scope,
    ceiling.effective_at_millis::double precision,
    ceiling.permissions,
    ceiling.state,
    pending.revision,
    EXISTS (
      SELECT 1
      FROM agentos.access_control_operations AS operation
      WHERE operation.phase IN ('prepared', 'verified')
        AND (
          (
            operation.target_type = 'binding'
            AND operation.target_id = binding.binding_id
          )
          OR (
            operation.target_type = 'profile'
            AND operation.target_id = profile.profile_id
          )
          OR (
            operation.target_type = 'ceiling'
            AND operation.target_id = binding.ceiling_id
          )
          OR operation.subjects @> jsonb_build_array(binding.subject)
        )
    )
  FROM agentos.access_bindings AS binding
  JOIN agentos.access_profiles AS profile
    ON profile.profile_id = binding.profile_id
   AND profile.profile_version = binding.profile_version
  LEFT JOIN agentos.access_profile_heads AS head
    ON head.profile_id = profile.profile_id
  JOIN agentos.access_ceilings AS ceiling
    ON ceiling.ceiling_id = binding.ceiling_id
   AND ceiling.revision = binding.ceiling_revision
  LEFT JOIN LATERAL (
    SELECT max(candidate.revision)::integer AS revision
    FROM agentos.access_ceilings AS candidate
    WHERE candidate.ceiling_id = binding.ceiling_id
      AND candidate.state = 'pending'
  ) AS pending ON true
  WHERE binding.subject = p_subject
    AND binding.state IN ('pending', 'active')
  ORDER BY binding.binding_id;
END;
$$;

COMMENT ON FUNCTION agentos.read_egress_policy_snapshots(jsonb) IS
  'One statement-consistent provider policy snapshot. The caller must reject pending, expired, stale, ineffective or unreconciled rows.';

REVOKE ALL ON FUNCTION agentos.read_egress_workload_agents(text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.read_egress_assignments(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.read_egress_policy_snapshots(jsonb)
  FROM PUBLIC;

CREATE FUNCTION agentos.configure_egress_authorizer_privileges(
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
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
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
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON SCHEMA agentos FROM %I',
    p_database_role
  );
  EXECUTE format('GRANT USAGE ON SCHEMA agentos TO %I', p_database_role);
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION agentos.read_egress_workload_agents(text, text), agentos.read_egress_assignments(uuid), agentos.read_egress_policy_snapshots(jsonb) TO %I',
    p_database_role
  );
END;
$$;

COMMENT ON FUNCTION agentos.configure_egress_authorizer_privileges(name) IS
  'Strips inherited direct AgentOS privileges from a dedicated non-privileged login, then grants only the three egress-authorizer readers. Login creation and credentials remain deployment concerns.';

REVOKE ALL ON FUNCTION agentos.configure_egress_authorizer_privileges(name)
  FROM PUBLIC;

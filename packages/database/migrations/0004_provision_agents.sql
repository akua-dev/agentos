CREATE FUNCTION agentos.provision_agent(
  p_handle text,
  p_role text,
  p_harness text,
  p_status_text text,
  p_display_name text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_actor_role text := agentos.current_agent_role();
  v_display_name text := nullif(btrim(p_display_name), '');
  v_harness text := btrim(p_harness);
  v_id uuid;
  v_existing agentos.agents%ROWTYPE;
BEGIN
  IF v_actor_id IS NULL OR v_actor_role NOT IN ('first_mate', 'second_mate') THEN
    RAISE EXCEPTION 'Agent provisioning requires an authenticated active Mate';
  END IF;

  IF p_role IS NULL OR p_role NOT IN ('second_mate', 'crewmate') THEN
    RAISE EXCEPTION 'First Mate may provision only Second Mates or Crewmates';
  END IF;

  IF v_actor_role = 'second_mate' AND p_role <> 'crewmate' THEN
    RAISE EXCEPTION 'Second Mate may provision only Crewmates';
  END IF;

  IF p_handle IS NULL
     OR length(p_handle) > 55
     OR p_handle !~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' THEN
    RAISE EXCEPTION 'Agent handle must be a Kubernetes-safe name of at most 55 characters';
  END IF;

  IF v_harness IS NULL OR length(v_harness) = 0 THEN
    RAISE EXCEPTION 'Agent harness must be non-empty';
  END IF;

  IF p_status_text IS NULL OR length(btrim(p_status_text)) = 0 THEN
    RAISE EXCEPTION 'Agent provisioning requires explanatory status text';
  END IF;

  IF p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' THEN
    RAISE EXCEPTION 'Agent metadata must be a JSON object';
  END IF;

  IF p_role = 'second_mate' AND (
    jsonb_typeof(p_metadata -> 'charter') IS DISTINCT FROM 'object'
    OR nullif(btrim(p_metadata #>> '{charter,summary}'), '') IS NULL
    OR nullif(btrim(p_metadata #>> '{charter,scope}'), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Second Mate charter requires non-empty summary and scope';
  END IF;

  INSERT INTO agentos.agents (
    handle,
    display_name,
    role,
    parent_agent_id,
    harness,
    lifecycle_status,
    status_text,
    metadata
  ) VALUES (
    p_handle,
    v_display_name,
    p_role,
    v_actor_id,
    v_harness,
    'provisioning',
    btrim(p_status_text),
    p_metadata
  )
  ON CONFLICT (handle) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  SELECT agent.*
    INTO v_existing
    FROM agentos.agents AS agent
   WHERE agent.handle = p_handle;

  IF v_existing.retired_at IS NULL
     AND v_existing.parent_agent_id = v_actor_id
     AND v_existing.role = p_role
     AND v_existing.harness = v_harness
     AND v_existing.display_name IS NOT DISTINCT FROM v_display_name
     AND v_existing.metadata = p_metadata THEN
    RETURN v_existing.id;
  END IF;

  RAISE EXCEPTION 'Agent handle % conflicts with the existing Agent identity', p_handle;
END;
$$;

COMMENT ON FUNCTION agentos.provision_agent(
  text, text, text, text, text, jsonb
) IS
  'Creates an idempotent direct child identity in provisioning state; external credentials and runtime resources remain explicit follow-up steps.';

REVOKE ALL ON FUNCTION agentos.provision_agent(
  text, text, text, text, text, jsonb
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION agentos.configure_agent_runtime_privileges(
  p_database_role name,
  p_agent_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF p_agent_role = 'first_mate' THEN
    RETURN;
  END IF;

  EXECUTE format(
    'REVOKE INSERT (id, project_id, parent_task_id, created_by_agent_id, title, description, status, status_text, priority, dependencies, external_links, metadata, completed_at, archived_at) ON agentos.tasks FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE INSERT (id, task_id, agent_id, assigned_by_agent_id, assignment_role, status, status_text, metadata, started_at, ended_at) ON agentos.task_assignments FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION agentos.retire_agent(uuid, text) FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION agentos.provision_agent(text, text, text, text, text, jsonb) FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION agentos.claim_external_events(uuid, text, text, interval), agentos.refresh_external_event_claim(uuid, uuid, interval), agentos.assert_external_event_claim_current(uuid, uuid), agentos.complete_external_event_claim(uuid, uuid, jsonb), agentos.release_external_event_claim(uuid, uuid, text) FROM %I',
    p_database_role
  );

  EXECUTE format(
    'GRANT UPDATE (status, status_text, metadata, completed_at) ON agentos.tasks TO %I',
    p_database_role
  );
  EXECUTE format(
    'GRANT UPDATE (status, status_text, metadata, started_at, ended_at) ON agentos.task_assignments TO %I',
    p_database_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION agentos.can_manage_task(uuid), agentos.can_manage_task_assignment(uuid) TO %I',
    p_database_role
  );

  IF p_agent_role = 'second_mate' THEN
    EXECUTE format(
      'GRANT INSERT (id, project_id, parent_task_id, created_by_agent_id, title, description, status, status_text, priority, dependencies, external_links, metadata, completed_at, archived_at) ON agentos.tasks TO %I',
      p_database_role
    );
    EXECUTE format(
      'GRANT INSERT (id, task_id, agent_id, assigned_by_agent_id, assignment_role, status, status_text, metadata, started_at, ended_at) ON agentos.task_assignments TO %I',
      p_database_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION agentos.retire_agent(uuid, text) TO %I',
      p_database_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION agentos.provision_agent(text, text, text, text, text, jsonb) TO %I',
      p_database_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION agentos.claim_external_events(uuid, text, text, interval), agentos.refresh_external_event_claim(uuid, uuid, interval), agentos.assert_external_event_claim_current(uuid, uuid), agentos.complete_external_event_claim(uuid, uuid, jsonb), agentos.release_external_event_claim(uuid, uuid, text) TO %I',
      p_database_role
    );
  END IF;
END;
$$;

DO $$
DECLARE
  v_agent record;
BEGIN
  FOR v_agent IN
    SELECT agent.database_role, agent.role
      FROM agentos.agents AS agent
     WHERE agent.database_role IS NOT NULL
       AND agent.retired_at IS NULL
  LOOP
    PERFORM agentos.configure_agent_runtime_privileges(
      v_agent.database_role,
      v_agent.role
    );
  END LOOP;
END;
$$;

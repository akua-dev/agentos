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
    'REVOKE INSERT (id, task_id, agent_id, assigned_by_agent_id, assignment_role, status, status_text, metadata, started_at, ended_at, brief, report, dispatch_profile, supersedes_assignment_id, decision_keys, decisions_attested_at, decisions_attested_by_agent_id) ON agentos.task_assignments FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE INSERT (id, topic, content, source, recorded_by_agent_id, metadata, archived_at, scope, scope_agent_id) ON agentos.captain FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE UPDATE (topic, content, source, metadata, archived_at) ON agentos.captain FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION agentos.retire_agent(uuid, text), agentos.provision_agent(text, text, text, text, text, jsonb), agentos.handoff_task_assignment(uuid, uuid, text, text, text, jsonb), agentos.hold_captain_decision(uuid, text, text, text, text), agentos.link_task_decision(uuid, text, text), agentos.attest_assignment_decisions(uuid, text[]), agentos.resolve_captain_decision(uuid, text, text) FROM %I',
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
    'GRANT UPDATE (status, status_text, metadata, report, started_at, ended_at) ON agentos.task_assignments TO %I',
    p_database_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION agentos.can_manage_task(uuid), agentos.can_manage_task_assignment(uuid), agentos.receive_inbox(uuid) TO %I',
    p_database_role
  );

  IF p_agent_role = 'second_mate' THEN
    EXECUTE format(
      'GRANT INSERT (id, project_id, parent_task_id, created_by_agent_id, title, description, status, status_text, priority, dependencies, external_links, metadata, completed_at, archived_at) ON agentos.tasks TO %I',
      p_database_role
    );
    EXECUTE format(
      'GRANT INSERT (id, task_id, agent_id, assigned_by_agent_id, assignment_role, status, status_text, metadata, started_at, ended_at, brief, report, dispatch_profile, supersedes_assignment_id, decision_keys, decisions_attested_at, decisions_attested_by_agent_id) ON agentos.task_assignments TO %I',
      p_database_role
    );
    EXECUTE format(
      'GRANT INSERT (id, topic, content, source, recorded_by_agent_id, metadata, archived_at, scope, scope_agent_id) ON agentos.captain TO %I',
      p_database_role
    );
    EXECUTE format(
      'GRANT UPDATE (topic, content, source, metadata, archived_at) ON agentos.captain TO %I',
      p_database_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION agentos.retire_agent(uuid, text), agentos.provision_agent(text, text, text, text, text, jsonb), agentos.handoff_task_assignment(uuid, uuid, text, text, text, jsonb), agentos.hold_captain_decision(uuid, text, text, text, text), agentos.link_task_decision(uuid, text, text), agentos.attest_assignment_decisions(uuid, text[]), agentos.resolve_captain_decision(uuid, text, text) TO %I',
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

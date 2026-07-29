CREATE FUNCTION agentos.current_mate_bearings()
RETURNS TABLE (
  bearing_kind text,
  inbox_id uuid,
  task_id uuid,
  assignment_id uuid,
  agent_id uuid,
  project_id uuid,
  external_event_id bigint,
  item_kind text,
  status text,
  status_text text,
  subject text,
  dependency_count integer,
  unresolved_decision_count integer,
  dependencies_satisfied boolean,
  read_at timestamptz,
  ready_at timestamptz,
  claim_expires_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_actor_role text := agentos.current_agent_role();
BEGIN
  IF v_actor_id IS NULL
     OR v_actor_role NOT IN ('first_mate', 'second_mate') THEN
    RAISE EXCEPTION
      'Current Mate bearings require an authenticated First or Second Mate';
  END IF;

  RETURN QUERY
  WITH task_facts AS (
    SELECT
      task.id,
      task.project_id,
      task.created_by_agent_id,
      task.title,
      task.status,
      task.status_text,
      task.dependencies,
      task.completed_at,
      task.created_at,
      task.updated_at,
      jsonb_array_length(task.dependencies)::integer AS dependency_count,
      (
        SELECT count(*)::integer
          FROM jsonb_array_elements(task.dependencies) AS dependency(value)
         WHERE dependency.value ->> 'kind' = 'captain_decision'
           AND EXISTS (
             SELECT 1
               FROM agentos.inbox AS decision
              WHERE decision.kind = 'captain_decision'
                AND decision.decision_key =
                    dependency.value ->> 'decision_key'
                AND decision.resolved_at IS NULL
           )
      ) AS unresolved_decision_count,
      EXISTS (
        SELECT 1
          FROM agentos.task_assignments AS assignment
         WHERE assignment.task_id = task.id
      ) AS has_assignment_history,
      EXISTS (
        SELECT 1
          FROM agentos.task_assignments AS assignment
         WHERE assignment.task_id = task.id
           AND assignment.ended_at IS NULL
      ) AS has_active_assignment
    FROM agentos.tasks AS task
    WHERE task.archived_at IS NULL
      AND agentos.can_manage_task(task.id)
  ),
  bearings AS (
    SELECT
      'unresolved_inbox'::text AS bearing_kind,
      delivery.id AS inbox_id,
      delivery.task_id,
      NULL::uuid AS assignment_id,
      delivery.sender_agent_id AS agent_id,
      task.project_id,
      NULL::bigint AS external_event_id,
      delivery.kind AS item_kind,
      delivery.status,
      delivery.status_text,
      delivery.subject,
      NULL::integer AS dependency_count,
      NULL::integer AS unresolved_decision_count,
      NULL::boolean AS dependencies_satisfied,
      delivery.read_at,
      NULL::timestamptz AS ready_at,
      NULL::timestamptz AS claim_expires_at,
      delivery.created_at,
      delivery.updated_at
    FROM agentos.inbox AS delivery
    LEFT JOIN agentos.tasks AS task ON task.id = delivery.task_id
    WHERE delivery.recipient_agent_id = v_actor_id
      AND delivery.resolved_at IS NULL
      AND delivery.kind <> 'captain_decision'

    UNION ALL

    SELECT
      'own_active_assignment'::text,
      NULL::uuid,
      assignment.task_id,
      assignment.id,
      assignment.agent_id,
      task.project_id,
      NULL::bigint,
      assignment.assignment_role,
      assignment.status,
      assignment.status_text,
      task.title,
      NULL::integer,
      NULL::integer,
      NULL::boolean,
      NULL::timestamptz,
      NULL::timestamptz,
      NULL::timestamptz,
      assignment.created_at,
      assignment.updated_at
    FROM agentos.task_assignments AS assignment
    JOIN agentos.tasks AS task ON task.id = assignment.task_id
    WHERE assignment.agent_id = v_actor_id
      AND assignment.ended_at IS NULL

    UNION ALL

    SELECT
      'direct_child_active_assignment'::text,
      NULL::uuid,
      assignment.task_id,
      assignment.id,
      assignment.agent_id,
      task.project_id,
      NULL::bigint,
      assignment.assignment_role,
      assignment.status,
      assignment.status_text,
      task.title,
      NULL::integer,
      NULL::integer,
      NULL::boolean,
      NULL::timestamptz,
      NULL::timestamptz,
      NULL::timestamptz,
      assignment.created_at,
      assignment.updated_at
    FROM agentos.task_assignments AS assignment
    JOIN agentos.agents AS child ON child.id = assignment.agent_id
    JOIN agentos.tasks AS task ON task.id = assignment.task_id
    WHERE child.parent_agent_id = v_actor_id
      AND child.retired_at IS NULL
      AND assignment.ended_at IS NULL

    UNION ALL

    SELECT
      'managed_task_reconciliation'::text,
      NULL::uuid,
      task.id,
      NULL::uuid,
      task.created_by_agent_id,
      task.project_id,
      NULL::bigint,
      CASE
        WHEN task.dependency_count > 0 THEN 'dependency'
        WHEN task.completed_at IS NOT NULL
             AND task.has_active_assignment
          THEN 'completed_with_active_owner'
        ELSE 'missing_active_owner'
      END,
      task.status,
      task.status_text,
      task.title,
      task.dependency_count,
      task.unresolved_decision_count,
      task.dependency_count = 0,
      NULL::timestamptz,
      NULL::timestamptz,
      NULL::timestamptz,
      task.created_at,
      task.updated_at
    FROM task_facts AS task
    WHERE task.dependency_count > 0
       OR (
         task.has_assignment_history
         AND NOT task.has_active_assignment
         AND task.completed_at IS NULL
       )
       OR (
         task.completed_at IS NOT NULL
         AND task.has_active_assignment
       )

    UNION ALL

    SELECT
      'queued_ready_backlog'::text,
      NULL::uuid,
      task.id,
      NULL::uuid,
      task.created_by_agent_id,
      task.project_id,
      NULL::bigint,
      'backlog'::text,
      task.status,
      task.status_text,
      task.title,
      task.dependency_count,
      task.unresolved_decision_count,
      true,
      NULL::timestamptz,
      NULL::timestamptz,
      NULL::timestamptz,
      task.created_at,
      task.updated_at
    FROM task_facts AS task
    WHERE NOT task.has_assignment_history
      AND task.completed_at IS NULL
      AND task.status IN ('queued', 'ready')
      AND task.dependency_count = 0

    UNION ALL

    SELECT
      'captain_decision'::text,
      decision.id,
      decision.task_id,
      NULL::uuid,
      decision.recipient_agent_id,
      task.project_id,
      NULL::bigint,
      decision.kind,
      decision.status,
      decision.status_text,
      decision.subject,
      NULL::integer,
      NULL::integer,
      NULL::boolean,
      decision.read_at,
      NULL::timestamptz,
      NULL::timestamptz,
      decision.created_at,
      decision.updated_at
    FROM agentos.inbox AS decision
    LEFT JOIN agentos.tasks AS task ON task.id = decision.task_id
    WHERE decision.kind = 'captain_decision'
      AND decision.resolved_at IS NULL
      AND agentos.can_manage_agent(decision.recipient_agent_id)

    UNION ALL

    SELECT
      'external_event'::text,
      NULL::uuid,
      NULL::uuid,
      NULL::uuid,
      event.claimed_by_agent_id,
      NULL::uuid,
      event.id,
      event.event_type,
      event.reconciliation_status,
      event.status_text,
      NULL::text,
      NULL::integer,
      NULL::integer,
      NULL::boolean,
      NULL::timestamptz,
      event.ready_at,
      event.claim_expires_at,
      event.created_at,
      event.updated_at
    FROM agentos.external_events AS event
    WHERE (
        event.reconciliation_status = 'pending'
        AND event.ready_at <= transaction_timestamp()
      )
       OR (
         event.reconciliation_status = 'processing'
         AND event.claimed_by_agent_id = v_actor_id
       )
       OR (
         event.reconciliation_status = 'processing'
         AND event.claim_expires_at <= transaction_timestamp()
       )
  )
  SELECT bearing.*
    FROM bearings AS bearing
   ORDER BY
     CASE bearing.bearing_kind
       WHEN 'unresolved_inbox' THEN 1
       WHEN 'captain_decision' THEN 2
       WHEN 'own_active_assignment' THEN 3
       WHEN 'direct_child_active_assignment' THEN 4
       WHEN 'managed_task_reconciliation' THEN 5
       WHEN 'queued_ready_backlog' THEN 6
       WHEN 'external_event' THEN 7
       ELSE 8
     END,
     bearing.inbox_id,
     bearing.task_id,
     bearing.assignment_id,
     bearing.external_event_id;
END;
$$;

COMMENT ON FUNCTION agentos.current_mate_bearings() IS
  'Read-only typed projection of durable coordination facts relevant to the authenticated Mate; excludes runtime health, payloads, message bodies and routing judgment.';

REVOKE ALL ON FUNCTION agentos.current_mate_bearings() FROM PUBLIC;

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
    'REVOKE INSERT (id, task_id, agent_id, assigned_by_agent_id, assignment_role, status, status_text, metadata, started_at, ended_at, brief, report, supersedes_assignment_id, decision_keys, decisions_attested_at, decisions_attested_by_agent_id) ON agentos.task_assignments FROM %I',
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
    'REVOKE EXECUTE ON FUNCTION agentos.retire_agent(uuid, text), agentos.provision_agent(text, text, text, text, text, jsonb), agentos.handoff_task_assignment(uuid, uuid, text, text, text), agentos.hold_captain_decision(uuid, text, text, text, text), agentos.link_task_decision(uuid, text, text), agentos.attest_assignment_decisions(uuid, text[]), agentos.resolve_captain_decision(uuid, text, text), agentos.create_task_with_assignment(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb, text, text, text, text, jsonb), agentos.accept_backlog_task(uuid, uuid, uuid, text, text, text, text, text, text, jsonb), agentos.current_mate_bearings() FROM %I',
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
      'GRANT INSERT (id, topic, content, source, recorded_by_agent_id, metadata, archived_at, scope, scope_agent_id) ON agentos.captain TO %I',
      p_database_role
    );
    EXECUTE format(
      'GRANT UPDATE (topic, content, source, metadata, archived_at) ON agentos.captain TO %I',
      p_database_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION agentos.retire_agent(uuid, text), agentos.provision_agent(text, text, text, text, text, jsonb), agentos.handoff_task_assignment(uuid, uuid, text, text, text), agentos.hold_captain_decision(uuid, text, text, text, text), agentos.link_task_decision(uuid, text, text), agentos.attest_assignment_decisions(uuid, text[]), agentos.resolve_captain_decision(uuid, text, text), agentos.create_task_with_assignment(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb, text, text, text, text, jsonb), agentos.accept_backlog_task(uuid, uuid, uuid, text, text, text, text, text, text, jsonb), agentos.current_mate_bearings() TO %I',
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

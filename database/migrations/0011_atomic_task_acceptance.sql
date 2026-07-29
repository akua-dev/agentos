DO $$
DECLARE
  v_conflicts text;
BEGIN
  SELECT string_agg(
           format(
             'Task %s has active Assignments: %s',
             conflict.task_id,
             conflict.assignment_details
           ),
           '; ' ORDER BY conflict.task_id
         )
    INTO v_conflicts
    FROM (
      SELECT assignment.task_id,
             string_agg(
               format(
                 '%s (Agent %s, status %s)',
                 assignment.id,
                 assignment.agent_id,
                 assignment.status
               ),
               ', ' ORDER BY assignment.id
             ) AS assignment_details
        FROM agentos.task_assignments AS assignment
       WHERE assignment.ended_at IS NULL
       GROUP BY assignment.task_id
      HAVING count(*) > 1
    ) AS conflict;

  IF v_conflicts IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0011 cannot enforce one active Assignment per Task; reconcile the listed active Assignments by ending or handing off ownership without deleting work, then retry. Conflicts: %',
      v_conflicts;
  END IF;
END;
$$;

ALTER TABLE agentos.task_assignments
  ADD COLUMN acceptance_request jsonb
    CHECK (
      acceptance_request IS NULL
      OR jsonb_typeof(acceptance_request) = 'object'
    );

COMMENT ON COLUMN agentos.task_assignments.acceptance_request IS
  'Immutable canonical input for an idempotent first-Assignment acceptance Function; null on historical and non-acceptance Assignments.';

CREATE UNIQUE INDEX task_assignments_one_active_owner_idx
  ON agentos.task_assignments (task_id)
  WHERE ended_at IS NULL;

CREATE FUNCTION agentos.protect_assignment_acceptance_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF NEW.acceptance_request IS DISTINCT FROM OLD.acceptance_request THEN
    RAISE EXCEPTION 'Task Assignment acceptance request is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER task_assignments_protect_acceptance_request
BEFORE UPDATE OF acceptance_request ON agentos.task_assignments
FOR EACH ROW EXECUTE FUNCTION agentos.protect_assignment_acceptance_request();

CREATE FUNCTION agentos.create_task_with_assignment(
  p_task_id uuid,
  p_assignment_id uuid,
  p_agent_id uuid,
  p_project_id uuid,
  p_parent_task_id uuid,
  p_title text,
  p_description text,
  p_task_status text,
  p_task_status_text text,
  p_priority text,
  p_dependencies jsonb,
  p_external_links jsonb,
  p_task_metadata jsonb,
  p_assignment_role text,
  p_assignment_status text,
  p_assignment_status_text text,
  p_brief text,
  p_assignment_metadata jsonb
)
RETURNS TABLE (
  accepted_task_id uuid,
  accepted_assignment_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_actor_role text := agentos.current_agent_role();
  v_agent agentos.agents%ROWTYPE;
  v_existing_assignment agentos.task_assignments%ROWTYPE;
  v_request jsonb;
BEGIN
  IF v_actor_id IS NULL
     OR v_actor_role NOT IN ('first_mate', 'second_mate') THEN
    RAISE EXCEPTION 'Task acceptance requires an authenticated Mate';
  END IF;

  IF p_task_id IS NULL
     OR p_assignment_id IS NULL
     OR p_agent_id IS NULL THEN
    RAISE EXCEPTION
      'Task acceptance requires caller-selected Task, Assignment and Agent IDs';
  END IF;

  IF p_title IS NULL OR p_title !~ '[^[:space:]]'
     OR p_task_status IS NULL OR p_task_status !~ '[^[:space:]]'
     OR p_task_status_text IS NULL OR p_task_status_text !~ '[^[:space:]]'
     OR p_assignment_role IS NULL
        OR p_assignment_role !~ '[^[:space:]]'
     OR p_assignment_status IS NULL
        OR p_assignment_status !~ '[^[:space:]]'
     OR p_assignment_status_text IS NULL
        OR p_assignment_status_text !~ '[^[:space:]]'
     OR p_brief IS NULL OR p_brief !~ '[^[:space:]]' THEN
    RAISE EXCEPTION
      'Task acceptance requires complete Task, Assignment and brief text';
  END IF;

  IF p_dependencies IS NULL
     OR jsonb_typeof(p_dependencies) <> 'array'
     OR p_external_links IS NULL
     OR jsonb_typeof(p_external_links) <> 'array'
     OR p_task_metadata IS NULL
     OR jsonb_typeof(p_task_metadata) <> 'object'
     OR p_assignment_metadata IS NULL
     OR jsonb_typeof(p_assignment_metadata) <> 'object' THEN
    RAISE EXCEPTION
      'Task acceptance requires valid Task and Assignment JSON values';
  END IF;

  SELECT agent.*
    INTO v_agent
    FROM agentos.agents AS agent
   WHERE agent.id = p_agent_id
     AND agent.retired_at IS NULL
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task acceptance requires an active destination Agent';
  END IF;

  IF NOT agentos.can_manage_agent(p_agent_id) THEN
    RAISE EXCEPTION
      'Task acceptance requires a destination in the managed hierarchy';
  END IF;

  IF p_parent_task_id IS NOT NULL
     AND NOT agentos.can_manage_task(p_parent_task_id) THEN
    RAISE EXCEPTION
      'Task acceptance requires a parent Task in the managed hierarchy';
  END IF;

  v_request := jsonb_build_object(
    'version', 1,
    'kind', 'create_task_with_assignment',
    'actor_id', v_actor_id,
    'task', jsonb_build_object(
      'id', p_task_id,
      'project_id', p_project_id,
      'parent_task_id', p_parent_task_id,
      'title', p_title,
      'description', p_description,
      'status', p_task_status,
      'status_text', p_task_status_text,
      'priority', p_priority,
      'dependencies', p_dependencies,
      'external_links', p_external_links,
      'metadata', p_task_metadata
    ),
    'assignment', jsonb_build_object(
      'id', p_assignment_id,
      'agent_id', p_agent_id,
      'assignment_role', p_assignment_role,
      'status', p_assignment_status,
      'status_text', p_assignment_status_text,
      'brief', p_brief,
      'metadata', p_assignment_metadata
    )
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('agentos:task:' || p_task_id::text, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('agentos:assignment:' || p_assignment_id::text, 0)
  );

  SELECT assignment.*
    INTO v_existing_assignment
    FROM agentos.task_assignments AS assignment
   WHERE assignment.id = p_assignment_id;

  IF FOUND THEN
    IF v_existing_assignment.acceptance_request
         IS NOT DISTINCT FROM v_request THEN
      RETURN QUERY SELECT p_task_id, p_assignment_id;
      RETURN;
    END IF;

    RAISE EXCEPTION
      'Task or Assignment ID conflicts with the original acceptance request';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM agentos.tasks AS task
     WHERE task.id = p_task_id
  ) THEN
    RAISE EXCEPTION
      'Task or Assignment ID conflicts with the original acceptance request';
  END IF;

  INSERT INTO agentos.tasks (
    id,
    project_id,
    parent_task_id,
    created_by_agent_id,
    title,
    description,
    status,
    status_text,
    priority,
    dependencies,
    external_links,
    metadata
  ) VALUES (
    p_task_id,
    p_project_id,
    p_parent_task_id,
    v_actor_id,
    p_title,
    p_description,
    p_task_status,
    p_task_status_text,
    p_priority,
    p_dependencies,
    p_external_links,
    p_task_metadata
  );

  INSERT INTO agentos.task_assignments (
    id,
    task_id,
    agent_id,
    assigned_by_agent_id,
    assignment_role,
    status,
    status_text,
    metadata,
    brief,
    acceptance_request
  ) VALUES (
    p_assignment_id,
    p_task_id,
    p_agent_id,
    v_actor_id,
    p_assignment_role,
    p_assignment_status,
    p_assignment_status_text,
    p_assignment_metadata,
    p_brief,
    v_request
  );

  RETURN QUERY SELECT p_task_id, p_assignment_id;
END;
$$;

CREATE FUNCTION agentos.accept_backlog_task(
  p_task_id uuid,
  p_assignment_id uuid,
  p_agent_id uuid,
  p_task_status text,
  p_task_status_text text,
  p_assignment_role text,
  p_assignment_status text,
  p_assignment_status_text text,
  p_brief text,
  p_assignment_metadata jsonb
)
RETURNS TABLE (
  accepted_task_id uuid,
  accepted_assignment_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_actor_role text := agentos.current_agent_role();
  v_agent agentos.agents%ROWTYPE;
  v_existing_assignment agentos.task_assignments%ROWTYPE;
  v_task agentos.tasks%ROWTYPE;
  v_request jsonb;
BEGIN
  IF v_actor_id IS NULL
     OR v_actor_role NOT IN ('first_mate', 'second_mate') THEN
    RAISE EXCEPTION 'Task acceptance requires an authenticated Mate';
  END IF;

  IF p_task_id IS NULL
     OR p_assignment_id IS NULL
     OR p_agent_id IS NULL THEN
    RAISE EXCEPTION
      'Task acceptance requires caller-selected Task, Assignment and Agent IDs';
  END IF;

  IF p_task_status IS NULL OR p_task_status !~ '[^[:space:]]'
     OR p_task_status_text IS NULL
        OR p_task_status_text !~ '[^[:space:]]'
     OR p_assignment_role IS NULL
        OR p_assignment_role !~ '[^[:space:]]'
     OR p_assignment_status IS NULL
        OR p_assignment_status !~ '[^[:space:]]'
     OR p_assignment_status_text IS NULL
        OR p_assignment_status_text !~ '[^[:space:]]'
     OR p_brief IS NULL OR p_brief !~ '[^[:space:]]' THEN
    RAISE EXCEPTION
      'Task acceptance requires complete Task, Assignment and brief text';
  END IF;

  IF p_assignment_metadata IS NULL
     OR jsonb_typeof(p_assignment_metadata) <> 'object' THEN
    RAISE EXCEPTION
      'Task acceptance requires valid Assignment metadata';
  END IF;

  SELECT agent.*
    INTO v_agent
    FROM agentos.agents AS agent
   WHERE agent.id = p_agent_id
     AND agent.retired_at IS NULL
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task acceptance requires an active destination Agent';
  END IF;

  IF NOT agentos.can_manage_agent(p_agent_id) THEN
    RAISE EXCEPTION
      'Task acceptance requires a destination in the managed hierarchy';
  END IF;

  v_request := jsonb_build_object(
    'version', 1,
    'kind', 'accept_backlog_task',
    'actor_id', v_actor_id,
    'task', jsonb_build_object(
      'id', p_task_id,
      'status', p_task_status,
      'status_text', p_task_status_text
    ),
    'assignment', jsonb_build_object(
      'id', p_assignment_id,
      'agent_id', p_agent_id,
      'assignment_role', p_assignment_role,
      'status', p_assignment_status,
      'status_text', p_assignment_status_text,
      'brief', p_brief,
      'metadata', p_assignment_metadata
    )
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('agentos:task:' || p_task_id::text, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('agentos:assignment:' || p_assignment_id::text, 0)
  );

  SELECT assignment.*
    INTO v_existing_assignment
    FROM agentos.task_assignments AS assignment
   WHERE assignment.id = p_assignment_id;

  IF FOUND THEN
    IF v_existing_assignment.acceptance_request
         IS NOT DISTINCT FROM v_request THEN
      RETURN QUERY SELECT p_task_id, p_assignment_id;
      RETURN;
    END IF;

    RAISE EXCEPTION
      'Task or Assignment ID conflicts with the original acceptance request';
  END IF;

  SELECT task.*
    INTO v_task
    FROM agentos.tasks AS task
   WHERE task.id = p_task_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Backlog acceptance requires an existing Task';
  END IF;

  IF NOT agentos.can_manage_task(p_task_id) THEN
    RAISE EXCEPTION
      'Backlog acceptance requires a Task in the managed hierarchy';
  END IF;

  IF v_task.archived_at IS NOT NULL OR v_task.completed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Backlog acceptance requires an unarchived, incomplete Task';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM agentos.task_assignments AS assignment
     WHERE assignment.task_id = p_task_id
  ) THEN
    RAISE EXCEPTION 'Backlog Task already has Assignment history';
  END IF;

  UPDATE agentos.tasks
     SET status = p_task_status,
         status_text = p_task_status_text
   WHERE id = p_task_id;

  INSERT INTO agentos.task_assignments (
    id,
    task_id,
    agent_id,
    assigned_by_agent_id,
    assignment_role,
    status,
    status_text,
    metadata,
    brief,
    acceptance_request
  ) VALUES (
    p_assignment_id,
    p_task_id,
    p_agent_id,
    v_actor_id,
    p_assignment_role,
    p_assignment_status,
    p_assignment_status_text,
    p_assignment_metadata,
    p_brief,
    v_request
  );

  RETURN QUERY SELECT p_task_id, p_assignment_id;
END;
$$;

COMMENT ON FUNCTION agentos.create_task_with_assignment(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text,
  jsonb, jsonb, jsonb, text, text, text, text, jsonb
) IS
  'Atomically creates a new Task and its first accountable Assignment with immutable exact-retry evidence.';

COMMENT ON FUNCTION agentos.accept_backlog_task(
  uuid, uuid, uuid, text, text, text, text, text, text, jsonb
) IS
  'Atomically accepts a deliberately recorded backlog Task by creating its first accountable Assignment with immutable exact-retry evidence.';

REVOKE ALL ON FUNCTION agentos.create_task_with_assignment(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text,
  jsonb, jsonb, jsonb, text, text, text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.accept_backlog_task(
  uuid, uuid, uuid, text, text, text, text, text, text, jsonb
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
    'REVOKE EXECUTE ON FUNCTION agentos.retire_agent(uuid, text), agentos.provision_agent(text, text, text, text, text, jsonb), agentos.handoff_task_assignment(uuid, uuid, text, text, text), agentos.hold_captain_decision(uuid, text, text, text, text), agentos.link_task_decision(uuid, text, text), agentos.attest_assignment_decisions(uuid, text[]), agentos.resolve_captain_decision(uuid, text, text), agentos.create_task_with_assignment(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb, text, text, text, text, jsonb), agentos.accept_backlog_task(uuid, uuid, uuid, text, text, text, text, text, text, jsonb) FROM %I',
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
      'GRANT EXECUTE ON FUNCTION agentos.retire_agent(uuid, text), agentos.provision_agent(text, text, text, text, text, jsonb), agentos.handoff_task_assignment(uuid, uuid, text, text, text), agentos.hold_captain_decision(uuid, text, text, text, text), agentos.link_task_decision(uuid, text, text), agentos.attest_assignment_decisions(uuid, text[]), agentos.resolve_captain_decision(uuid, text, text), agentos.create_task_with_assignment(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb, text, text, text, text, jsonb), agentos.accept_backlog_task(uuid, uuid, uuid, text, text, text, text, text, text, jsonb) TO %I',
      p_database_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION agentos.claim_external_events(uuid, text, text, interval), agentos.refresh_external_event_claim(uuid, uuid, interval), agentos.assert_external_event_claim_current(uuid, uuid), agentos.complete_external_event_claim(uuid, uuid, jsonb), agentos.release_external_event_claim(uuid, uuid, text) TO %I',
      p_database_role
    );
  END IF;
END;
$$;

COMMENT ON TABLE agentos.tasks IS
  'Durable backlog and accepted outcomes. A Task becomes accepted execution when its first accountable Assignment is created.';
COMMENT ON TABLE agentos.inbox IS
  'Direct delivery to an Agent. A request becomes accepted execution only when its first accountable Assignment is created.';

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

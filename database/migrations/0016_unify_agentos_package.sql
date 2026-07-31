DROP FUNCTION agentos.resolve_agent_composition_decision(
  uuid, boolean, text, text
);
DROP FUNCTION agentos.hold_agent_composition_decision(
  uuid, uuid, jsonb, text, text, text, text
);
DROP FUNCTION agentos.replace_agent_composition(
  uuid, jsonb, uuid, text
);
DROP FUNCTION agentos.repair_agent_composition(
  uuid, jsonb, uuid, text
);
DROP FUNCTION agentos.change_agent_composition(
  uuid, jsonb, uuid, text, text
);
DROP FUNCTION agentos.repair_task_assignment_dispatch(
  uuid, text, jsonb, text
);

DROP FUNCTION agentos.handoff_task_assignment(
  uuid, uuid, text, text, text, jsonb
);
DROP FUNCTION agentos.create_task_with_assignment(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text,
  jsonb, jsonb, jsonb, text, text, text, text, jsonb, jsonb
);
DROP FUNCTION agentos.accept_backlog_task(
  uuid, uuid, uuid, text, text, text, text, text, text, jsonb, jsonb
);

DROP TRIGGER agents_composition_contract ON agentos.agents;
DROP TRIGGER task_assignments_composition_contract
  ON agentos.task_assignments;

CREATE OR REPLACE FUNCTION agentos.enforce_task_assignment_contract()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_open_decision_keys text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.brief IS NULL OR length(btrim(NEW.brief)) = 0 THEN
      RAISE EXCEPTION 'Task Assignment requires a durable brief';
    END IF;
  END IF;

  IF NEW.ended_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.ended_at IS NULL) THEN
    IF NEW.report IS NULL OR length(btrim(NEW.report)) = 0 THEN
      RAISE EXCEPTION 'ending a Task Assignment requires a durable report';
    END IF;

    IF NEW.assignment_role IN ('scout', 'review')
       AND NEW.status IN ('completed', 'done') THEN
      SELECT coalesce(
               array_agg(delivery.decision_key ORDER BY delivery.decision_key),
               ARRAY[]::text[]
             )
        INTO v_open_decision_keys
        FROM agentos.inbox AS delivery
       WHERE delivery.task_id = NEW.task_id
         AND delivery.kind = 'captain_decision'
         AND delivery.resolved_at IS NULL;

      IF NEW.decision_keys IS NULL
         OR NEW.decision_keys IS DISTINCT FROM v_open_decision_keys THEN
        RAISE EXCEPTION 'Scout or review completion requires an exact Captain-decision attestation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION agentos.protect_completed_task_assignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL AND ROW(
    NEW.task_id,
    NEW.agent_id,
    NEW.assigned_by_agent_id,
    NEW.assignment_role,
    NEW.status,
    NEW.status_text,
    NEW.metadata,
    NEW.started_at,
    NEW.ended_at,
    NEW.brief,
    NEW.report,
    NEW.supersedes_assignment_id,
    NEW.decision_keys,
    NEW.decisions_attested_at,
    NEW.decisions_attested_by_agent_id
  ) IS DISTINCT FROM ROW(
    OLD.task_id,
    OLD.agent_id,
    OLD.assigned_by_agent_id,
    OLD.assignment_role,
    OLD.status,
    OLD.status_text,
    OLD.metadata,
    OLD.started_at,
    OLD.ended_at,
    OLD.brief,
    OLD.report,
    OLD.supersedes_assignment_id,
    OLD.decision_keys,
    OLD.decisions_attested_at,
    OLD.decisions_attested_by_agent_id
  ) THEN
    RAISE EXCEPTION 'completed Task assignment is immutable; create a new assignment';
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE agentos.agents
  DROP CONSTRAINT agents_resolved_composition_check;
ALTER TABLE agentos.task_assignments
  DROP CONSTRAINT task_assignments_composition_manifest_check;

ALTER TABLE agentos.agents
  DROP COLUMN resolved_composition;
ALTER TABLE agentos.task_assignments
  DROP COLUMN dispatch_profile;

DROP FUNCTION agentos.enforce_agent_composition();
DROP FUNCTION agentos.enforce_assignment_composition();
DROP FUNCTION agentos.valid_composition_manifest(jsonb);
DROP FUNCTION agentos.valid_composition_reference(jsonb);
DROP FUNCTION agentos.valid_composition_origin(jsonb);
DROP FUNCTION agentos.valid_composition_path(text);

DROP TRIGGER task_assignments_protect_acceptance_request
  ON agentos.task_assignments;
UPDATE agentos.task_assignments
   SET acceptance_request = jsonb_set(
         acceptance_request,
         '{assignment}',
         (acceptance_request -> 'assignment') - 'dispatch_profile'
       )
 WHERE acceptance_request IS NOT NULL
   AND acceptance_request -> 'assignment' ? 'dispatch_profile';
CREATE TRIGGER task_assignments_protect_acceptance_request
BEFORE UPDATE OF acceptance_request ON agentos.task_assignments
FOR EACH ROW
EXECUTE FUNCTION agentos.protect_assignment_acceptance_request();

CREATE FUNCTION agentos.handoff_task_assignment(
  p_assignment_id uuid,
  p_destination_agent_id uuid,
  p_brief text,
  p_report text,
  p_status_text text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_previous agentos.task_assignments%ROWTYPE;
  v_replacement_id uuid;
BEGIN
  IF v_actor_id IS NULL
     OR agentos.current_agent_role() NOT IN ('first_mate', 'second_mate') THEN
    RAISE EXCEPTION 'Task handoff requires an authenticated Mate';
  END IF;

  IF p_brief IS NULL OR length(btrim(p_brief)) = 0
     OR p_report IS NULL OR length(btrim(p_report)) = 0
     OR p_status_text IS NULL OR length(btrim(p_status_text)) = 0 THEN
    RAISE EXCEPTION 'Task handoff requires a complete brief, report and status text';
  END IF;

  SELECT assignment.*
    INTO v_previous
    FROM agentos.task_assignments AS assignment
   WHERE assignment.id = p_assignment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task handoff requires an existing Assignment';
  END IF;

  IF v_previous.ended_at IS NOT NULL THEN
    SELECT assignment.id
      INTO v_replacement_id
      FROM agentos.task_assignments AS assignment
     WHERE assignment.supersedes_assignment_id = p_assignment_id
       AND assignment.agent_id = p_destination_agent_id
       AND assignment.brief = btrim(p_brief)
       AND assignment.status_text = btrim(p_status_text)
       AND v_previous.report = btrim(p_report);

    IF v_replacement_id IS NOT NULL THEN
      RETURN v_replacement_id;
    END IF;

    RAISE EXCEPTION 'Task handoff cannot replace an ended Assignment';
  END IF;

  IF NOT agentos.can_manage_task_assignment(p_assignment_id)
     OR NOT agentos.can_manage_agent(p_destination_agent_id) THEN
    RAISE EXCEPTION 'Task handoff requires a managed Assignment and destination Agent';
  END IF;

  IF v_previous.agent_id = p_destination_agent_id THEN
    RAISE EXCEPTION 'Task handoff destination must differ from the current Agent';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM agentos.agents AS destination
     WHERE destination.id = p_destination_agent_id
       AND destination.retired_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Task handoff destination must be an active Agent';
  END IF;

  UPDATE agentos.task_assignments
     SET status = 'handed_off',
         status_text = btrim(p_status_text),
         report = btrim(p_report),
         ended_at = transaction_timestamp()
   WHERE id = p_assignment_id;

  INSERT INTO agentos.task_assignments (
    task_id,
    agent_id,
    assigned_by_agent_id,
    assignment_role,
    status,
    status_text,
    brief,
    supersedes_assignment_id
  ) VALUES (
    v_previous.task_id,
    p_destination_agent_id,
    v_actor_id,
    v_previous.assignment_role,
    'assigned',
    btrim(p_status_text),
    btrim(p_brief),
    p_assignment_id
  )
  RETURNING id INTO v_replacement_id;

  RETURN v_replacement_id;
END;
$$;

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

REVOKE ALL ON FUNCTION agentos.handoff_task_assignment(
  uuid, uuid, text, text, text
) FROM PUBLIC;
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

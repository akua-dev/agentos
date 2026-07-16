CREATE FUNCTION agentos.can_manage_task(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  SELECT coalesce(
    (
      SELECT CASE agentos.current_agent_role()
        WHEN 'first_mate' THEN true
        WHEN 'second_mate' THEN
          agentos.can_manage_agent(t.created_by_agent_id)
          OR EXISTS (
            SELECT 1
              FROM agentos.task_assignments AS assignment
             WHERE assignment.task_id = t.id
               AND assignment.ended_at IS NULL
               AND agentos.can_manage_agent(assignment.agent_id)
          )
        ELSE EXISTS (
          SELECT 1
            FROM agentos.task_assignments AS assignment
           WHERE assignment.task_id = t.id
             AND assignment.agent_id = agentos.current_agent_id()
             AND assignment.ended_at IS NULL
        )
      END
        FROM agentos.tasks AS t
       WHERE t.id = p_task_id
    ),
    false
  )
$$;

CREATE FUNCTION agentos.can_manage_task_assignment(p_assignment_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  SELECT coalesce(
    (
      SELECT CASE agentos.current_agent_role()
        WHEN 'first_mate' THEN true
        WHEN 'second_mate' THEN
          agentos.can_manage_task(assignment.task_id)
          AND agentos.can_manage_agent(assignment.agent_id)
        ELSE assignment.agent_id = agentos.current_agent_id()
          AND assignment.ended_at IS NULL
      END
        FROM agentos.task_assignments AS assignment
       WHERE assignment.id = p_assignment_id
    ),
    false
  )
$$;

REVOKE ALL ON FUNCTION agentos.can_manage_task(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.can_manage_task_assignment(uuid) FROM PUBLIC;

CREATE POLICY tasks_mate_insert
  ON agentos.tasks
  FOR INSERT
  WITH CHECK (
    agentos.current_agent_role() IN ('first_mate', 'second_mate')
    AND created_by_agent_id = agentos.current_agent_id()
    AND (
      parent_task_id IS NULL
      OR agentos.can_manage_task(parent_task_id)
    )
  );

CREATE POLICY tasks_managed_update
  ON agentos.tasks
  FOR UPDATE
  USING (agentos.can_manage_task(id))
  WITH CHECK (agentos.can_manage_task(id));

CREATE POLICY task_assignments_mate_insert
  ON agentos.task_assignments
  FOR INSERT
  WITH CHECK (
    agentos.current_agent_role() IN ('first_mate', 'second_mate')
    AND assigned_by_agent_id = agentos.current_agent_id()
    AND agentos.can_manage_task(task_id)
    AND agentos.can_manage_agent(agent_id)
    AND EXISTS (
      SELECT 1
        FROM agentos.agents AS target
       WHERE target.id = agent_id
         AND target.retired_at IS NULL
    )
  );

CREATE POLICY task_assignments_managed_update
  ON agentos.task_assignments
  FOR UPDATE
  USING (agentos.can_manage_task_assignment(id))
  WITH CHECK (agentos.can_manage_task_assignment(id));

CREATE FUNCTION agentos.protect_completed_task_assignment()
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
    NEW.ended_at
  ) IS DISTINCT FROM ROW(
    OLD.task_id,
    OLD.agent_id,
    OLD.assigned_by_agent_id,
    OLD.assignment_role,
    OLD.status,
    OLD.status_text,
    OLD.metadata,
    OLD.started_at,
    OLD.ended_at
  ) THEN
    RAISE EXCEPTION 'completed Task assignment is immutable; create a new assignment';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER task_assignments_protect_completed
BEFORE UPDATE ON agentos.task_assignments
FOR EACH ROW EXECUTE FUNCTION agentos.protect_completed_task_assignment();

CREATE FUNCTION agentos.protect_agent_retirement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'Agent retirement is immutable';
  END IF;

  IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
        FROM agentos.task_assignments AS assignment
       WHERE assignment.agent_id = OLD.id
         AND assignment.ended_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Agent has active Task assignments; complete or reassign them before retirement';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM agentos.agents AS child
       WHERE child.parent_agent_id = OLD.id
         AND child.retired_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Agent has active child Agents; hand them off before retirement';
    END IF;

  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER agents_protect_retirement
BEFORE UPDATE OF retired_at ON agentos.agents
FOR EACH ROW EXECUTE FUNCTION agentos.protect_agent_retirement();

CREATE FUNCTION agentos.retire_agent(
  p_agent_id uuid,
  p_status_text text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
BEGIN
  IF p_status_text IS NULL OR length(btrim(p_status_text)) = 0 THEN
    RAISE EXCEPTION 'retirement requires explanatory status text';
  END IF;

  IF v_actor_id IS NULL
     OR agentos.current_agent_role() NOT IN ('first_mate', 'second_mate')
     OR p_agent_id = v_actor_id
     OR NOT agentos.can_manage_agent(p_agent_id) THEN
    RAISE EXCEPTION 'Agent retirement requires another Agent in the managed hierarchy';
  END IF;

  UPDATE agentos.agents
     SET lifecycle_status = 'retired',
         status_text = p_status_text,
         retired_at = transaction_timestamp()
   WHERE id = p_agent_id
     AND retired_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'retirement requires an active Agent';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION agentos.retire_agent(uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION agentos.require_reconciliation_agent(p_agent_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_handle text;
BEGIN
  IF p_agent_id IS DISTINCT FROM agentos.current_agent_id() THEN
    RAISE EXCEPTION 'reconciliation Agent must match the authenticated Agent identity';
  END IF;

  SELECT a.handle
    INTO v_handle
    FROM agentos.agents AS a
   WHERE a.id = p_agent_id
     AND a.role IN ('first_mate', 'second_mate')
     AND a.retired_at IS NULL;

  IF v_handle IS NULL THEN
    RAISE EXCEPTION 'external reconciliation requires an active First or Second Mate';
  END IF;

  RETURN v_handle;
END;
$$;

ALTER FUNCTION agentos.claim_external_events(uuid, text, text, interval)
  SECURITY DEFINER;
ALTER FUNCTION agentos.refresh_external_event_claim(uuid, uuid, interval)
  SECURITY DEFINER;
ALTER FUNCTION agentos.assert_external_event_claim_current(uuid, uuid)
  SECURITY DEFINER;
ALTER FUNCTION agentos.complete_external_event_claim(uuid, uuid, jsonb)
  SECURITY DEFINER;
ALTER FUNCTION agentos.release_external_event_claim(uuid, uuid, text)
  SECURITY DEFINER;

REVOKE ALL ON FUNCTION agentos.require_reconciliation_agent(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.ingest_external_event(
  text, text, text, text, jsonb, text, jsonb, interval, interval
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.claim_external_events(
  uuid, text, text, interval
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.refresh_external_event_claim(
  uuid, uuid, interval
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.assert_external_event_claim_current(uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.complete_external_event_claim(uuid, uuid, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.release_external_event_claim(uuid, uuid, text)
  FROM PUBLIC;

CREATE FUNCTION agentos.configure_agent_runtime_privileges(
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
      'GRANT EXECUTE ON FUNCTION agentos.claim_external_events(uuid, text, text, interval), agentos.refresh_external_event_claim(uuid, uuid, interval), agentos.assert_external_event_claim_current(uuid, uuid), agentos.complete_external_event_claim(uuid, uuid, jsonb), agentos.release_external_event_claim(uuid, uuid, text) TO %I',
      p_database_role
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION agentos.configure_agent_runtime_privileges(name, text)
  FROM PUBLIC;

CREATE FUNCTION agentos.configure_registered_agent_runtime()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF NEW.database_role IS NOT NULL AND (
    OLD.database_role IS DISTINCT FROM NEW.database_role
    OR OLD.role IS DISTINCT FROM NEW.role
  ) THEN
    PERFORM agentos.configure_agent_runtime_privileges(
      NEW.database_role,
      NEW.role
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION agentos.configure_registered_agent_runtime()
  FROM PUBLIC;

CREATE TRIGGER agents_configure_runtime_privileges
AFTER UPDATE OF database_role, role ON agentos.agents
FOR EACH ROW EXECUTE FUNCTION agentos.configure_registered_agent_runtime();

DO $$
DECLARE
  v_agent record;
BEGIN
  FOR v_agent IN
    SELECT a.database_role, a.role
      FROM agentos.agents AS a
     WHERE a.database_role IS NOT NULL
       AND a.retired_at IS NULL
  LOOP
    PERFORM agentos.configure_agent_runtime_privileges(
      v_agent.database_role,
      v_agent.role
    );
  END LOOP;
END;
$$;

CREATE FUNCTION agentos.receive_inbox(p_inbox_id uuid)
RETURNS agentos.inbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_actor_handle text := agentos.current_agent_handle();
  v_actor_role text := agentos.current_agent_role();
  v_delivery agentos.inbox%ROWTYPE;
  v_administrative boolean;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Inbox receipt requires an active authenticated Agent';
  END IF;

  SELECT delivery.*
    INTO v_delivery
    FROM agentos.inbox AS delivery
   WHERE delivery.id = p_inbox_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inbox delivery does not exist';
  END IF;

  v_administrative := v_delivery.recipient_agent_id IS DISTINCT FROM v_actor_id;
  IF v_administrative AND v_actor_role IS DISTINCT FROM 'first_mate' THEN
    RAISE EXCEPTION 'Only the recipient or First Mate may receive an Inbox delivery';
  END IF;

  IF v_delivery.read_at IS NULL THEN
    UPDATE agentos.inbox AS delivery
       SET read_at = transaction_timestamp(),
           status = CASE
             WHEN delivery.status = 'unread' THEN 'read'
             ELSE delivery.status
           END,
           status_text = CASE
             WHEN delivery.status <> 'unread' THEN delivery.status_text
             WHEN v_administrative THEN 'Administratively received by First Mate'
             ELSE format('Received by %s', v_actor_handle)
           END
     WHERE delivery.id = p_inbox_id
     RETURNING delivery.* INTO v_delivery;
  END IF;

  RETURN v_delivery;
END;
$$;

COMMENT ON FUNCTION agentos.receive_inbox(uuid) IS
  'Idempotently returns one durable Inbox delivery while recording that its recipient loaded it; First Mate retains administrative repair capability. Resolution remains a separate recipient-owned state effect.';

REVOKE ALL ON FUNCTION agentos.receive_inbox(uuid) FROM PUBLIC;

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
    'GRANT EXECUTE ON FUNCTION agentos.can_manage_task(uuid), agentos.can_manage_task_assignment(uuid), agentos.receive_inbox(uuid) TO %I',
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

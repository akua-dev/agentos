CREATE FUNCTION agentos.verify_a2a_inbox_reference(
  p_inbox_id uuid,
  p_task_id uuid,
  p_assignment_id uuid,
  p_caller_agent_id uuid,
  p_target_agent_id uuid,
  p_speech_act text,
  p_skill_id text,
  p_subject text
)
RETURNS TABLE (
  version integer,
  "inboxId" text,
  "taskId" text,
  "assignmentId" text,
  "callerAgentId" text,
  "targetAgentId" text,
  "speechAct" text,
  "skillId" text,
  subject text,
  "canonicalInbox" text,
  "a2aContextId" text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  SELECT
    1,
    delivery.id::text,
    delivery.task_id::text,
    p_assignment_id::text,
    delivery.sender_agent_id::text,
    delivery.recipient_agent_id::text,
    delivery.kind,
    delivery.metadata ->> 'a2aSkillId',
    delivery.subject,
    CASE
      WHEN delivery.resolved_at IS NOT NULL THEN 'resolved'
      WHEN delivery.read_at IS NOT NULL THEN 'read'
      ELSE 'unread'
    END,
    CASE
      WHEN delivery.task_id IS NULL THEN 'agentos:inbox:' || delivery.id::text
      ELSE 'agentos:task:' || delivery.task_id::text
    END
  FROM agentos.inbox AS delivery
  JOIN agentos.agents AS caller
    ON caller.id = delivery.sender_agent_id
   AND caller.retired_at IS NULL
  JOIN agentos.agents AS target
    ON target.id = delivery.recipient_agent_id
   AND target.retired_at IS NULL
  LEFT JOIN agentos.task_assignments AS assignment
    ON assignment.id = p_assignment_id
  WHERE delivery.id = p_inbox_id
    AND delivery.task_id IS NOT DISTINCT FROM p_task_id
    AND delivery.sender_agent_id = p_caller_agent_id
    AND delivery.recipient_agent_id = p_target_agent_id
    AND delivery.kind = p_speech_act
    AND delivery.metadata ->> 'a2aSkillId' = p_skill_id
    AND delivery.metadata ->> 'a2aAssignmentId'
      IS NOT DISTINCT FROM p_assignment_id::text
    AND delivery.subject = p_subject
    AND (
      caller.parent_agent_id = target.id
      OR target.parent_agent_id = caller.id
    )
    AND (
      (
        p_assignment_id IS NULL
        AND assignment.id IS NULL
      )
      OR (
        assignment.id = p_assignment_id
        AND assignment.task_id IS NOT DISTINCT FROM delivery.task_id
        AND assignment.agent_id = delivery.recipient_agent_id
        AND assignment.ended_at IS NULL
      )
    )
$$;

COMMENT ON FUNCTION agentos.verify_a2a_inbox_reference(
  uuid, uuid, uuid, uuid, uuid, text, text, text
) IS
  'Returns one content-free A2A projection only for an already-visible canonical Inbox row whose caller, target, direct hierarchy edge, speech act, reviewed skill, subject and active target Assignment match exactly.';

CREATE FUNCTION agentos.wake_a2a_inbox_reference(p_inbox_id uuid)
RETURNS TABLE (
  version integer,
  "inboxId" text,
  recovery text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_target_mate_id uuid;
BEGIN
  SELECT agentos.notification_mate_for_agent(delivery.recipient_agent_id)
    INTO v_target_mate_id
    FROM agentos.inbox AS delivery
   WHERE delivery.id = p_inbox_id;

  IF v_target_mate_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_notify(
    agentos.mate_notification_channel(v_target_mate_id),
    jsonb_build_object(
      'version', 2,
      'table', 'inbox',
      'operation', 'a2a_wake'
    )::text
  );

  RETURN QUERY SELECT
    1,
    p_inbox_id::text,
    'postgresql_listener_then_herdr_wake'::text;
END;
$$;

COMMENT ON FUNCTION agentos.wake_a2a_inbox_reference(uuid) IS
  'Repeats only a transactional PostgreSQL wake hint for an existing Inbox UUID. It creates no Task, Assignment, Inbox row, execution, receipt or report; the listener and Herdr remain the recovery path.';

CREATE FUNCTION agentos.read_a2a_delivery_projection(
  p_inbox_id uuid,
  p_caller_agent_id uuid,
  p_target_agent_id uuid
)
RETURNS TABLE (
  version integer,
  "inboxId" text,
  "taskId" text,
  "contextId" text,
  state text,
  "canonicalInbox" text,
  "skillId" text,
  "assignmentId" text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  SELECT
    1,
    delivery.id::text,
    delivery.task_id::text,
    CASE
      WHEN delivery.task_id IS NULL THEN 'agentos:inbox:' || delivery.id::text
      ELSE 'agentos:task:' || delivery.task_id::text
    END,
    CASE
      WHEN delivery.read_at IS NULL THEN 'TASK_STATE_SUBMITTED'
      ELSE 'TASK_STATE_COMPLETED'
    END,
    CASE
      WHEN delivery.resolved_at IS NOT NULL THEN 'resolved'
      WHEN delivery.read_at IS NOT NULL THEN 'read'
      ELSE 'unread'
    END,
    delivery.metadata ->> 'a2aSkillId',
    delivery.metadata ->> 'a2aAssignmentId'
  FROM agentos.inbox AS delivery
  WHERE delivery.id = p_inbox_id
    AND delivery.sender_agent_id = p_caller_agent_id
    AND delivery.recipient_agent_id = p_target_agent_id
$$;

COMMENT ON FUNCTION agentos.read_a2a_delivery_projection(uuid, uuid, uuid) IS
  'Derives a content-free A2A delivery Task projection from the exact caller-target canonical Inbox receipt; it exposes no body, history, artifact or Assignment mutation.';

REVOKE ALL ON FUNCTION agentos.verify_a2a_inbox_reference(
  uuid, uuid, uuid, uuid, uuid, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.wake_a2a_inbox_reference(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.read_a2a_delivery_projection(
  uuid, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION agentos.configure_a2a_service_privileges(
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
    RAISE EXCEPTION 'A2A service privileges require the schema owner';
  END IF;
  SELECT role.oid,
         role.rolsuper OR role.rolcreaterole OR role.rolcreatedb
           OR role.rolreplication OR role.rolbypassrls
    INTO v_role, v_has_dangerous_attributes
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = p_database_role;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'A2A service database role does not exist';
  END IF;
  IF v_has_dangerous_attributes THEN
    RAISE EXCEPTION 'A2A service database role is privileged';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.member = v_role
  ) THEN
    RAISE EXCEPTION 'A2A service database role must not inherit roles';
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
    'GRANT EXECUTE ON FUNCTION agentos.read_egress_workload_agents(text, text), agentos.read_egress_assignments(uuid), agentos.read_egress_policy_snapshots(jsonb), agentos.verify_a2a_inbox_reference(uuid,uuid,uuid,uuid,uuid,text,text,text), agentos.wake_a2a_inbox_reference(uuid), agentos.read_a2a_delivery_projection(uuid,uuid,uuid) TO %I',
    p_database_role
  );
END;
$$;

COMMENT ON FUNCTION agentos.configure_a2a_service_privileges(name) IS
  'Strips direct AgentOS access from a dedicated non-privileged A2A login and grants only workload identity, policy snapshot, content-free canonical verification, wake and delivery-projection functions.';

REVOKE ALL ON FUNCTION agentos.configure_a2a_service_privileges(name)
  FROM PUBLIC;

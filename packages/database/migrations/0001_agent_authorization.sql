ALTER TABLE agentos.agents
  ADD COLUMN database_role name;

COMMENT ON COLUMN agentos.agents.database_role IS
  'Exact PostgreSQL session_user bound to this Agent; credentials and role creation remain outside migrations.';

CREATE UNIQUE INDEX agents_database_role_idx
  ON agentos.agents (database_role)
  WHERE database_role IS NOT NULL;

CREATE FUNCTION agentos.current_agent_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  SELECT a.id
    FROM agentos.agents AS a
   WHERE a.database_role = session_user::name
     AND a.retired_at IS NULL
$$;

CREATE FUNCTION agentos.current_agent_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  SELECT a.role
    FROM agentos.agents AS a
   WHERE a.database_role = session_user::name
     AND a.retired_at IS NULL
$$;

CREATE FUNCTION agentos.current_agent_handle()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  SELECT a.handle
    FROM agentos.agents AS a
   WHERE a.database_role = session_user::name
     AND a.retired_at IS NULL
$$;

CREATE FUNCTION agentos.can_manage_agent(p_agent_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  WITH RECURSIVE caller AS (
    SELECT a.id, a.role
      FROM agentos.agents AS a
     WHERE a.database_role = session_user::name
       AND a.retired_at IS NULL
  ), managed AS (
    SELECT c.id
      FROM caller AS c
    UNION
    SELECT child.id
      FROM agentos.agents AS child
      JOIN managed AS parent ON child.parent_agent_id = parent.id
  )
  SELECT coalesce(
    (
      SELECT CASE
        WHEN c.role = 'first_mate' THEN true
        WHEN c.role = 'second_mate' THEN p_agent_id IN (SELECT m.id FROM managed AS m)
        ELSE p_agent_id = c.id
      END
      FROM caller AS c
    ),
    false
  )
$$;

CREATE FUNCTION agentos.register_agent_principal(
  p_agent_id uuid,
  p_database_role name
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_agent_role text;
  v_existing_role name;
  v_owner name;
  v_role record;
BEGIN
  SELECT owner.rolname
    INTO STRICT v_owner
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
   WHERE relation.oid = 'agentos.agents'::regclass;

  SELECT a.role, a.database_role
    INTO v_agent_role, v_existing_role
    FROM agentos.agents AS a
   WHERE a.id = p_agent_id
     AND a.retired_at IS NULL;

  IF v_agent_role IS NULL THEN
    RAISE EXCEPTION 'principal registration requires an active Agent';
  END IF;

  IF session_user::name <> v_owner AND (
    agentos.current_agent_role() NOT IN ('first_mate', 'second_mate') OR
    NOT agentos.can_manage_agent(p_agent_id)
  ) THEN
    RAISE EXCEPTION 'principal registration requires the Fleet owner or a managing Mate';
  END IF;

  IF v_existing_role IS NOT NULL AND v_existing_role <> p_database_role THEN
    RAISE EXCEPTION 'Agent is already bound to database role %', v_existing_role;
  END IF;

  SELECT
    r.rolcanlogin,
    r.rolsuper,
    r.rolcreatedb,
    r.rolcreaterole,
    r.rolbypassrls
    INTO v_role
    FROM pg_catalog.pg_roles AS r
   WHERE r.rolname = p_database_role;

  IF NOT FOUND OR NOT v_role.rolcanlogin THEN
    RAISE EXCEPTION 'database role % must already exist and allow login', p_database_role;
  END IF;

  IF v_agent_role = 'first_mate' AND p_database_role <> v_owner THEN
    RAISE EXCEPTION 'First Mate must use the Fleet owner role %', v_owner;
  END IF;

  IF p_database_role = v_owner THEN
    IF session_user::name <> v_owner OR v_agent_role <> 'first_mate' THEN
      RAISE EXCEPTION 'only the Fleet owner may bind its role to First Mate';
    END IF;
  ELSIF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles AS inherited_role
     WHERE (
       inherited_role.rolsuper OR
       inherited_role.rolcreatedb OR
       inherited_role.rolcreaterole OR
       inherited_role.rolbypassrls OR
       inherited_role.rolname = v_owner OR
       inherited_role.oid = (
         SELECT database_owner.datdba
           FROM pg_catalog.pg_database AS database_owner
          WHERE database_owner.datname = current_database()
       )
     )
       AND pg_catalog.pg_has_role(
         p_database_role,
         inherited_role.oid,
         'MEMBER'
       )
  ) THEN
    RAISE EXCEPTION 'database role % is too privileged for an Agent principal', p_database_role;
  END IF;

  UPDATE agentos.agents
     SET database_role = p_database_role
   WHERE id = p_agent_id;

  EXECUTE format('GRANT USAGE ON SCHEMA agentos TO %I', p_database_role);
  EXECUTE format(
    'GRANT SELECT ON agentos.agents, agentos.captain, agentos.external_events, agentos.inbox, agentos.learnings, agentos.projects, agentos.task_assignments, agentos.tasks TO %I',
    p_database_role
  );
  EXECUTE format(
    'GRANT UPDATE (display_name, harness, lifecycle_status, status_text, kubernetes_context, kubernetes_namespace, kubernetes_pod, persistent_volume_claim, herdr_locator, metadata) ON agentos.agents TO %I',
    p_database_role
  );
  EXECUTE format(
    'GRANT INSERT (id, sender_agent_id, sender_label, recipient_agent_id, task_id, reply_to_id, kind, subject, body, decision_key, status, status_text, metadata, read_at, resolved_at) ON agentos.inbox TO %I',
    p_database_role
  );
  EXECUTE format(
    'GRANT UPDATE (subject, body, status, status_text, metadata, read_at, resolved_at) ON agentos.inbox TO %I',
    p_database_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION agentos.current_agent_id(), agentos.current_agent_role(), agentos.current_agent_handle(), agentos.can_manage_agent(uuid), agentos.register_agent_principal(uuid, name) TO %I',
    p_database_role
  );
END;
$$;

REVOKE ALL ON FUNCTION agentos.current_agent_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.current_agent_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.current_agent_handle() FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.can_manage_agent(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.register_agent_principal(uuid, name) FROM PUBLIC;

ALTER TABLE agentos.agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY agents_registered_read
  ON agentos.agents
  FOR SELECT
  USING (agentos.current_agent_id() IS NOT NULL);

CREATE POLICY agents_managed_update
  ON agentos.agents
  FOR UPDATE
  USING (agentos.can_manage_agent(id))
  WITH CHECK (agentos.can_manage_agent(id));

ALTER TABLE agentos.inbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY inbox_registered_read
  ON agentos.inbox
  FOR SELECT
  USING (agentos.current_agent_id() IS NOT NULL);

CREATE POLICY inbox_authentic_insert
  ON agentos.inbox
  FOR INSERT
  WITH CHECK (
    sender_agent_id = agentos.current_agent_id() AND
    sender_label = agentos.current_agent_handle()
  );

CREATE POLICY inbox_managed_update
  ON agentos.inbox
  FOR UPDATE
  USING (
    sender_agent_id = agentos.current_agent_id() OR
    recipient_agent_id = agentos.current_agent_id() OR
    agentos.can_manage_agent(sender_agent_id) OR
    agentos.can_manage_agent(recipient_agent_id)
  )
  WITH CHECK (
    sender_agent_id = agentos.current_agent_id() OR
    recipient_agent_id = agentos.current_agent_id() OR
    agentos.can_manage_agent(sender_agent_id) OR
    agentos.can_manage_agent(recipient_agent_id)
  );

ALTER TABLE agentos.captain ENABLE ROW LEVEL SECURITY;

CREATE POLICY captain_registered_read
  ON agentos.captain
  FOR SELECT
  USING (agentos.current_agent_id() IS NOT NULL);

ALTER TABLE agentos.external_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY external_events_registered_read
  ON agentos.external_events
  FOR SELECT
  USING (agentos.current_agent_id() IS NOT NULL);

ALTER TABLE agentos.learnings ENABLE ROW LEVEL SECURITY;

CREATE POLICY learnings_registered_read
  ON agentos.learnings
  FOR SELECT
  USING (agentos.current_agent_id() IS NOT NULL);

ALTER TABLE agentos.projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY projects_registered_read
  ON agentos.projects
  FOR SELECT
  USING (agentos.current_agent_id() IS NOT NULL);

ALTER TABLE agentos.task_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY task_assignments_registered_read
  ON agentos.task_assignments
  FOR SELECT
  USING (agentos.current_agent_id() IS NOT NULL);

ALTER TABLE agentos.tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY tasks_registered_read
  ON agentos.tasks
  FOR SELECT
  USING (agentos.current_agent_id() IS NOT NULL);

CREATE OR REPLACE FUNCTION agentos.protect_read_inbox_message()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_agent_id uuid := agentos.current_agent_id();
  v_owner name;
BEGIN
  SELECT owner.rolname
    INTO STRICT v_owner
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
   WHERE relation.oid = TG_RELID;

  IF NEW.sender_agent_id IS DISTINCT FROM OLD.sender_agent_id OR
     NEW.sender_label IS DISTINCT FROM OLD.sender_label OR
     NEW.recipient_agent_id IS DISTINCT FROM OLD.recipient_agent_id OR
     NEW.task_id IS DISTINCT FROM OLD.task_id OR
     NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id OR
     NEW.kind IS DISTINCT FROM OLD.kind OR
     NEW.decision_key IS DISTINCT FROM OLD.decision_key THEN
    RAISE EXCEPTION 'inbox delivery routing is immutable; create a follow-up delivery';
  END IF;

  IF NEW.subject IS DISTINCT FROM OLD.subject OR
     NEW.body IS DISTINCT FROM OLD.body OR
     NEW.metadata IS DISTINCT FROM OLD.metadata THEN
    IF OLD.read_at IS NOT NULL THEN
      RAISE EXCEPTION 'a read inbox delivery is immutable; create a follow-up delivery';
    END IF;

    IF session_user::name <> v_owner AND OLD.sender_agent_id IS DISTINCT FROM v_agent_id THEN
      RAISE EXCEPTION 'only the sender may edit unread inbox content';
    END IF;
  END IF;

  IF NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    IF OLD.read_at IS NOT NULL THEN
      RAISE EXCEPTION 'inbox read state cannot be reversed or rewritten';
    END IF;

    IF session_user::name <> v_owner AND OLD.recipient_agent_id IS DISTINCT FROM v_agent_id THEN
      RAISE EXCEPTION 'only the recipient may mark an inbox delivery read';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

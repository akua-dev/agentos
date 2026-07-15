DO $$
DECLARE
  v_active_first_mates integer;
  v_database_role name;
  v_first_mate_id uuid;
  v_owner name;
BEGIN
  SELECT owner.rolname
    INTO STRICT v_owner
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
   WHERE namespace.nspname = 'agentos'
     AND relation.relname = 'agents'
     AND relation.relkind = 'r';

  IF session_user::name <> v_owner THEN
    RAISE EXCEPTION 'Fleet initialization must run as Fleet owner %', v_owner;
  END IF;

  SELECT count(*)::integer
    INTO v_active_first_mates
    FROM agentos.agents AS agent
   WHERE agent.role = 'first_mate'
     AND agent.retired_at IS NULL;

  IF v_active_first_mates > 1 THEN
    RAISE EXCEPTION 'Fleet initialization found multiple active First Mates';
  END IF;

  IF v_active_first_mates = 0 THEN
    INSERT INTO agentos.agents (
      handle,
      display_name,
      role,
      harness,
      lifecycle_status,
      status_text
    ) VALUES (
      'firstmate',
      'First Mate',
      'first_mate',
      'pi',
      'active',
      'Database identity initialized; runtime verification pending'
    )
    RETURNING id, database_role
      INTO v_first_mate_id, v_database_role;
  ELSE
    SELECT agent.id, agent.database_role
      INTO STRICT v_first_mate_id, v_database_role
      FROM agentos.agents AS agent
     WHERE agent.role = 'first_mate'
       AND agent.retired_at IS NULL;
  END IF;

  IF v_database_role IS NULL THEN
    PERFORM agentos.register_agent_principal(v_first_mate_id, v_owner);
  ELSIF v_database_role <> v_owner THEN
    RAISE EXCEPTION 'active First Mate is bound to %, expected Fleet owner %',
      v_database_role,
      v_owner;
  END IF;
END;
$$;

CREATE UNIQUE INDEX agents_one_active_first_mate_idx
  ON agentos.agents (role)
  WHERE role = 'first_mate'
    AND retired_at IS NULL;

CREATE FUNCTION agentos.mate_notification_channel(p_agent_id uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT 'agentos_mate_' || replace(lower(p_agent_id::text), '-', '')
$$;

COMMENT ON FUNCTION agentos.mate_notification_channel(uuid) IS
  'Deterministic non-secret PostgreSQL wake channel for one persistent Mate Agent UUID; the channel grants no authority.';

CREATE FUNCTION agentos.notification_mate_for_agent(p_agent_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE
    WHEN agent.role IN ('first_mate', 'second_mate')
     AND agent.retired_at IS NULL THEN agent.id
    WHEN parent.role IN ('first_mate', 'second_mate')
     AND parent.retired_at IS NULL THEN parent.id
    ELSE NULL
  END
    FROM agentos.agents AS agent
    LEFT JOIN agentos.agents AS parent ON parent.id = agent.parent_agent_id
   WHERE agent.id = p_agent_id
$$;

CREATE FUNCTION agentos.notification_targets(
  p_table text,
  p_operation text,
  p_old jsonb,
  p_new jsonb
)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_agent_id uuid;
  v_first_mate_id uuid;
  v_target_id uuid;
  v_targets uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT agent.id
    INTO v_first_mate_id
    FROM agentos.agents AS agent
   WHERE agent.role = 'first_mate'
     AND agent.retired_at IS NULL;

  IF p_table = 'inbox'
     AND p_operation = 'UPDATE'
     AND agentos.current_agent_id()
         IS NOT DISTINCT FROM (p_new ->> 'recipient_agent_id')::uuid
     AND (
       p_old - ARRAY[
         'read_at',
         'resolved_at',
         'status',
         'status_text',
         'updated_at'
       ]::text[]
     ) IS NOT DISTINCT FROM (
       p_new - ARRAY[
         'read_at',
         'resolved_at',
         'status',
         'status_text',
         'updated_at'
       ]::text[]
     ) THEN
    RETURN;
  END IF;

  CASE p_table
    WHEN 'inbox' THEN
      IF p_old IS NOT NULL
         AND p_old ->> 'recipient_agent_id' IS NOT NULL THEN
        v_agent_id := (p_old ->> 'recipient_agent_id')::uuid;
        v_targets := array_append(
          v_targets,
          agentos.notification_mate_for_agent(v_agent_id)
        );
      END IF;
      IF p_new IS NOT NULL
         AND p_new ->> 'recipient_agent_id' IS NOT NULL THEN
        v_agent_id := (p_new ->> 'recipient_agent_id')::uuid;
        v_targets := array_append(
          v_targets,
          agentos.notification_mate_for_agent(v_agent_id)
        );
      END IF;

    WHEN 'task_assignments' THEN
      IF p_old IS NOT NULL AND p_old ->> 'agent_id' IS NOT NULL THEN
        v_agent_id := (p_old ->> 'agent_id')::uuid;
        v_targets := array_append(
          v_targets,
          agentos.notification_mate_for_agent(v_agent_id)
        );
      END IF;
      IF p_new IS NOT NULL AND p_new ->> 'agent_id' IS NOT NULL THEN
        v_agent_id := (p_new ->> 'agent_id')::uuid;
        v_targets := array_append(
          v_targets,
          agentos.notification_mate_for_agent(v_agent_id)
        );
      END IF;

    WHEN 'tasks' THEN
      SELECT agentos.notification_mate_for_agent(assignment.agent_id)
        INTO v_target_id
        FROM agentos.task_assignments AS assignment
       WHERE assignment.task_id = (p_new ->> 'id')::uuid
         AND assignment.ended_at IS NULL;

      IF v_target_id IS NULL
         AND p_new ->> 'created_by_agent_id' IS NOT NULL THEN
        v_target_id := agentos.notification_mate_for_agent(
          (p_new ->> 'created_by_agent_id')::uuid
        );
      END IF;
      v_targets := array_append(v_targets, v_target_id);

    WHEN 'agents' THEN
      IF p_old IS NOT NULL THEN
        IF p_old ->> 'role' IN ('first_mate', 'second_mate') THEN
          v_targets := array_append(
            v_targets,
            agentos.notification_mate_for_agent((p_old ->> 'id')::uuid)
          );
        END IF;
        IF p_old ->> 'parent_agent_id' IS NOT NULL THEN
          v_targets := array_append(
            v_targets,
            agentos.notification_mate_for_agent(
              (p_old ->> 'parent_agent_id')::uuid
            )
          );
        END IF;
      END IF;
      IF p_new IS NOT NULL THEN
        IF p_new ->> 'role' IN ('first_mate', 'second_mate') THEN
          v_targets := array_append(
            v_targets,
            agentos.notification_mate_for_agent((p_new ->> 'id')::uuid)
          );
        END IF;
        IF p_new ->> 'parent_agent_id' IS NOT NULL THEN
          v_targets := array_append(
            v_targets,
            agentos.notification_mate_for_agent(
              (p_new ->> 'parent_agent_id')::uuid
            )
          );
        END IF;
      END IF;

    WHEN 'captain' THEN
      IF p_old IS NOT NULL THEN
        IF p_old ->> 'scope' = 'fleet' THEN
          v_targets := array_append(v_targets, v_first_mate_id);
        ELSIF p_old ->> 'scope_agent_id' IS NOT NULL THEN
          v_targets := array_append(
            v_targets,
            agentos.notification_mate_for_agent(
              (p_old ->> 'scope_agent_id')::uuid
            )
          );
        END IF;
      END IF;
      IF p_new IS NOT NULL THEN
        IF p_new ->> 'scope' = 'fleet' THEN
          v_targets := array_append(v_targets, v_first_mate_id);
        ELSIF p_new ->> 'scope_agent_id' IS NOT NULL THEN
          v_targets := array_append(
            v_targets,
            agentos.notification_mate_for_agent(
              (p_new ->> 'scope_agent_id')::uuid
            )
          );
        END IF;
      END IF;

    WHEN 'external_events' THEN
      IF p_old IS NOT NULL
         AND p_old ->> 'claimed_by_agent_id' IS NOT NULL THEN
        v_targets := array_append(
          v_targets,
          agentos.notification_mate_for_agent(
            (p_old ->> 'claimed_by_agent_id')::uuid
          )
        );
      ELSIF p_old IS NOT NULL THEN
        v_targets := array_append(v_targets, v_first_mate_id);
      END IF;
      IF p_new IS NOT NULL
         AND p_new ->> 'claimed_by_agent_id' IS NOT NULL THEN
        v_targets := array_append(
          v_targets,
          agentos.notification_mate_for_agent(
            (p_new ->> 'claimed_by_agent_id')::uuid
          )
        );
      ELSIF p_new IS NOT NULL THEN
        v_targets := array_append(v_targets, v_first_mate_id);
      END IF;

    ELSE
      v_targets := array_append(v_targets, v_first_mate_id);
  END CASE;

  IF coalesce(cardinality(array_remove(v_targets, NULL)), 0) = 0 THEN
    v_targets := array_append(v_targets, v_first_mate_id);
  END IF;

  RETURN QUERY
    SELECT DISTINCT target.agent_id
      FROM unnest(v_targets) AS target(agent_id)
     WHERE target.agent_id IS NOT NULL
     ORDER BY target.agent_id;
END;
$$;

REVOKE ALL ON FUNCTION agentos.notification_mate_for_agent(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.notification_targets(
  text, text, jsonb, jsonb
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION agentos.notify_fleet_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_old jsonb;
  v_target_id uuid;
  v_target_payload text := jsonb_build_object(
    'version', 2,
    'table', TG_TABLE_NAME,
    'operation', lower(TG_OP)
  )::text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old := to_jsonb(OLD);
  END IF;

  FOR v_target_id IN
    SELECT target
      FROM agentos.notification_targets(
        TG_TABLE_NAME,
        TG_OP,
        v_old,
        to_jsonb(NEW)
      ) AS target
  LOOP
    PERFORM pg_notify(
      agentos.mate_notification_channel(v_target_id),
      v_target_payload
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER notify_agentos_events_tasks ON agentos.tasks;

CREATE CONSTRAINT TRIGGER notify_agentos_events_tasks
AFTER INSERT OR UPDATE ON agentos.tasks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION agentos.notify_fleet_change();

COMMENT ON FUNCTION agentos.notify_fleet_change() IS
  'Emits deterministic targeted Mate hints after commit; durable Fleet rows remain authoritative.';

DO $$
DECLARE
  v_active_rows text;
BEGIN
  SELECT string_agg(
           format(
             '%s topic=%L scope=%s target=%s',
             captain.id,
             captain.topic,
             captain.scope,
             coalesce(captain.scope_agent_id::text, 'fleet')
           ),
           '; '
           ORDER BY captain.created_at, captain.id
         )
    INTO v_active_rows
    FROM agentos.captain AS captain
   WHERE captain.archived_at IS NULL;

  IF v_active_rows IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0015 cannot remove active Captain intent. First preserve active Captain rows in the owning Mate''s $HOME/memory/, verify dynamic injection, archive the preserved or superseded rows, and retry. Active rows: %',
      v_active_rows;
  END IF;
END;
$$;

CREATE FUNCTION agentos.hold_agent_composition_decision(
  p_task_id uuid,
  p_agent_id uuid,
  p_composition jsonb,
  p_decision_key text,
  p_subject text,
  p_body text,
  p_status_text text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_existing agentos.inbox%ROWTYPE;
  v_id uuid;
  v_metadata jsonb := jsonb_build_object(
    'agent_composition',
    jsonb_build_object(
      'version', 1,
      'agent_id', p_agent_id,
      'composition', p_composition
    )
  );
  v_target agentos.agents%ROWTYPE;
BEGIN
  IF v_actor_id IS NULL
     OR agentos.current_agent_role() <> 'first_mate'
     OR NOT agentos.can_manage_task(p_task_id)
     OR NOT EXISTS (
       SELECT 1
         FROM agentos.task_assignments AS assignment
        WHERE assignment.task_id = p_task_id
     ) THEN
    RAISE EXCEPTION
      'persistent composition decision creation requires the owning First Mate and a managed accepted Task';
  END IF;

  SELECT agent.*
    INTO v_target
    FROM agentos.agents AS agent
   WHERE agent.id = p_agent_id
     AND agent.retired_at IS NULL
   FOR UPDATE;

  IF NOT FOUND OR v_target.role NOT IN ('first_mate', 'second_mate') THEN
    RAISE EXCEPTION
      'persistent composition decision requires an active First or Second Mate';
  END IF;

  IF (
    v_target.role = 'first_mate'
    AND v_target.id IS DISTINCT FROM v_actor_id
  ) OR (
    v_target.role = 'second_mate'
    AND v_target.parent_agent_id IS DISTINCT FROM v_actor_id
  ) THEN
    RAISE EXCEPTION
      'persistent composition decision requires the owning First Mate';
  END IF;

  IF NOT agentos.valid_composition_manifest(p_composition) THEN
    RAISE EXCEPTION
      'persistent composition decision requires a valid composition';
  END IF;

  IF p_composition ->> 'harness' IS DISTINCT FROM v_target.harness THEN
    RAISE EXCEPTION
      'composition harness must match the Agent';
  END IF;

  IF p_decision_key IS NULL
     OR p_decision_key !~ '^[a-z0-9][a-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION
      'composition decision key must be stable, privacy-safe and at most 128 characters';
  END IF;

  IF p_subject IS NULL OR length(btrim(p_subject)) = 0
     OR p_body IS NULL OR length(btrim(p_body)) = 0
     OR p_status_text IS NULL OR length(btrim(p_status_text)) = 0 THEN
    RAISE EXCEPTION
      'composition decision creation requires subject, body and status text';
  END IF;

  SELECT delivery.*
    INTO v_existing
    FROM agentos.inbox AS delivery
   WHERE delivery.decision_key = p_decision_key;

  IF FOUND THEN
    IF v_existing.sender_agent_id = v_actor_id
       AND v_existing.recipient_agent_id = v_actor_id
       AND v_existing.task_id = p_task_id
       AND v_existing.kind = 'captain_decision'
       AND v_existing.subject = btrim(p_subject)
       AND v_existing.body = btrim(p_body)
       AND v_existing.metadata IS NOT DISTINCT FROM v_metadata THEN
      RETURN v_existing.id;
    END IF;

    RAISE EXCEPTION
      'composition decision key conflicts with an existing decision';
  END IF;

  INSERT INTO agentos.inbox (
    sender_agent_id,
    sender_label,
    recipient_agent_id,
    task_id,
    kind,
    subject,
    body,
    decision_key,
    status,
    status_text,
    metadata
  ) VALUES (
    v_actor_id,
    agentos.current_agent_handle(),
    v_actor_id,
    p_task_id,
    'captain_decision',
    btrim(p_subject),
    btrim(p_body),
    p_decision_key,
    'awaiting_captain',
    btrim(p_status_text),
    v_metadata
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE FUNCTION agentos.resolve_agent_composition_decision(
  p_decision_id uuid,
  p_approved boolean,
  p_answer text,
  p_status_text text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_answer_id uuid;
  v_answer_metadata jsonb := jsonb_build_object(
    'agent_composition_approval',
    jsonb_build_object(
      'version', 1,
      'approved', p_approved
    )
  );
  v_decision agentos.inbox%ROWTYPE;
BEGIN
  IF v_actor_id IS NULL
     OR agentos.current_agent_role() <> 'first_mate' THEN
    RAISE EXCEPTION
      'persistent composition decision resolution requires the owning First Mate';
  END IF;

  IF p_approved IS NULL
     OR p_answer IS NULL OR length(btrim(p_answer)) = 0
     OR p_status_text IS NULL OR length(btrim(p_status_text)) = 0 THEN
    RAISE EXCEPTION
      'composition decision resolution requires explicit approval, exact answer and status text';
  END IF;

  SELECT decision.*
    INTO v_decision
    FROM agentos.inbox AS decision
   WHERE decision.id = p_decision_id
     AND decision.kind = 'captain_decision'
     AND decision.metadata #> '{agent_composition,version}' = '1'::jsonb
   FOR UPDATE;

  IF NOT FOUND
     OR v_decision.sender_agent_id IS DISTINCT FROM v_actor_id
     OR v_decision.recipient_agent_id IS DISTINCT FROM v_actor_id
     OR v_decision.task_id IS NULL
     OR NOT agentos.can_manage_task(v_decision.task_id) THEN
    RAISE EXCEPTION
      'composition decision resolution requires an owned typed decision';
  END IF;

  IF v_decision.resolved_at IS NOT NULL THEN
    SELECT answer.id
      INTO v_answer_id
      FROM agentos.inbox AS answer
     WHERE answer.reply_to_id = p_decision_id
       AND answer.kind = 'captain_decision_answer'
       AND answer.sender_agent_id IS NULL
       AND answer.sender_label = 'Captain'
       AND answer.body = btrim(p_answer)
       AND answer.metadata IS NOT DISTINCT FROM v_answer_metadata;

    IF v_answer_id IS NOT NULL THEN
      RETURN v_answer_id;
    END IF;

    RAISE EXCEPTION
      'composition decision is already resolved with a different answer or approval';
  END IF;

  INSERT INTO agentos.inbox (
    sender_agent_id,
    sender_label,
    recipient_agent_id,
    task_id,
    reply_to_id,
    kind,
    subject,
    body,
    status,
    status_text,
    metadata,
    resolved_at
  ) VALUES (
    NULL,
    'Captain',
    v_decision.recipient_agent_id,
    v_decision.task_id,
    p_decision_id,
    'captain_decision_answer',
    v_decision.subject,
    btrim(p_answer),
    'resolved',
    btrim(p_status_text),
    v_answer_metadata,
    transaction_timestamp()
  )
  RETURNING id INTO v_answer_id;

  UPDATE agentos.inbox
     SET status = 'resolved',
         status_text = btrim(p_status_text),
         resolved_at = transaction_timestamp()
   WHERE id = p_decision_id;

  UPDATE agentos.tasks AS task
     SET dependencies = (
           SELECT coalesce(jsonb_agg(dependency), '[]'::jsonb)
             FROM jsonb_array_elements(task.dependencies) AS dependency
            WHERE NOT (
              dependency ->> 'kind' = 'captain_decision'
              AND dependency ->> 'decision_key' = v_decision.decision_key
            )
         ),
         status_text = btrim(p_status_text)
   WHERE agentos.can_manage_task(task.id)
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(task.dependencies) AS dependency
        WHERE dependency ->> 'kind' = 'captain_decision'
          AND dependency ->> 'decision_key' = v_decision.decision_key
     );

  RETURN v_answer_id;
END;
$$;

COMMENT ON FUNCTION agentos.hold_agent_composition_decision(
  uuid, uuid, jsonb, text, text, text, text
) IS
  'Creates one Captain decision bound to an exact persistent Mate and validated composition; the decision alone grants no authority.';
COMMENT ON FUNCTION agentos.resolve_agent_composition_decision(
  uuid, boolean, text, text
) IS
  'Records an explicit Captain approve or reject answer for one typed persistent composition decision.';

REVOKE ALL ON FUNCTION agentos.hold_agent_composition_decision(
  uuid, uuid, jsonb, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.resolve_agent_composition_decision(
  uuid, boolean, text, text
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION agentos.change_agent_composition(
  p_agent_id uuid,
  p_composition jsonb,
  p_authority_id uuid,
  p_reason text,
  p_change_kind text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_caller_id uuid := agentos.current_agent_id();
  v_caller_role text := agentos.current_agent_role();
  v_target agentos.agents%ROWTYPE;
BEGIN
  IF v_caller_id IS NULL OR v_caller_role <> 'first_mate' THEN
    RAISE EXCEPTION
      'persistent Agent composition requires First Mate';
  END IF;

  IF p_change_kind NOT IN ('replace', 'repair') THEN
    RAISE EXCEPTION
      'Agent composition change kind must be replace or repair';
  END IF;

  IF p_reason IS NULL OR p_reason !~ '[^[:space:]]' THEN
    RAISE EXCEPTION
      'Agent composition change requires a durable reason';
  END IF;

  SELECT agent.*
    INTO v_target
    FROM agentos.agents AS agent
   WHERE agent.id = p_agent_id
     AND agent.retired_at IS NULL
   FOR UPDATE;

  IF NOT FOUND OR v_target.role NOT IN ('first_mate', 'second_mate') THEN
    RAISE EXCEPTION
      'persistent composition requires an active First or Second Mate';
  END IF;

  IF (
    v_target.role = 'first_mate'
    AND v_target.id IS DISTINCT FROM v_caller_id
  ) OR (
    v_target.role = 'second_mate'
    AND v_target.parent_agent_id IS DISTINCT FROM v_caller_id
  ) THEN
    RAISE EXCEPTION
      'persistent Agent composition requires the owning First Mate';
  END IF;

  IF NOT agentos.valid_composition_manifest(p_composition) THEN
    RAISE EXCEPTION
      'persistent Agent composition is invalid';
  END IF;

  IF p_composition ->> 'harness' IS DISTINCT FROM v_target.harness THEN
    RAISE EXCEPTION
      'composition harness must match the Agent';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM agentos.inbox AS answer
      JOIN agentos.inbox AS decision
        ON decision.id = answer.reply_to_id
      JOIN agentos.tasks AS authority_task
        ON authority_task.id = decision.task_id
     WHERE answer.id = p_authority_id
       AND answer.kind = 'captain_decision_answer'
       AND answer.sender_agent_id IS NULL
       AND answer.sender_label = 'Captain'
       AND answer.recipient_agent_id = v_caller_id
       AND answer.task_id = decision.task_id
       AND answer.resolved_at IS NOT NULL
       AND answer.status = 'resolved'
       AND answer.metadata #> '{agent_composition_approval,version}'
           = '1'::jsonb
       AND answer.metadata #> '{agent_composition_approval,approved}'
           = 'true'::jsonb
       AND decision.kind = 'captain_decision'
       AND decision.sender_agent_id = v_caller_id
       AND decision.recipient_agent_id = v_caller_id
       AND decision.resolved_at IS NOT NULL
       AND decision.status = 'resolved'
       AND decision.metadata #> '{agent_composition,version}' = '1'::jsonb
       AND decision.metadata #> '{agent_composition,agent_id}'
           = to_jsonb(p_agent_id::text)
       AND decision.metadata #> '{agent_composition,composition}'
           IS NOT DISTINCT FROM p_composition
       AND authority_task.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'persistent Agent composition requires an exact approved Captain composition decision';
  END IF;

  IF v_target.resolved_composition IS NOT DISTINCT FROM p_composition THEN
    RETURN;
  END IF;

  UPDATE agentos.agents AS agent
     SET resolved_composition = p_composition,
         metadata = jsonb_set(
           agent.metadata,
           '{composition_change}',
           jsonb_build_object(
             'authority_id', p_authority_id,
             'change_kind', p_change_kind,
             'changed_by_agent_id', v_caller_id,
             'previous', v_target.resolved_composition,
             'reason', regexp_replace(
               p_reason,
               '^[[:space:]]+|[[:space:]]+$',
               '',
               'g'
             )
           ),
           true
         )
   WHERE agent.id = p_agent_id;
END;
$$;

CREATE OR REPLACE FUNCTION agentos.notification_targets(
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
     AND agent.retired_at IS NULL
     AND agent.database_role IS NOT NULL;

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

CREATE OR REPLACE FUNCTION agentos.register_agent_principal(
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

  SELECT agent.role, agent.database_role
    INTO v_agent_role, v_existing_role
    FROM agentos.agents AS agent
   WHERE agent.id = p_agent_id
     AND agent.retired_at IS NULL;

  IF v_agent_role IS NULL THEN
    RAISE EXCEPTION 'principal registration requires an active Agent';
  END IF;

  IF session_user::name <> v_owner AND (
    agentos.current_agent_role() NOT IN ('first_mate', 'second_mate') OR
    NOT agentos.can_manage_agent(p_agent_id)
  ) THEN
    RAISE EXCEPTION
      'principal registration requires the Fleet owner or a managing Mate';
  END IF;

  IF v_existing_role IS NOT NULL AND v_existing_role <> p_database_role THEN
    RAISE EXCEPTION
      'Agent is already bound to database role %',
      v_existing_role;
  END IF;

  SELECT
    role.rolcanlogin,
    role.rolsuper,
    role.rolcreatedb,
    role.rolcreaterole,
    role.rolbypassrls
    INTO v_role
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = p_database_role;

  IF NOT FOUND OR NOT v_role.rolcanlogin THEN
    RAISE EXCEPTION
      'database role % must already exist and allow login',
      p_database_role;
  END IF;

  IF v_agent_role = 'first_mate' AND p_database_role <> v_owner THEN
    RAISE EXCEPTION 'First Mate must use the Fleet owner role %', v_owner;
  END IF;

  IF p_database_role = v_owner THEN
    IF session_user::name <> v_owner OR v_agent_role <> 'first_mate' THEN
      RAISE EXCEPTION
        'only the Fleet owner may bind its role to First Mate';
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
    RAISE EXCEPTION
      'database role % is too privileged for an Agent principal',
      p_database_role;
  END IF;

  UPDATE agentos.agents
     SET database_role = p_database_role
   WHERE id = p_agent_id;

  EXECUTE format('GRANT USAGE ON SCHEMA agentos TO %I', p_database_role);
  EXECUTE format(
    'GRANT SELECT ON agentos.agents, agentos.external_events, agentos.inbox, agentos.learnings, agentos.projects, agentos.task_assignments, agentos.tasks TO %I',
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
    'REVOKE EXECUTE ON FUNCTION agentos.retire_agent(uuid, text), agentos.provision_agent(text, text, text, text, text, jsonb), agentos.handoff_task_assignment(uuid, uuid, text, text, text, jsonb), agentos.hold_captain_decision(uuid, text, text, text, text), agentos.link_task_decision(uuid, text, text), agentos.attest_assignment_decisions(uuid, text[]), agentos.resolve_captain_decision(uuid, text, text), agentos.create_task_with_assignment(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb, text, text, text, text, jsonb, jsonb), agentos.accept_backlog_task(uuid, uuid, uuid, text, text, text, text, text, text, jsonb, jsonb), agentos.current_mate_bearings(), agentos.hold_agent_composition_decision(uuid, uuid, jsonb, text, text, text, text), agentos.resolve_agent_composition_decision(uuid, boolean, text, text) FROM %I',
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
      'GRANT EXECUTE ON FUNCTION agentos.retire_agent(uuid, text), agentos.provision_agent(text, text, text, text, text, jsonb), agentos.handoff_task_assignment(uuid, uuid, text, text, text, jsonb), agentos.hold_captain_decision(uuid, text, text, text, text), agentos.link_task_decision(uuid, text, text), agentos.attest_assignment_decisions(uuid, text[]), agentos.resolve_captain_decision(uuid, text, text), agentos.create_task_with_assignment(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb, text, text, text, text, jsonb, jsonb), agentos.accept_backlog_task(uuid, uuid, uuid, text, text, text, text, text, text, jsonb, jsonb), agentos.current_mate_bearings() TO %I',
      p_database_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION agentos.claim_external_events(uuid, text, text, interval), agentos.refresh_external_event_claim(uuid, uuid, interval), agentos.assert_external_event_claim_current(uuid, uuid), agentos.complete_external_event_claim(uuid, uuid, jsonb), agentos.release_external_event_claim(uuid, uuid, text) TO %I',
      p_database_role
    );
  END IF;
END;
$$;

DROP TRIGGER notify_agentos_events_captain ON agentos.captain;
DROP TRIGGER captain_touch ON agentos.captain;
DROP TRIGGER captain_no_delete ON agentos.captain;
DROP POLICY captain_registered_read ON agentos.captain;
DROP POLICY captain_second_mate_insert ON agentos.captain;
DROP POLICY captain_second_mate_update ON agentos.captain;
DROP TABLE agentos.captain;

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

ALTER TABLE agentos.captain
  ADD COLUMN scope text NOT NULL DEFAULT 'fleet',
  ADD COLUMN scope_agent_id uuid REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  ADD CONSTRAINT captain_scope_check CHECK (
    (scope = 'fleet' AND scope_agent_id IS NULL)
    OR
    (scope = 'agent' AND scope_agent_id IS NOT NULL)
  );

COMMENT ON COLUMN agentos.captain.scope IS
  'Fleet-wide Captain state uses fleet; domain-local state uses agent and names its owning Mate.';
COMMENT ON COLUMN agentos.captain.scope_agent_id IS
  'Owning Mate for domain-local Captain state. All registered Agents retain the unfiltered read view.';

CREATE INDEX captain_scope_topic_idx
  ON agentos.captain (scope, scope_agent_id, topic)
  WHERE archived_at IS NULL;

CREATE POLICY captain_second_mate_insert
  ON agentos.captain
  FOR INSERT
  WITH CHECK (
    agentos.current_agent_role() = 'second_mate'
    AND recorded_by_agent_id = agentos.current_agent_id()
    AND scope = 'agent'
    AND scope_agent_id = agentos.current_agent_id()
  );

CREATE POLICY captain_second_mate_update
  ON agentos.captain
  FOR UPDATE
  USING (
    agentos.current_agent_role() = 'second_mate'
    AND recorded_by_agent_id = agentos.current_agent_id()
    AND scope = 'agent'
    AND scope_agent_id = agentos.current_agent_id()
  )
  WITH CHECK (
    agentos.current_agent_role() = 'second_mate'
    AND recorded_by_agent_id = agentos.current_agent_id()
    AND scope = 'agent'
    AND scope_agent_id = agentos.current_agent_id()
  );

ALTER TABLE agentos.task_assignments
  ADD COLUMN brief text CHECK (brief IS NULL OR length(btrim(brief)) > 0),
  ADD COLUMN report text CHECK (report IS NULL OR length(btrim(report)) > 0),
  ADD COLUMN dispatch_profile jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(dispatch_profile) = 'object'),
  ADD COLUMN supersedes_assignment_id uuid
    REFERENCES agentos.task_assignments(id) ON DELETE RESTRICT,
  ADD COLUMN decision_keys text[],
  ADD COLUMN decisions_attested_at timestamptz,
  ADD COLUMN decisions_attested_by_agent_id uuid
    REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  ADD CONSTRAINT task_assignments_supersedes_check CHECK (
    supersedes_assignment_id IS NULL OR supersedes_assignment_id <> id
  ),
  ADD CONSTRAINT task_assignments_decision_attestation_check CHECK (
    (
      decision_keys IS NULL
      AND decisions_attested_at IS NULL
      AND decisions_attested_by_agent_id IS NULL
    )
    OR
    (
      decision_keys IS NOT NULL
      AND decisions_attested_at IS NOT NULL
      AND decisions_attested_by_agent_id IS NOT NULL
    )
  );

COMMENT ON COLUMN agentos.task_assignments.brief IS
  'Authoritative complete Assignment brief. A rendered PVC file is a replaceable harness view.';
COMMENT ON COLUMN agentos.task_assignments.report IS
  'Authoritative final or handoff report required before an Assignment ends.';
COMMENT ON COLUMN agentos.task_assignments.dispatch_profile IS
  'Concrete harness plus optional native model, effort and immutable image selected for this Assignment.';
COMMENT ON COLUMN agentos.task_assignments.supersedes_assignment_id IS
  'Prior Assignment ended by an atomic handoff of the same stable Task.';
COMMENT ON COLUMN agentos.task_assignments.decision_keys IS
  'Complete unresolved Captain-decision key set attested for Scout or review completion; NULL means not attested.';

CREATE UNIQUE INDEX task_assignments_supersedes_idx
  ON agentos.task_assignments (supersedes_assignment_id)
  WHERE supersedes_assignment_id IS NOT NULL;

DROP INDEX agentos.inbox_decision_key_idx;
CREATE UNIQUE INDEX inbox_decision_key_idx
  ON agentos.inbox (decision_key)
  WHERE decision_key IS NOT NULL;

CREATE FUNCTION agentos.enforce_task_assignment_contract()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_open_decision_keys text[];
  v_target_harness text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.brief IS NULL OR length(btrim(NEW.brief)) = 0 THEN
      RAISE EXCEPTION 'Task Assignment requires a durable brief';
    END IF;

    IF nullif(btrim(NEW.dispatch_profile ->> 'harness'), '') IS NULL THEN
      RAISE EXCEPTION 'Task Assignment requires a concrete dispatch-profile harness';
    END IF;

    SELECT agent.harness
      INTO v_target_harness
      FROM agentos.agents AS agent
     WHERE agent.id = NEW.agent_id;

    IF NEW.dispatch_profile ->> 'harness' IS DISTINCT FROM v_target_harness THEN
      RAISE EXCEPTION 'dispatch-profile harness must match the assigned Agent';
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

CREATE TRIGGER task_assignments_contract
BEFORE INSERT OR UPDATE ON agentos.task_assignments
FOR EACH ROW EXECUTE FUNCTION agentos.enforce_task_assignment_contract();

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
    NEW.dispatch_profile,
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
    OLD.dispatch_profile,
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

CREATE FUNCTION agentos.handoff_task_assignment(
  p_assignment_id uuid,
  p_destination_agent_id uuid,
  p_brief text,
  p_report text,
  p_status_text text,
  p_dispatch_profile jsonb
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

  IF p_dispatch_profile IS NULL
     OR jsonb_typeof(p_dispatch_profile) <> 'object'
     OR nullif(btrim(p_dispatch_profile ->> 'harness'), '') IS NULL THEN
    RAISE EXCEPTION 'Task handoff requires a concrete dispatch profile';
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
       AND assignment.brief = p_brief
       AND assignment.dispatch_profile = p_dispatch_profile;

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
    dispatch_profile,
    supersedes_assignment_id
  ) VALUES (
    v_previous.task_id,
    p_destination_agent_id,
    v_actor_id,
    v_previous.assignment_role,
    'assigned',
    btrim(p_status_text),
    btrim(p_brief),
    p_dispatch_profile,
    p_assignment_id
  )
  RETURNING id INTO v_replacement_id;

  RETURN v_replacement_id;
END;
$$;

CREATE FUNCTION agentos.hold_captain_decision(
  p_task_id uuid,
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
BEGIN
  IF v_actor_id IS NULL
     OR agentos.current_agent_role() NOT IN ('first_mate', 'second_mate')
     OR NOT agentos.can_manage_task(p_task_id) THEN
    RAISE EXCEPTION 'Captain decision creation requires a managing Mate';
  END IF;

  IF p_decision_key IS NULL
     OR p_decision_key !~ '^[a-z0-9][a-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION 'Captain decision key must be stable, privacy-safe and at most 128 characters';
  END IF;

  IF p_subject IS NULL OR length(btrim(p_subject)) = 0
     OR p_body IS NULL OR length(btrim(p_body)) = 0
     OR p_status_text IS NULL OR length(btrim(p_status_text)) = 0 THEN
    RAISE EXCEPTION 'Captain decision creation requires subject, body and status text';
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
       AND v_existing.body = btrim(p_body) THEN
      RETURN v_existing.id;
    END IF;

    RAISE EXCEPTION 'Captain decision key conflicts with an existing decision';
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
    status_text
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
    btrim(p_status_text)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE FUNCTION agentos.link_task_decision(
  p_task_id uuid,
  p_decision_key text,
  p_status_text text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_dependency jsonb := jsonb_build_object(
    'kind', 'captain_decision',
    'decision_key', p_decision_key
  );
BEGIN
  IF agentos.current_agent_role() NOT IN ('first_mate', 'second_mate')
     OR NOT agentos.can_manage_task(p_task_id) THEN
    RAISE EXCEPTION 'linking a Captain decision requires a managing Mate';
  END IF;

  IF p_status_text IS NULL OR length(btrim(p_status_text)) = 0 THEN
    RAISE EXCEPTION 'linking a Captain decision requires status text';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM agentos.inbox AS decision
     WHERE decision.decision_key = p_decision_key
       AND decision.kind = 'captain_decision'
       AND decision.resolved_at IS NULL
  ) THEN
    RAISE EXCEPTION 'linked Captain decision must exist and remain unresolved';
  END IF;

  UPDATE agentos.tasks
     SET dependencies = CASE
           WHEN dependencies @> jsonb_build_array(v_dependency) THEN dependencies
           ELSE dependencies || jsonb_build_array(v_dependency)
         END,
         status_text = btrim(p_status_text)
   WHERE id = p_task_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'linked Task does not exist';
  END IF;
END;
$$;

CREATE FUNCTION agentos.attest_assignment_decisions(
  p_assignment_id uuid,
  p_decision_keys text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_task_id uuid;
  v_expected text[];
  v_provided text[];
BEGIN
  IF v_actor_id IS NULL
     OR agentos.current_agent_role() NOT IN ('first_mate', 'second_mate')
     OR NOT agentos.can_manage_task_assignment(p_assignment_id) THEN
    RAISE EXCEPTION 'decision attestation requires the managing Mate';
  END IF;

  IF p_decision_keys IS NULL THEN
    RAISE EXCEPTION 'decision attestation requires an explicit complete key set, including an empty set';
  END IF;

  SELECT assignment.task_id
    INTO v_task_id
    FROM agentos.task_assignments AS assignment
   WHERE assignment.id = p_assignment_id
     AND assignment.ended_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'decision attestation requires an active Assignment';
  END IF;

  SELECT coalesce(array_agg(key ORDER BY key), ARRAY[]::text[])
    INTO v_provided
    FROM (
      SELECT DISTINCT btrim(value) AS key
        FROM unnest(p_decision_keys) AS value
    ) AS provided;

  IF EXISTS (
    SELECT 1
      FROM unnest(v_provided) AS key
     WHERE key !~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
  ) THEN
    RAISE EXCEPTION 'decision attestation contains an invalid key';
  END IF;

  SELECT coalesce(
           array_agg(decision.decision_key ORDER BY decision.decision_key),
           ARRAY[]::text[]
         )
    INTO v_expected
    FROM agentos.inbox AS decision
   WHERE decision.task_id = v_task_id
     AND decision.kind = 'captain_decision'
     AND decision.resolved_at IS NULL;

  IF v_provided IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'decision attestation must contain the complete unresolved key set';
  END IF;

  UPDATE agentos.task_assignments
     SET decision_keys = v_provided,
         decisions_attested_at = transaction_timestamp(),
         decisions_attested_by_agent_id = v_actor_id
   WHERE id = p_assignment_id;
END;
$$;

CREATE FUNCTION agentos.resolve_captain_decision(
  p_decision_id uuid,
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
  v_decision agentos.inbox%ROWTYPE;
BEGIN
  IF v_actor_id IS NULL
     OR agentos.current_agent_role() NOT IN ('first_mate', 'second_mate') THEN
    RAISE EXCEPTION 'Captain decision resolution requires an authenticated Mate';
  END IF;

  IF p_answer IS NULL OR length(btrim(p_answer)) = 0
     OR p_status_text IS NULL OR length(btrim(p_status_text)) = 0 THEN
    RAISE EXCEPTION 'Captain decision resolution requires the exact answer and status text';
  END IF;

  SELECT decision.*
    INTO v_decision
    FROM agentos.inbox AS decision
   WHERE decision.id = p_decision_id
     AND decision.kind = 'captain_decision'
   FOR UPDATE;

  IF NOT FOUND OR NOT agentos.can_manage_agent(v_decision.recipient_agent_id) THEN
    RAISE EXCEPTION 'Captain decision resolution requires a managed decision';
  END IF;

  IF v_decision.resolved_at IS NOT NULL THEN
    SELECT answer.id
      INTO v_answer_id
      FROM agentos.inbox AS answer
     WHERE answer.reply_to_id = p_decision_id
       AND answer.kind = 'captain_decision_answer'
       AND answer.body = btrim(p_answer);

    IF v_answer_id IS NOT NULL THEN
      RETURN v_answer_id;
    END IF;

    RAISE EXCEPTION 'Captain decision is already resolved with a different answer';
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

REVOKE ALL ON FUNCTION agentos.handoff_task_assignment(
  uuid, uuid, text, text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.hold_captain_decision(
  uuid, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.link_task_decision(uuid, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.attest_assignment_decisions(uuid, text[])
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.resolve_captain_decision(uuid, text, text)
  FROM PUBLIC;

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
    'REVOKE INSERT (id, topic, content, source, recorded_by_agent_id, metadata, archived_at, scope, scope_agent_id) ON agentos.captain FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE UPDATE (topic, content, source, metadata, archived_at) ON agentos.captain FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION agentos.retire_agent(uuid, text), agentos.provision_agent(text, text, text, text, text, jsonb), agentos.handoff_task_assignment(uuid, uuid, text, text, text, jsonb), agentos.hold_captain_decision(uuid, text, text, text, text), agentos.link_task_decision(uuid, text, text), agentos.attest_assignment_decisions(uuid, text[]), agentos.resolve_captain_decision(uuid, text, text) FROM %I',
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
    'GRANT EXECUTE ON FUNCTION agentos.can_manage_task(uuid), agentos.can_manage_task_assignment(uuid) TO %I',
    p_database_role
  );

  IF p_agent_role = 'second_mate' THEN
    EXECUTE format(
      'GRANT INSERT (id, project_id, parent_task_id, created_by_agent_id, title, description, status, status_text, priority, dependencies, external_links, metadata, completed_at, archived_at) ON agentos.tasks TO %I',
      p_database_role
    );
    EXECUTE format(
      'GRANT INSERT (id, task_id, agent_id, assigned_by_agent_id, assignment_role, status, status_text, metadata, started_at, ended_at, brief, report, dispatch_profile, supersedes_assignment_id, decision_keys, decisions_attested_at, decisions_attested_by_agent_id) ON agentos.task_assignments TO %I',
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
      'GRANT EXECUTE ON FUNCTION agentos.retire_agent(uuid, text), agentos.provision_agent(text, text, text, text, text, jsonb), agentos.handoff_task_assignment(uuid, uuid, text, text, text, jsonb), agentos.hold_captain_decision(uuid, text, text, text, text), agentos.link_task_decision(uuid, text, text), agentos.attest_assignment_decisions(uuid, text[]), agentos.resolve_captain_decision(uuid, text, text) TO %I',
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

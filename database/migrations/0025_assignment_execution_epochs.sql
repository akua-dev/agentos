CREATE TABLE agentos.assignment_execution_epochs (
  id uuid PRIMARY KEY,
  assignment_id uuid NOT NULL
    REFERENCES agentos.task_assignments(id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  epoch integer NOT NULL CHECK (epoch > 0),
  runtime_operation_id uuid
    REFERENCES agentos.runtime_operations(id) ON DELETE RESTRICT,
  native_session_ref text NOT NULL
    CHECK (
      length(native_session_ref) BETWEEN 1 AND 128
      AND native_session_ref ~ '^[0-9A-Za-z_.:@/-]+$'
    ),
  state text NOT NULL DEFAULT 'active'
    CHECK (
      state IN (
        'active', 'exhausted', 'completed', 'resumed', 'reassigned', 'stopped'
      )
    ),
  predecessor_epoch_id uuid UNIQUE
    REFERENCES agentos.assignment_execution_epochs(id) ON DELETE RESTRICT,
  failure_class text CHECK (
    failure_class IS NULL OR failure_class IN (
      'overload', 'authentication', 'transport', 'protocol', 'stream',
      'capacity', 'policy', 'provider', 'harness', 'runtime'
    )
  ),
  retry_ceiling integer CHECK (retry_ceiling IS NULL OR retry_ceiling > 0),
  attempts_observed integer
    CHECK (attempts_observed IS NULL OR attempts_observed > 0),
  recovery_action text CHECK (
    recovery_action IS NULL OR recovery_action IN ('resume', 'reassign', 'stop')
  ),
  recovery_reference text CHECK (
    recovery_reference IS NULL OR (
      length(recovery_reference) BETWEEN 1 AND 128
      AND recovery_reference ~ '^[0-9A-Za-z_.:@/-]+$'
    )
  ),
  replacement_assignment_id uuid
    REFERENCES agentos.task_assignments(id) ON DELETE RESTRICT,
  recorded_by_agent_id uuid NOT NULL
    REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  exhausted_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (assignment_id, epoch),
  CHECK (
    (state = 'active'
      AND failure_class IS NULL
      AND retry_ceiling IS NULL
      AND attempts_observed IS NULL
      AND recovery_action IS NULL
      AND recovery_reference IS NULL
      AND replacement_assignment_id IS NULL
      AND exhausted_at IS NULL
      AND finished_at IS NULL)
    OR
    (state = 'exhausted'
      AND failure_class IS NOT NULL
      AND retry_ceiling IS NOT NULL
      AND attempts_observed = retry_ceiling
      AND recovery_action IS NULL
      AND recovery_reference IS NULL
      AND replacement_assignment_id IS NULL
      AND exhausted_at IS NOT NULL
      AND finished_at IS NULL)
    OR
    (state = 'completed'
      AND failure_class IS NULL
      AND retry_ceiling IS NULL
      AND attempts_observed IS NULL
      AND recovery_action IS NULL
      AND recovery_reference IS NULL
      AND replacement_assignment_id IS NULL
      AND exhausted_at IS NULL
      AND finished_at IS NOT NULL)
    OR
    (state = 'resumed'
      AND failure_class IS NOT NULL
      AND retry_ceiling IS NOT NULL
      AND attempts_observed = retry_ceiling
      AND recovery_action = 'resume'
      AND recovery_reference IS NOT NULL
      AND replacement_assignment_id IS NULL
      AND exhausted_at IS NOT NULL
      AND finished_at IS NOT NULL)
    OR
    (state = 'reassigned'
      AND failure_class IS NOT NULL
      AND retry_ceiling IS NOT NULL
      AND attempts_observed = retry_ceiling
      AND recovery_action = 'reassign'
      AND recovery_reference IS NULL
      AND replacement_assignment_id IS NOT NULL
      AND exhausted_at IS NOT NULL
      AND finished_at IS NOT NULL)
    OR
    (state = 'stopped'
      AND failure_class IS NOT NULL
      AND retry_ceiling IS NOT NULL
      AND attempts_observed = retry_ceiling
      AND recovery_action = 'stop'
      AND recovery_reference IS NULL
      AND replacement_assignment_id IS NULL
      AND exhausted_at IS NOT NULL
      AND finished_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX assignment_execution_epochs_active_idx
  ON agentos.assignment_execution_epochs (assignment_id)
  WHERE state = 'active';
CREATE INDEX assignment_execution_epochs_agent_idx
  ON agentos.assignment_execution_epochs (agent_id, state, epoch);

COMMENT ON TABLE agentos.assignment_execution_epochs IS
  'Durable bounded execution epochs and recovery custody; never work content, terminal output, credentials, provider payloads, or runtime status.';
COMMENT ON COLUMN agentos.assignment_execution_epochs.native_session_ref IS
  'Bounded provider-native session correlation only; session content and authority remain on the Agent PVC and in Herdr.';

CREATE FUNCTION agentos.protect_assignment_execution_epoch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'assignment execution epochs are append-only';
  END IF;

  IF current_setting('agentos.assignment_execution_transition', true)
       IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION
      'assignment execution epoch changes require a released transition Function';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.epoch IS DISTINCT FROM OLD.epoch
     OR NEW.runtime_operation_id IS DISTINCT FROM OLD.runtime_operation_id
     OR NEW.native_session_ref IS DISTINCT FROM OLD.native_session_ref
     OR NEW.predecessor_epoch_id IS DISTINCT FROM OLD.predecessor_epoch_id
     OR NEW.recorded_by_agent_id IS DISTINCT FROM OLD.recorded_by_agent_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'assignment execution epoch identity is immutable';
  END IF;

  IF OLD.state IN ('completed', 'resumed', 'reassigned', 'stopped') THEN
    RAISE EXCEPTION '% assignment execution epoch is immutable', OLD.state;
  END IF;

  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER assignment_execution_epochs_protect
BEFORE UPDATE OR DELETE ON agentos.assignment_execution_epochs
FOR EACH ROW EXECUTE FUNCTION agentos.protect_assignment_execution_epoch();

CREATE FUNCTION agentos.assignment_retry_ceiling(p_failure_class text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE p_failure_class
    WHEN 'overload' THEN 5
    WHEN 'transport' THEN 5
    WHEN 'stream' THEN 3
    WHEN 'protocol' THEN 2
    WHEN 'provider' THEN 2
    WHEN 'harness' THEN 2
    WHEN 'runtime' THEN 2
    WHEN 'authentication' THEN 1
    WHEN 'policy' THEN 1
    WHEN 'capacity' THEN 1
    ELSE NULL
  END
$$;

REVOKE ALL ON FUNCTION agentos.assignment_retry_ceiling(text) FROM PUBLIC;

CREATE FUNCTION agentos.begin_assignment_execution_epoch(
  p_epoch_id uuid,
  p_assignment_id uuid,
  p_runtime_operation_id uuid,
  p_native_session_ref text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_assignment agentos.task_assignments%ROWTYPE;
  v_existing agentos.assignment_execution_epochs%ROWTYPE;
  v_epoch integer;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'execution epoch requires an authenticated Agent';
  END IF;
  IF p_native_session_ref IS NULL
     OR length(p_native_session_ref) NOT BETWEEN 1 AND 128
     OR p_native_session_ref !~ '^[0-9A-Za-z_.:@/-]+$' THEN
    RAISE EXCEPTION 'execution epoch requires a bounded native session reference';
  END IF;

  SELECT assignment.*
    INTO v_assignment
    FROM agentos.task_assignments AS assignment
   WHERE assignment.id = p_assignment_id
   FOR UPDATE;
  IF NOT FOUND OR v_assignment.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'execution epoch requires an active Assignment';
  END IF;
  IF v_actor_id <> v_assignment.agent_id
     AND NOT (
       agentos.current_agent_role() IN ('first_mate', 'second_mate')
       AND agentos.can_manage_task_assignment(p_assignment_id)
     ) THEN
    RAISE EXCEPTION 'execution epoch requires the assigned Agent or supervising Mate';
  END IF;

  SELECT execution.*
    INTO v_existing
    FROM agentos.assignment_execution_epochs AS execution
   WHERE execution.id = p_epoch_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.assignment_id = p_assignment_id
       AND v_existing.agent_id = v_assignment.agent_id
       AND v_existing.runtime_operation_id IS NOT DISTINCT FROM p_runtime_operation_id
       AND v_existing.native_session_ref = p_native_session_ref
       AND v_existing.predecessor_epoch_id IS NULL THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'request conflicts with the existing execution epoch';
  END IF;

  IF p_runtime_operation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM agentos.runtime_operations AS operation
     WHERE operation.id = p_runtime_operation_id
       AND operation.agent_id = v_assignment.agent_id
       AND operation.assignment_id = p_assignment_id
  ) THEN
    RAISE EXCEPTION
      'execution epoch runtime operation must match the Agent and Assignment';
  END IF;
  IF (
    SELECT execution.state
      FROM agentos.assignment_execution_epochs AS execution
     WHERE execution.assignment_id = p_assignment_id
     ORDER BY execution.epoch DESC
     LIMIT 1
  ) = 'exhausted' THEN
    RAISE EXCEPTION
      'exhausted Assignment execution requires supervising recovery';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM agentos.assignment_execution_epochs AS execution
     WHERE execution.assignment_id = p_assignment_id
       AND execution.state = 'active'
  ) THEN
    RAISE EXCEPTION 'Assignment already has an active execution epoch';
  END IF;

  SELECT coalesce(max(execution.epoch), 0) + 1
    INTO v_epoch
    FROM agentos.assignment_execution_epochs AS execution
   WHERE execution.assignment_id = p_assignment_id;

  INSERT INTO agentos.assignment_execution_epochs (
    id, assignment_id, agent_id, epoch, runtime_operation_id,
    native_session_ref, state, recorded_by_agent_id
  ) VALUES (
    p_epoch_id, p_assignment_id, v_assignment.agent_id, v_epoch,
    p_runtime_operation_id, p_native_session_ref, 'active', v_actor_id
  );
  RETURN p_epoch_id;
END;
$$;

CREATE FUNCTION agentos.exhaust_assignment_execution_epoch(
  p_epoch_id uuid,
  p_failure_class text,
  p_attempts_observed integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_execution agentos.assignment_execution_epochs%ROWTYPE;
  v_retry_ceiling integer := agentos.assignment_retry_ceiling(p_failure_class);
BEGIN
  SELECT execution.*
    INTO v_execution
    FROM agentos.assignment_execution_epochs AS execution
   WHERE execution.id = p_epoch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution epoch does not exist';
  END IF;
  IF v_actor_id IS NULL OR (
    v_actor_id <> v_execution.agent_id
    AND NOT (
      agentos.current_agent_role() IN ('first_mate', 'second_mate')
      AND agentos.can_manage_task_assignment(v_execution.assignment_id)
    )
  ) THEN
    RAISE EXCEPTION 'execution exhaustion requires the assigned Agent or supervising Mate';
  END IF;
  IF v_retry_ceiling IS NULL THEN
    RAISE EXCEPTION 'unsupported execution failure class';
  END IF;

  IF v_execution.state = 'exhausted' THEN
    IF v_execution.failure_class = p_failure_class
       AND v_execution.retry_ceiling = v_retry_ceiling
       AND v_execution.attempts_observed = p_attempts_observed THEN
      RETURN v_execution.state;
    END IF;
    RAISE EXCEPTION 'request conflicts with exhausted execution epoch';
  END IF;
  IF v_execution.state <> 'active' THEN
    RAISE EXCEPTION '% execution epoch is immutable', v_execution.state;
  END IF;
  IF p_attempts_observed IS DISTINCT FROM v_retry_ceiling THEN
    RAISE EXCEPTION
      '% execution exhaustion requires exact retry ceiling %',
      p_failure_class,
      v_retry_ceiling;
  END IF;

  PERFORM set_config(
    'agentos.assignment_execution_transition',
    v_execution.id::text,
    true
  );
  UPDATE agentos.assignment_execution_epochs
     SET state = 'exhausted',
         failure_class = p_failure_class,
         retry_ceiling = v_retry_ceiling,
         attempts_observed = p_attempts_observed,
         exhausted_at = transaction_timestamp()
   WHERE id = v_execution.id;
  RETURN 'exhausted';
END;
$$;

CREATE FUNCTION agentos.complete_assignment_execution_epoch(p_epoch_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_execution agentos.assignment_execution_epochs%ROWTYPE;
BEGIN
  SELECT execution.*
    INTO v_execution
    FROM agentos.assignment_execution_epochs AS execution
   WHERE execution.id = p_epoch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution epoch does not exist';
  END IF;
  IF v_actor_id IS NULL OR (
    v_actor_id <> v_execution.agent_id
    AND NOT (
      agentos.current_agent_role() IN ('first_mate', 'second_mate')
      AND agentos.can_manage_task_assignment(v_execution.assignment_id)
    )
  ) THEN
    RAISE EXCEPTION 'execution completion requires the assigned Agent or supervising Mate';
  END IF;
  IF v_execution.state = 'completed' THEN
    RETURN v_execution.state;
  END IF;
  IF v_execution.state <> 'active' THEN
    RAISE EXCEPTION '% execution epoch cannot complete', v_execution.state;
  END IF;

  PERFORM set_config(
    'agentos.assignment_execution_transition',
    v_execution.id::text,
    true
  );
  UPDATE agentos.assignment_execution_epochs
     SET state = 'completed', finished_at = transaction_timestamp()
   WHERE id = v_execution.id;
  RETURN 'completed';
END;
$$;

CREATE FUNCTION agentos.resume_assignment_execution_epoch(
  p_exhausted_epoch_id uuid,
  p_successor_epoch_id uuid,
  p_runtime_operation_id uuid,
  p_recovery_reference text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_exhausted agentos.assignment_execution_epochs%ROWTYPE;
  v_successor agentos.assignment_execution_epochs%ROWTYPE;
  v_runtime agentos.runtime_operations%ROWTYPE;
  v_runtime_operation_id uuid;
  v_max_epoch integer;
BEGIN
  SELECT execution.*
    INTO v_exhausted
    FROM agentos.assignment_execution_epochs AS execution
   WHERE execution.id = p_exhausted_epoch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exhausted execution epoch does not exist';
  END IF;
  IF v_actor_id IS NULL
     OR agentos.current_agent_role() NOT IN ('first_mate', 'second_mate')
     OR NOT agentos.can_manage_task_assignment(v_exhausted.assignment_id) THEN
    RAISE EXCEPTION 'execution resume requires the supervising Mate';
  END IF;
  IF p_recovery_reference IS NULL
     OR length(p_recovery_reference) NOT BETWEEN 1 AND 128
     OR p_recovery_reference !~ '^[0-9A-Za-z_.:@/-]+$' THEN
    RAISE EXCEPTION 'execution resume requires a bounded recovery reference';
  END IF;

  v_runtime_operation_id := coalesce(
    p_runtime_operation_id,
    v_exhausted.runtime_operation_id
  );

  SELECT execution.*
    INTO v_successor
    FROM agentos.assignment_execution_epochs AS execution
   WHERE execution.predecessor_epoch_id = v_exhausted.id
   FOR UPDATE;
  IF FOUND THEN
    IF v_exhausted.state = 'resumed'
       AND v_exhausted.recovery_action = 'resume'
       AND v_exhausted.recovery_reference = p_recovery_reference
       AND v_successor.id = p_successor_epoch_id
       AND v_successor.runtime_operation_id IS NOT DISTINCT FROM v_runtime_operation_id
       AND v_successor.native_session_ref = v_exhausted.native_session_ref THEN
      RETURN v_successor.id;
    END IF;
    RAISE EXCEPTION 'request conflicts with the existing execution resume';
  END IF;
  IF v_exhausted.state <> 'exhausted' THEN
    RAISE EXCEPTION '% execution epoch cannot resume', v_exhausted.state;
  END IF;

  IF v_exhausted.failure_class IN ('authentication', 'policy')
     AND p_recovery_reference !~ '^authority:[0-9A-Za-z_.:@/-]+$' THEN
    RAISE EXCEPTION
      '% exhaustion requires authority-granted recovery evidence',
      v_exhausted.failure_class;
  ELSIF v_exhausted.failure_class NOT IN ('authentication', 'policy')
        AND p_recovery_reference !~ '^boundary:[0-9A-Za-z_.:@/-]+$' THEN
    RAISE EXCEPTION
      '% exhaustion requires changed-boundary recovery evidence',
      v_exhausted.failure_class;
  END IF;

  IF v_exhausted.failure_class = 'capacity' THEN
    IF p_runtime_operation_id IS NULL
       OR p_runtime_operation_id IS NOT DISTINCT FROM
          v_exhausted.runtime_operation_id THEN
      RAISE EXCEPTION
        'capacity recovery requires a distinct verified runtime operation';
    END IF;
    SELECT operation.*
      INTO v_runtime
      FROM agentos.runtime_operations AS operation
     WHERE operation.id = p_runtime_operation_id
       AND operation.agent_id = v_exhausted.agent_id
       AND operation.assignment_id = v_exhausted.assignment_id
       AND operation.action IN ('rollout', 'recover')
       AND operation.phase IN ('harness_ready', 'completed');
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'capacity recovery requires a distinct verified runtime operation';
    END IF;
  ELSIF p_runtime_operation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM agentos.runtime_operations AS operation
       WHERE operation.id = p_runtime_operation_id
         AND operation.agent_id = v_exhausted.agent_id
         AND operation.assignment_id = v_exhausted.assignment_id
    ) THEN
    RAISE EXCEPTION
      'resume runtime operation must match the Agent and Assignment';
  END IF;
  SELECT max(execution.epoch)
    INTO v_max_epoch
    FROM agentos.assignment_execution_epochs AS execution
   WHERE execution.assignment_id = v_exhausted.assignment_id;
  IF v_max_epoch IS DISTINCT FROM v_exhausted.epoch THEN
    RAISE EXCEPTION 'only the latest exhausted execution epoch may resume';
  END IF;

  PERFORM set_config(
    'agentos.assignment_execution_transition',
    v_exhausted.id::text,
    true
  );
  UPDATE agentos.assignment_execution_epochs
     SET state = 'resumed',
         recovery_action = 'resume',
         recovery_reference = p_recovery_reference,
         finished_at = transaction_timestamp()
   WHERE id = v_exhausted.id;

  INSERT INTO agentos.assignment_execution_epochs (
    id, assignment_id, agent_id, epoch, runtime_operation_id,
    native_session_ref, state, predecessor_epoch_id, recorded_by_agent_id
  ) VALUES (
    p_successor_epoch_id,
    v_exhausted.assignment_id,
    v_exhausted.agent_id,
    v_exhausted.epoch + 1,
    v_runtime_operation_id,
    v_exhausted.native_session_ref,
    'active',
    v_exhausted.id,
    v_actor_id
  );
  RETURN p_successor_epoch_id;
END;
$$;

CREATE FUNCTION agentos.stop_assignment_execution_epoch(
  p_exhausted_epoch_id uuid,
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
  v_exhausted agentos.assignment_execution_epochs%ROWTYPE;
  v_assignment agentos.task_assignments%ROWTYPE;
BEGIN
  IF p_report IS NULL OR p_report !~ '[^[:space:]]'
     OR p_status_text IS NULL OR p_status_text !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'execution stop requires a durable report and status text';
  END IF;

  SELECT execution.*
    INTO v_exhausted
    FROM agentos.assignment_execution_epochs AS execution
   WHERE execution.id = p_exhausted_epoch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exhausted execution epoch does not exist';
  END IF;
  IF v_actor_id IS NULL
     OR agentos.current_agent_role() NOT IN ('first_mate', 'second_mate')
     OR NOT agentos.can_manage_task_assignment(v_exhausted.assignment_id) THEN
    RAISE EXCEPTION 'execution stop requires the supervising Mate';
  END IF;

  SELECT assignment.*
    INTO STRICT v_assignment
    FROM agentos.task_assignments AS assignment
   WHERE assignment.id = v_exhausted.assignment_id
   FOR UPDATE;
  IF v_exhausted.state = 'stopped' THEN
    IF v_assignment.status = 'stopped'
       AND v_assignment.status_text = btrim(p_status_text)
       AND v_assignment.report = btrim(p_report)
       AND v_assignment.ended_at IS NOT NULL THEN
      RETURN v_exhausted.id;
    END IF;
    RAISE EXCEPTION 'request conflicts with the existing execution stop';
  END IF;
  IF v_exhausted.state <> 'exhausted' THEN
    RAISE EXCEPTION '% execution epoch cannot stop', v_exhausted.state;
  END IF;
  IF v_assignment.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'execution stop requires an active Assignment';
  END IF;

  UPDATE agentos.task_assignments
     SET status = 'stopped',
         status_text = btrim(p_status_text),
         report = btrim(p_report),
         ended_at = transaction_timestamp()
   WHERE id = v_assignment.id;

  PERFORM set_config(
    'agentos.assignment_execution_transition',
    v_exhausted.id::text,
    true
  );
  UPDATE agentos.assignment_execution_epochs
     SET state = 'stopped',
         recovery_action = 'stop',
         finished_at = transaction_timestamp()
   WHERE id = v_exhausted.id;
  RETURN v_exhausted.id;
END;
$$;

CREATE FUNCTION agentos.reassign_assignment_execution_epoch(
  p_exhausted_epoch_id uuid,
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
  v_exhausted agentos.assignment_execution_epochs%ROWTYPE;
  v_previous agentos.task_assignments%ROWTYPE;
  v_replacement agentos.task_assignments%ROWTYPE;
  v_replacement_id uuid;
BEGIN
  IF p_brief IS NULL OR p_brief !~ '[^[:space:]]'
     OR p_report IS NULL OR p_report !~ '[^[:space:]]'
     OR p_status_text IS NULL OR p_status_text !~ '[^[:space:]]' THEN
    RAISE EXCEPTION
      'execution reassignment requires a complete brief, report and status text';
  END IF;

  SELECT execution.*
    INTO v_exhausted
    FROM agentos.assignment_execution_epochs AS execution
   WHERE execution.id = p_exhausted_epoch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exhausted execution epoch does not exist';
  END IF;
  IF v_actor_id IS NULL
     OR agentos.current_agent_role() NOT IN ('first_mate', 'second_mate')
     OR NOT agentos.can_manage_task_assignment(v_exhausted.assignment_id) THEN
    RAISE EXCEPTION 'execution reassignment requires the supervising Mate';
  END IF;

  SELECT assignment.*
    INTO STRICT v_previous
    FROM agentos.task_assignments AS assignment
   WHERE assignment.id = v_exhausted.assignment_id
   FOR UPDATE;
  IF v_exhausted.state = 'reassigned' THEN
    SELECT assignment.*
      INTO v_replacement
      FROM agentos.task_assignments AS assignment
     WHERE assignment.id = v_exhausted.replacement_assignment_id;
    IF FOUND
       AND v_replacement.supersedes_assignment_id = v_previous.id
       AND v_replacement.agent_id = p_destination_agent_id
       AND v_replacement.brief = btrim(p_brief)
       AND v_replacement.status_text = btrim(p_status_text)
       AND v_previous.report = btrim(p_report) THEN
      RETURN v_replacement.id;
    END IF;
    RAISE EXCEPTION 'request conflicts with the existing execution reassignment';
  END IF;
  IF v_exhausted.state <> 'exhausted' THEN
    RAISE EXCEPTION '% execution epoch cannot reassign', v_exhausted.state;
  END IF;

  v_replacement_id := agentos.handoff_task_assignment(
    v_exhausted.assignment_id,
    p_destination_agent_id,
    p_brief,
    p_report,
    p_status_text
  );

  PERFORM set_config(
    'agentos.assignment_execution_transition',
    v_exhausted.id::text,
    true
  );
  UPDATE agentos.assignment_execution_epochs
     SET state = 'reassigned',
         recovery_action = 'reassign',
         replacement_assignment_id = v_replacement_id,
         finished_at = transaction_timestamp()
   WHERE id = v_exhausted.id;
  RETURN v_replacement_id;
END;
$$;

REVOKE ALL ON TABLE agentos.assignment_execution_epochs FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.begin_assignment_execution_epoch(
  uuid, uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.exhaust_assignment_execution_epoch(
  uuid, text, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.complete_assignment_execution_epoch(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.resume_assignment_execution_epoch(
  uuid, uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.stop_assignment_execution_epoch(
  uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.reassign_assignment_execution_epoch(
  uuid, uuid, text, text, text
) FROM PUBLIC;

CREATE FUNCTION agentos.configure_assignment_execution_privileges(
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
    'GRANT SELECT ON agentos.assignment_execution_epochs TO %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE INSERT, UPDATE, DELETE ON agentos.assignment_execution_epochs FROM %I',
    p_database_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION agentos.begin_assignment_execution_epoch(uuid, uuid, uuid, text), agentos.exhaust_assignment_execution_epoch(uuid, text, integer), agentos.complete_assignment_execution_epoch(uuid) TO %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION agentos.resume_assignment_execution_epoch(uuid, uuid, uuid, text) FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION agentos.stop_assignment_execution_epoch(uuid, text, text) FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION agentos.reassign_assignment_execution_epoch(uuid, uuid, text, text, text) FROM %I',
    p_database_role
  );
  IF p_agent_role = 'second_mate' THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION agentos.resume_assignment_execution_epoch(uuid, uuid, uuid, text), agentos.stop_assignment_execution_epoch(uuid, text, text), agentos.reassign_assignment_execution_epoch(uuid, uuid, text, text, text) TO %I',
      p_database_role
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION agentos.configure_assignment_execution_privileges(
  name, text
) FROM PUBLIC;

CREATE FUNCTION agentos.configure_registered_assignment_execution_privileges()
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
    PERFORM agentos.configure_assignment_execution_privileges(
      NEW.database_role,
      NEW.role
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION
  agentos.configure_registered_assignment_execution_privileges()
  FROM PUBLIC;

CREATE TRIGGER agents_configure_assignment_execution_privileges
AFTER UPDATE OF database_role, role ON agentos.agents
FOR EACH ROW EXECUTE FUNCTION
  agentos.configure_registered_assignment_execution_privileges();

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
    PERFORM agentos.configure_assignment_execution_privileges(
      v_agent.database_role,
      v_agent.role
    );
  END LOOP;
END;
$$;

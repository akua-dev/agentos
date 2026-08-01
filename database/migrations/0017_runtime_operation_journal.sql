CREATE FUNCTION agentos.valid_runtime_operation_resources(
  p_resources jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE
    WHEN p_resources IS NULL
      OR jsonb_typeof(p_resources) IS DISTINCT FROM 'array' THEN false
    ELSE
      NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(p_resources) AS item(resource)
         WHERE jsonb_typeof(item.resource) <> 'object'
            OR item.resource - ARRAY['kind', 'name', 'disposition'] <> '{}'::jsonb
            OR NOT item.resource ?& ARRAY['kind', 'name', 'disposition']
            OR item.resource ->> 'kind' NOT IN (
              'persistent_volume_claim',
              'worktree'
            )
            OR item.resource ->> 'disposition' NOT IN ('retain', 'discard')
            OR nullif(btrim(item.resource ->> 'name'), '') IS NULL
            OR length(item.resource ->> 'name') > 253
            OR item.resource ->> 'name'
                 !~ '^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$'
      )
      AND NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(p_resources) AS item(resource)
         GROUP BY item.resource ->> 'kind', item.resource ->> 'name'
        HAVING count(*) > 1
      )
  END
$$;

COMMENT ON FUNCTION agentos.valid_runtime_operation_resources(jsonb) IS
  'Validates the closed non-secret retained-resource identity and disposition contract used by runtime operations.';

REVOKE ALL ON FUNCTION agentos.valid_runtime_operation_resources(jsonb)
  FROM PUBLIC;

CREATE TABLE agentos.runtime_operations (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL
    REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  owner_agent_id uuid NOT NULL
    REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  assignment_id uuid
    REFERENCES agentos.task_assignments(id) ON DELETE RESTRICT,
  kubernetes_namespace text NOT NULL
    CHECK (
      length(kubernetes_namespace) <= 63
      AND kubernetes_namespace
        ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
    ),
  workload_name text NOT NULL
    CHECK (
      length(workload_name) <= 63
      AND workload_name ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
    ),
  action text NOT NULL
    CHECK (action IN ('provision', 'rollout', 'recover', 'teardown')),
  render_digest text NOT NULL
    CHECK (render_digest ~ '^[0-9a-f]{64}$'),
  retained_resources jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (agentos.valid_runtime_operation_resources(retained_resources)),
  phase text NOT NULL DEFAULT 'prepared'
    CHECK (
      phase IN (
        'prepared',
        'applied',
        'workload_ready',
        'harness_ready',
        'recovery_required',
        'completed',
        'failed',
        'superseded'
      )
    ),
  decision_code text
    CHECK (
      decision_code IS NULL
      OR decision_code ~ '^[a-z][a-z0-9_]{0,62}$'
    ),
  supersedes_operation_id uuid UNIQUE
    REFERENCES agentos.runtime_operations(id) ON DELETE RESTRICT,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (supersedes_operation_id IS NULL OR supersedes_operation_id <> id),
  CHECK (
    (phase IN ('completed', 'failed', 'superseded')) =
      (finished_at IS NOT NULL)
  )
);

COMMENT ON TABLE agentos.runtime_operations IS
  'Resumable Agent runtime intent and current phase; Kubernetes, Herdr and retained storage remain live authorities.';
COMMENT ON COLUMN agentos.runtime_operations.render_digest IS
  'SHA-256 of the reviewed desired render; raw YAML is never stored.';
COMMENT ON COLUMN agentos.runtime_operations.retained_resources IS
  'Closed resource identities and explicit retain/discard disposition; never credentials or copied Kubernetes status.';

CREATE UNIQUE INDEX runtime_operations_one_active_agent_idx
  ON agentos.runtime_operations (agent_id)
  WHERE phase IN (
    'prepared',
    'applied',
    'workload_ready',
    'harness_ready',
    'recovery_required'
  );
CREATE INDEX runtime_operations_owner_phase_idx
  ON agentos.runtime_operations (owner_agent_id, phase, created_at);
CREATE INDEX runtime_operations_assignment_idx
  ON agentos.runtime_operations (assignment_id)
  WHERE assignment_id IS NOT NULL;

CREATE TABLE agentos.runtime_operation_events (
  operation_id uuid NOT NULL
    REFERENCES agentos.runtime_operations(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence > 0),
  phase text NOT NULL
    CHECK (
      phase IN (
        'prepared',
        'applied',
        'workload_ready',
        'harness_ready',
        'recovery_required',
        'completed',
        'failed',
        'superseded'
      )
    ),
  decision_code text
    CHECK (
      decision_code IS NULL
      OR decision_code ~ '^[a-z][a-z0-9_]{0,62}$'
    ),
  recorded_by_agent_id uuid NOT NULL
    REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (operation_id, sequence),
  CHECK (
    (phase IN ('recovery_required', 'failed', 'superseded')) =
      (decision_code IS NOT NULL)
  )
);

COMMENT ON TABLE agentos.runtime_operation_events IS
  'Append-only privacy-safe phase and decision audit for runtime repair-forward reconciliation.';

CREATE FUNCTION agentos.protect_runtime_operation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.owner_agent_id IS DISTINCT FROM OLD.owner_agent_id
     OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.kubernetes_namespace IS DISTINCT FROM OLD.kubernetes_namespace
     OR NEW.workload_name IS DISTINCT FROM OLD.workload_name
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.render_digest IS DISTINCT FROM OLD.render_digest
     OR NEW.retained_resources IS DISTINCT FROM OLD.retained_resources
     OR NEW.supersedes_operation_id IS DISTINCT FROM OLD.supersedes_operation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'runtime operation identity is immutable; supersede it with a new operation';
  END IF;

  IF OLD.phase IN ('completed', 'superseded') THEN
    RAISE EXCEPTION '% runtime operation is immutable', OLD.phase;
  END IF;

  IF OLD.phase = 'failed' AND NEW.phase <> 'superseded' THEN
    RAISE EXCEPTION
      'failed runtime operation may only be superseded by a new operation';
  END IF;

  IF NEW.phase IS NOT DISTINCT FROM OLD.phase THEN
    RAISE EXCEPTION
      'runtime operation state changes require a released phase Function';
  END IF;

  IF NEW.phase NOT IN ('recovery_required', 'failed', 'superseded')
     AND NEW.decision_code IS NOT NULL THEN
    RAISE EXCEPTION
      'only recovery, failure, or supersession records a decision code';
  END IF;

  IF NEW.phase IN ('recovery_required', 'failed', 'superseded')
     AND NEW.decision_code IS NULL THEN
    RAISE EXCEPTION '% requires a decision code', NEW.phase;
  END IF;

  IF NEW.phase IN ('completed', 'failed', 'superseded') THEN
    NEW.finished_at := transaction_timestamp();
  ELSIF NEW.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'only terminal runtime operations have finished_at';
  END IF;

  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION agentos.protect_runtime_operation() FROM PUBLIC;

CREATE TRIGGER runtime_operations_protect
BEFORE UPDATE ON agentos.runtime_operations
FOR EACH ROW EXECUTE FUNCTION agentos.protect_runtime_operation();
CREATE TRIGGER runtime_operations_no_delete
BEFORE DELETE ON agentos.runtime_operations
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_hard_delete();

CREATE FUNCTION agentos.prevent_runtime_operation_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'runtime operation events are append-only';
END;
$$;

REVOKE ALL ON FUNCTION agentos.prevent_runtime_operation_event_mutation()
  FROM PUBLIC;

CREATE TRIGGER runtime_operation_events_no_update
BEFORE UPDATE OR DELETE ON agentos.runtime_operation_events
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_runtime_operation_event_mutation();

ALTER TABLE agentos.runtime_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY runtime_operations_registered_read
  ON agentos.runtime_operations
  FOR SELECT
  USING (agentos.current_agent_id() IS NOT NULL);

ALTER TABLE agentos.runtime_operation_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY runtime_operation_events_registered_read
  ON agentos.runtime_operation_events
  FOR SELECT
  USING (agentos.current_agent_id() IS NOT NULL);

CREATE FUNCTION agentos.runtime_operation_authorized(
  p_agent_id uuid,
  p_owner_agent_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  SELECT coalesce(
    agentos.current_agent_role() IN ('first_mate', 'second_mate')
    AND agentos.can_manage_agent(p_agent_id)
    AND (
      p_owner_agent_id IS NULL
      OR agentos.can_manage_agent(p_owner_agent_id)
    ),
    false
  )
$$;

REVOKE ALL ON FUNCTION agentos.runtime_operation_authorized(uuid, uuid)
  FROM PUBLIC;

CREATE FUNCTION agentos.record_runtime_operation_event(
  p_operation_id uuid,
  p_phase text,
  p_decision_code text,
  p_recorded_by_agent_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_sequence integer;
BEGIN
  SELECT coalesce(max(event.sequence), 0) + 1
    INTO v_sequence
    FROM agentos.runtime_operation_events AS event
   WHERE event.operation_id = p_operation_id;

  INSERT INTO agentos.runtime_operation_events (
    operation_id,
    sequence,
    phase,
    decision_code,
    recorded_by_agent_id
  ) VALUES (
    p_operation_id,
    v_sequence,
    p_phase,
    p_decision_code,
    p_recorded_by_agent_id
  );
END;
$$;

REVOKE ALL ON FUNCTION agentos.record_runtime_operation_event(
  uuid, text, text, uuid
) FROM PUBLIC;

CREATE FUNCTION agentos.begin_runtime_operation(
  p_operation_id uuid,
  p_agent_id uuid,
  p_assignment_id uuid,
  p_kubernetes_namespace text,
  p_workload_name text,
  p_action text,
  p_render_digest text,
  p_retained_resources jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_agent agentos.agents%ROWTYPE;
  v_assignment agentos.task_assignments%ROWTYPE;
  v_existing agentos.runtime_operations%ROWTYPE;
BEGIN
  IF NOT agentos.runtime_operation_authorized(p_agent_id, NULL) THEN
    RAISE EXCEPTION
      'runtime operation requires an authenticated Mate and managed hierarchy';
  END IF;

  IF p_kubernetes_namespace IS NULL
     OR length(p_kubernetes_namespace) > 63
     OR p_kubernetes_namespace
          !~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' THEN
    RAISE EXCEPTION 'runtime operation namespace must be Kubernetes-safe';
  END IF;

  IF p_workload_name IS NULL
     OR length(p_workload_name) > 63
     OR p_workload_name !~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' THEN
    RAISE EXCEPTION 'runtime operation workload must be Kubernetes-safe';
  END IF;

  IF p_action IS NULL
     OR p_action NOT IN ('provision', 'rollout', 'recover', 'teardown') THEN
    RAISE EXCEPTION 'unsupported runtime operation action';
  END IF;

  IF p_render_digest IS NULL OR p_render_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'runtime operation render digest must be SHA-256';
  END IF;

  IF NOT agentos.valid_runtime_operation_resources(p_retained_resources) THEN
    RAISE EXCEPTION
      'runtime operation retained resources violate the closed contract';
  END IF;

  SELECT agent.*
    INTO v_agent
    FROM agentos.agents AS agent
   WHERE agent.id = p_agent_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime operation Agent does not exist';
  END IF;

  SELECT operation.*
    INTO v_existing
    FROM agentos.runtime_operations AS operation
   WHERE operation.id = p_operation_id
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.agent_id = p_agent_id
       AND v_existing.owner_agent_id = v_actor_id
       AND v_existing.assignment_id IS NOT DISTINCT FROM p_assignment_id
       AND v_existing.kubernetes_namespace = p_kubernetes_namespace
       AND v_existing.workload_name = p_workload_name
       AND v_existing.action = p_action
       AND v_existing.render_digest = p_render_digest
       AND v_existing.retained_resources = p_retained_resources
       AND v_existing.supersedes_operation_id IS NULL THEN
      RETURN v_existing.id;
    END IF;

    RAISE EXCEPTION
      'request conflicts with the existing runtime operation %',
      p_operation_id;
  END IF;

  IF p_action <> 'teardown' AND v_agent.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'only teardown may target a retired Agent';
  END IF;

  IF p_assignment_id IS NOT NULL THEN
    SELECT assignment.*
      INTO v_assignment
      FROM agentos.task_assignments AS assignment
     WHERE assignment.id = p_assignment_id;

    IF NOT FOUND OR v_assignment.agent_id <> p_agent_id THEN
      RAISE EXCEPTION
        'runtime operation Assignment must belong to the target Agent';
    END IF;

    IF p_action <> 'teardown' AND v_assignment.ended_at IS NOT NULL THEN
      RAISE EXCEPTION
        'runtime operation Assignment must remain active';
    END IF;
  END IF;

  IF p_action = 'teardown' THEN
    IF EXISTS (
      SELECT 1
        FROM agentos.task_assignments AS assignment
       WHERE assignment.agent_id = p_agent_id
         AND assignment.ended_at IS NULL
    ) THEN
      RAISE EXCEPTION 'teardown requires ended work';
    END IF;

    IF v_agent.persistent_volume_claim IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_retained_resources) AS item(resource)
          WHERE item.resource ->> 'kind' = 'persistent_volume_claim'
            AND item.resource ->> 'name' = v_agent.persistent_volume_claim
            AND item.resource ->> 'disposition' IN ('retain', 'discard')
       ) THEN
      RAISE EXCEPTION
        'teardown requires explicit retained PVC disposition';
    END IF;
  ELSIF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_retained_resources) AS item(resource)
     WHERE item.resource ->> 'disposition' = 'discard'
  ) THEN
    RAISE EXCEPTION
      'only teardown may request destructive retained-resource disposition';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM agentos.runtime_operations AS operation
     WHERE operation.agent_id = p_agent_id
       AND operation.phase IN (
         'prepared',
         'applied',
         'workload_ready',
         'harness_ready',
         'recovery_required'
       )
  ) THEN
    RAISE EXCEPTION 'Agent already has an active runtime operation';
  END IF;

  INSERT INTO agentos.runtime_operations (
    id,
    agent_id,
    owner_agent_id,
    assignment_id,
    kubernetes_namespace,
    workload_name,
    action,
    render_digest,
    retained_resources,
    phase
  ) VALUES (
    p_operation_id,
    p_agent_id,
    v_actor_id,
    p_assignment_id,
    p_kubernetes_namespace,
    p_workload_name,
    p_action,
    p_render_digest,
    p_retained_resources,
    'prepared'
  );

  PERFORM agentos.record_runtime_operation_event(
    p_operation_id,
    'prepared',
    NULL,
    v_actor_id
  );

  RETURN p_operation_id;
END;
$$;

CREATE FUNCTION agentos.observe_runtime_operation(
  p_operation_id uuid,
  p_phase text,
  p_decision_code text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_operation agentos.runtime_operations%ROWTYPE;
  v_allowed boolean := false;
BEGIN
  SELECT operation.*
    INTO v_operation
    FROM agentos.runtime_operations AS operation
   WHERE operation.id = p_operation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime operation does not exist';
  END IF;

  IF NOT agentos.runtime_operation_authorized(
    v_operation.agent_id,
    v_operation.owner_agent_id
  ) THEN
    RAISE EXCEPTION
      'runtime operation requires an authenticated Mate and managed hierarchy';
  END IF;

  IF v_operation.phase IN ('completed', 'failed', 'superseded') THEN
    RAISE EXCEPTION '% runtime operation is immutable', v_operation.phase;
  END IF;

  IF p_phase IS NULL
     OR p_phase NOT IN (
       'prepared',
       'applied',
       'workload_ready',
       'harness_ready',
       'recovery_required'
     ) THEN
    RAISE EXCEPTION 'unsupported runtime operation observation phase';
  END IF;

  IF p_phase = 'recovery_required' THEN
    IF p_decision_code IS NULL
       OR p_decision_code !~ '^[a-z][a-z0-9_]{0,62}$' THEN
      RAISE EXCEPTION 'recovery_required requires a stable decision code';
    END IF;
  ELSIF p_decision_code IS NOT NULL THEN
    RAISE EXCEPTION 'stable runtime observations do not accept a decision code';
  END IF;

  IF v_operation.phase = p_phase THEN
    IF v_operation.decision_code IS NOT DISTINCT FROM p_decision_code THEN
      RETURN p_phase;
    END IF;
    RAISE EXCEPTION 'runtime operation observation conflicts with current phase';
  END IF;

  IF p_phase = 'recovery_required' THEN
    v_allowed := true;
  ELSIF v_operation.phase = 'recovery_required' THEN
    v_allowed := (
      (v_operation.action = 'teardown' AND p_phase IN ('prepared', 'applied'))
      OR (
        v_operation.action <> 'teardown'
        AND p_phase IN (
          'prepared',
          'applied',
          'workload_ready',
          'harness_ready'
        )
      )
    );
  ELSIF v_operation.action = 'teardown' THEN
    v_allowed := v_operation.phase = 'prepared' AND p_phase = 'applied';
  ELSE
    v_allowed :=
      (v_operation.phase = 'prepared' AND p_phase = 'applied')
      OR (
        v_operation.phase = 'applied'
        AND p_phase = 'workload_ready'
      )
      OR (
        v_operation.phase = 'workload_ready'
        AND p_phase = 'harness_ready'
      );
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION
      'runtime operation phase transition from % to % is invalid',
      v_operation.phase,
      p_phase;
  END IF;

  UPDATE agentos.runtime_operations
     SET phase = p_phase,
         decision_code = p_decision_code
   WHERE id = p_operation_id;

  PERFORM agentos.record_runtime_operation_event(
    p_operation_id,
    p_phase,
    p_decision_code,
    v_actor_id
  );

  RETURN p_phase;
END;
$$;

CREATE FUNCTION agentos.complete_runtime_operation(
  p_operation_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_operation agentos.runtime_operations%ROWTYPE;
BEGIN
  SELECT operation.*
    INTO v_operation
    FROM agentos.runtime_operations AS operation
   WHERE operation.id = p_operation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime operation does not exist';
  END IF;

  IF NOT agentos.runtime_operation_authorized(
    v_operation.agent_id,
    v_operation.owner_agent_id
  ) THEN
    RAISE EXCEPTION
      'runtime operation requires an authenticated Mate and managed hierarchy';
  END IF;

  IF v_operation.phase = 'completed' THEN
    RETURN 'completed';
  END IF;

  IF v_operation.phase IN ('failed', 'superseded') THEN
    RAISE EXCEPTION '% runtime operation is immutable', v_operation.phase;
  END IF;

  IF (
    v_operation.action = 'teardown'
    AND v_operation.phase <> 'applied'
  ) OR (
    v_operation.action <> 'teardown'
    AND v_operation.phase <> 'harness_ready'
  ) THEN
    RAISE EXCEPTION
      'runtime operation has not reached its completion boundary';
  END IF;

  UPDATE agentos.runtime_operations
     SET phase = 'completed',
         decision_code = NULL
   WHERE id = p_operation_id;

  PERFORM agentos.record_runtime_operation_event(
    p_operation_id,
    'completed',
    NULL,
    v_actor_id
  );

  RETURN 'completed';
END;
$$;

CREATE FUNCTION agentos.fail_runtime_operation(
  p_operation_id uuid,
  p_decision_code text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_operation agentos.runtime_operations%ROWTYPE;
BEGIN
  SELECT operation.*
    INTO v_operation
    FROM agentos.runtime_operations AS operation
   WHERE operation.id = p_operation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime operation does not exist';
  END IF;

  IF NOT agentos.runtime_operation_authorized(
    v_operation.agent_id,
    v_operation.owner_agent_id
  ) THEN
    RAISE EXCEPTION
      'runtime operation requires an authenticated Mate and managed hierarchy';
  END IF;

  IF p_decision_code IS NULL
     OR p_decision_code !~ '^[a-z][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'runtime operation failure requires a stable decision code';
  END IF;

  IF v_operation.phase = 'failed' THEN
    IF v_operation.decision_code = p_decision_code THEN
      RETURN 'failed';
    END IF;
    RAISE EXCEPTION 'failed runtime operation is immutable';
  END IF;

  IF v_operation.phase IN ('completed', 'superseded') THEN
    RAISE EXCEPTION '% runtime operation is immutable', v_operation.phase;
  END IF;

  UPDATE agentos.runtime_operations
     SET phase = 'failed',
         decision_code = p_decision_code
   WHERE id = p_operation_id;

  PERFORM agentos.record_runtime_operation_event(
    p_operation_id,
    'failed',
    p_decision_code,
    v_actor_id
  );

  RETURN 'failed';
END;
$$;

CREATE FUNCTION agentos.supersede_runtime_operation(
  p_operation_id uuid,
  p_replacement_operation_id uuid,
  p_render_digest text,
  p_retained_resources jsonb,
  p_decision_code text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
  v_agent agentos.agents%ROWTYPE;
  v_operation agentos.runtime_operations%ROWTYPE;
  v_replacement agentos.runtime_operations%ROWTYPE;
BEGIN
  SELECT operation.*
    INTO v_operation
    FROM agentos.runtime_operations AS operation
   WHERE operation.id = p_operation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime operation does not exist';
  END IF;

  IF NOT agentos.runtime_operation_authorized(
    v_operation.agent_id,
    v_operation.owner_agent_id
  ) THEN
    RAISE EXCEPTION
      'runtime operation requires an authenticated Mate and managed hierarchy';
  END IF;

  IF p_replacement_operation_id = p_operation_id THEN
    RAISE EXCEPTION 'replacement runtime operation requires a new ID';
  END IF;

  IF p_render_digest IS NULL OR p_render_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'runtime operation render digest must be SHA-256';
  END IF;

  IF NOT agentos.valid_runtime_operation_resources(p_retained_resources) THEN
    RAISE EXCEPTION
      'runtime operation retained resources violate the closed contract';
  END IF;

  IF p_decision_code IS NULL
     OR p_decision_code !~ '^[a-z][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'runtime operation supersession requires a stable decision code';
  END IF;

  IF v_operation.phase = 'superseded' THEN
    SELECT replacement.*
      INTO v_replacement
      FROM agentos.runtime_operations AS replacement
     WHERE replacement.supersedes_operation_id = p_operation_id;

    IF FOUND
       AND v_replacement.id = p_replacement_operation_id
       AND v_replacement.owner_agent_id = v_actor_id
       AND v_replacement.render_digest = p_render_digest
       AND v_replacement.retained_resources = p_retained_resources
       AND v_operation.decision_code = p_decision_code THEN
      RETURN v_replacement.id;
    END IF;

    RAISE EXCEPTION
      'request conflicts with the replacement runtime operation';
  END IF;

  IF v_operation.phase = 'completed' THEN
    RAISE EXCEPTION 'completed runtime operation is immutable';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM agentos.runtime_operations AS replacement
     WHERE replacement.id = p_replacement_operation_id
  ) THEN
    RAISE EXCEPTION
      'request conflicts with the replacement runtime operation';
  END IF;

  SELECT agent.*
    INTO STRICT v_agent
    FROM agentos.agents AS agent
   WHERE agent.id = v_operation.agent_id
   FOR UPDATE;

  IF v_operation.action = 'teardown' THEN
    IF EXISTS (
      SELECT 1
        FROM agentos.task_assignments AS assignment
       WHERE assignment.agent_id = v_operation.agent_id
         AND assignment.ended_at IS NULL
    ) THEN
      RAISE EXCEPTION 'teardown requires ended work';
    END IF;

    IF v_agent.persistent_volume_claim IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_retained_resources) AS item(resource)
          WHERE item.resource ->> 'kind' = 'persistent_volume_claim'
            AND item.resource ->> 'name' = v_agent.persistent_volume_claim
            AND item.resource ->> 'disposition' IN ('retain', 'discard')
       ) THEN
      RAISE EXCEPTION
        'teardown requires explicit retained PVC disposition';
    END IF;
  ELSIF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_retained_resources) AS item(resource)
     WHERE item.resource ->> 'disposition' = 'discard'
  ) THEN
    RAISE EXCEPTION
      'only teardown may request destructive retained-resource disposition';
  END IF;

  UPDATE agentos.runtime_operations
     SET phase = 'superseded',
         decision_code = p_decision_code
   WHERE id = p_operation_id;

  PERFORM agentos.record_runtime_operation_event(
    p_operation_id,
    'superseded',
    p_decision_code,
    v_actor_id
  );

  INSERT INTO agentos.runtime_operations (
    id,
    agent_id,
    owner_agent_id,
    assignment_id,
    kubernetes_namespace,
    workload_name,
    action,
    render_digest,
    retained_resources,
    phase,
    supersedes_operation_id
  ) VALUES (
    p_replacement_operation_id,
    v_operation.agent_id,
    v_actor_id,
    v_operation.assignment_id,
    v_operation.kubernetes_namespace,
    v_operation.workload_name,
    v_operation.action,
    p_render_digest,
    p_retained_resources,
    'prepared',
    p_operation_id
  );

  PERFORM agentos.record_runtime_operation_event(
    p_replacement_operation_id,
    'prepared',
    NULL,
    v_actor_id
  );

  RETURN p_replacement_operation_id;
END;
$$;

COMMENT ON FUNCTION agentos.begin_runtime_operation(
  uuid, uuid, uuid, text, text, text, text, jsonb
) IS
  'Begins or exactly retries one hierarchy-owned resumable runtime operation without creating external resources.';
COMMENT ON FUNCTION agentos.observe_runtime_operation(uuid, text, text) IS
  'Records one verified external boundary or recovery-required decision after native inspection.';
COMMENT ON FUNCTION agentos.complete_runtime_operation(uuid) IS
  'Completes one operation only after its action-specific verified boundary.';
COMMENT ON FUNCTION agentos.fail_runtime_operation(uuid, text) IS
  'Records one stable privacy-safe terminal failure decision.';
COMMENT ON FUNCTION agentos.supersede_runtime_operation(
  uuid, uuid, text, jsonb, text
) IS
  'Atomically supersedes a non-completed operation with one replacement bound to the same durable identities.';

REVOKE ALL ON FUNCTION agentos.begin_runtime_operation(
  uuid, uuid, uuid, text, text, text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.observe_runtime_operation(uuid, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.complete_runtime_operation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.fail_runtime_operation(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.supersede_runtime_operation(
  uuid, uuid, text, jsonb, text
) FROM PUBLIC;

CREATE FUNCTION agentos.configure_runtime_operation_privileges(
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
    'GRANT SELECT ON agentos.runtime_operations, agentos.runtime_operation_events TO %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE INSERT, UPDATE, DELETE ON agentos.runtime_operations, agentos.runtime_operation_events FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION agentos.begin_runtime_operation(uuid, uuid, uuid, text, text, text, text, jsonb), agentos.observe_runtime_operation(uuid, text, text), agentos.complete_runtime_operation(uuid), agentos.fail_runtime_operation(uuid, text), agentos.supersede_runtime_operation(uuid, uuid, text, jsonb, text) FROM %I',
    p_database_role
  );

  IF p_agent_role = 'second_mate' THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION agentos.begin_runtime_operation(uuid, uuid, uuid, text, text, text, text, jsonb), agentos.observe_runtime_operation(uuid, text, text), agentos.complete_runtime_operation(uuid), agentos.fail_runtime_operation(uuid, text), agentos.supersede_runtime_operation(uuid, uuid, text, jsonb, text) TO %I',
      p_database_role
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION agentos.configure_runtime_operation_privileges(
  name, text
) FROM PUBLIC;

CREATE FUNCTION agentos.configure_registered_runtime_operation_privileges()
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
    PERFORM agentos.configure_runtime_operation_privileges(
      NEW.database_role,
      NEW.role
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION
  agentos.configure_registered_runtime_operation_privileges()
  FROM PUBLIC;

CREATE TRIGGER agents_configure_runtime_operation_privileges
AFTER UPDATE OF database_role, role ON agentos.agents
FOR EACH ROW
EXECUTE FUNCTION agentos.configure_registered_runtime_operation_privileges();

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
    PERFORM agentos.configure_runtime_operation_privileges(
      v_agent.database_role,
      v_agent.role
    );
  END LOOP;
END;
$$;

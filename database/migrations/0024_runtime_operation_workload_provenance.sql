ALTER TABLE agentos.runtime_operations
  ADD COLUMN workload_spec_version integer,
  ADD COLUMN workload_spec_digest text,
  ADD COLUMN workload_overlay_digest text,
  ADD CONSTRAINT runtime_operations_workload_provenance_check
  CHECK (
    (
      workload_spec_version IS NULL
      AND workload_spec_digest IS NULL
      AND workload_overlay_digest IS NULL
    ) OR (
      workload_spec_version = 1
      AND workload_spec_digest ~ '^[0-9a-f]{64}$'
      AND workload_overlay_digest ~ '^[0-9a-f]{64}$'
    )
  );

COMMENT ON COLUMN agentos.runtime_operations.workload_spec_version IS
  'Version of the reviewed typed AgentWorkloadSpec; null only for operations that do not originate from the workload compiler.';
COMMENT ON COLUMN agentos.runtime_operations.workload_spec_digest IS
  'SHA-256 of the reviewed canonical AgentWorkloadSpec; never the spec body.';
COMMENT ON COLUMN agentos.runtime_operations.workload_overlay_digest IS
  'SHA-256 of the reviewed generated Kustomize overlay; never generated YAML.';

CREATE OR REPLACE FUNCTION agentos.protect_runtime_operation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_binds_workload_provenance boolean :=
    OLD.workload_spec_version IS NULL
    AND OLD.workload_spec_digest IS NULL
    AND OLD.workload_overlay_digest IS NULL
    AND NEW.workload_spec_version = 1
    AND NEW.workload_spec_digest ~ '^[0-9a-f]{64}$'
    AND NEW.workload_overlay_digest ~ '^[0-9a-f]{64}$'
    AND OLD.phase = 'prepared'
    AND NEW.phase = OLD.phase
    AND NEW.decision_code IS NOT DISTINCT FROM OLD.decision_code
    AND NEW.finished_at IS NOT DISTINCT FROM OLD.finished_at;
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
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (
       (
         NEW.workload_spec_version IS DISTINCT FROM OLD.workload_spec_version
         OR NEW.workload_spec_digest IS DISTINCT FROM OLD.workload_spec_digest
         OR NEW.workload_overlay_digest IS DISTINCT FROM OLD.workload_overlay_digest
       )
       AND NOT v_binds_workload_provenance
     ) THEN
    RAISE EXCEPTION
      'runtime operation identity is immutable; supersede it with a new operation';
  END IF;

  IF v_binds_workload_provenance THEN
    NEW.updated_at := transaction_timestamp();
    RETURN NEW;
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

CREATE FUNCTION agentos.begin_workload_runtime_operation(
  p_operation_id uuid,
  p_agent_id uuid,
  p_assignment_id uuid,
  p_kubernetes_namespace text,
  p_workload_name text,
  p_action text,
  p_workload_spec_version integer,
  p_workload_spec_digest text,
  p_workload_overlay_digest text,
  p_render_digest text,
  p_retained_resources jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_operation agentos.runtime_operations%ROWTYPE;
BEGIN
  IF p_workload_spec_version <> 1 THEN
    RAISE EXCEPTION 'workload runtime operation requires spec version 1';
  END IF;
  IF p_workload_spec_digest IS NULL
     OR p_workload_spec_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'workload runtime operation spec digest must be SHA-256';
  END IF;
  IF p_workload_overlay_digest IS NULL
     OR p_workload_overlay_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'workload runtime operation overlay digest must be SHA-256';
  END IF;

  PERFORM agentos.begin_runtime_operation(
    p_operation_id,
    p_agent_id,
    p_assignment_id,
    p_kubernetes_namespace,
    p_workload_name,
    p_action,
    p_render_digest,
    p_retained_resources
  );

  UPDATE agentos.runtime_operations
     SET workload_spec_version = p_workload_spec_version,
         workload_spec_digest = p_workload_spec_digest,
         workload_overlay_digest = p_workload_overlay_digest
   WHERE id = p_operation_id
     AND workload_spec_version IS NULL
     AND workload_spec_digest IS NULL
     AND workload_overlay_digest IS NULL;

  SELECT operation.*
    INTO STRICT v_operation
    FROM agentos.runtime_operations AS operation
   WHERE operation.id = p_operation_id;

  IF v_operation.workload_spec_version = p_workload_spec_version
     AND v_operation.workload_spec_digest = p_workload_spec_digest
     AND v_operation.workload_overlay_digest = p_workload_overlay_digest THEN
    RETURN v_operation.id;
  END IF;

  RAISE EXCEPTION
    'request conflicts with the existing workload runtime operation %',
    p_operation_id;
END;
$$;

CREATE FUNCTION agentos.supersede_workload_runtime_operation(
  p_operation_id uuid,
  p_replacement_operation_id uuid,
  p_workload_spec_version integer,
  p_workload_spec_digest text,
  p_workload_overlay_digest text,
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
  v_operation agentos.runtime_operations%ROWTYPE;
  v_replacement agentos.runtime_operations%ROWTYPE;
BEGIN
  IF p_workload_spec_version <> 1 THEN
    RAISE EXCEPTION 'workload runtime operation requires spec version 1';
  END IF;
  IF p_workload_spec_digest IS NULL
     OR p_workload_spec_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'workload runtime operation spec digest must be SHA-256';
  END IF;
  IF p_workload_overlay_digest IS NULL
     OR p_workload_overlay_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'workload runtime operation overlay digest must be SHA-256';
  END IF;

  SELECT operation.*
    INTO v_operation
    FROM agentos.runtime_operations AS operation
   WHERE operation.id = p_operation_id;
  IF NOT FOUND
     OR v_operation.workload_spec_version IS NULL
     OR v_operation.workload_spec_digest IS NULL
     OR v_operation.workload_overlay_digest IS NULL THEN
    RAISE EXCEPTION
      'workload supersession requires an operation with typed workload provenance';
  END IF;

  PERFORM agentos.supersede_runtime_operation(
    p_operation_id,
    p_replacement_operation_id,
    p_render_digest,
    p_retained_resources,
    p_decision_code
  );

  UPDATE agentos.runtime_operations
     SET workload_spec_version = p_workload_spec_version,
         workload_spec_digest = p_workload_spec_digest,
         workload_overlay_digest = p_workload_overlay_digest
   WHERE id = p_replacement_operation_id
     AND workload_spec_version IS NULL
     AND workload_spec_digest IS NULL
     AND workload_overlay_digest IS NULL;

  SELECT replacement.*
    INTO STRICT v_replacement
    FROM agentos.runtime_operations AS replacement
   WHERE replacement.id = p_replacement_operation_id;

  IF v_replacement.workload_spec_version = p_workload_spec_version
     AND v_replacement.workload_spec_digest = p_workload_spec_digest
     AND v_replacement.workload_overlay_digest = p_workload_overlay_digest THEN
    RETURN v_replacement.id;
  END IF;

  RAISE EXCEPTION
    'request conflicts with the replacement workload runtime operation';
END;
$$;

COMMENT ON FUNCTION agentos.begin_workload_runtime_operation(
  uuid, uuid, uuid, text, text, text, integer, text, text, text, jsonb
) IS
  'Begins or exactly retries one typed workload operation by immutable spec, overlay and reviewed render provenance.';
COMMENT ON FUNCTION agentos.supersede_workload_runtime_operation(
  uuid, uuid, integer, text, text, text, jsonb, text
) IS
  'Atomically supersedes a typed workload operation with one exact replacement provenance contract.';

REVOKE ALL ON FUNCTION agentos.begin_workload_runtime_operation(
  uuid, uuid, uuid, text, text, text, integer, text, text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.supersede_workload_runtime_operation(
  uuid, uuid, integer, text, text, text, jsonb, text
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION agentos.configure_runtime_operation_privileges(
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
    'REVOKE EXECUTE ON FUNCTION agentos.begin_runtime_operation(uuid, uuid, uuid, text, text, text, text, jsonb), agentos.begin_workload_runtime_operation(uuid, uuid, uuid, text, text, text, integer, text, text, text, jsonb), agentos.observe_runtime_operation(uuid, text, text), agentos.complete_runtime_operation(uuid), agentos.fail_runtime_operation(uuid, text), agentos.supersede_runtime_operation(uuid, uuid, text, jsonb, text), agentos.supersede_workload_runtime_operation(uuid, uuid, integer, text, text, text, jsonb, text) FROM %I',
    p_database_role
  );

  IF p_agent_role = 'second_mate' THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION agentos.begin_runtime_operation(uuid, uuid, uuid, text, text, text, text, jsonb), agentos.begin_workload_runtime_operation(uuid, uuid, uuid, text, text, text, integer, text, text, text, jsonb), agentos.observe_runtime_operation(uuid, text, text), agentos.complete_runtime_operation(uuid), agentos.fail_runtime_operation(uuid, text), agentos.supersede_runtime_operation(uuid, uuid, text, jsonb, text), agentos.supersede_workload_runtime_operation(uuid, uuid, integer, text, text, text, jsonb, text) TO %I',
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
    PERFORM agentos.configure_runtime_operation_privileges(
      v_agent.database_role,
      v_agent.role
    );
  END LOOP;
END;
$$;

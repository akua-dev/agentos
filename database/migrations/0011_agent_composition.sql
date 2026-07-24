CREATE FUNCTION agentos.valid_composition_path(p_path text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_path IS NOT NULL
     AND length(p_path) BETWEEN 1 AND 512
     AND p_path !~ '^/'
     AND p_path !~ '\\'
     AND p_path !~ '(^|/)\.{1,2}(/|$)'
     AND p_path !~ '//'
     AND p_path !~ '[[:cntrl:]]'
$$;

CREATE FUNCTION agentos.valid_composition_origin(p_origin jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(
    jsonb_typeof(p_origin) = 'object'
    AND p_origin ?& ARRAY['kind', 'locator']::text[]
    AND jsonb_typeof(p_origin -> 'kind') = 'string'
    AND jsonb_typeof(p_origin -> 'locator') = 'string'
    AND p_origin ->> 'kind' ~ '[^[:space:]]'
    AND p_origin ->> 'locator' ~ '[^[:space:]]'
    AND (
      NOT p_origin ? 'revision'
      OR (
        jsonb_typeof(p_origin -> 'revision') = 'string'
        AND p_origin ->> 'revision' ~ '[^[:space:]]'
      )
    )
    AND (
      NOT p_origin ? 'path'
      OR (
        jsonb_typeof(p_origin -> 'path') = 'string'
        AND agentos.valid_composition_path(p_origin ->> 'path')
      )
    ),
    false
  )
$$;

CREATE FUNCTION agentos.valid_composition_reference(p_reference jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(
    jsonb_typeof(p_reference) = 'object'
    AND p_reference ?& ARRAY['id', 'origin', 'digest']::text[]
    AND jsonb_typeof(p_reference -> 'id') = 'string'
    AND jsonb_typeof(p_reference -> 'digest') = 'string'
    AND p_reference ->> 'id' ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
    AND agentos.valid_composition_origin(p_reference -> 'origin')
    AND p_reference ->> 'digest' ~ '^sha256:[0-9a-f]{64}$',
    false
  )
$$;

CREATE FUNCTION agentos.valid_composition_manifest(p_manifest jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  v_capability jsonb;
  v_material jsonb;
  v_material_ids text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
     OR NOT coalesce(
       p_manifest ?& ARRAY['version', 'harness', 'materials']::text[],
       false
     )
     OR p_manifest -> 'version' IS DISTINCT FROM '1'::jsonb
     OR jsonb_typeof(p_manifest -> 'harness') IS DISTINCT FROM 'string'
     OR p_manifest ->> 'harness' !~ '[^[:space:]]'
     OR jsonb_typeof(p_manifest -> 'materials') IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1
         FROM jsonb_object_keys(p_manifest) AS manifest_key(key)
        WHERE manifest_key.key NOT IN (
          'version',
          'harness',
          'materials',
          'composer',
          'profile',
          'settings',
          'capability_requirements'
        )
     ) THEN
    RETURN false;
  END IF;

  IF p_manifest ? 'composer'
     AND NOT agentos.valid_composition_reference(p_manifest -> 'composer') THEN
    RETURN false;
  END IF;

  IF p_manifest ? 'profile'
     AND NOT agentos.valid_composition_reference(p_manifest -> 'profile') THEN
    RETURN false;
  END IF;

  IF p_manifest ? 'settings'
     AND jsonb_typeof(p_manifest -> 'settings') IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  FOR v_material IN
    SELECT value FROM jsonb_array_elements(p_manifest -> 'materials')
  LOOP
    IF jsonb_typeof(v_material) IS DISTINCT FROM 'object'
       OR NOT coalesce(
         v_material ?& ARRAY[
           'id',
           'kind',
           'origin',
           'digest',
           'entrypoint'
         ]::text[],
         false
       )
       OR jsonb_typeof(v_material -> 'id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_material -> 'kind') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_material -> 'digest') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_material -> 'entrypoint') IS DISTINCT FROM 'string'
       OR v_material ->> 'id' !~ '^[a-z0-9][a-z0-9._-]{0,127}$'
       OR v_material ->> 'kind' NOT IN (
         'instructions',
         'skill'
       )
       OR NOT agentos.valid_composition_origin(v_material -> 'origin')
       OR v_material ->> 'digest' !~ '^sha256:[0-9a-f]{64}$'
       OR NOT agentos.valid_composition_path(v_material ->> 'entrypoint')
       OR (
         v_material ->> 'kind' = 'skill'
         AND v_material ->> 'entrypoint' !~ '(^|/)SKILL\.md$'
       ) THEN
      RETURN false;
    END IF;

    IF v_material ->> 'id' = ANY(v_material_ids) THEN
      RETURN false;
    END IF;
    v_material_ids := array_append(v_material_ids, v_material ->> 'id');
  END LOOP;

  IF p_manifest ? 'capability_requirements' THEN
    IF jsonb_typeof(p_manifest -> 'capability_requirements')
       IS DISTINCT FROM 'array' THEN
      RETURN false;
    END IF;

    FOR v_capability IN
      SELECT value
        FROM jsonb_array_elements(p_manifest -> 'capability_requirements')
    LOOP
      IF jsonb_typeof(v_capability) IS DISTINCT FROM 'object'
         OR NOT coalesce(
           v_capability ?& ARRAY['id', 'access']::text[],
           false
         )
         OR jsonb_typeof(v_capability -> 'id') IS DISTINCT FROM 'string'
         OR jsonb_typeof(v_capability -> 'access') IS DISTINCT FROM 'string'
         OR v_capability ->> 'id' !~ '[^[:space:]]'
         OR v_capability ->> 'access' !~ '[^[:space:]]'
         OR (
           v_capability ? 'authority_ref'
           AND (
             jsonb_typeof(v_capability -> 'authority_ref') <> 'string'
             OR v_capability ->> 'authority_ref' !~ '[^[:space:]]'
           )
         ) THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;

  RETURN true;
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END;
$$;

ALTER TABLE agentos.agents
  ADD COLUMN resolved_composition jsonb,
  ADD CONSTRAINT agents_resolved_composition_check CHECK (
    resolved_composition IS NULL
    OR agentos.valid_composition_manifest(resolved_composition)
  );

COMMENT ON COLUMN agentos.agents.resolved_composition IS
  'Resolved versioned persistent composition; observed activation remains in the native harness and runtime.';

UPDATE agentos.task_assignments AS assignment
   SET dispatch_profile =
         jsonb_build_object(
           'version', 1,
           'harness', agent.harness,
           'materials', '[]'::jsonb,
           'settings', assignment.dispatch_profile - 'harness'
         )
  FROM agentos.agents AS agent
 WHERE agent.id = assignment.agent_id;

ALTER TABLE agentos.task_assignments
  ALTER COLUMN dispatch_profile DROP DEFAULT,
  ADD CONSTRAINT task_assignments_composition_manifest_check CHECK (
    agentos.valid_composition_manifest(dispatch_profile)
  );

COMMENT ON COLUMN agentos.task_assignments.dispatch_profile IS
  'Pinned versioned Assignment composition: concrete harness, ordered material provenance and opaque native runtime settings.';

CREATE FUNCTION agentos.enforce_agent_composition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.harness IS DISTINCT FROM OLD.harness
     AND EXISTS (
       SELECT 1
         FROM agentos.task_assignments AS assignment
        WHERE assignment.agent_id = OLD.id
          AND assignment.ended_at IS NULL
          AND assignment.dispatch_profile ->> 'harness'
              IS DISTINCT FROM NEW.harness
     ) THEN
    RAISE EXCEPTION
      'Agent harness cannot contradict an active Task Assignment';
  END IF;

  IF NEW.resolved_composition IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.role NOT IN ('first_mate', 'second_mate') THEN
    RAISE EXCEPTION 'persistent composition is limited to First and Second Mates';
  END IF;

  IF NEW.resolved_composition ->> 'harness' IS DISTINCT FROM NEW.harness THEN
    RAISE EXCEPTION 'composition harness must match the Agent';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER agents_composition_contract
BEFORE INSERT OR UPDATE OF role, harness, resolved_composition ON agentos.agents
FOR EACH ROW EXECUTE FUNCTION agentos.enforce_agent_composition();

CREATE FUNCTION agentos.enforce_assignment_composition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_agent_harness text;
BEGIN
  SELECT agent.harness
    INTO v_agent_harness
    FROM agentos.agents AS agent
   WHERE agent.id = NEW.agent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assignment composition requires an existing Agent';
  END IF;

  IF NEW.dispatch_profile ->> 'harness' IS DISTINCT FROM v_agent_harness THEN
    RAISE EXCEPTION 'composition harness must match the assigned Agent';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER task_assignments_composition_contract
BEFORE INSERT OR UPDATE OF agent_id, dispatch_profile
ON agentos.task_assignments
FOR EACH ROW EXECUTE FUNCTION agentos.enforce_assignment_composition();

CREATE OR REPLACE FUNCTION agentos.protect_completed_task_assignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF OLD.started_at IS NOT NULL
     AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION
      'started Task Assignment start time is immutable';
  END IF;

  IF (OLD.started_at IS NOT NULL OR NEW.started_at IS NOT NULL)
     AND (
       NEW.brief IS DISTINCT FROM OLD.brief
       OR NEW.dispatch_profile IS DISTINCT FROM OLD.dispatch_profile
     ) THEN
    RAISE EXCEPTION
      'started Task Assignment brief and composition are immutable; hand off or replace the Assignment';
  END IF;

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
    RAISE EXCEPTION
      'completed Task assignment is immutable; create a new assignment';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION agentos.repair_task_assignment_dispatch(
  p_assignment_id uuid,
  p_brief text,
  p_composition jsonb,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_caller_id uuid := agentos.current_agent_id();
  v_caller_role text := agentos.current_agent_role();
  v_assignment agentos.task_assignments%ROWTYPE;
  v_harness text;
  v_reason text;
BEGIN
  IF v_caller_id IS NULL OR v_caller_role <> 'first_mate' THEN
    RAISE EXCEPTION
      'Task Assignment dispatch repair requires First Mate';
  END IF;

  IF p_brief IS NULL OR p_brief !~ '[^[:space:]]' THEN
    RAISE EXCEPTION
      'Task Assignment dispatch repair requires a durable brief';
  END IF;

  IF p_reason IS NULL OR p_reason !~ '[^[:space:]]' THEN
    RAISE EXCEPTION
      'Task Assignment dispatch repair requires a durable reason';
  END IF;

  IF NOT agentos.valid_composition_manifest(p_composition) THEN
    RAISE EXCEPTION
      'Task Assignment dispatch repair requires a valid composition';
  END IF;

  LOCK TABLE agentos.task_assignments IN ACCESS EXCLUSIVE MODE;

  SELECT assignment.*
    INTO v_assignment
    FROM agentos.task_assignments AS assignment
   WHERE assignment.id = p_assignment_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_assignment.started_at IS NULL
     OR v_assignment.ended_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Task Assignment dispatch repair requires an active started Task Assignment';
  END IF;

  SELECT agent.harness
    INTO v_harness
    FROM agentos.agents AS agent
   WHERE agent.id = v_assignment.agent_id;

  IF NOT FOUND
     OR p_composition ->> 'harness' IS DISTINCT FROM v_harness THEN
    RAISE EXCEPTION
      'Task Assignment repair composition must match the assigned Agent';
  END IF;

  IF v_assignment.brief IS NOT DISTINCT FROM p_brief
     AND v_assignment.dispatch_profile IS NOT DISTINCT FROM p_composition THEN
    RETURN;
  END IF;

  v_reason := regexp_replace(
    p_reason,
    '^[[:space:]]+|[[:space:]]+$',
    '',
    'g'
  );

  ALTER TABLE agentos.task_assignments
    DISABLE TRIGGER task_assignments_protect_completed;

  UPDATE agentos.task_assignments AS assignment
     SET brief = p_brief,
         dispatch_profile = p_composition,
         metadata = jsonb_set(
           assignment.metadata,
           '{dispatch_repair}',
           jsonb_build_object(
             'changed_by_agent_id', v_caller_id,
             'previous_brief', v_assignment.brief,
             'previous_composition', v_assignment.dispatch_profile,
             'reason', v_reason
           ),
           true
         )
   WHERE assignment.id = p_assignment_id;

  ALTER TABLE agentos.task_assignments
    ENABLE TRIGGER task_assignments_protect_completed;
END;
$$;

CREATE FUNCTION agentos.change_agent_composition(
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
     AND agent.retired_at IS NULL;

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
     FROM agentos.captain AS authority
     WHERE authority.id = p_authority_id
       AND authority.archived_at IS NULL
       AND authority.topic = 'agent-composition-authority'
       AND (
         authority.scope = 'fleet'
         OR (
           authority.scope = 'agent'
           AND authority.scope_agent_id = p_agent_id
         )
       )
  ) THEN
    RAISE EXCEPTION
      'persistent Agent composition requires active Captain composition authority';
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

CREATE FUNCTION agentos.replace_agent_composition(
  p_agent_id uuid,
  p_composition jsonb,
  p_authority_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  SELECT agentos.change_agent_composition(
    p_agent_id,
    p_composition,
    p_authority_id,
    p_reason,
    'replace'
  )
$$;

CREATE FUNCTION agentos.repair_agent_composition(
  p_agent_id uuid,
  p_composition jsonb,
  p_authority_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  SELECT agentos.change_agent_composition(
    p_agent_id,
    p_composition,
    p_authority_id,
    p_reason,
    'repair'
  )
$$;

COMMENT ON FUNCTION agentos.valid_composition_manifest(jsonb) IS
  'Pure manifest validator kept executable for registered table writers because Assignment CHECK constraints invoke it as the caller.';

REVOKE ALL ON FUNCTION agentos.change_agent_composition(
  uuid, jsonb, uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.repair_task_assignment_dispatch(
  uuid, text, jsonb, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.replace_agent_composition(
  uuid, jsonb, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.repair_agent_composition(
  uuid, jsonb, uuid, text
) FROM PUBLIC;

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

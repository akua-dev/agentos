CREATE FUNCTION agentos.access_rate_class_rank(p_rate_class text)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE p_rate_class
    WHEN 'disabled' THEN 0
    WHEN 'low' THEN 1
    WHEN 'standard' THEN 2
    WHEN 'high' THEN 3
    ELSE NULL
  END::smallint
$$;

CREATE FUNCTION agentos.valid_access_scope(p_scope jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_scope) <> 'object' THEN false
    WHEN p_scope ->> 'kind' = 'fleet' THEN
      p_scope - ARRAY['kind', 'fleet'] = '{}'::jsonb
      AND p_scope ?& ARRAY['kind', 'fleet']
      AND p_scope ->> 'fleet' ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
      AND length(p_scope ->> 'fleet') <= 63
    WHEN p_scope ->> 'kind' = 'domain' THEN
      p_scope - ARRAY['kind', 'fleet', 'domain'] = '{}'::jsonb
      AND p_scope ?& ARRAY['kind', 'fleet', 'domain']
      AND p_scope ->> 'fleet' ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
      AND p_scope ->> 'domain' ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
      AND length(p_scope ->> 'fleet') <= 63
      AND length(p_scope ->> 'domain') <= 63
    ELSE false
  END
$$;

CREATE FUNCTION agentos.valid_access_subject(p_subject jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_subject) <> 'object' THEN false
    WHEN p_subject ->> 'kind' = 'mate' THEN
      p_subject - ARRAY['kind', 'fleet', 'domain', 'agentId'] = '{}'::jsonb
      AND p_subject ?& ARRAY['kind', 'fleet', 'domain', 'agentId']
      AND p_subject ->> 'agentId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    WHEN p_subject ->> 'kind' = 'assignment' THEN
      p_subject - ARRAY['kind', 'fleet', 'domain', 'assignmentId'] = '{}'::jsonb
      AND p_subject ?& ARRAY['kind', 'fleet', 'domain', 'assignmentId']
      AND p_subject ->> 'assignmentId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ELSE false
  END
  AND p_subject ->> 'fleet' ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
  AND p_subject ->> 'domain' ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
  AND length(p_subject ->> 'fleet') <= 63
  AND length(p_subject ->> 'domain') <= 63
$$;

CREATE FUNCTION agentos.valid_access_subjects(p_subjects jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_subjects) <> 'array'
      OR jsonb_array_length(p_subjects) = 0 THEN false
    ELSE
      NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(p_subjects) AS item(subject)
         WHERE NOT agentos.valid_access_subject(item.subject)
      )
      AND NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(p_subjects) AS item(subject)
         GROUP BY item.subject
        HAVING count(*) > 1
      )
  END
$$;

CREATE FUNCTION agentos.valid_authorization_resource(p_resource jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE p_resource ->> 'kind'
    WHEN 'provider_service' THEN
      p_resource - ARRAY['kind', 'provider', 'service'] = '{}'::jsonb
      AND p_resource ?& ARRAY['kind', 'provider', 'service']
      AND p_resource ->> 'provider' IN ('github', 'openai')
      AND p_resource ->> 'service' ~ '^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$'
    WHEN 'provider_account' THEN
      p_resource - ARRAY['kind', 'provider', 'account'] = '{}'::jsonb
      AND p_resource ?& ARRAY['kind', 'provider', 'account']
      AND p_resource ->> 'provider' IN ('github', 'openai')
      AND p_resource ->> 'account' ~ '^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$'
    WHEN 'provider_adapter' THEN
      p_resource - ARRAY['kind', 'provider', 'adapter'] = '{}'::jsonb
      AND p_resource ?& ARRAY['kind', 'provider', 'adapter']
      AND p_resource ->> 'provider' IN ('github', 'openai')
      AND p_resource ->> 'adapter' ~ '^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$'
    WHEN 'github_repository' THEN
      p_resource - ARRAY['kind', 'owner', 'repository'] = '{}'::jsonb
      AND p_resource ?& ARRAY['kind', 'owner', 'repository']
      AND p_resource ->> 'owner' ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'
      AND p_resource ->> 'repository' ~ '^[A-Za-z0-9_.-]{1,100}$'
      AND p_resource ->> 'owner' NOT LIKE '%*%'
      AND p_resource ->> 'repository' NOT LIKE '%*%'
    WHEN 'github_project' THEN
      p_resource - ARRAY['kind', 'organization', 'projectNumber'] = '{}'::jsonb
      AND p_resource ?& ARRAY['kind', 'organization', 'projectNumber']
      AND p_resource ->> 'organization' ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'
      AND p_resource ->> 'projectNumber' ~ '^[1-9][0-9]*$'
    ELSE false
  END
$$;

CREATE FUNCTION agentos.valid_access_permissions(p_permissions jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_permissions) <> 'array'
      OR jsonb_array_length(p_permissions) = 0 THEN false
    ELSE
      NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(p_permissions) AS item(permission)
         WHERE jsonb_typeof(item.permission) <> 'object'
            OR item.permission - ARRAY[
                 'capability', 'resource', 'environment',
                 'expiresAtMillis', 'rateClass'
               ] <> '{}'::jsonb
            OR NOT item.permission ?& ARRAY[
                 'capability', 'resource', 'environment',
                 'expiresAtMillis', 'rateClass'
               ]
            OR item.permission ->> 'capability' NOT IN (
                 'github.actions.dispatch', 'github.actions.read',
                 'github.contents.write', 'github.issue.read',
                 'github.issue.write', 'github.project.read',
                 'github.project.write', 'github.pull_request.read',
                 'github.pull_request.write', 'github.repository.read',
                 'openai.models.read', 'openai.responses.compact',
                 'openai.responses.create', 'provider.secret.use'
               )
            OR NOT agentos.valid_authorization_resource(
                 item.permission -> 'resource'
               )
            OR (
                 item.permission -> 'environment' <> 'null'::jsonb
                 AND (
                   jsonb_typeof(item.permission -> 'environment') <> 'string'
                   OR item.permission ->> 'environment'
                        !~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
                   OR length(item.permission ->> 'environment') > 63
                 )
               )
            OR (
                 item.permission -> 'expiresAtMillis' <> 'null'::jsonb
                 AND (
                   jsonb_typeof(item.permission -> 'expiresAtMillis') <> 'number'
                   OR item.permission ->> 'expiresAtMillis' !~ '^[0-9]+$'
                 )
               )
            OR agentos.access_rate_class_rank(
                 item.permission ->> 'rateClass'
               ) IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(p_permissions) AS item(permission)
         GROUP BY
           item.permission ->> 'capability',
           item.permission -> 'resource',
           item.permission -> 'environment'
        HAVING count(*) > 1
      )
  END
$$;

CREATE FUNCTION agentos.valid_openfga_tuple_condition(p_condition jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE
    WHEN p_condition = 'null'::jsonb THEN true
    WHEN jsonb_typeof(p_condition) <> 'object' THEN false
    ELSE
      p_condition - ARRAY['name', 'context'] = '{}'::jsonb
      AND p_condition ?& ARRAY['name', 'context']
      AND p_condition ->> 'name' = 'active_window'
      AND jsonb_typeof(p_condition -> 'context') = 'object'
      AND (p_condition -> 'context') - ARRAY['effective_at', 'expires_at'] = '{}'::jsonb
      AND (p_condition -> 'context') ?& ARRAY['effective_at', 'expires_at']
      AND p_condition -> 'context' ->> 'effective_at'
            ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      AND p_condition -> 'context' ->> 'expires_at'
            ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  END
$$;

CREATE FUNCTION agentos.valid_openfga_tuple_mutation(p_mutation jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_mutation) <> 'object'
      OR p_mutation - ARRAY['writes', 'deletes'] <> '{}'::jsonb
      OR NOT p_mutation ?& ARRAY['writes', 'deletes']
      OR jsonb_typeof(p_mutation -> 'writes') <> 'array'
      OR jsonb_typeof(p_mutation -> 'deletes') <> 'array' THEN false
    ELSE
      NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(p_mutation -> 'writes') AS item(tuple_value)
         WHERE jsonb_typeof(item.tuple_value) <> 'object'
            OR item.tuple_value - ARRAY['user', 'relation', 'object', 'condition']
                 <> '{}'::jsonb
            OR NOT item.tuple_value ?& ARRAY[
                 'user', 'relation', 'object', 'condition'
               ]
            OR jsonb_typeof(item.tuple_value -> 'user') <> 'string'
            OR jsonb_typeof(item.tuple_value -> 'relation') <> 'string'
            OR jsonb_typeof(item.tuple_value -> 'object') <> 'string'
            OR item.tuple_value ->> 'user' !~ '^[^[:space:][:cntrl:]]+$'
            OR length(item.tuple_value ->> 'user') > 512
            OR item.tuple_value ->> 'relation' !~ '^[^[:space:][:cntrl:]]+$'
            OR length(item.tuple_value ->> 'relation') > 512
            OR item.tuple_value ->> 'object' !~ '^[^[:space:][:cntrl:]]+$'
            OR length(item.tuple_value ->> 'object') > 512
            OR NOT agentos.valid_openfga_tuple_condition(
                 item.tuple_value -> 'condition'
               )
      )
      AND NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(p_mutation -> 'deletes') AS item(tuple_value)
         WHERE jsonb_typeof(item.tuple_value) <> 'object'
            OR item.tuple_value - ARRAY['user', 'relation', 'object']
                 <> '{}'::jsonb
            OR NOT item.tuple_value ?& ARRAY['user', 'relation', 'object']
            OR jsonb_typeof(item.tuple_value -> 'user') <> 'string'
            OR jsonb_typeof(item.tuple_value -> 'relation') <> 'string'
            OR jsonb_typeof(item.tuple_value -> 'object') <> 'string'
            OR item.tuple_value ->> 'user' !~ '^[^[:space:][:cntrl:]]+$'
            OR length(item.tuple_value ->> 'user') > 512
            OR item.tuple_value ->> 'relation' !~ '^[^[:space:][:cntrl:]]+$'
            OR length(item.tuple_value ->> 'relation') > 512
            OR item.tuple_value ->> 'object' !~ '^[^[:space:][:cntrl:]]+$'
            OR length(item.tuple_value ->> 'object') > 512
      )
  END
$$;

CREATE FUNCTION agentos.valid_access_control_verifications(p_verifications jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_verifications) <> 'array'
      OR jsonb_array_length(p_verifications) = 0 THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_verifications) AS item(verification)
       WHERE jsonb_typeof(item.verification) <> 'object'
          OR item.verification - ARRAY['request', 'expectedAllowed'] <> '{}'::jsonb
          OR NOT item.verification ?& ARRAY['request', 'expectedAllowed']
          OR jsonb_typeof(item.verification -> 'expectedAllowed') <> 'boolean'
          OR jsonb_typeof(item.verification -> 'request') <> 'object'
          OR (item.verification -> 'request') - ARRAY[
               'storeId', 'authorizationModelId', 'user', 'relation',
               'object', 'context', 'consistency'
             ] <> '{}'::jsonb
          OR NOT ((item.verification -> 'request') ?& ARRAY[
               'storeId', 'authorizationModelId', 'user', 'relation',
               'object', 'context', 'consistency'
             ])
          OR item.verification -> 'request' ->> 'storeId'
               !~ '^[0-9A-HJKMNP-TV-Z]{26}$'
          OR item.verification -> 'request' ->> 'authorizationModelId'
               !~ '^[0-9A-HJKMNP-TV-Z]{26}$'
          OR item.verification -> 'request' ->> 'consistency'
               <> 'HIGHER_CONSISTENCY'
          OR item.verification -> 'request' ->> 'user'
               !~ '^[^[:space:][:cntrl:]]+$'
          OR length(item.verification -> 'request' ->> 'user') > 512
          OR item.verification -> 'request' ->> 'relation'
               !~ '^[^[:space:][:cntrl:]]+$'
          OR length(item.verification -> 'request' ->> 'relation') > 512
          OR item.verification -> 'request' ->> 'object'
               !~ '^[^[:space:][:cntrl:]]+$'
          OR length(item.verification -> 'request' ->> 'object') > 512
          OR jsonb_typeof(item.verification -> 'request' -> 'context')
               <> 'object'
          OR (item.verification -> 'request' -> 'context')
               - ARRAY['current_time'] <> '{}'::jsonb
          OR NOT ((item.verification -> 'request' -> 'context') ? 'current_time')
          OR item.verification -> 'request' -> 'context' ->> 'current_time'
               !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    )
  END
$$;

CREATE FUNCTION agentos.valid_access_control_stages(p_stages jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_stages) <> 'array'
      OR jsonb_array_length(p_stages) NOT BETWEEN 1 AND 2 THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_stages) AS item(stage)
       WHERE jsonb_typeof(item.stage) <> 'object'
          OR item.stage - ARRAY['mutation', 'verifications'] <> '{}'::jsonb
          OR NOT item.stage ?& ARRAY['mutation', 'verifications']
          OR NOT agentos.valid_openfga_tuple_mutation(
               item.stage -> 'mutation'
             )
          OR NOT agentos.valid_access_control_verifications(
               item.stage -> 'verifications'
             )
    )
  END
$$;

REVOKE ALL ON FUNCTION agentos.access_rate_class_rank(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.valid_access_scope(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.valid_access_subject(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.valid_access_subjects(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.valid_authorization_resource(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.valid_access_permissions(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.valid_openfga_tuple_condition(jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.valid_openfga_tuple_mutation(jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.valid_access_control_verifications(jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.valid_access_control_stages(jsonb)
  FROM PUBLIC;

CREATE TABLE agentos.access_ceilings (
  ceiling_id text NOT NULL
    CHECK (ceiling_id ~ '^ceiling_[0-9a-f]{32}$'),
  revision integer NOT NULL CHECK (revision > 0),
  supersedes_revision integer,
  scope jsonb NOT NULL CHECK (agentos.valid_access_scope(scope)),
  effective_at_millis bigint NOT NULL CHECK (effective_at_millis >= 0),
  permissions jsonb NOT NULL
    CHECK (agentos.valid_access_permissions(permissions)),
  document_digest text NOT NULL CHECK (document_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('pending', 'active', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (ceiling_id, revision),
  CHECK (
    (revision = 1 AND supersedes_revision IS NULL)
    OR (revision > 1 AND supersedes_revision = revision - 1)
  )
);

CREATE UNIQUE INDEX access_ceilings_one_active_idx
  ON agentos.access_ceilings (ceiling_id)
  WHERE state = 'active';

CREATE UNIQUE INDEX access_ceilings_one_pending_idx
  ON agentos.access_ceilings (ceiling_id)
  WHERE state = 'pending';

CREATE TABLE agentos.access_profiles (
  profile_id text NOT NULL
    CHECK (profile_id ~ '^[a-z][a-z0-9-]{0,62}$'),
  profile_version integer NOT NULL CHECK (profile_version > 0),
  previous_profile_version integer,
  ceiling_id text NOT NULL,
  ceiling_revision integer NOT NULL,
  target_scope jsonb NOT NULL CHECK (agentos.valid_access_scope(target_scope)),
  permissions jsonb NOT NULL
    CHECK (agentos.valid_access_permissions(permissions)),
  published_by_agent_id uuid NOT NULL
    REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (profile_id, profile_version),
  FOREIGN KEY (ceiling_id, ceiling_revision)
    REFERENCES agentos.access_ceilings(ceiling_id, revision) ON DELETE RESTRICT,
  CHECK (
    (profile_version = 1 AND previous_profile_version IS NULL)
    OR (
      profile_version > 1
      AND previous_profile_version = profile_version - 1
    )
  )
);

CREATE TABLE agentos.access_profile_heads (
  profile_id text PRIMARY KEY,
  profile_version integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (profile_id, profile_version)
    REFERENCES agentos.access_profiles(profile_id, profile_version)
    ON DELETE RESTRICT
);

CREATE TABLE agentos.access_bindings (
  binding_id text PRIMARY KEY
    CHECK (binding_id ~ '^binding_[0-9a-f]{32}$'),
  profile_id text NOT NULL,
  profile_version integer NOT NULL,
  subject jsonb NOT NULL CHECK (agentos.valid_access_subject(subject)),
  created_at_millis bigint NOT NULL CHECK (created_at_millis >= 0),
  expires_at_millis bigint CHECK (
    expires_at_millis IS NULL OR expires_at_millis > created_at_millis
  ),
  ceiling_id text NOT NULL,
  ceiling_revision integer NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  created_by_agent_id uuid NOT NULL
    REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (profile_id, profile_version)
    REFERENCES agentos.access_profiles(profile_id, profile_version)
    ON DELETE RESTRICT,
  FOREIGN KEY (ceiling_id, ceiling_revision)
    REFERENCES agentos.access_ceilings(ceiling_id, revision)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX access_bindings_one_live_subject_idx
  ON agentos.access_bindings ((subject::text))
  WHERE state IN ('pending', 'active');

CREATE TABLE agentos.access_control_operations (
  operation_id uuid PRIMARY KEY,
  actor_agent_id uuid NOT NULL
    REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  service_account_uid uuid NOT NULL,
  correlation_id text NOT NULL
    CHECK (correlation_id ~ '^corr_[0-9a-f]{32}$'),
  kind text NOT NULL CHECK (
    kind IN (
      'profile_published', 'binding_created',
      'binding_revoked', 'ceiling_reconciled'
    )
  ),
  target_type text NOT NULL CHECK (target_type IN ('profile', 'binding', 'ceiling')),
  target_id text NOT NULL CHECK (
    target_id ~ '^[a-z][a-z0-9_-]{0,127}$'
  ),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  phase text NOT NULL CHECK (
    phase IN ('prepared', 'verified', 'completed', 'failed')
  ),
  previous_version integer CHECK (previous_version IS NULL OR previous_version > 0),
  new_version integer CHECK (new_version IS NULL OR new_version > 0),
  reason_code text NOT NULL CHECK (
    reason_code IN (
      'assignment_requirement', 'operator_request', 'least_privilege',
      'incident_response', 'ceiling_changed', 'assignment_ended'
    )
  ),
  decision text CHECK (decision IS NULL OR decision IN ('recorded', 'denied')),
  subjects jsonb CHECK (
    subjects IS NULL OR agentos.valid_access_subjects(subjects)
  ),
  tuple_stages jsonb,
  next_stage_index integer NOT NULL DEFAULT 0 CHECK (next_stage_index >= 0),
  decision_code text CHECK (
    decision_code IS NULL OR decision_code ~ '^[a-z][a-z0-9_]{0,62}$'
  ),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (
    (
      kind = 'profile_published'
      AND subjects IS NULL
      AND tuple_stages IS NULL
      AND next_stage_index = 0
    )
    OR (
      kind <> 'profile_published'
      AND agentos.valid_access_subjects(subjects)
      AND agentos.valid_access_control_stages(tuple_stages)
      AND next_stage_index <= jsonb_array_length(tuple_stages)
    )
  ),
  CHECK (
    (phase IN ('completed', 'failed')) = (finished_at IS NOT NULL)
  ),
  CHECK (
    (phase = 'completed') = (decision = 'recorded')
    OR phase = 'failed'
  )
);

CREATE UNIQUE INDEX access_control_one_active_target_idx
  ON agentos.access_control_operations (target_type, target_id)
  WHERE phase IN ('prepared', 'verified');

CREATE TABLE agentos.access_control_operation_events (
  operation_id uuid NOT NULL
    REFERENCES agentos.access_control_operations(operation_id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence > 0),
  phase text NOT NULL CHECK (
    phase IN ('prepared', 'stage_verified', 'verified', 'completed', 'failed')
  ),
  stage_index integer CHECK (stage_index IS NULL OR stage_index >= 0),
  decision_code text CHECK (
    decision_code IS NULL OR decision_code ~ '^[a-z][a-z0-9_]{0,62}$'
  ),
  recorded_by_agent_id uuid NOT NULL
    REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (operation_id, sequence),
  CHECK ((phase = 'failed') = (decision_code IS NOT NULL)),
  CHECK ((phase IN ('stage_verified', 'verified')) = (stage_index IS NOT NULL))
);

CREATE TABLE agentos.access_control_audit (
  operation_id uuid PRIMARY KEY
    REFERENCES agentos.access_control_operations(operation_id) ON DELETE RESTRICT,
  actor_agent_id uuid NOT NULL
    REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  service_account_uid uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('profile', 'binding', 'ceiling')),
  target_id text NOT NULL,
  previous_version integer CHECK (previous_version IS NULL OR previous_version > 0),
  new_version integer CHECK (new_version IS NULL OR new_version > 0),
  reason_code text NOT NULL CHECK (
    reason_code IN (
      'assignment_requirement', 'operator_request', 'least_privilege',
      'incident_response', 'ceiling_changed', 'assignment_ended'
    )
  ),
  decision text NOT NULL CHECK (decision IN ('recorded', 'denied')),
  correlation_id text NOT NULL
    CHECK (correlation_id ~ '^corr_[0-9a-f]{32}$'),
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

COMMENT ON TABLE agentos.access_profiles IS
  'Immutable First-Mate access-profile versions bounded by an immutable Captain ceiling revision.';
COMMENT ON TABLE agentos.access_bindings IS
  'Exact profile-version bindings; pending rows never authorize and become active only after strong OpenFGA verification.';
COMMENT ON TABLE agentos.access_control_operations IS
  'Repair-forward access mutation intent with closed staged OpenFGA tuple and verification plans; credentials and provider payloads are forbidden.';
COMMENT ON TABLE agentos.access_control_audit IS
  'Append-only privacy-safe access mutation record containing actor, target, versions, reason, decision and correlation only.';

CREATE FUNCTION agentos.require_first_mate_access_actor()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.current_agent_id();
BEGIN
  IF v_actor_id IS NULL OR agentos.current_agent_role() <> 'first_mate' THEN
    RAISE EXCEPTION 'access-control mutation requires authenticated First Mate';
  END IF;
  RETURN v_actor_id;
END;
$$;

CREATE FUNCTION agentos.record_access_control_operation_event(
  p_operation_id uuid,
  p_phase text,
  p_decision_code text,
  p_actor_id uuid,
  p_stage_index integer DEFAULT NULL
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
    FROM agentos.access_control_operation_events AS event
   WHERE event.operation_id = p_operation_id;
  INSERT INTO agentos.access_control_operation_events (
    operation_id, sequence, phase, stage_index,
    decision_code, recorded_by_agent_id
  ) VALUES (
    p_operation_id, v_sequence, p_phase, p_stage_index,
    p_decision_code, p_actor_id
  );
END;
$$;

CREATE FUNCTION agentos.record_access_ceiling(
  p_ceiling_id text,
  p_revision integer,
  p_supersedes_revision integer,
  p_scope jsonb,
  p_effective_at_millis bigint,
  p_permissions jsonb,
  p_document_digest text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_existing agentos.access_ceilings%ROWTYPE;
  v_current agentos.access_ceilings%ROWTYPE;
  v_state text;
BEGIN
  PERFORM agentos.require_first_mate_access_actor();
  IF p_ceiling_id !~ '^ceiling_[0-9a-f]{32}$'
     OR p_revision IS NULL OR p_revision <= 0
     OR NOT agentos.valid_access_scope(p_scope)
     OR p_effective_at_millis IS NULL OR p_effective_at_millis < 0
     OR NOT agentos.valid_access_permissions(p_permissions)
     OR p_document_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid Captain ceiling document';
  END IF;

  SELECT ceiling.* INTO v_existing
    FROM agentos.access_ceilings AS ceiling
   WHERE ceiling.ceiling_id = p_ceiling_id
     AND ceiling.revision = p_revision;
  IF FOUND THEN
    IF v_existing.supersedes_revision IS NOT DISTINCT FROM p_supersedes_revision
       AND v_existing.scope = p_scope
       AND v_existing.effective_at_millis = p_effective_at_millis
       AND v_existing.permissions = p_permissions
       AND v_existing.document_digest = p_document_digest THEN
      RETURN v_existing.revision;
    END IF;
    RAISE EXCEPTION 'Captain ceiling revision is immutable';
  END IF;

  SELECT ceiling.* INTO v_current
    FROM agentos.access_ceilings AS ceiling
   WHERE ceiling.ceiling_id = p_ceiling_id
     AND ceiling.state = 'active'
   FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM agentos.access_ceilings AS ceiling
     WHERE ceiling.ceiling_id = p_ceiling_id
       AND ceiling.state = 'pending'
  ) THEN
    RAISE EXCEPTION 'Captain ceiling reconciliation is already pending';
  END IF;
  IF (v_current.revision IS NULL AND (p_revision <> 1 OR p_supersedes_revision IS NOT NULL))
     OR (v_current.revision IS NOT NULL AND (
       p_revision <> v_current.revision + 1
       OR p_supersedes_revision <> v_current.revision
       OR p_scope <> v_current.scope
     )) THEN
    RAISE EXCEPTION 'Captain ceiling revision must be contiguous and scope-stable';
  END IF;

  v_state := CASE
    WHEN v_current.revision IS NULL OR NOT EXISTS (
      SELECT 1 FROM agentos.access_bindings AS binding
       WHERE binding.ceiling_id = p_ceiling_id
         AND binding.state = 'active'
    ) THEN 'active'
    ELSE 'pending'
  END;
  IF v_current.revision IS NOT NULL AND v_state = 'active' THEN
    UPDATE agentos.access_ceilings
       SET state = 'superseded'
     WHERE ceiling_id = p_ceiling_id AND revision = v_current.revision;
  END IF;
  INSERT INTO agentos.access_ceilings (
    ceiling_id, revision, supersedes_revision, scope,
    effective_at_millis, permissions, document_digest, state
  ) VALUES (
    p_ceiling_id, p_revision, p_supersedes_revision, p_scope,
    p_effective_at_millis, p_permissions, p_document_digest, v_state
  );
  RETURN p_revision;
END;
$$;

CREATE FUNCTION agentos.publish_access_profile(
  p_operation_id uuid,
  p_profile_id text,
  p_expected_previous_version integer,
  p_ceiling_id text,
  p_ceiling_revision integer,
  p_permissions jsonb,
  p_reason_code text,
  p_correlation_id text,
  p_request_digest text,
  p_service_account_uid uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.require_first_mate_access_actor();
  v_existing agentos.access_control_operations%ROWTYPE;
  v_ceiling agentos.access_ceilings%ROWTYPE;
  v_head integer;
  v_new_version integer;
BEGIN
  SELECT operation.* INTO v_existing
    FROM agentos.access_control_operations AS operation
   WHERE operation.operation_id = p_operation_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.kind = 'profile_published'
       AND v_existing.target_id = p_profile_id
       AND v_existing.request_digest = p_request_digest
       AND v_existing.actor_agent_id = v_actor_id THEN
      RETURN v_existing.new_version;
    END IF;
    RAISE EXCEPTION 'request conflicts with existing access-control operation';
  END IF;

  IF p_profile_id !~ '^[a-z][a-z0-9-]{0,62}$'
     OR p_expected_previous_version IS NOT NULL
          AND p_expected_previous_version <= 0
     OR p_reason_code NOT IN (
       'assignment_requirement', 'operator_request', 'least_privilege',
       'incident_response', 'ceiling_changed', 'assignment_ended'
     )
     OR p_correlation_id !~ '^corr_[0-9a-f]{32}$'
     OR p_request_digest !~ '^[0-9a-f]{64}$'
     OR p_service_account_uid IS NULL
     OR NOT agentos.valid_access_permissions(p_permissions) THEN
    RAISE EXCEPTION 'invalid access-profile publication request';
  END IF;

  SELECT ceiling.* INTO v_ceiling
    FROM agentos.access_ceilings AS ceiling
   WHERE ceiling.ceiling_id = p_ceiling_id
     AND ceiling.revision = p_ceiling_revision
     AND ceiling.state = 'active'
   FOR SHARE;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM agentos.access_ceilings AS pending_ceiling
     WHERE pending_ceiling.ceiling_id = p_ceiling_id
       AND pending_ceiling.state = 'pending'
  ) THEN
    RAISE EXCEPTION 'profile requires the current Captain ceiling revision';
  END IF;

  SELECT head.profile_version INTO v_head
    FROM agentos.access_profile_heads AS head
   WHERE head.profile_id = p_profile_id
   FOR UPDATE;
  IF v_head IS DISTINCT FROM p_expected_previous_version THEN
    RAISE EXCEPTION 'profile version conflict';
  END IF;
  v_new_version := coalesce(v_head, 0) + 1;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_permissions) AS requested(permission)
     WHERE NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(v_ceiling.permissions) AS allowed(permission)
        WHERE allowed.permission ->> 'capability' =
                requested.permission ->> 'capability'
          AND allowed.permission -> 'resource' =
                requested.permission -> 'resource'
          AND allowed.permission -> 'environment' =
                requested.permission -> 'environment'
          AND agentos.access_rate_class_rank(
                requested.permission ->> 'rateClass'
              ) <= agentos.access_rate_class_rank(
                allowed.permission ->> 'rateClass'
              )
          AND (
            allowed.permission -> 'expiresAtMillis' = 'null'::jsonb
            OR (
              requested.permission -> 'expiresAtMillis' <> 'null'::jsonb
              AND (requested.permission ->> 'expiresAtMillis')::bigint <=
                    (allowed.permission ->> 'expiresAtMillis')::bigint
            )
          )
     )
  ) THEN
    RAISE EXCEPTION 'permission exceeds current Captain ceiling';
  END IF;

  INSERT INTO agentos.access_profiles (
    profile_id, profile_version, previous_profile_version,
    ceiling_id, ceiling_revision, target_scope, permissions,
    published_by_agent_id
  ) VALUES (
    p_profile_id, v_new_version, v_head,
    p_ceiling_id, p_ceiling_revision, v_ceiling.scope, p_permissions,
    v_actor_id
  );
  INSERT INTO agentos.access_profile_heads (
    profile_id, profile_version
  ) VALUES (p_profile_id, v_new_version)
  ON CONFLICT (profile_id) DO UPDATE
    SET profile_version = excluded.profile_version,
        updated_at = transaction_timestamp();

  INSERT INTO agentos.access_control_operations (
    operation_id, actor_agent_id, service_account_uid, correlation_id,
    kind, target_type, target_id, request_digest, phase,
    previous_version, new_version, reason_code, decision, finished_at
  ) VALUES (
    p_operation_id, v_actor_id, p_service_account_uid, p_correlation_id,
    'profile_published', 'profile', p_profile_id, p_request_digest, 'completed',
    v_head, v_new_version, p_reason_code, 'recorded', transaction_timestamp()
  );
  PERFORM agentos.record_access_control_operation_event(
    p_operation_id, 'prepared', NULL, v_actor_id
  );
  PERFORM agentos.record_access_control_operation_event(
    p_operation_id, 'completed', NULL, v_actor_id
  );
  INSERT INTO agentos.access_control_audit (
    operation_id, actor_agent_id, service_account_uid,
    target_type, target_id, previous_version, new_version,
    reason_code, decision, correlation_id
  ) VALUES (
    p_operation_id, v_actor_id, p_service_account_uid,
    'profile', p_profile_id, v_head, v_new_version,
    p_reason_code, 'recorded', p_correlation_id
  );
  PERFORM pg_notify('agentos_access_control', p_operation_id::text);
  RETURN v_new_version;
END;
$$;

CREATE FUNCTION agentos.begin_access_binding_operation(
  p_operation_id uuid,
  p_kind text,
  p_binding_id text,
  p_profile_id text,
  p_profile_version integer,
  p_subject jsonb,
  p_created_at_millis bigint,
  p_expires_at_millis bigint,
  p_ceiling_id text,
  p_ceiling_revision integer,
  p_tuple_mutation jsonb,
  p_verifications jsonb,
  p_reason_code text,
  p_correlation_id text,
  p_request_digest text,
  p_service_account_uid uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.require_first_mate_access_actor();
  v_existing agentos.access_control_operations%ROWTYPE;
  v_binding agentos.access_bindings%ROWTYPE;
  v_ceiling agentos.access_ceilings%ROWTYPE;
BEGIN
  SELECT operation.* INTO v_existing
    FROM agentos.access_control_operations AS operation
   WHERE operation.operation_id = p_operation_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.kind = p_kind
       AND v_existing.target_id = p_binding_id
       AND v_existing.request_digest = p_request_digest
       AND v_existing.actor_agent_id = v_actor_id THEN
      RETURN v_existing.phase;
    END IF;
    RAISE EXCEPTION 'request conflicts with existing access-control operation';
  END IF;

  IF p_kind NOT IN ('binding_created', 'binding_revoked')
     OR p_binding_id !~ '^binding_[0-9a-f]{32}$'
     OR p_profile_id !~ '^[a-z][a-z0-9-]{0,62}$'
     OR p_profile_version IS NULL OR p_profile_version <= 0
     OR NOT agentos.valid_access_subject(p_subject)
     OR p_created_at_millis IS NULL OR p_created_at_millis < 0
     OR p_expires_at_millis IS NOT NULL
          AND p_expires_at_millis <= p_created_at_millis
     OR p_reason_code NOT IN (
       'assignment_requirement', 'operator_request', 'least_privilege',
       'incident_response', 'ceiling_changed', 'assignment_ended'
     )
     OR p_correlation_id !~ '^corr_[0-9a-f]{32}$'
     OR p_request_digest !~ '^[0-9a-f]{64}$'
     OR NOT agentos.valid_openfga_tuple_mutation(p_tuple_mutation)
     OR NOT agentos.valid_access_control_verifications(p_verifications) THEN
    RAISE EXCEPTION 'invalid access-binding operation request';
  END IF;

  SELECT ceiling.* INTO v_ceiling
    FROM agentos.access_ceilings AS ceiling
   WHERE ceiling.ceiling_id = p_ceiling_id
     AND ceiling.revision = p_ceiling_revision
     AND ceiling.state = 'active';
  IF NOT FOUND OR (
    p_kind = 'binding_created' AND EXISTS (
      SELECT 1 FROM agentos.access_ceilings AS pending_ceiling
       WHERE pending_ceiling.ceiling_id = p_ceiling_id
         AND pending_ceiling.state = 'pending'
    )
  ) THEN
    RAISE EXCEPTION 'binding requires the current Captain ceiling revision';
  END IF;
  IF p_subject ->> 'fleet' <> v_ceiling.scope ->> 'fleet'
     OR (
       v_ceiling.scope ->> 'kind' = 'domain'
       AND p_subject ->> 'domain' <> v_ceiling.scope ->> 'domain'
     ) THEN
    RAISE EXCEPTION 'binding subject is outside the Captain ceiling';
  END IF;
  IF (
    p_subject ->> 'kind' = 'mate'
    AND NOT EXISTS (
      SELECT 1
        FROM agentos.agents AS agent
       WHERE agent.id = (p_subject ->> 'agentId')::uuid
         AND agent.retired_at IS NULL
    )
  ) OR (
    p_subject ->> 'kind' = 'assignment'
    AND NOT EXISTS (
      SELECT 1
        FROM agentos.task_assignments AS assignment
        JOIN agentos.agents AS agent ON agent.id = assignment.agent_id
       WHERE assignment.id = (p_subject ->> 'assignmentId')::uuid
         AND assignment.ended_at IS NULL
         AND agent.retired_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'binding subject must name a live Agent or Assignment';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agentos.access_profiles AS profile
     WHERE profile.profile_id = p_profile_id
       AND profile.profile_version = p_profile_version
  ) THEN
    RAISE EXCEPTION 'binding requires an immutable published profile version';
  END IF;

  SELECT binding.* INTO v_binding
    FROM agentos.access_bindings AS binding
   WHERE binding.binding_id = p_binding_id
   FOR UPDATE;
  IF EXISTS (
    SELECT 1
      FROM agentos.access_control_operations AS operation
     WHERE operation.kind = 'ceiling_reconciled'
       AND operation.phase IN ('prepared', 'verified')
       AND operation.subjects @> jsonb_build_array(p_subject)
  ) THEN
    RAISE EXCEPTION 'binding is serialized behind ceiling reconciliation';
  END IF;
  IF p_kind = 'binding_created' THEN
    IF FOUND THEN
      RAISE EXCEPTION 'access binding identity already exists';
    END IF;
    INSERT INTO agentos.access_bindings (
      binding_id, profile_id, profile_version, subject,
      created_at_millis, expires_at_millis,
      ceiling_id, ceiling_revision, state, created_by_agent_id
    ) VALUES (
      p_binding_id, p_profile_id, p_profile_version, p_subject,
      p_created_at_millis, p_expires_at_millis,
      p_ceiling_id, p_ceiling_revision, 'pending', v_actor_id
    );
  ELSE
    IF NOT FOUND OR v_binding.state <> 'active'
       OR v_binding.profile_id <> p_profile_id
       OR v_binding.profile_version <> p_profile_version
       OR v_binding.subject <> p_subject THEN
      RAISE EXCEPTION 'binding revocation requires the exact active binding';
    END IF;
  END IF;

  INSERT INTO agentos.access_control_operations (
    operation_id, actor_agent_id, service_account_uid, correlation_id,
    kind, target_type, target_id, request_digest, phase,
    previous_version, new_version, reason_code, subjects, tuple_stages
  ) VALUES (
    p_operation_id, v_actor_id, p_service_account_uid, p_correlation_id,
    p_kind, 'binding', p_binding_id, p_request_digest, 'prepared',
    CASE WHEN p_kind = 'binding_revoked' THEN p_profile_version ELSE NULL END,
    CASE WHEN p_kind = 'binding_created' THEN p_profile_version ELSE NULL END,
    p_reason_code, jsonb_build_array(p_subject), jsonb_build_array(
      jsonb_build_object(
        'mutation', p_tuple_mutation,
        'verifications', p_verifications
      )
    )
  );
  PERFORM agentos.record_access_control_operation_event(
    p_operation_id, 'prepared', NULL, v_actor_id
  );
  RETURN 'prepared';
END;
$$;

CREATE FUNCTION agentos.begin_access_ceiling_reconciliation(
  p_operation_id uuid,
  p_ceiling_id text,
  p_ceiling_revision integer,
  p_subjects jsonb,
  p_tuple_stages jsonb,
  p_reason_code text,
  p_correlation_id text,
  p_request_digest text,
  p_service_account_uid uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.require_first_mate_access_actor();
  v_existing agentos.access_control_operations%ROWTYPE;
  v_current agentos.access_ceilings%ROWTYPE;
  v_pending agentos.access_ceilings%ROWTYPE;
BEGIN
  SELECT operation.* INTO v_existing
    FROM agentos.access_control_operations AS operation
   WHERE operation.operation_id = p_operation_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.kind = 'ceiling_reconciled'
       AND v_existing.target_id = p_ceiling_id
       AND v_existing.new_version = p_ceiling_revision
       AND v_existing.request_digest = p_request_digest
       AND v_existing.actor_agent_id = v_actor_id THEN
      RETURN v_existing.phase;
    END IF;
    RAISE EXCEPTION 'request conflicts with existing access-control operation';
  END IF;

  IF p_ceiling_id !~ '^ceiling_[0-9a-f]{32}$'
     OR p_ceiling_revision IS NULL OR p_ceiling_revision <= 1
     OR NOT agentos.valid_access_subjects(p_subjects)
     OR NOT agentos.valid_access_control_stages(p_tuple_stages)
     OR p_reason_code NOT IN ('ceiling_changed', 'incident_response')
     OR p_correlation_id !~ '^corr_[0-9a-f]{32}$'
     OR p_request_digest !~ '^[0-9a-f]{64}$'
     OR p_service_account_uid IS NULL THEN
    RAISE EXCEPTION 'invalid ceiling reconciliation request';
  END IF;

  SELECT ceiling.* INTO v_current
    FROM agentos.access_ceilings AS ceiling
   WHERE ceiling.ceiling_id = p_ceiling_id
     AND ceiling.state = 'active'
   FOR UPDATE;
  SELECT ceiling.* INTO v_pending
    FROM agentos.access_ceilings AS ceiling
   WHERE ceiling.ceiling_id = p_ceiling_id
     AND ceiling.revision = p_ceiling_revision
     AND ceiling.state = 'pending'
   FOR UPDATE;
  IF v_current.revision IS NULL OR v_pending.revision IS NULL
     OR v_pending.supersedes_revision <> v_current.revision THEN
    RAISE EXCEPTION 'ceiling reconciliation requires the exact pending revision';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM agentos.access_bindings AS binding
     WHERE binding.ceiling_id = p_ceiling_id
       AND binding.state = 'active'
       AND NOT p_subjects @> jsonb_build_array(binding.subject)
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_subjects) AS requested(subject)
     WHERE NOT EXISTS (
       SELECT 1
         FROM agentos.access_bindings AS binding
        WHERE binding.ceiling_id = p_ceiling_id
          AND binding.state = 'active'
          AND binding.subject = requested.subject
     )
  ) THEN
    RAISE EXCEPTION 'ceiling reconciliation must cover every active subject exactly';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM agentos.access_control_operations AS operation
     WHERE operation.phase IN ('prepared', 'verified')
       AND operation.subjects IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(operation.subjects) AS active(subject)
          WHERE p_subjects @> jsonb_build_array(active.subject)
       )
  ) THEN
    RAISE EXCEPTION 'ceiling reconciliation is serialized behind subject mutation';
  END IF;

  INSERT INTO agentos.access_control_operations (
    operation_id, actor_agent_id, service_account_uid, correlation_id,
    kind, target_type, target_id, request_digest, phase,
    previous_version, new_version, reason_code, subjects, tuple_stages
  ) VALUES (
    p_operation_id, v_actor_id, p_service_account_uid, p_correlation_id,
    'ceiling_reconciled', 'ceiling', p_ceiling_id, p_request_digest,
    'prepared', v_current.revision, v_pending.revision,
    p_reason_code, p_subjects, p_tuple_stages
  );
  PERFORM agentos.record_access_control_operation_event(
    p_operation_id, 'prepared', NULL, v_actor_id
  );
  RETURN 'prepared';
END;
$$;

CREATE FUNCTION agentos.advance_access_control_operation(
  p_operation_id uuid,
  p_expected_stage_index integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.require_first_mate_access_actor();
  v_operation agentos.access_control_operations%ROWTYPE;
  v_next_stage_index integer;
  v_stage_count integer;
BEGIN
  SELECT operation.* INTO v_operation
    FROM agentos.access_control_operations AS operation
   WHERE operation.operation_id = p_operation_id
   FOR UPDATE;
  IF NOT FOUND OR v_operation.actor_agent_id <> v_actor_id THEN
    RAISE EXCEPTION 'access-control operation is unavailable';
  END IF;
  IF v_operation.phase IN ('verified', 'completed') THEN
    RETURN v_operation.phase;
  END IF;
  IF v_operation.phase <> 'prepared' THEN
    RAISE EXCEPTION 'only a prepared access-control operation can be verified';
  END IF;
  IF p_expected_stage_index IS NULL OR p_expected_stage_index < 0
     OR p_expected_stage_index <> v_operation.next_stage_index THEN
    RAISE EXCEPTION 'access-control stage progress conflict';
  END IF;
  v_stage_count := jsonb_array_length(v_operation.tuple_stages);
  v_next_stage_index := v_operation.next_stage_index + 1;
  UPDATE agentos.access_control_operations
     SET phase = CASE
           WHEN v_next_stage_index = v_stage_count THEN 'verified'
           ELSE 'prepared'
         END,
         next_stage_index = v_next_stage_index,
         updated_at = transaction_timestamp()
   WHERE operation_id = p_operation_id;
  PERFORM agentos.record_access_control_operation_event(
    p_operation_id,
    CASE WHEN v_next_stage_index = v_stage_count
      THEN 'verified' ELSE 'stage_verified' END,
    NULL, v_actor_id, p_expected_stage_index
  );
  RETURN CASE WHEN v_next_stage_index = v_stage_count
    THEN 'verified' ELSE 'prepared' END;
END;
$$;

CREATE FUNCTION agentos.complete_access_control_operation(p_operation_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_actor_id uuid := agentos.require_first_mate_access_actor();
  v_operation agentos.access_control_operations%ROWTYPE;
BEGIN
  SELECT operation.* INTO v_operation
    FROM agentos.access_control_operations AS operation
   WHERE operation.operation_id = p_operation_id
   FOR UPDATE;
  IF NOT FOUND OR v_operation.actor_agent_id <> v_actor_id THEN
    RAISE EXCEPTION 'access-control operation is unavailable';
  END IF;
  IF v_operation.phase = 'completed' THEN
    RETURN 'completed';
  END IF;
  IF v_operation.phase <> 'verified' THEN
    RAISE EXCEPTION 'access-control operation must be verified before completion';
  END IF;

  IF v_operation.kind = 'binding_created' THEN
    UPDATE agentos.access_bindings
       SET state = 'active', updated_at = transaction_timestamp()
     WHERE binding_id = v_operation.target_id AND state = 'pending';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pending access binding is unavailable';
    END IF;
  ELSIF v_operation.kind = 'binding_revoked' THEN
    UPDATE agentos.access_bindings
       SET state = 'revoked', updated_at = transaction_timestamp()
     WHERE binding_id = v_operation.target_id AND state = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active access binding is unavailable';
    END IF;
  ELSIF v_operation.kind = 'ceiling_reconciled' THEN
    UPDATE agentos.access_ceilings
       SET state = 'superseded'
     WHERE ceiling_id = v_operation.target_id
       AND revision = v_operation.previous_version
       AND state = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active Captain ceiling is unavailable';
    END IF;
    UPDATE agentos.access_ceilings
       SET state = 'active'
     WHERE ceiling_id = v_operation.target_id
       AND revision = v_operation.new_version
       AND state = 'pending';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pending Captain ceiling is unavailable';
    END IF;
  END IF;

  UPDATE agentos.access_control_operations
     SET phase = 'completed', decision = 'recorded',
         finished_at = transaction_timestamp(),
         updated_at = transaction_timestamp()
   WHERE operation_id = p_operation_id;
  PERFORM agentos.record_access_control_operation_event(
    p_operation_id, 'completed', NULL, v_actor_id
  );
  INSERT INTO agentos.access_control_audit (
    operation_id, actor_agent_id, service_account_uid,
    target_type, target_id, previous_version, new_version,
    reason_code, decision, correlation_id
  ) VALUES (
    p_operation_id, v_actor_id, v_operation.service_account_uid,
    v_operation.target_type, v_operation.target_id,
    v_operation.previous_version, v_operation.new_version,
    v_operation.reason_code, 'recorded', v_operation.correlation_id
  );
  PERFORM pg_notify('agentos_access_control', p_operation_id::text);
  RETURN 'completed';
END;
$$;

CREATE FUNCTION agentos.prevent_access_control_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'access-control audit is append-only';
END;
$$;

CREATE FUNCTION agentos.protect_access_control_operation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.actor_agent_id IS DISTINCT FROM OLD.actor_agent_id
     OR NEW.service_account_uid IS DISTINCT FROM OLD.service_account_uid
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.target_type IS DISTINCT FROM OLD.target_type
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
     OR NEW.previous_version IS DISTINCT FROM OLD.previous_version
     OR NEW.new_version IS DISTINCT FROM OLD.new_version
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.subjects IS DISTINCT FROM OLD.subjects
     OR NEW.tuple_stages IS DISTINCT FROM OLD.tuple_stages
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'access-control operation identity is immutable';
  END IF;
  IF OLD.phase IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'finished access-control operation is immutable';
  END IF;
  IF NOT (
    (
      OLD.phase = 'prepared' AND NEW.phase IN ('prepared', 'verified')
      AND NEW.next_stage_index = OLD.next_stage_index + 1
      AND NEW.decision IS NULL AND NEW.decision_code IS NULL
      AND NEW.finished_at IS NULL
    )
    OR (
      OLD.phase = 'verified' AND NEW.phase = 'completed'
      AND NEW.next_stage_index = OLD.next_stage_index
      AND NEW.decision = 'recorded' AND NEW.decision_code IS NULL
      AND NEW.finished_at IS NOT NULL
    )
    OR (
      OLD.phase IN ('prepared', 'verified') AND NEW.phase = 'failed'
      AND NEW.next_stage_index = OLD.next_stage_index
      AND NEW.decision = 'denied' AND NEW.decision_code IS NOT NULL
      AND NEW.finished_at IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'invalid access-control operation phase transition';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'access-control operation time cannot move backward';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION agentos.protect_access_ceiling()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF NEW.ceiling_id IS DISTINCT FROM OLD.ceiling_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.supersedes_revision IS DISTINCT FROM OLD.supersedes_revision
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.effective_at_millis IS DISTINCT FROM OLD.effective_at_millis
     OR NEW.permissions IS DISTINCT FROM OLD.permissions
     OR NEW.document_digest IS DISTINCT FROM OLD.document_digest
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Captain ceiling revision is immutable';
  END IF;
  IF NOT (
    (OLD.state = 'pending' AND NEW.state = 'active')
    OR (OLD.state = 'active' AND NEW.state = 'superseded')
  ) THEN
    RAISE EXCEPTION 'invalid Captain ceiling state transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER access_profiles_no_mutation
BEFORE UPDATE OR DELETE ON agentos.access_profiles
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_access_control_history_mutation();
CREATE TRIGGER access_ceilings_protect
BEFORE UPDATE ON agentos.access_ceilings
FOR EACH ROW EXECUTE FUNCTION agentos.protect_access_ceiling();
CREATE TRIGGER access_ceilings_no_delete
BEFORE DELETE ON agentos.access_ceilings
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_access_control_history_mutation();
CREATE TRIGGER access_control_operations_protect
BEFORE UPDATE ON agentos.access_control_operations
FOR EACH ROW EXECUTE FUNCTION agentos.protect_access_control_operation();
CREATE TRIGGER access_control_operations_no_delete
BEFORE DELETE ON agentos.access_control_operations
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_access_control_history_mutation();
CREATE TRIGGER access_control_events_no_mutation
BEFORE UPDATE OR DELETE ON agentos.access_control_operation_events
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_access_control_history_mutation();
CREATE TRIGGER access_control_audit_no_mutation
BEFORE UPDATE OR DELETE ON agentos.access_control_audit
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_access_control_history_mutation();

REVOKE ALL ON FUNCTION agentos.require_first_mate_access_actor() FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.record_access_control_operation_event(
  uuid, text, text, uuid, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.record_access_ceiling(
  text, integer, integer, jsonb, bigint, jsonb, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.publish_access_profile(
  uuid, text, integer, text, integer, jsonb, text, text, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.begin_access_binding_operation(
  uuid, text, text, text, integer, jsonb, bigint, bigint,
  text, integer, jsonb, jsonb, text, text, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.begin_access_ceiling_reconciliation(
  uuid, text, integer, jsonb, jsonb, text, text, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.advance_access_control_operation(uuid, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.complete_access_control_operation(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.prevent_access_control_history_mutation()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.protect_access_control_operation()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.protect_access_ceiling()
  FROM PUBLIC;

ALTER TABLE agentos.access_ceilings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.access_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.access_profile_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.access_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.access_control_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.access_control_operation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.access_control_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY access_ceilings_registered_read ON agentos.access_ceilings
  FOR SELECT USING (agentos.current_agent_id() IS NOT NULL);
CREATE POLICY access_profiles_registered_read ON agentos.access_profiles
  FOR SELECT USING (agentos.current_agent_id() IS NOT NULL);
CREATE POLICY access_profile_heads_registered_read ON agentos.access_profile_heads
  FOR SELECT USING (agentos.current_agent_id() IS NOT NULL);
CREATE POLICY access_bindings_registered_read ON agentos.access_bindings
  FOR SELECT USING (agentos.current_agent_id() IS NOT NULL);
CREATE POLICY access_control_operations_registered_read
  ON agentos.access_control_operations
  FOR SELECT USING (agentos.current_agent_id() IS NOT NULL);
CREATE POLICY access_control_events_registered_read
  ON agentos.access_control_operation_events
  FOR SELECT USING (agentos.current_agent_id() IS NOT NULL);
CREATE POLICY access_control_audit_registered_read
  ON agentos.access_control_audit
  FOR SELECT USING (agentos.current_agent_id() IS NOT NULL);

CREATE FUNCTION agentos.configure_access_control_privileges(
  p_database_role name,
  p_agent_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
BEGIN
  EXECUTE format(
    'GRANT SELECT ON agentos.access_ceilings, agentos.access_profiles, agentos.access_profile_heads, agentos.access_bindings, agentos.access_control_operations, agentos.access_control_operation_events, agentos.access_control_audit TO %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE INSERT, UPDATE, DELETE ON agentos.access_ceilings, agentos.access_profiles, agentos.access_profile_heads, agentos.access_bindings, agentos.access_control_operations, agentos.access_control_operation_events, agentos.access_control_audit FROM %I',
    p_database_role
  );
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION agentos.record_access_ceiling(text, integer, integer, jsonb, bigint, jsonb, text), agentos.publish_access_profile(uuid, text, integer, text, integer, jsonb, text, text, text, uuid), agentos.begin_access_binding_operation(uuid, text, text, text, integer, jsonb, bigint, bigint, text, integer, jsonb, jsonb, text, text, text, uuid), agentos.begin_access_ceiling_reconciliation(uuid, text, integer, jsonb, jsonb, text, text, text, uuid), agentos.advance_access_control_operation(uuid, integer), agentos.complete_access_control_operation(uuid) FROM %I',
    p_database_role
  );
  IF p_agent_role = 'first_mate' THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION agentos.publish_access_profile(uuid, text, integer, text, integer, jsonb, text, text, text, uuid), agentos.begin_access_binding_operation(uuid, text, text, text, integer, jsonb, bigint, bigint, text, integer, jsonb, jsonb, text, text, text, uuid), agentos.begin_access_ceiling_reconciliation(uuid, text, integer, jsonb, jsonb, text, text, text, uuid), agentos.advance_access_control_operation(uuid, integer), agentos.complete_access_control_operation(uuid) TO %I',
      p_database_role
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION agentos.configure_access_control_privileges(name, text)
  FROM PUBLIC;

CREATE FUNCTION agentos.configure_registered_access_control_privileges()
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
    PERFORM agentos.configure_access_control_privileges(
      NEW.database_role, NEW.role
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION
  agentos.configure_registered_access_control_privileges()
  FROM PUBLIC;

CREATE TRIGGER agents_configure_access_control_privileges
AFTER UPDATE OF database_role, role ON agentos.agents
FOR EACH ROW EXECUTE FUNCTION
  agentos.configure_registered_access_control_privileges();

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
    PERFORM agentos.configure_access_control_privileges(
      v_agent.database_role, v_agent.role
    );
  END LOOP;
END;
$$;

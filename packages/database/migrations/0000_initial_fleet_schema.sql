CREATE SCHEMA agentos;
CREATE SCHEMA local;

COMMENT ON SCHEMA agentos IS
  'Released AgentOS Fleet data and deterministic coordination mechanics.';
COMMENT ON SCHEMA local IS
  'Approved First-Mate playground; not part of the released AgentOS contract.';

CREATE FUNCTION agentos.touch_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'id is immutable on %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'created_at is immutable on %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;

  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION agentos.touch_task()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'id is immutable on %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'created_at is immutable on %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;

  NEW.revision := OLD.revision + 1;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION agentos.prevent_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'hard delete is disabled on %.%; archive or retire the row instead',
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME;
END;
$$;

CREATE TABLE agentos.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle text NOT NULL UNIQUE,
  display_name text,
  role text NOT NULL CHECK (role IN ('first_mate', 'second_mate', 'crewmate')),
  parent_agent_id uuid REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  harness text NOT NULL,
  lifecycle_status text NOT NULL CHECK (length(btrim(lifecycle_status)) > 0),
  status_text text NOT NULL CHECK (length(btrim(status_text)) > 0),
  kubernetes_context text,
  kubernetes_namespace text,
  kubernetes_pod text,
  persistent_volume_claim text,
  herdr_locator text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (parent_agent_id IS NULL OR parent_agent_id <> id),
  CHECK (
    (role = 'first_mate' AND parent_agent_id IS NULL)
    OR
    (role <> 'first_mate' AND parent_agent_id IS NOT NULL)
  )
);

COMMENT ON TABLE agentos.agents IS
  'Durable Agent identities, hierarchy and runtime locators; live health remains in Kubernetes and Herdr.';

CREATE INDEX agents_parent_idx ON agentos.agents (parent_agent_id)
  WHERE parent_agent_id IS NOT NULL;
CREATE INDEX agents_lifecycle_idx ON agentos.agents (lifecycle_status, role)
  WHERE retired_at IS NULL;

CREATE TRIGGER agents_touch
BEFORE UPDATE ON agentos.agents
FOR EACH ROW EXECUTE FUNCTION agentos.touch_row();
CREATE TRIGGER agents_no_delete
BEFORE DELETE ON agentos.agents
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_hard_delete();

CREATE TABLE agentos.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  repository_url text,
  scope_text text NOT NULL CHECK (length(btrim(scope_text)) > 0),
  status text NOT NULL CHECK (length(btrim(status)) > 0),
  status_text text NOT NULL CHECK (length(btrim(status_text)) > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

COMMENT ON TABLE agentos.projects IS
  'Non-exclusive repository and work scopes used by First and Second Mates for routing.';

CREATE UNIQUE INDEX projects_repository_url_idx
  ON agentos.projects (repository_url)
  WHERE repository_url IS NOT NULL AND archived_at IS NULL;
CREATE INDEX projects_status_idx ON agentos.projects (status)
  WHERE archived_at IS NULL;

CREATE TRIGGER projects_touch
BEFORE UPDATE ON agentos.projects
FOR EACH ROW EXECUTE FUNCTION agentos.touch_row();
CREATE TRIGGER projects_no_delete
BEFORE DELETE ON agentos.projects
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_hard_delete();

CREATE TABLE agentos.captain (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL CHECK (length(btrim(topic)) > 0),
  content text NOT NULL CHECK (length(btrim(content)) > 0),
  source text,
  recorded_by_agent_id uuid REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

COMMENT ON TABLE agentos.captain IS
  'Multiple durable captain preferences and context entries; never a singleton Fleet row.';

CREATE INDEX captain_topic_idx ON agentos.captain (topic)
  WHERE archived_at IS NULL;

CREATE TRIGGER captain_touch
BEFORE UPDATE ON agentos.captain
FOR EACH ROW EXECUTE FUNCTION agentos.touch_row();
CREATE TRIGGER captain_no_delete
BEFORE DELETE ON agentos.captain
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_hard_delete();

CREATE TABLE agentos.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES agentos.projects(id) ON DELETE RESTRICT,
  parent_task_id uuid REFERENCES agentos.tasks(id) ON DELETE RESTRICT,
  created_by_agent_id uuid REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  description text,
  status text NOT NULL CHECK (length(btrim(status)) > 0),
  status_text text NOT NULL CHECK (length(btrim(status_text)) > 0),
  priority text,
  dependencies jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(dependencies) = 'array'),
  external_links jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(external_links) = 'array'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  completed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (parent_task_id IS NULL OR parent_task_id <> id)
);

COMMENT ON TABLE agentos.tasks IS
  'Accepted durable work. External tracker links remain a small JSONB array on the Task.';
COMMENT ON COLUMN agentos.tasks.external_links IS
  'Provider resource locators and observed/published revisions; not a separate synchronization table.';

CREATE INDEX tasks_project_status_idx
  ON agentos.tasks (project_id, status)
  WHERE archived_at IS NULL;
CREATE INDEX tasks_parent_idx ON agentos.tasks (parent_task_id)
  WHERE parent_task_id IS NOT NULL;
CREATE INDEX tasks_dependencies_idx
  ON agentos.tasks USING gin (dependencies jsonb_path_ops);
CREATE INDEX tasks_external_links_idx
  ON agentos.tasks USING gin (external_links jsonb_path_ops);

CREATE TRIGGER tasks_touch
BEFORE UPDATE ON agentos.tasks
FOR EACH ROW EXECUTE FUNCTION agentos.touch_task();
CREATE TRIGGER tasks_no_delete
BEFORE DELETE ON agentos.tasks
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_hard_delete();

CREATE TABLE agentos.task_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES agentos.tasks(id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  assigned_by_agent_id uuid REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  assignment_role text NOT NULL CHECK (length(btrim(assignment_role)) > 0),
  status text NOT NULL CHECK (length(btrim(status)) > 0),
  status_text text NOT NULL CHECK (length(btrim(status_text)) > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (ended_at IS NULL OR ended_at >= created_at)
);

COMMENT ON TABLE agentos.task_assignments IS
  'Referentially safe Agent-to-Task work relationships and their history.';

CREATE UNIQUE INDEX task_assignments_active_agent_idx
  ON agentos.task_assignments (task_id, agent_id)
  WHERE ended_at IS NULL;
CREATE INDEX task_assignments_agent_idx
  ON agentos.task_assignments (agent_id, status)
  WHERE ended_at IS NULL;

CREATE TRIGGER task_assignments_touch
BEFORE UPDATE ON agentos.task_assignments
FOR EACH ROW EXECUTE FUNCTION agentos.touch_row();
CREATE TRIGGER task_assignments_no_delete
BEFORE DELETE ON agentos.task_assignments
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_hard_delete();

CREATE TABLE agentos.inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_agent_id uuid REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  sender_label text NOT NULL CHECK (length(btrim(sender_label)) > 0),
  recipient_agent_id uuid NOT NULL REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  task_id uuid REFERENCES agentos.tasks(id) ON DELETE RESTRICT,
  reply_to_id uuid REFERENCES agentos.inbox(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (length(btrim(kind)) > 0),
  subject text,
  body text NOT NULL CHECK (length(btrim(body)) > 0),
  decision_key text,
  status text NOT NULL CHECK (length(btrim(status)) > 0),
  status_text text NOT NULL CHECK (length(btrim(status_text)) > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  read_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (reply_to_id IS NULL OR reply_to_id <> id),
  CHECK (read_at IS NULL OR read_at >= created_at),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

COMMENT ON TABLE agentos.inbox IS
  'Direct delivery to an Agent. A request does not become accepted work until a Task exists.';

CREATE INDEX inbox_recipient_status_idx
  ON agentos.inbox (recipient_agent_id, status, created_at);
CREATE INDEX inbox_task_idx ON agentos.inbox (task_id, created_at)
  WHERE task_id IS NOT NULL;
CREATE INDEX inbox_decision_key_idx ON agentos.inbox (decision_key)
  WHERE decision_key IS NOT NULL AND resolved_at IS NULL;

CREATE FUNCTION agentos.protect_read_inbox_message()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF OLD.read_at IS NOT NULL AND (
    NEW.sender_agent_id IS DISTINCT FROM OLD.sender_agent_id OR
    NEW.sender_label IS DISTINCT FROM OLD.sender_label OR
    NEW.recipient_agent_id IS DISTINCT FROM OLD.recipient_agent_id OR
    NEW.task_id IS DISTINCT FROM OLD.task_id OR
    NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id OR
    NEW.kind IS DISTINCT FROM OLD.kind OR
    NEW.subject IS DISTINCT FROM OLD.subject OR
    NEW.body IS DISTINCT FROM OLD.body OR
    NEW.decision_key IS DISTINCT FROM OLD.decision_key OR
    NEW.metadata IS DISTINCT FROM OLD.metadata OR
    NEW.read_at IS DISTINCT FROM OLD.read_at
  ) THEN
    RAISE EXCEPTION 'a read inbox delivery is immutable; create a follow-up delivery';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inbox_protect_after_read
BEFORE UPDATE ON agentos.inbox
FOR EACH ROW EXECUTE FUNCTION agentos.protect_read_inbox_message();
CREATE TRIGGER inbox_touch
BEFORE UPDATE ON agentos.inbox
FOR EACH ROW EXECUTE FUNCTION agentos.touch_row();
CREATE TRIGGER inbox_no_delete
BEFORE DELETE ON agentos.inbox
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_hard_delete();

CREATE TABLE agentos.learnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES agentos.projects(id) ON DELETE RESTRICT,
  recorded_by_agent_id uuid REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (length(btrim(scope)) > 0),
  topic text NOT NULL CHECK (length(btrim(topic)) > 0),
  content text NOT NULL CHECK (length(btrim(content)) > 0),
  evidence text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

COMMENT ON TABLE agentos.learnings IS
  'Curated, evidence-backed Fleet knowledge that may be updated or archived as reality changes.';

CREATE INDEX learnings_scope_topic_idx
  ON agentos.learnings (scope, topic)
  WHERE archived_at IS NULL;
CREATE INDEX learnings_project_idx
  ON agentos.learnings (project_id)
  WHERE project_id IS NOT NULL AND archived_at IS NULL;

CREATE TRIGGER learnings_touch
BEFORE UPDATE ON agentos.learnings
FOR EACH ROW EXECUTE FUNCTION agentos.touch_row();
CREATE TRIGGER learnings_no_delete
BEFORE DELETE ON agentos.learnings
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_hard_delete();

CREATE TABLE agentos.external_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (length(btrim(provider)) > 0),
  delivery_id text NOT NULL CHECK (length(btrim(delivery_id)) > 0),
  event_type text NOT NULL CHECK (length(btrim(event_type)) > 0),
  coalesce_key text NOT NULL CHECK (length(btrim(coalesce_key)) > 0),
  actor_external_id text,
  payload jsonb NOT NULL,
  request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(request_metadata) = 'object'),
  batch_id uuid NOT NULL DEFAULT gen_random_uuid(),
  batch_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  ready_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  reconciliation_status text NOT NULL DEFAULT 'pending'
    CHECK (reconciliation_status IN ('pending', 'processing', 'reconciled')),
  status_text text NOT NULL DEFAULT 'Awaiting reconciliation'
    CHECK (length(btrim(status_text)) > 0),
  claimed_by_agent_id uuid REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  claim_token uuid,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  reconciled_by_agent_id uuid REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  reconciled_at timestamptz,
  reconciliation_result jsonb
    CHECK (reconciliation_result IS NULL OR jsonb_typeof(reconciliation_result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (provider, delivery_id),
  CHECK (ready_at >= batch_started_at),
  CHECK (
    (reconciliation_status = 'pending'
      AND claimed_by_agent_id IS NULL
      AND claim_token IS NULL
      AND claim_expires_at IS NULL
      AND reconciled_by_agent_id IS NULL
      AND reconciled_at IS NULL
      AND reconciliation_result IS NULL)
    OR
    (reconciliation_status = 'processing'
      AND claimed_by_agent_id IS NOT NULL
      AND claim_token IS NOT NULL
      AND claim_expires_at IS NOT NULL
      AND reconciled_by_agent_id IS NULL
      AND reconciled_at IS NULL
      AND reconciliation_result IS NULL)
    OR
    (reconciliation_status = 'reconciled'
      AND claimed_by_agent_id IS NOT NULL
      AND claim_token IS NOT NULL
      AND claim_expires_at IS NULL
      AND reconciled_by_agent_id IS NOT NULL
      AND reconciled_at IS NOT NULL
      AND reconciliation_result IS NOT NULL)
  )
);

COMMENT ON TABLE agentos.external_events IS
  'Append-only provider evidence plus minimal batching, claim and reconciliation coordination.';
COMMENT ON COLUMN agentos.external_events.payload IS
  'Complete accepted provider JSON; never stripped or normalized into a lossy internal event.';
COMMENT ON COLUMN agentos.external_events.coalesce_key IS
  'Provider-resource identity used to serialize related reconciliation work.';

CREATE INDEX external_events_pending_idx
  ON agentos.external_events (ready_at, id)
  WHERE reconciliation_status = 'pending';
CREATE INDEX external_events_resource_idx
  ON agentos.external_events (provider, coalesce_key, id);
CREATE INDEX external_events_batch_idx
  ON agentos.external_events (batch_id, id);
CREATE INDEX external_events_claim_idx
  ON agentos.external_events (claim_token, id)
  WHERE claim_token IS NOT NULL;
CREATE INDEX external_events_payload_idx
  ON agentos.external_events USING gin (payload jsonb_path_ops);

CREATE FUNCTION agentos.protect_external_event_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider OR
     NEW.delivery_id IS DISTINCT FROM OLD.delivery_id OR
     NEW.event_type IS DISTINCT FROM OLD.event_type OR
     NEW.coalesce_key IS DISTINCT FROM OLD.coalesce_key OR
     NEW.actor_external_id IS DISTINCT FROM OLD.actor_external_id OR
     NEW.payload IS DISTINCT FROM OLD.payload OR
     NEW.request_metadata IS DISTINCT FROM OLD.request_metadata OR
     NEW.batch_id IS DISTINCT FROM OLD.batch_id OR
     NEW.batch_started_at IS DISTINCT FROM OLD.batch_started_at THEN
    RAISE EXCEPTION 'external event evidence is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER external_events_protect_evidence
BEFORE UPDATE ON agentos.external_events
FOR EACH ROW EXECUTE FUNCTION agentos.protect_external_event_evidence();
CREATE TRIGGER external_events_touch
BEFORE UPDATE ON agentos.external_events
FOR EACH ROW EXECUTE FUNCTION agentos.touch_row();
CREATE TRIGGER external_events_no_delete
BEFORE DELETE ON agentos.external_events
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_hard_delete();

CREATE FUNCTION agentos.require_reconciliation_agent(p_agent_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_handle text;
BEGIN
  SELECT a.handle
    INTO v_handle
    FROM agentos.agents AS a
   WHERE a.id = p_agent_id
     AND a.role IN ('first_mate', 'second_mate')
     AND a.retired_at IS NULL;

  IF v_handle IS NULL THEN
    RAISE EXCEPTION 'external reconciliation requires an active First or Second Mate';
  END IF;

  RETURN v_handle;
END;
$$;

CREATE FUNCTION agentos.ingest_external_event(
  p_provider text,
  p_delivery_id text,
  p_event_type text,
  p_coalesce_key text,
  p_payload jsonb,
  p_actor_external_id text DEFAULT NULL,
  p_request_metadata jsonb DEFAULT '{}'::jsonb,
  p_quiet_window interval DEFAULT interval '3 seconds',
  p_max_batch_window interval DEFAULT interval '30 seconds'
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_event_id bigint;
  v_batch_id uuid;
  v_batch_started_at timestamptz;
  v_ready_at timestamptz;
BEGIN
  IF p_provider IS NULL OR length(btrim(p_provider)) = 0 OR
     p_delivery_id IS NULL OR length(btrim(p_delivery_id)) = 0 OR
     p_event_type IS NULL OR length(btrim(p_event_type)) = 0 OR
     p_coalesce_key IS NULL OR length(btrim(p_coalesce_key)) = 0 OR
     p_payload IS NULL THEN
    RAISE EXCEPTION 'provider, delivery_id, event_type, coalesce_key and payload are required';
  END IF;

  IF p_request_metadata IS NULL OR jsonb_typeof(p_request_metadata) <> 'object' THEN
    RAISE EXCEPTION 'request_metadata must be a JSON object';
  END IF;

  IF p_quiet_window <= interval '0 seconds' OR
     p_max_batch_window < p_quiet_window THEN
    RAISE EXCEPTION 'batch windows must be positive and max must be at least quiet';
  END IF;

  SELECT e.id
    INTO v_event_id
    FROM agentos.external_events AS e
   WHERE e.provider = p_provider
     AND e.delivery_id = p_delivery_id;

  IF FOUND THEN
    RETURN v_event_id;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_provider || E'\x1f' || p_coalesce_key, 0)
  );

  SELECT e.id
    INTO v_event_id
    FROM agentos.external_events AS e
   WHERE e.provider = p_provider
     AND e.delivery_id = p_delivery_id;

  IF FOUND THEN
    RETURN v_event_id;
  END IF;

  SELECT e.batch_id, e.batch_started_at
    INTO v_batch_id, v_batch_started_at
    FROM agentos.external_events AS e
   WHERE e.provider = p_provider
     AND e.coalesce_key = p_coalesce_key
     AND e.reconciliation_status IN ('pending', 'processing')
   ORDER BY e.id DESC
   LIMIT 1;

  IF v_batch_id IS NULL OR
     v_now >= v_batch_started_at + p_max_batch_window THEN
    v_batch_id := gen_random_uuid();
    v_batch_started_at := v_now;
  END IF;

  v_ready_at := least(
    v_now + p_quiet_window,
    v_batch_started_at + p_max_batch_window
  );

  UPDATE agentos.external_events AS e
     SET ready_at = v_ready_at,
         status_text = 'Awaiting end of related event burst'
   WHERE e.batch_id = v_batch_id
     AND e.reconciliation_status = 'pending';

  INSERT INTO agentos.external_events (
    provider,
    delivery_id,
    event_type,
    coalesce_key,
    actor_external_id,
    payload,
    request_metadata,
    batch_id,
    batch_started_at,
    ready_at,
    status_text
  ) VALUES (
    p_provider,
    p_delivery_id,
    p_event_type,
    p_coalesce_key,
    p_actor_external_id,
    p_payload,
    p_request_metadata,
    v_batch_id,
    v_batch_started_at,
    v_ready_at,
    'Awaiting end of related event burst'
  )
  ON CONFLICT (provider, delivery_id) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    SELECT e.id
      INTO STRICT v_event_id
      FROM agentos.external_events AS e
     WHERE e.provider = p_provider
       AND e.delivery_id = p_delivery_id;
  END IF;

  RETURN v_event_id;
END;
$$;

CREATE FUNCTION agentos.claim_external_events(
  p_agent_id uuid,
  p_provider text DEFAULT NULL,
  p_coalesce_key text DEFAULT NULL,
  p_claim_for interval DEFAULT interval '5 minutes'
)
RETURNS TABLE (
  claimed_token uuid,
  claimed_provider text,
  claimed_coalesce_key text,
  event_count bigint,
  high_water_event_id bigint,
  claim_expires_at timestamptz
)
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_candidate record;
  v_handle text;
  v_token uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  v_handle := agentos.require_reconciliation_agent(p_agent_id);

  IF p_claim_for <= interval '0 seconds' THEN
    RAISE EXCEPTION 'claim duration must be positive';
  END IF;

  FOR v_candidate IN
    SELECT e.provider, e.coalesce_key, min(e.id) AS first_event_id
      FROM agentos.external_events AS e
     WHERE (
             (e.reconciliation_status = 'pending' AND e.ready_at <= v_now)
             OR
             (e.reconciliation_status = 'processing' AND e.claim_expires_at <= v_now)
           )
       AND (p_provider IS NULL OR e.provider = p_provider)
       AND (p_coalesce_key IS NULL OR e.coalesce_key = p_coalesce_key)
     GROUP BY e.provider, e.coalesce_key
     ORDER BY min(e.id)
  LOOP
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(
      hashtextextended(v_candidate.provider || E'\x1f' || v_candidate.coalesce_key, 0)
    );

    UPDATE agentos.external_events AS e
       SET reconciliation_status = 'pending',
           status_text = 'Previous claim expired; ready for reconciliation',
           claimed_by_agent_id = NULL,
           claim_token = NULL,
           claim_expires_at = NULL,
           last_error = coalesce(e.last_error, 'Previous reconciliation claim expired')
     WHERE e.provider = v_candidate.provider
       AND e.coalesce_key = v_candidate.coalesce_key
       AND e.reconciliation_status = 'processing'
       AND e.claim_expires_at <= v_now;

    CONTINUE WHEN EXISTS (
      SELECT 1
        FROM agentos.external_events AS active
       WHERE active.provider = v_candidate.provider
         AND active.coalesce_key = v_candidate.coalesce_key
         AND active.reconciliation_status = 'processing'
         AND active.claim_expires_at > v_now
    );

    CONTINUE WHEN NOT EXISTS (
      SELECT 1
        FROM agentos.external_events AS pending
       WHERE pending.provider = v_candidate.provider
         AND pending.coalesce_key = v_candidate.coalesce_key
         AND pending.reconciliation_status = 'pending'
         AND pending.ready_at <= v_now
    );

    v_token := gen_random_uuid();

    UPDATE agentos.external_events AS e
       SET reconciliation_status = 'processing',
           status_text = format('Claimed for reconciliation by %s', v_handle),
           claimed_by_agent_id = p_agent_id,
           claim_token = v_token,
           claim_expires_at = v_now + p_claim_for,
           attempt_count = e.attempt_count + 1
     WHERE e.provider = v_candidate.provider
       AND e.coalesce_key = v_candidate.coalesce_key
       AND e.reconciliation_status = 'pending';

    RETURN QUERY
      SELECT
        v_token,
        v_candidate.provider,
        v_candidate.coalesce_key,
        count(*),
        max(e.id),
        max(e.claim_expires_at)
      FROM agentos.external_events AS e
      WHERE e.claim_token = v_token
        AND e.reconciliation_status = 'processing';
    RETURN;
  END LOOP;

  RETURN;
END;
$$;

CREATE FUNCTION agentos.refresh_external_event_claim(
  p_agent_id uuid,
  p_claim_token uuid,
  p_claim_for interval DEFAULT interval '5 minutes'
)
RETURNS TABLE (
  absorbed_event_count bigint,
  event_count bigint,
  high_water_event_id bigint,
  claim_expires_at timestamptz
)
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_provider text;
  v_coalesce_key text;
  v_absorbed bigint;
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM agentos.require_reconciliation_agent(p_agent_id);

  IF p_claim_for <= interval '0 seconds' THEN
    RAISE EXCEPTION 'claim duration must be positive';
  END IF;

  SELECT e.provider, e.coalesce_key
    INTO v_provider, v_coalesce_key
    FROM agentos.external_events AS e
   WHERE e.claim_token = p_claim_token
     AND e.claimed_by_agent_id = p_agent_id
     AND e.reconciliation_status = 'processing'
   LIMIT 1;

  IF v_provider IS NULL THEN
    RAISE EXCEPTION 'claim is missing, completed or owned by another Agent';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_provider || E'\x1f' || v_coalesce_key, 0)
  );

  IF NOT EXISTS (
    SELECT 1
      FROM agentos.external_events AS e
     WHERE e.claim_token = p_claim_token
       AND e.claimed_by_agent_id = p_agent_id
       AND e.reconciliation_status = 'processing'
       AND e.claim_expires_at > v_now
  ) THEN
    RAISE EXCEPTION 'claim expired or was fenced by another Agent';
  END IF;

  UPDATE agentos.external_events AS e
     SET reconciliation_status = 'processing',
         status_text = 'Absorbed into the current reconciliation claim',
         claimed_by_agent_id = p_agent_id,
         claim_token = p_claim_token,
         claim_expires_at = v_now + p_claim_for,
         attempt_count = e.attempt_count + 1
   WHERE e.provider = v_provider
     AND e.coalesce_key = v_coalesce_key
     AND e.reconciliation_status = 'pending';

  GET DIAGNOSTICS v_absorbed = ROW_COUNT;

  UPDATE agentos.external_events AS e
     SET claim_expires_at = v_now + p_claim_for,
         status_text = 'Reconciliation claim refreshed'
   WHERE e.claim_token = p_claim_token
     AND e.claimed_by_agent_id = p_agent_id
     AND e.reconciliation_status = 'processing';

  RETURN QUERY
    SELECT
      v_absorbed,
      count(*),
      max(e.id),
      max(e.claim_expires_at)
    FROM agentos.external_events AS e
    WHERE e.claim_token = p_claim_token
      AND e.claimed_by_agent_id = p_agent_id
      AND e.reconciliation_status = 'processing';
END;
$$;

CREATE FUNCTION agentos.assert_external_event_claim_current(
  p_agent_id uuid,
  p_claim_token uuid
)
RETURNS TABLE (
  claimed_provider text,
  claimed_coalesce_key text,
  high_water_event_id bigint
)
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_provider text;
  v_coalesce_key text;
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM agentos.require_reconciliation_agent(p_agent_id);

  SELECT e.provider, e.coalesce_key
    INTO v_provider, v_coalesce_key
    FROM agentos.external_events AS e
   WHERE e.claim_token = p_claim_token
     AND e.claimed_by_agent_id = p_agent_id
     AND e.reconciliation_status = 'processing'
   LIMIT 1;

  IF v_provider IS NULL THEN
    RAISE EXCEPTION 'claim is missing, completed or owned by another Agent';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_provider || E'\x1f' || v_coalesce_key, 0)
  );

  IF EXISTS (
    SELECT 1
      FROM agentos.external_events AS e
     WHERE e.claim_token = p_claim_token
       AND e.claimed_by_agent_id = p_agent_id
       AND e.reconciliation_status = 'processing'
       AND e.claim_expires_at <= v_now
  ) THEN
    RAISE EXCEPTION 'claim expired and must be reclaimed before completion';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM agentos.external_events AS e
     WHERE e.provider = v_provider
       AND e.coalesce_key = v_coalesce_key
       AND e.reconciliation_status = 'pending'
  ) THEN
    RAISE EXCEPTION 'new external events arrived; refresh the claim and reconcile the current state';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM agentos.external_events AS e
     WHERE e.provider = v_provider
       AND e.coalesce_key = v_coalesce_key
       AND e.reconciliation_status = 'processing'
       AND e.claim_token IS DISTINCT FROM p_claim_token
  ) THEN
    RAISE EXCEPTION 'claim was fenced by another Agent';
  END IF;

  RETURN QUERY
    SELECT v_provider, v_coalesce_key, max(e.id)
      FROM agentos.external_events AS e
     WHERE e.claim_token = p_claim_token
       AND e.claimed_by_agent_id = p_agent_id
       AND e.reconciliation_status = 'processing';
END;
$$;

CREATE FUNCTION agentos.complete_external_event_claim(
  p_agent_id uuid,
  p_claim_token uuid,
  p_result jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_handle text;
  v_completed bigint;
BEGIN
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object' THEN
    RAISE EXCEPTION 'reconciliation result must be a JSON object';
  END IF;

  v_handle := agentos.require_reconciliation_agent(p_agent_id);

  PERFORM *
    FROM agentos.assert_external_event_claim_current(p_agent_id, p_claim_token);

  UPDATE agentos.external_events AS e
     SET reconciliation_status = 'reconciled',
         status_text = format('Reconciled by %s', v_handle),
         claim_expires_at = NULL,
         reconciled_by_agent_id = p_agent_id,
         reconciled_at = clock_timestamp(),
         reconciliation_result = p_result,
         last_error = NULL
   WHERE e.claim_token = p_claim_token
     AND e.claimed_by_agent_id = p_agent_id
     AND e.reconciliation_status = 'processing';

  GET DIAGNOSTICS v_completed = ROW_COUNT;

  IF v_completed = 0 THEN
    RAISE EXCEPTION 'claim completed no events';
  END IF;

  RETURN v_completed;
END;
$$;

CREATE FUNCTION agentos.release_external_event_claim(
  p_agent_id uuid,
  p_claim_token uuid,
  p_error text
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_provider text;
  v_coalesce_key text;
  v_released bigint;
BEGIN
  PERFORM agentos.require_reconciliation_agent(p_agent_id);

  IF p_error IS NULL OR length(btrim(p_error)) = 0 THEN
    RAISE EXCEPTION 'release requires an explanatory error';
  END IF;

  SELECT e.provider, e.coalesce_key
    INTO v_provider, v_coalesce_key
    FROM agentos.external_events AS e
   WHERE e.claim_token = p_claim_token
     AND e.claimed_by_agent_id = p_agent_id
     AND e.reconciliation_status = 'processing'
   LIMIT 1;

  IF v_provider IS NULL THEN
    RAISE EXCEPTION 'claim is missing, completed or owned by another Agent';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_provider || E'\x1f' || v_coalesce_key, 0)
  );

  UPDATE agentos.external_events AS e
     SET reconciliation_status = 'pending',
         status_text = 'Reconciliation failed; ready for retry',
         claimed_by_agent_id = NULL,
         claim_token = NULL,
         claim_expires_at = NULL,
         ready_at = clock_timestamp(),
         last_error = p_error
   WHERE e.claim_token = p_claim_token
     AND e.claimed_by_agent_id = p_agent_id
     AND e.reconciliation_status = 'processing';

  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released;
END;
$$;

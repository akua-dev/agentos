CREATE FUNCTION agentos.valid_second_mate_charter(p_charter jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
  SELECT CASE
    WHEN p_charter IS NULL
      OR jsonb_typeof(p_charter) IS DISTINCT FROM 'object' THEN false
    ELSE
      p_charter ?& ARRAY[
        'version', 'summary', 'scope', 'projectAccess', 'crossDomainRouting'
      ]
      AND p_charter - ARRAY[
        'version', 'summary', 'scope', 'projectAccess', 'crossDomainRouting'
      ] = '{}'::jsonb
      AND p_charter -> 'version' = '1'::jsonb
      AND nullif(btrim(p_charter ->> 'summary'), '') IS NOT NULL
      AND length(p_charter ->> 'summary') <= 240
      AND nullif(btrim(p_charter ->> 'scope'), '') IS NOT NULL
      AND length(p_charter ->> 'scope') <= 4000
      AND p_charter ->> 'projectAccess' = 'non_exclusive'
      AND p_charter ->> 'crossDomainRouting' = 'common_ancestor'
  END
$$;

COMMENT ON FUNCTION agentos.valid_second_mate_charter(jsonb) IS
  'Validates one closed, non-exclusive Second Mate broad-domain charter.';

CREATE FUNCTION agentos.valid_second_mate_topology_plan(p_plan jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_action text;
  v_destination jsonb;
  v_destination_count integer;
  v_destination_distinct_count integer;
  v_existing_count integer;
  v_new_count integer;
  v_observed_authority_count integer;
  v_proposal jsonb;
  v_reason_count integer;
  v_reason_distinct_count integer;
  v_signal jsonb;
  v_signal_count integer;
  v_signal_distinct_count integer;
  v_source jsonb;
  v_source_count integer;
  v_source_distinct_count integer;
BEGIN
  IF p_plan IS NULL
     OR jsonb_typeof(p_plan) IS DISTINCT FROM 'object'
     OR NOT p_plan ?& ARRAY['version', 'proposal', 'digest']
     OR p_plan - ARRAY['version', 'proposal', 'digest'] <> '{}'::jsonb
     OR p_plan -> 'version' <> '1'::jsonb
     OR p_plan ->> 'digest' !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(p_plan -> 'proposal') IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  v_proposal := p_plan -> 'proposal';
  IF NOT v_proposal ?& ARRAY[
       'version', 'proposalId', 'proposedByAgentId', 'action',
       'observedAtMillis', 'validUntilMillis', 'sources', 'destinations',
       'reasons', 'signals', 'invariants'
     ]
     OR v_proposal - ARRAY[
       'version', 'proposalId', 'proposedByAgentId', 'action',
       'observedAtMillis', 'validUntilMillis', 'sources', 'destinations',
       'reasons', 'signals', 'invariants'
     ] <> '{}'::jsonb
     OR v_proposal -> 'version' <> '1'::jsonb
     OR v_proposal ->> 'proposalId'
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR v_proposal ->> 'proposedByAgentId'
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR v_proposal ->> 'action' NOT IN (
       'expand', 'modify', 'shrink', 'split', 'merge', 'retire'
     )
     OR jsonb_typeof(v_proposal -> 'observedAtMillis') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_proposal -> 'validUntilMillis') IS DISTINCT FROM 'number'
     OR v_proposal ->> 'observedAtMillis' !~ '^[0-9]{1,16}$'
     OR v_proposal ->> 'validUntilMillis' !~ '^[0-9]{1,16}$'
     OR (v_proposal ->> 'validUntilMillis')::bigint
          <= (v_proposal ->> 'observedAtMillis')::bigint
     OR (v_proposal ->> 'validUntilMillis')::bigint
          - (v_proposal ->> 'observedAtMillis')::bigint > 2592000000
     OR jsonb_typeof(v_proposal -> 'sources') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_proposal -> 'destinations') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_proposal -> 'reasons') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_proposal -> 'signals') IS DISTINCT FROM 'array'
     OR v_proposal -> 'invariants' IS DISTINCT FROM jsonb_build_object(
       'projectAccess', 'non_exclusive',
       'crossDomainRouting', 'common_ancestor',
       'lateralDelivery', 'forbidden',
       'automaticScheduling', 'forbidden'
     ) THEN
    RETURN false;
  END IF;

  v_action := v_proposal ->> 'action';
  v_source_count := jsonb_array_length(v_proposal -> 'sources');
  v_destination_count := jsonb_array_length(v_proposal -> 'destinations');
  v_reason_count := jsonb_array_length(v_proposal -> 'reasons');
  v_signal_count := jsonb_array_length(v_proposal -> 'signals');
  IF v_source_count NOT BETWEEN 1 AND 2
     OR v_destination_count NOT BETWEEN 0 AND 2
     OR v_reason_count NOT BETWEEN 1 AND 6
     OR v_signal_count NOT BETWEEN 1 AND 12 THEN
    RETURN false;
  END IF;

  FOR v_source IN
    SELECT value FROM jsonb_array_elements(v_proposal -> 'sources')
  LOOP
    IF jsonb_typeof(v_source) IS DISTINCT FROM 'object'
       OR NOT v_source ?& ARRAY['agentId', 'expectedCharter']
       OR v_source - ARRAY['agentId', 'expectedCharter'] <> '{}'::jsonb
       OR v_source ->> 'agentId'
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR NOT agentos.valid_second_mate_charter(v_source -> 'expectedCharter') THEN
      RETURN false;
    END IF;
  END LOOP;

  SELECT count(DISTINCT source ->> 'agentId')
    INTO v_source_distinct_count
    FROM jsonb_array_elements(v_proposal -> 'sources') AS source;
  IF v_source_distinct_count <> v_source_count THEN
    RETURN false;
  END IF;

  FOR v_destination IN
    SELECT value FROM jsonb_array_elements(v_proposal -> 'destinations')
  LOOP
    IF jsonb_typeof(v_destination) IS DISTINCT FROM 'object'
       OR v_destination ->> 'kind' NOT IN ('existing', 'new') THEN
      RETURN false;
    END IF;
    IF v_destination ->> 'kind' = 'existing' THEN
      IF NOT v_destination ?& ARRAY['kind', 'agentId', 'desiredCharter']
         OR v_destination - ARRAY['kind', 'agentId', 'desiredCharter']
              <> '{}'::jsonb
         OR v_destination ->> 'agentId'
              !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         OR NOT agentos.valid_second_mate_charter(
           v_destination -> 'desiredCharter'
         ) THEN
        RETURN false;
      END IF;
    ELSE
      IF NOT v_destination ?& ARRAY[
           'kind', 'handle', 'displayName', 'desiredCharter'
         ]
         OR v_destination - ARRAY[
           'kind', 'handle', 'displayName', 'desiredCharter'
         ] <> '{}'::jsonb
         OR length(v_destination ->> 'handle') > 55
         OR v_destination ->> 'handle'
              !~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
         OR nullif(btrim(v_destination ->> 'displayName'), '') IS NULL
         OR length(v_destination ->> 'displayName') > 128
         OR NOT agentos.valid_second_mate_charter(
           v_destination -> 'desiredCharter'
         ) THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;

  SELECT count(DISTINCT CASE
         WHEN destination ->> 'kind' = 'existing'
             THEN 'existing:' || (destination ->> 'agentId')
           ELSE 'new:' || (destination ->> 'handle')
         END),
         count(*) FILTER (WHERE destination ->> 'kind' = 'existing'),
         count(*) FILTER (WHERE destination ->> 'kind' = 'new')
    INTO v_destination_distinct_count, v_existing_count, v_new_count
    FROM jsonb_array_elements(v_proposal -> 'destinations') AS destination;
  IF v_destination_distinct_count <> v_destination_count THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(v_proposal -> 'reasons') AS reason
     WHERE reason NOT IN (
       'persistent_load', 'routing_ambiguity', 'charter_overlap',
       'cross_domain_escalation', 'dependency_coupling', 'repeated_failure',
       'capacity_pressure', 'cost_pressure', 'durable_idle',
       'delivery_degradation', 'captain_direction'
     )
  ) THEN
    RETURN false;
  END IF;
  SELECT count(DISTINCT reason)
    INTO v_reason_distinct_count
    FROM jsonb_array_elements_text(v_proposal -> 'reasons') AS reason;
  IF v_reason_distinct_count <> v_reason_count THEN
    RETURN false;
  END IF;

  FOR v_signal IN
    SELECT value FROM jsonb_array_elements(v_proposal -> 'signals')
  LOOP
    IF jsonb_typeof(v_signal) IS DISTINCT FROM 'object'
       OR NOT v_signal ?& ARRAY['authority', 'kind', 'observation', 'trend']
       OR v_signal - ARRAY['authority', 'kind', 'observation', 'trend']
            <> '{}'::jsonb
       OR v_signal ->> 'authority' NOT IN (
         'postgresql', 'kubernetes', 'herdr', 'otel'
       )
       OR v_signal ->> 'kind' NOT IN (
         'assignment_load', 'backlog_load', 'routing_ambiguity',
         'handoff_frequency', 'cross_domain_escalation',
         'dependency_coupling', 'failure_rate', 'capacity_headroom',
         'cost_pressure', 'idle_duration', 'delivery_health'
       )
       OR v_signal ->> 'observation' NOT IN ('observed', 'unobserved')
       OR v_signal ->> 'trend' NOT IN (
         'rising', 'stable', 'falling', 'degrading', 'improving', 'unknown'
       ) THEN
      RETURN false;
    END IF;
  END LOOP;
  SELECT count(DISTINCT
           (signal ->> 'authority') || ':' || (signal ->> 'kind')
         ),
         count(*) FILTER (
           WHERE signal ->> 'authority' <> 'otel'
             AND signal ->> 'observation' = 'observed'
         )
    INTO v_signal_distinct_count, v_observed_authority_count
    FROM jsonb_array_elements(v_proposal -> 'signals') AS signal;
  IF v_signal_distinct_count <> v_signal_count
     OR v_observed_authority_count = 0 THEN
    RETURN false;
  END IF;

  IF v_action IN ('expand', 'modify', 'shrink') THEN
    IF v_source_count <> 1 OR v_destination_count <> 1
       OR v_existing_count <> 1
       OR v_proposal #>> '{sources,0,agentId}'
            IS DISTINCT FROM v_proposal #>> '{destinations,0,agentId}'
       OR v_proposal #> '{sources,0,expectedCharter}'
            IS NOT DISTINCT FROM v_proposal #> '{destinations,0,desiredCharter}' THEN
      RETURN false;
    END IF;
  ELSIF v_action = 'split' THEN
    IF v_source_count <> 1 OR v_destination_count <> 2
       OR v_existing_count <> 1 OR v_new_count <> 1
       OR NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(v_proposal -> 'destinations') AS destination
          WHERE destination ->> 'kind' = 'existing'
            AND destination ->> 'agentId'
                  = v_proposal #>> '{sources,0,agentId}'
            AND destination -> 'desiredCharter'
                  IS DISTINCT FROM v_proposal #> '{sources,0,expectedCharter}'
       ) THEN
      RETURN false;
    END IF;
  ELSIF v_action = 'merge' THEN
    IF v_source_count <> 2 OR v_destination_count <> 1
       OR v_existing_count <> 1
       OR NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(v_proposal -> 'sources') AS source
          WHERE source ->> 'agentId'
                = v_proposal #>> '{destinations,0,agentId}'
       ) THEN
      RETURN false;
    END IF;
  ELSIF v_action = 'retire' THEN
    IF v_source_count <> 1 OR v_destination_count <> 0 THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION agentos.valid_second_mate_topology_plan(jsonb) IS
  'Validates the closed, privacy-safe, anti-silo Second Mate topology plan compiled by AgentOS Effect code.';

REVOKE ALL ON FUNCTION agentos.valid_second_mate_charter(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.valid_second_mate_topology_plan(jsonb) FROM PUBLIC;

CREATE TABLE agentos.second_mate_topology_transitions (
  proposal_id uuid PRIMARY KEY,
  decision_id uuid NOT NULL UNIQUE
    REFERENCES agentos.inbox(id) ON DELETE RESTRICT,
  applied_by_agent_id uuid NOT NULL
    REFERENCES agentos.agents(id) ON DELETE RESTRICT,
  action text NOT NULL
    CHECK (action IN ('expand', 'modify', 'shrink', 'split', 'merge', 'retire')),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  plan jsonb NOT NULL CHECK (agentos.valid_second_mate_topology_plan(plan)),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  status_text text NOT NULL CHECK (length(btrim(status_text)) > 0),
  applied_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (digest = plan ->> 'digest'),
  CHECK (proposal_id::text = plan #>> '{proposal,proposalId}'),
  CHECK (action = plan #>> '{proposal,action}')
);

COMMENT ON TABLE agentos.second_mate_topology_transitions IS
  'Immutable applied topology history; Captain authority remains in Inbox and live runtime state remains in Kubernetes and Herdr.';

CREATE FUNCTION agentos.protect_second_mate_topology_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = agentos, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'applied Second Mate topology transitions are immutable; create a new proposal';
END;
$$;

CREATE TRIGGER second_mate_topology_transitions_no_update
BEFORE UPDATE ON agentos.second_mate_topology_transitions
FOR EACH ROW EXECUTE FUNCTION agentos.protect_second_mate_topology_transition();
CREATE TRIGGER second_mate_topology_transitions_no_delete
BEFORE DELETE ON agentos.second_mate_topology_transitions
FOR EACH ROW EXECUTE FUNCTION agentos.prevent_hard_delete();

ALTER TABLE agentos.second_mate_topology_transitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY second_mate_topology_transitions_registered_read
ON agentos.second_mate_topology_transitions
FOR SELECT
USING (agentos.current_agent_id() IS NOT NULL);

CREATE UNIQUE INDEX inbox_second_mate_topology_proposal_idx
ON agentos.inbox ((metadata #>> '{second_mate_topology,plan,proposal,proposalId}'))
WHERE kind = 'captain_decision'
  AND metadata #> '{second_mate_topology,version}' = '1'::jsonb;

CREATE FUNCTION agentos.hold_second_mate_topology_decision(
  p_task_id uuid,
  p_plan jsonb,
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
    'second_mate_topology',
    jsonb_build_object('version', 1, 'plan', p_plan)
  );
BEGIN
  IF v_actor_id IS NULL OR agentos.current_agent_role() <> 'first_mate'
     OR NOT agentos.can_manage_task(p_task_id)
     OR NOT EXISTS (
       SELECT 1
         FROM agentos.tasks AS task
        WHERE task.id = p_task_id
          AND task.completed_at IS NULL
          AND task.archived_at IS NULL
     )
     OR NOT EXISTS (
       SELECT 1
         FROM agentos.task_assignments AS assignment
        WHERE assignment.task_id = p_task_id
     ) THEN
    RAISE EXCEPTION
      'Second Mate topology decision creation requires the owning First Mate and a managed accepted Task';
  END IF;
  IF NOT agentos.valid_second_mate_topology_plan(p_plan)
     OR p_plan #>> '{proposal,proposedByAgentId}' IS DISTINCT FROM v_actor_id::text THEN
    RAISE EXCEPTION
      'Second Mate topology decision requires a valid plan proposed by the owning First Mate';
  END IF;
  IF p_decision_key IS NULL
     OR p_decision_key !~ '^[a-z0-9][a-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION
      'Second Mate topology decision key must be stable, privacy-safe and at most 128 characters';
  END IF;
  IF p_subject IS NULL OR length(btrim(p_subject)) = 0
     OR p_body IS NULL OR length(btrim(p_body)) = 0
     OR p_status_text IS NULL OR length(btrim(p_status_text)) = 0 THEN
    RAISE EXCEPTION
      'Second Mate topology decision requires subject, body and status text';
  END IF;

  SELECT delivery.*
    INTO v_existing
    FROM agentos.inbox AS delivery
   WHERE delivery.decision_key = p_decision_key
   ORDER BY delivery.created_at, delivery.id
   LIMIT 1;
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
      'Second Mate topology decision key conflicts with an existing decision';
  END IF;

  IF (p_plan #>> '{proposal,validUntilMillis}')::bigint
       <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN
    RAISE EXCEPTION
      'Second Mate topology decision requires a current plan';
  END IF;

  INSERT INTO agentos.inbox (
    sender_agent_id, sender_label, recipient_agent_id, task_id, kind,
    subject, body, decision_key, status, status_text, metadata
  ) VALUES (
    v_actor_id, agentos.current_agent_handle(), v_actor_id, p_task_id,
    'captain_decision', btrim(p_subject), btrim(p_body), p_decision_key,
    'awaiting_captain', btrim(p_status_text), v_metadata
  ) RETURNING id INTO v_id;

  UPDATE agentos.tasks
     SET dependencies = CASE
           WHEN dependencies @> jsonb_build_array(jsonb_build_object(
             'kind', 'captain_decision', 'decision_key', p_decision_key
           )) THEN dependencies
           ELSE dependencies || jsonb_build_array(jsonb_build_object(
             'kind', 'captain_decision', 'decision_key', p_decision_key
           ))
         END,
         status_text = btrim(p_status_text)
   WHERE id = p_task_id;
  RETURN v_id;
END;
$$;

CREATE FUNCTION agentos.resolve_second_mate_topology_decision(
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
    'second_mate_topology_approval',
    jsonb_build_object('version', 1, 'approved', p_approved)
  );
  v_decision agentos.inbox%ROWTYPE;
BEGIN
  IF v_actor_id IS NULL OR agentos.current_agent_role() <> 'first_mate' THEN
    RAISE EXCEPTION
      'Second Mate topology decision resolution requires the owning First Mate';
  END IF;
  IF p_approved IS NULL
     OR p_answer IS NULL OR length(btrim(p_answer)) = 0
     OR p_status_text IS NULL OR length(btrim(p_status_text)) = 0 THEN
    RAISE EXCEPTION
      'Second Mate topology decision resolution requires explicit approval, exact answer and status text';
  END IF;

  SELECT decision.* INTO v_decision
    FROM agentos.inbox AS decision
   WHERE decision.id = p_decision_id
     AND decision.kind = 'captain_decision'
     AND decision.metadata #> '{second_mate_topology,version}' = '1'::jsonb
   FOR UPDATE;
  IF NOT FOUND
     OR v_decision.sender_agent_id IS DISTINCT FROM v_actor_id
     OR v_decision.recipient_agent_id IS DISTINCT FROM v_actor_id
     OR v_decision.task_id IS NULL
     OR NOT agentos.can_manage_task(v_decision.task_id) THEN
    RAISE EXCEPTION
      'Second Mate topology decision resolution requires an owned typed decision';
  END IF;

  IF v_decision.resolved_at IS NOT NULL THEN
    SELECT answer.id INTO v_answer_id
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
      'Second Mate topology decision is already resolved with a different answer or approval';
  END IF;

  INSERT INTO agentos.inbox (
    sender_agent_id, sender_label, recipient_agent_id, task_id, reply_to_id,
    kind, subject, body, status, status_text, metadata, resolved_at
  ) VALUES (
    NULL, 'Captain', v_decision.recipient_agent_id, v_decision.task_id,
    p_decision_id, 'captain_decision_answer', v_decision.subject,
    btrim(p_answer), 'resolved', btrim(p_status_text), v_answer_metadata,
    transaction_timestamp()
  ) RETURNING id INTO v_answer_id;

  UPDATE agentos.inbox
     SET status = 'resolved', status_text = btrim(p_status_text),
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
   WHERE task.id = v_decision.task_id;
  RETURN v_answer_id;
END;
$$;

CREATE FUNCTION agentos.apply_second_mate_topology_decision(
  p_decision_id uuid,
  p_status_text text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_action text;
  v_actor_id uuid := agentos.current_agent_id();
  v_applied agentos.second_mate_topology_transitions%ROWTYPE;
  v_decision agentos.inbox%ROWTYPE;
  v_destination jsonb;
  v_existing_destination jsonb;
  v_new_agent_id uuid;
  v_new_destination jsonb;
  v_plan jsonb;
  v_proposal jsonb;
  v_result jsonb;
  v_source jsonb;
  v_source_agent agentos.agents%ROWTYPE;
  v_source_ids jsonb;
  v_survivor_id uuid;
BEGIN
  IF v_actor_id IS NULL OR agentos.current_agent_role() <> 'first_mate'
     OR p_status_text IS NULL OR length(btrim(p_status_text)) = 0 THEN
    RAISE EXCEPTION
      'applying Second Mate topology requires the owning First Mate and status text';
  END IF;

  SELECT decision.* INTO v_decision
    FROM agentos.inbox AS decision
   WHERE decision.id = p_decision_id
     AND decision.kind = 'captain_decision'
     AND decision.metadata #> '{second_mate_topology,version}' = '1'::jsonb
   FOR UPDATE;
  IF NOT FOUND
     OR v_decision.sender_agent_id IS DISTINCT FROM v_actor_id
     OR v_decision.recipient_agent_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'topology application requires an owned typed decision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agentos.inbox AS answer
     WHERE answer.reply_to_id = p_decision_id
       AND answer.kind = 'captain_decision_answer'
       AND answer.sender_agent_id IS NULL
       AND answer.sender_label = 'Captain'
       AND answer.metadata #> '{second_mate_topology_approval,version}' = '1'::jsonb
       AND answer.metadata #> '{second_mate_topology_approval,approved}' = 'true'::jsonb
  ) THEN
    RAISE EXCEPTION 'topology application requires explicit Captain approval';
  END IF;

  v_plan := v_decision.metadata #> '{second_mate_topology,plan}';
  IF NOT agentos.valid_second_mate_topology_plan(v_plan) THEN
    RAISE EXCEPTION 'topology decision contains an invalid plan';
  END IF;
  v_proposal := v_plan -> 'proposal';
  v_action := v_proposal ->> 'action';

  SELECT transition.* INTO v_applied
    FROM agentos.second_mate_topology_transitions AS transition
   WHERE transition.proposal_id = (v_proposal ->> 'proposalId')::uuid;
  IF FOUND THEN
    IF v_applied.decision_id = p_decision_id
       AND v_applied.digest = v_plan ->> 'digest'
       AND v_applied.plan IS NOT DISTINCT FROM v_plan THEN
      RETURN v_applied.result;
    END IF;
    RAISE EXCEPTION 'topology proposal conflicts with an applied transition';
  END IF;

  IF (v_proposal ->> 'validUntilMillis')::bigint
       <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN
    RAISE EXCEPTION 'topology plan expired before application';
  END IF;

  FOR v_source IN
    SELECT value FROM jsonb_array_elements(v_proposal -> 'sources')
  LOOP
    SELECT agent.* INTO v_source_agent
      FROM agentos.agents AS agent
     WHERE agent.id = (v_source ->> 'agentId')::uuid
       AND agent.role = 'second_mate'
       AND agent.parent_agent_id = v_actor_id
       AND agent.retired_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'topology source must be an active direct Second Mate of the owning First Mate';
    END IF;
    IF v_source_agent.metadata -> 'charter'
         IS DISTINCT FROM v_source -> 'expectedCharter' THEN
      RAISE EXCEPTION 'topology source has a stale charter';
    END IF;
  END LOOP;

  SELECT coalesce(jsonb_agg(source ->> 'agentId' ORDER BY source ->> 'agentId'), '[]'::jsonb)
    INTO v_source_ids
    FROM jsonb_array_elements(v_proposal -> 'sources') AS source;

  IF v_action IN ('expand', 'modify', 'shrink') THEN
    v_destination := v_proposal #> '{destinations,0}';
    UPDATE agentos.agents
       SET metadata = jsonb_set(
             jsonb_set(metadata, '{charter}', v_destination -> 'desiredCharter', true),
             '{topology_change}',
             jsonb_build_object(
               'version', 1, 'proposalId', v_proposal ->> 'proposalId',
               'digest', v_plan ->> 'digest', 'action', v_action
             ), true
           ),
           status_text = btrim(p_status_text)
     WHERE id = (v_destination ->> 'agentId')::uuid;
    v_result := jsonb_build_object(
      'version', 1, 'proposalId', v_proposal ->> 'proposalId',
      'action', v_action, 'sourceAgentIds', v_source_ids,
      'destinationAgentIds', jsonb_build_array(v_destination ->> 'agentId')
    );
  ELSIF v_action = 'split' THEN
    SELECT destination INTO v_existing_destination
      FROM jsonb_array_elements(v_proposal -> 'destinations') AS destination
     WHERE destination ->> 'kind' = 'existing';
    SELECT destination INTO v_new_destination
      FROM jsonb_array_elements(v_proposal -> 'destinations') AS destination
     WHERE destination ->> 'kind' = 'new';
    SELECT agent.* INTO v_source_agent
      FROM agentos.agents AS agent
     WHERE agent.id = (v_existing_destination ->> 'agentId')::uuid;
    UPDATE agentos.agents
       SET metadata = jsonb_set(
             jsonb_set(metadata, '{charter}',
               v_existing_destination -> 'desiredCharter', true),
             '{topology_change}', jsonb_build_object(
               'version', 1, 'proposalId', v_proposal ->> 'proposalId',
               'digest', v_plan ->> 'digest', 'action', v_action
             ), true
           ),
           status_text = btrim(p_status_text)
     WHERE id = v_source_agent.id;
    v_new_agent_id := agentos.provision_agent(
      v_new_destination ->> 'handle', 'second_mate', v_source_agent.harness,
      btrim(p_status_text), v_new_destination ->> 'displayName',
      jsonb_build_object(
        'charter', v_new_destination -> 'desiredCharter',
        'topology_origin', jsonb_build_object(
          'version', 1, 'proposalId', v_proposal ->> 'proposalId',
          'digest', v_plan ->> 'digest', 'action', v_action
        )
      )
    );
    v_result := jsonb_build_object(
      'version', 1, 'proposalId', v_proposal ->> 'proposalId',
      'action', v_action, 'sourceAgentIds', v_source_ids,
      'destinationAgentIds', jsonb_build_array(
        v_existing_destination ->> 'agentId', v_new_agent_id::text
      )
    );
  ELSIF v_action = 'merge' THEN
    v_destination := v_proposal #> '{destinations,0}';
    v_survivor_id := (v_destination ->> 'agentId')::uuid;
    UPDATE agentos.agents
       SET metadata = jsonb_set(
             jsonb_set(metadata, '{charter}', v_destination -> 'desiredCharter', true),
             '{topology_change}', jsonb_build_object(
               'version', 1, 'proposalId', v_proposal ->> 'proposalId',
               'digest', v_plan ->> 'digest', 'action', v_action
             ), true
           ),
           status_text = btrim(p_status_text)
     WHERE id = v_survivor_id;
    FOR v_source IN
      SELECT value FROM jsonb_array_elements(v_proposal -> 'sources')
    LOOP
      IF (v_source ->> 'agentId')::uuid <> v_survivor_id THEN
        UPDATE agentos.agents
           SET metadata = jsonb_set(
                 metadata, '{topology_change}', jsonb_build_object(
                   'version', 1, 'proposalId', v_proposal ->> 'proposalId',
                   'digest', v_plan ->> 'digest', 'action', v_action,
                   'survivorAgentId', v_survivor_id::text
                 ), true
               )
         WHERE id = (v_source ->> 'agentId')::uuid;
        PERFORM agentos.retire_agent(
          (v_source ->> 'agentId')::uuid, btrim(p_status_text)
        );
      END IF;
    END LOOP;
    v_result := jsonb_build_object(
      'version', 1, 'proposalId', v_proposal ->> 'proposalId',
      'action', v_action, 'sourceAgentIds', v_source_ids,
      'destinationAgentIds', jsonb_build_array(v_survivor_id::text)
    );
  ELSE
    v_source := v_proposal #> '{sources,0}';
    UPDATE agentos.agents
       SET metadata = jsonb_set(
             metadata, '{topology_change}', jsonb_build_object(
               'version', 1, 'proposalId', v_proposal ->> 'proposalId',
               'digest', v_plan ->> 'digest', 'action', v_action
             ), true
           )
     WHERE id = (v_source ->> 'agentId')::uuid;
    PERFORM agentos.retire_agent(
      (v_source ->> 'agentId')::uuid, btrim(p_status_text)
    );
    v_result := jsonb_build_object(
      'version', 1, 'proposalId', v_proposal ->> 'proposalId',
      'action', v_action, 'sourceAgentIds', v_source_ids,
      'destinationAgentIds', '[]'::jsonb
    );
  END IF;

  INSERT INTO agentos.second_mate_topology_transitions (
    proposal_id, decision_id, applied_by_agent_id, action, digest, plan,
    result, status_text
  ) VALUES (
    (v_proposal ->> 'proposalId')::uuid, p_decision_id, v_actor_id, v_action,
    v_plan ->> 'digest', v_plan, v_result, btrim(p_status_text)
  );
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION agentos.hold_second_mate_topology_decision(
  uuid, jsonb, text, text, text, text
) IS
  'Creates one exact Captain decision for a validated topology plan; the decision alone grants no authority.';
COMMENT ON FUNCTION agentos.resolve_second_mate_topology_decision(
  uuid, boolean, text, text
) IS
  'Records the explicit Captain approval or rejection of one typed topology plan.';
COMMENT ON FUNCTION agentos.apply_second_mate_topology_decision(uuid, text) IS
  'Atomically applies one approved, current, safe topology plan and appends immutable transition history.';

REVOKE ALL ON FUNCTION agentos.hold_second_mate_topology_decision(
  uuid, jsonb, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.resolve_second_mate_topology_decision(
  uuid, boolean, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.apply_second_mate_topology_decision(uuid, text)
  FROM PUBLIC;

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
    EXECUTE format(
      'REVOKE ALL ON TABLE agentos.second_mate_topology_transitions FROM %I',
      v_agent.database_role
    );
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION agentos.hold_second_mate_topology_decision(uuid, jsonb, text, text, text, text), agentos.resolve_second_mate_topology_decision(uuid, boolean, text, text), agentos.apply_second_mate_topology_decision(uuid, text) FROM %I',
      v_agent.database_role
    );
    IF v_agent.role = 'first_mate' THEN
      EXECUTE format(
        'GRANT SELECT ON agentos.second_mate_topology_transitions TO %I',
        v_agent.database_role
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION agentos.hold_second_mate_topology_decision(uuid, jsonb, text, text, text, text), agentos.resolve_second_mate_topology_decision(uuid, boolean, text, text), agentos.apply_second_mate_topology_decision(uuid, text) TO %I',
        v_agent.database_role
      );
    END IF;
  END LOOP;
END;
$$;

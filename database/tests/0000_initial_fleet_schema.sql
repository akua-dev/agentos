BEGIN;

DO $$
DECLARE
  v_first_mate_id uuid := gen_random_uuid();
  v_second_mate_id uuid := gen_random_uuid();
  v_project_id uuid := gen_random_uuid();
  v_task_id uuid := gen_random_uuid();
  v_inbox_id uuid := gen_random_uuid();
  v_first_event_id bigint;
  v_duplicate_event_id bigint;
  v_second_event_id bigint;
  v_third_event_id bigint;
  v_fourth_event_id bigint;
  v_batch_id uuid;
  v_claim record;
  v_refresh record;
  v_expired_claim record;
  v_replacement_claim record;
  v_failed boolean;
  v_revision bigint;
BEGIN
  INSERT INTO agentos.agents (
    id,
    handle,
    role,
    harness,
    lifecycle_status,
    status_text
  ) VALUES (
    v_first_mate_id,
    'test-first-mate',
    'first_mate',
    'pi',
    'active',
    'Ready for schema verification'
  );

  INSERT INTO agentos.agents (
    id,
    handle,
    role,
    parent_agent_id,
    harness,
    lifecycle_status,
    status_text
  ) VALUES (
    v_second_mate_id,
    'test-second-mate',
    'second_mate',
    v_first_mate_id,
    'pi',
    'active',
    'Ready for schema verification'
  );

  INSERT INTO agentos.projects (
    id,
    name,
    scope_text,
    status,
    status_text
  ) VALUES (
    v_project_id,
    'schema-verification',
    'Verify the initial AgentOS database contract',
    'active',
    'Test project is active'
  );

  INSERT INTO agentos.tasks (
    id,
    project_id,
    created_by_agent_id,
    title,
    status,
    status_text,
    external_links
  ) VALUES (
    v_task_id,
    v_project_id,
    v_first_mate_id,
    'Reconcile GitHub issue 42',
    'active',
    'Waiting for external events',
    '[{"provider":"github","resource":"issue","external_id":"42"}]'::jsonb
  );

  UPDATE agentos.tasks
     SET status_text = 'Task update exercises automatic revisioning'
   WHERE id = v_task_id
  RETURNING revision INTO v_revision;

  IF v_revision <> 2 THEN
    RAISE EXCEPTION 'task revision trigger returned %, expected 2', v_revision;
  END IF;

  INSERT INTO agentos.inbox (
    id,
    sender_agent_id,
    sender_label,
    recipient_agent_id,
    task_id,
    kind,
    body,
    status,
    status_text,
    read_at
  ) VALUES (
    v_inbox_id,
    v_first_mate_id,
    'test-first-mate',
    v_second_mate_id,
    v_task_id,
    'request',
    'Please inspect the linked issue.',
    'read',
    'Recipient read the delivery',
    transaction_timestamp()
  );

  v_failed := false;
  BEGIN
    UPDATE agentos.inbox
       SET body = 'Silently rewritten after first read.'
     WHERE id = v_inbox_id;
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'read inbox content was mutable';
  END IF;

  v_first_event_id := agentos.ingest_external_event(
    'github',
    'delivery-1',
    'issues.closed',
    'repo:akua/agentos:issue:42',
    '{"action":"closed","issue":{"number":42}}'::jsonb,
    'captain',
    '{}'::jsonb,
    interval '1 millisecond',
    interval '30 seconds'
  );

  v_duplicate_event_id := agentos.ingest_external_event(
    'github',
    'delivery-1',
    'issues.closed',
    'repo:akua/agentos:issue:42',
    '{"action":"closed","issue":{"number":42}}'::jsonb,
    'captain',
    '{}'::jsonb,
    interval '1 millisecond',
    interval '30 seconds'
  );

  IF v_duplicate_event_id <> v_first_event_id THEN
    RAISE EXCEPTION 'duplicate delivery created another event';
  END IF;

  v_second_event_id := agentos.ingest_external_event(
    'github',
    'delivery-2',
    'issue_comment.created',
    'repo:akua/agentos:issue:42',
    '{"action":"created","comment":{"body":"Please reopen this."}}'::jsonb,
    'captain',
    '{}'::jsonb,
    interval '1 millisecond',
    interval '30 seconds'
  );

  SELECT e.batch_id
    INTO v_batch_id
    FROM agentos.external_events AS e
   WHERE e.id = v_first_event_id;

  IF NOT EXISTS (
    SELECT 1
      FROM agentos.external_events AS e
     WHERE e.id = v_second_event_id
       AND e.batch_id = v_batch_id
  ) THEN
    RAISE EXCEPTION 'related deliveries did not coalesce into one burst';
  END IF;

  PERFORM pg_sleep(0.01);

  SELECT *
    INTO v_claim
    FROM agentos.claim_external_events(
      v_first_mate_id,
      'github',
      'repo:akua/agentos:issue:42',
      interval '5 minutes'
    );

  IF v_claim.claimed_token IS NULL OR v_claim.event_count <> 2 THEN
    RAISE EXCEPTION 'expected a two-event claim, received %', row_to_json(v_claim);
  END IF;

  v_third_event_id := agentos.ingest_external_event(
    'github',
    'delivery-3',
    'issues.reopened',
    'repo:akua/agentos:issue:42',
    '{"action":"reopened","issue":{"number":42}}'::jsonb,
    'captain',
    '{}'::jsonb,
    interval '1 millisecond',
    interval '30 seconds'
  );

  v_failed := false;
  BEGIN
    PERFORM * FROM agentos.assert_external_event_claim_current(
      v_first_mate_id,
      v_claim.claimed_token
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'a claim remained current after a newer related event';
  END IF;

  SELECT *
    INTO v_refresh
    FROM agentos.refresh_external_event_claim(
      v_first_mate_id,
      v_claim.claimed_token,
      interval '5 minutes'
    );

  IF v_refresh.absorbed_event_count <> 1 OR
     v_refresh.high_water_event_id <> v_third_event_id THEN
    RAISE EXCEPTION 'claim refresh did not absorb the newest event: %', row_to_json(v_refresh);
  END IF;

  PERFORM * FROM agentos.assert_external_event_claim_current(
    v_first_mate_id,
    v_claim.claimed_token
  );

  UPDATE agentos.tasks
     SET status = 'active',
         status_text = 'Issue was reopened after reviewing the complete event set'
   WHERE id = v_task_id;

  UPDATE agentos.inbox
     SET status = 'resolved',
         status_text = 'The related external event batch was reconciled',
         resolved_at = transaction_timestamp()
   WHERE id = v_inbox_id;

  IF agentos.complete_external_event_claim(
       v_first_mate_id,
       v_claim.claimed_token,
       '{"outcome":"task-and-inbox-updated"}'::jsonb
     ) <> 3 THEN
    RAISE EXCEPTION 'completion did not reconcile all three related events';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM agentos.external_events AS e
     WHERE e.provider = 'github'
       AND e.coalesce_key = 'repo:akua/agentos:issue:42'
       AND e.reconciliation_status <> 'reconciled'
  ) THEN
    RAISE EXCEPTION 'completion left unresolved external events';
  END IF;

  v_fourth_event_id := agentos.ingest_external_event(
    'github',
    'delivery-4',
    'issues.closed',
    'repo:akua/agentos:issue:99',
    '{"action":"closed","issue":{"number":99}}'::jsonb,
    'captain',
    '{}'::jsonb,
    interval '1 millisecond',
    interval '30 seconds'
  );

  PERFORM pg_sleep(0.01);

  SELECT *
    INTO v_expired_claim
    FROM agentos.claim_external_events(
      v_first_mate_id,
      'github',
      'repo:akua/agentos:issue:99',
      interval '1 millisecond'
    );

  PERFORM pg_sleep(0.01);

  SELECT *
    INTO v_replacement_claim
    FROM agentos.claim_external_events(
      v_second_mate_id,
      'github',
      'repo:akua/agentos:issue:99',
      interval '5 minutes'
    );

  IF v_expired_claim.claimed_token IS NULL OR
     v_replacement_claim.claimed_token IS NULL OR
     v_expired_claim.claimed_token = v_replacement_claim.claimed_token THEN
    RAISE EXCEPTION 'expired claim was not fenced by a replacement claim';
  END IF;

  v_failed := false;
  BEGIN
    PERFORM agentos.complete_external_event_claim(
      v_first_mate_id,
      v_expired_claim.claimed_token,
      '{"outcome":"stale-owner"}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'expired owner completed a fenced claim';
  END IF;

  IF agentos.complete_external_event_claim(
       v_second_mate_id,
       v_replacement_claim.claimed_token,
       '{"outcome":"recovered-after-expiry"}'::jsonb
     ) <> 1 THEN
    RAISE EXCEPTION 'replacement owner did not reconcile event %', v_fourth_event_id;
  END IF;
END;
$$;

ROLLBACK;

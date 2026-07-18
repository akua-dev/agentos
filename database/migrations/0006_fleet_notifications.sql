CREATE FUNCTION agentos.notify_fleet_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_notify(
    'agentos_events',
    jsonb_build_object(
      'version', 1,
      'table', TG_TABLE_NAME,
      'operation', lower(TG_OP)
    )::text
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION agentos.notify_fleet_change() FROM PUBLIC;

CREATE TRIGGER notify_agentos_events_agents
AFTER INSERT OR UPDATE ON agentos.agents
FOR EACH ROW EXECUTE FUNCTION agentos.notify_fleet_change();

CREATE TRIGGER notify_agentos_events_captain
AFTER INSERT OR UPDATE ON agentos.captain
FOR EACH ROW EXECUTE FUNCTION agentos.notify_fleet_change();

CREATE TRIGGER notify_agentos_events_tasks
AFTER INSERT OR UPDATE ON agentos.tasks
FOR EACH ROW EXECUTE FUNCTION agentos.notify_fleet_change();

CREATE TRIGGER notify_agentos_events_task_assignments
AFTER INSERT OR UPDATE ON agentos.task_assignments
FOR EACH ROW EXECUTE FUNCTION agentos.notify_fleet_change();

CREATE TRIGGER notify_agentos_events_inbox
AFTER INSERT OR UPDATE ON agentos.inbox
FOR EACH ROW EXECUTE FUNCTION agentos.notify_fleet_change();

CREATE TRIGGER notify_agentos_events_external_events
AFTER INSERT OR UPDATE ON agentos.external_events
FOR EACH ROW EXECUTE FUNCTION agentos.notify_fleet_change();

COMMENT ON FUNCTION agentos.notify_fleet_change() IS
  'Emits small transactional wake hints; durable Fleet rows remain authoritative.';

COMMENT ON POLICY inbox_authentic_insert ON agentos.inbox IS
  'Authenticates the Agent sender and label. The inbox_enforce_hierarchy_edge Trigger owns recipient topology for every Agent-authored delivery, including Fleet-owner writes.';

CREATE FUNCTION agentos.enforce_inbox_hierarchy_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF NEW.sender_agent_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.sender_agent_id IS DISTINCT FROM agentos.current_agent_id()
     OR NEW.sender_label IS DISTINCT FROM agentos.current_agent_handle() THEN
    RAISE EXCEPTION 'Inbox delivery requires the authenticated Agent identity';
  END IF;

  IF NEW.sender_agent_id = NEW.recipient_agent_id
     AND NEW.kind = 'captain_decision' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM agentos.agents AS sender
      JOIN agentos.agents AS recipient
        ON recipient.id = NEW.recipient_agent_id
     WHERE sender.id = NEW.sender_agent_id
       AND sender.retired_at IS NULL
       AND recipient.retired_at IS NULL
       AND (
         sender.parent_agent_id = recipient.id
         OR recipient.parent_agent_id = sender.id
       )
  ) THEN
    RAISE EXCEPTION 'Inbox delivery requires one direct parent-child hierarchy edge';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION agentos.enforce_inbox_hierarchy_edge() FROM PUBLIC;

CREATE TRIGGER inbox_enforce_hierarchy_edge
BEFORE INSERT ON agentos.inbox
FOR EACH ROW EXECUTE FUNCTION agentos.enforce_inbox_hierarchy_edge();

COMMENT ON FUNCTION agentos.enforce_inbox_hierarchy_edge() IS
  'Protects hierarchy-edge Inbox routing even for the Fleet-owner Agent; released Captain-decision Functions retain their intentional self-addressed or Captain-authored rows.';

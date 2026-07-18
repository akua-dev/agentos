ALTER TABLE agentos.inbox
  DROP CONSTRAINT inbox_kind_check,
  ADD CONSTRAINT inbox_kind_check CHECK (
    kind IN (
      'answer',
      'approval',
      'approval_request',
      'captain_decision',
      'captain_decision_answer',
      'escalation',
      'notification',
      'question',
      'request'
    )
  );

COMMENT ON COLUMN agentos.inbox.kind IS
  'Closed durable speech-act vocabulary: request, question, answer, approval_request, approval, notification, escalation, captain_decision and captain_decision_answer.';

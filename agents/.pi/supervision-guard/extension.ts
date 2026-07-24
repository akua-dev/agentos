import type {
  ExtensionAPI,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

const MESSAGE_TYPE = "agentos-supervision-guard";
const RECOVERY_MESSAGE_TYPE = "agentos-supervision-recovery";
const COMPLETION_MESSAGE_TYPE = "agentos-background-command-completion";
const SUPERVISION_MARKER = "[agentos-supervision]";
const REMINDER = [
  `TURN WOULD END BLIND — Pi does not know a running background command whose useful description contains ${SUPERVISION_MARKER}.`,
  "Reconcile with $agentos-supervision and arm or re-arm the tagged continuity wait. Use list_background_commands only when current task state is uncertain.",
  "You are responsible for choosing, verifying, and re-arming the useful native supervision waits; this guard never launches commands or proves that a running command is semantically useful.",
].join("\n");
const RECOVERY = [
  "MATE SESSION RECOVERY — background commands do not survive a Pi runtime restart.",
  'Inspect persisted recovery candidates with list_background_commands with state "interrupted"; their command metadata is a hint, not authority and not permission to replay it.',
  `You are responsible for reconciling authoritative state with $agentos-supervision, then choosing and arming a continuity wait whose useful description contains ${SUPERVISION_MARKER}.`,
  "This recovery guard has not selected or launched a command.",
].join("\n");

export function registerAgentosSupervisionGuard(pi: ExtensionAPI) {
  if (supervisionGuardDisabled()) return;

  const taggedRunningTaskIds = new Set<string>();
  let reminderFollowUpActive = false;
  let sessionStartChecked = false;

  pi.on("session_start", async (_event, context) => {
    if (sessionStartChecked) return;
    sessionStartChecked = true;
    if (!context.isIdle()) return;

    try {
      await pi.sendMessage(
        {
          customType: RECOVERY_MESSAGE_TYPE,
          content: RECOVERY,
          display: true,
          details: {},
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      sessionStartChecked = false;
    }
  });

  pi.on("tool_result", (event) => {
    if (event.isError) return;
    if (event.toolName === "list_background_commands") {
      reconcileTaggedTasks(taggedRunningTaskIds, event);
      return;
    }
    if (
      event.toolName === "run_background_command" ||
      event.toolName === "get_background_command_output" ||
      event.toolName === "kill_background_command"
    ) {
      observeTaskSnapshot(taggedRunningTaskIds, event.details);
    }
  });

  pi.on("message_start", (event) => {
    const message = event.message;
    if (
      message.role !== "custom" ||
      message.customType !== COMPLETION_MESSAGE_TYPE
    ) {
      return;
    }
    for (const taskId of completionTaskIds(message.details)) {
      taggedRunningTaskIds.delete(taskId);
    }
  });

  pi.on("agent_settled", async (_event, context) => {
    if (reminderFollowUpActive) {
      reminderFollowUpActive = false;
      return;
    }
    if (!context.isIdle()) return;
    if (taggedRunningTaskIds.size > 0) return;

    reminderFollowUpActive = true;
    try {
      await pi.sendMessage(
        {
          customType: MESSAGE_TYPE,
          content: REMINDER,
          display: true,
          details: {},
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      reminderFollowUpActive = false;
    }
  });
}

export default registerAgentosSupervisionGuard;

function reconcileTaggedTasks(
  taggedTaskIds: Set<string>,
  event: ToolResultEvent,
) {
  const requestedState = event.input?.state;
  if (
    requestedState === undefined ||
    requestedState === "running" ||
    requestedState === "all"
  ) {
    taggedTaskIds.clear();
  }
  const tasks = listedTasks(event.details);
  for (const task of tasks) {
    observeTaskSnapshot(taggedTaskIds, task);
  }
}

function listedTasks(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "tasks" in value &&
    Array.isArray(value.tasks)
  ) {
    return value.tasks;
  }
  return [];
}

function observeTaskSnapshot(taggedTaskIds: Set<string>, value: unknown) {
  if (typeof value !== "object" || value === null || !("id" in value)) return;
  if (typeof value.id !== "string") return;
  if (
    "state" in value &&
    value.state === "running" &&
    "description" in value &&
    typeof value.description === "string" &&
    value.description.includes(SUPERVISION_MARKER)
  ) {
    taggedTaskIds.add(value.id);
  } else {
    taggedTaskIds.delete(value.id);
  }
}

function completionTaskIds(value: unknown): string[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("taskIds" in value) ||
    !Array.isArray(value.taskIds)
  ) {
    return [];
  }
  return value.taskIds.filter(
    (taskId): taskId is string => typeof taskId === "string",
  );
}

function supervisionGuardDisabled(): boolean {
  return process.env.AGENTOS_DISABLE_SUPERVISION_GUARD?.toLowerCase() === "true";
}

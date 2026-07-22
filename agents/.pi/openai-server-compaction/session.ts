import {
  buildSessionContext,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  isCompactionArtifact,
  isResponseItem,
  messagesToResponseItems,
  type ResponseItem,
} from "./messages.ts";

export const NATIVE_DETAILS_KEY = "agentosOpenAIServerCompaction";

export type NativeCompactionState = {
  version: 1;
  provider: string;
  model: string;
  replacementInput: ResponseItem[];
  usage?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReplayInput(value: unknown): value is ResponseItem[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isResponseItem) &&
    value.filter(isCompactionArtifact).length === 1
  );
}

function readState(entry: CompactionEntry): NativeCompactionState | undefined {
  if (!isRecord(entry.details)) return undefined;
  const state = entry.details[NATIVE_DETAILS_KEY];
  if (
    !isRecord(state) ||
    state.version !== 1 ||
    typeof state.provider !== "string" ||
    state.provider.length === 0 ||
    typeof state.model !== "string" ||
    state.model.length === 0 ||
    !isReplayInput(state.replacementInput)
  ) {
    return undefined;
  }
  const usage = isRecord(state.usage) ? state.usage : undefined;
  return {
    version: 1,
    provider: state.provider,
    model: state.model,
    replacementInput: state.replacementInput,
    ...(usage ? { usage } : {}),
  };
}

function latestCompaction(entries: SessionEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "compaction") return { entry, index };
  }
  return undefined;
}

function messagesAfter(entries: SessionEntry[], index: number) {
  return entries.slice(index + 1).flatMap(sessionEntryToContextMessages);
}

export function nativeCompactionDetails(
  provider: string,
  model: string,
  replacementInput: ResponseItem[],
  usage?: Record<string, unknown>,
): Record<typeof NATIVE_DETAILS_KEY, NativeCompactionState> {
  return {
    [NATIVE_DETAILS_KEY]: {
      version: 1,
      provider,
      model,
      replacementInput,
      ...(usage ? { usage } : {}),
    },
  };
}

function matchingState(entries: SessionEntry[], provider: string, model: string) {
  const latest = latestCompaction(entries);
  if (!latest) return undefined;
  const state = readState(latest.entry);
  if (!state || state.provider !== provider || state.model !== model) return undefined;
  return { state, index: latest.index };
}

export function buildCompactionInput(
  entries: SessionEntry[],
  provider: string,
  model: string,
): ResponseItem[] {
  const native = matchingState(entries, provider, model);
  if (native) {
    return [
      ...native.state.replacementInput,
      ...messagesToResponseItems(messagesAfter(entries, native.index)),
    ];
  }
  return messagesToResponseItems(buildSessionContext(entries).messages);
}

export function rewriteResponsesPayload(
  payload: unknown,
  entries: SessionEntry[],
  provider: string,
  model: string,
): Record<string, unknown> | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;
  if (payload.model !== undefined && payload.model !== model) return undefined;
  const native = matchingState(entries, provider, model);
  if (!native) return undefined;
  return {
    ...payload,
    input: [
      ...native.state.replacementInput,
      ...messagesToResponseItems(messagesAfter(entries, native.index)),
    ],
  };
}

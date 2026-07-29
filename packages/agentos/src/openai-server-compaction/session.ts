import {
  buildSessionContext,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  messagesToResponseItems,
  type ResponseItem,
} from "./messages.ts";
import {
  JsonObjectSchema,
  NativeCompactionStateSchema,
  ProviderRequestPayloadSchema,
  type NativeCompactionState,
  type ProviderRequestPayload,
  type ResponseUsage,
} from "./schemas.ts";

export type { NativeCompactionState } from "./schemas.ts";

export const NATIVE_DETAILS_KEY = "agentosOpenAIServerCompaction";

function readState(entry: CompactionEntry): NativeCompactionState | undefined {
  const details = JsonObjectSchema.safeParse(entry.details);
  if (!details.success) return undefined;
  const state = NativeCompactionStateSchema.safeParse(details.data[NATIVE_DETAILS_KEY]);
  return state.success ? state.data : undefined;
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
  usage?: ResponseUsage,
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
): ProviderRequestPayload | undefined {
  const parsed = ProviderRequestPayloadSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  if (parsed.data.model !== undefined && parsed.data.model !== model) return undefined;
  const native = matchingState(entries, provider, model);
  if (!native) return undefined;
  return {
    ...parsed.data,
    input: [
      ...native.state.replacementInput,
      ...messagesToResponseItems(messagesAfter(entries, native.index)),
    ],
  };
}

import {
  buildSessionContext,
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
  NativeCompactionStateV2Schema,
  ProviderRequestPayloadSchema,
  type NativeCompactionState,
  type NativeCompactionApi,
  type NativeCompactionProvider,
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

export function nativeCompactionDetails(
  provider: NativeCompactionProvider,
  api: NativeCompactionApi,
  model: string,
  replacementInput: ResponseItem[],
  usage?: ResponseUsage,
): Record<typeof NATIVE_DETAILS_KEY, NativeCompactionState> {
  const state = NativeCompactionStateV2Schema.parse({
    version: 2,
    implementation: "responses_compaction_v2",
    provider,
    api,
    model,
    replacementInput,
    ...(usage ? { usage } : {}),
  });
  return {
    [NATIVE_DETAILS_KEY]: state,
  };
}

function matchingState(
  entries: SessionEntry[],
  provider: NativeCompactionProvider,
  api: NativeCompactionApi,
  model: string,
) {
  const latest = latestCompaction(entries);
  if (!latest) return undefined;
  const state = readState(latest.entry);
  if (
    !state ||
    state.provider !== provider ||
    state.model !== model ||
    (state.version === 2 && state.api !== api)
  ) {
    return undefined;
  }
  return { state, index: latest.index };
}

function matchingTrailingMessages(
  entries: SessionEntry[],
  index: number,
  provider: NativeCompactionProvider,
  api: NativeCompactionApi,
  model: string,
): ResponseItem[] {
  const completed: ResponseItem[] = [];
  let pending: ResponseItem[] = [];

  for (const entry of entries.slice(index + 1)) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      const items = messagesToResponseItems([entry.message]);
      if (
        entry.message.provider === provider &&
        entry.message.api === api &&
        entry.message.model === model
      ) {
        completed.push(...pending, ...items);
      }
      pending = [];
      continue;
    }
    const items = messagesToResponseItems([entry.message]);
    if (items.length === 0) continue;
    pending.push(...items);
  }

  return [...completed, ...pending];
}

export function buildCompactionInput(
  entries: SessionEntry[],
  provider: NativeCompactionProvider,
  api: NativeCompactionApi,
  model: string,
): ResponseItem[] {
  const native = matchingState(entries, provider, api, model);
  if (native) {
    return [
      ...native.state.replacementInput,
      ...matchingTrailingMessages(
        entries,
        native.index,
        provider,
        api,
        model,
      ),
    ];
  }
  return messagesToResponseItems(buildSessionContext(entries).messages);
}

export function rewriteResponsesPayload(
  payload: unknown,
  entries: SessionEntry[],
  provider: NativeCompactionProvider,
  api: NativeCompactionApi,
  model: string,
): ProviderRequestPayload | undefined {
  const parsed = ProviderRequestPayloadSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  if (parsed.data.model !== undefined && parsed.data.model !== model) return undefined;
  const native = matchingState(entries, provider, api, model);
  if (!native) return undefined;
  return {
    ...parsed.data,
    input: [
      ...native.state.replacementInput,
      ...matchingTrailingMessages(
        entries,
        native.index,
        provider,
        api,
        model,
      ),
    ],
  };
}

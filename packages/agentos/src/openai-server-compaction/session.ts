import {
  buildSessionContext,
  type CompactionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import {
  messagesToResponseItems,
  type ResponseItem,
} from "./messages.ts";
import {
  JsonObjectSchema,
  NativeCompactionStateSchema,
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
  const details = Schema.decodeUnknownOption(JsonObjectSchema)(entry.details);
  if (Option.isNone(details)) return undefined;
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(NativeCompactionStateSchema, {
      onExcessProperty: "error",
    })(details.value[NATIVE_DETAILS_KEY]),
  );
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
  const state: NativeCompactionState = provider === "openai" && api === "openai-responses"
    ? {
      version: 2,
      implementation: "responses_compaction_v2",
      provider,
      api,
      model,
      replacementInput,
      ...(usage ? { usage } : {}),
    }
    : provider === "openai-codex" && api === "openai-codex-responses"
    ? {
      version: 2,
      implementation: "responses_compaction_v2",
      provider,
      api,
      model,
      replacementInput,
      ...(usage ? { usage } : {}),
    }
    : {
      version: 1,
      provider,
      model,
      replacementInput,
      ...(usage ? { usage } : {}),
    };
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
    state.version !== 2 ||
    state.provider !== provider ||
    state.model !== model ||
    state.api !== api
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
  const parsed = Schema.decodeUnknownOption(ProviderRequestPayloadSchema, {
    onExcessProperty: "preserve",
  })(payload);
  if (Option.isNone(parsed)) return undefined;
  if (parsed.value.model !== undefined && parsed.value.model !== model) return undefined;
  const native = matchingState(entries, provider, api, model);
  if (!native) return undefined;
  return {
    ...parsed.value,
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

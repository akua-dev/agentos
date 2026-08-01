import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import {
  JsonObjectSchema,
  ResponseContentItemSchema,
  ResponseItemSchema,
  ResponseReasoningItemSchema,
  type CompactionArtifact,
  type JsonValue,
  type ResponseContentItem,
  type ResponseItem,
} from "./schemas.ts";

export type { CompactionArtifact, ResponseContentItem, ResponseItem } from "./schemas.ts";

type AgentMessages = Parameters<typeof convertToLlm>[0];

export type AssistantPhase = "commentary" | "final_answer";

const IMAGE_CONTENT_OMITTED_PLACEHOLDER =
  "image content omitted because you do not support image input";
const JsonText = Schema.UnknownFromJsonString;

export function isCompactionArtifact(value: unknown): value is CompactionArtifact {
  const parsed = Schema.decodeUnknownOption(ResponseItemSchema, {
    onExcessProperty: "preserve",
  })(value);
  return Option.isSome(parsed) && parsed.value.type === "compaction";
}

export function isResponseItem(value: unknown): value is ResponseItem {
  return Option.isSome(
    Schema.decodeUnknownOption(ResponseItemSchema, {
      onExcessProperty: "preserve",
    })(value),
  );
}

function cloneResponseItem<T extends ResponseItem>(item: T): T {
  return structuredClone(item);
}

function responseItemCallId(item: ResponseItem): string | undefined {
  if (!("call_id" in item)) return undefined;
  return typeof item.call_id === "string" && item.call_id
    ? item.call_id
    : undefined;
}

function outputTypeForCallType(type: string): string | undefined {
  if (type === "function_call") return "function_call_output";
  if (type === "local_shell_call") return "local_shell_call_output";
  if (type === "tool_search_call") return "tool_search_output";
  if (type === "custom_tool_call") return "custom_tool_call_output";
  return undefined;
}

function responseItemIdentifier(item: ResponseItem): string | undefined {
  if (!(
    "id" in item &&
    typeof item.id === "string" &&
    item.id
  )) {
    return undefined;
  }
  return item.id;
}

function outputPairId(item: ResponseItem): string | undefined {
  if (item.type === "local_shell_call") return responseItemCallId(item);
  if (item.type === "local_shell_call_output") return responseItemIdentifier(item);
  return responseItemCallId(item);
}

function syntheticOutputForCall(
  item: ResponseItem,
): ResponseItem | undefined {
  const callId = responseItemCallId(item);
  if (item.type === "local_shell_call") {
    if (!callId) return undefined;
    return {
      type: "local_shell_call_output",
      id: callId,
      output: "aborted",
    };
  }
  if (!callId) return undefined;
  if (item.type === "function_call") {
    return {
      type: "function_call_output",
      call_id: callId,
      output: "aborted",
    };
  }
  if (item.type === "custom_tool_call") {
    return {
      type: "custom_tool_call_output",
      call_id: callId,
      output: "aborted",
    };
  }
  if (item.type === "tool_search_call") {
    const id =
      "id" in item && typeof item.id === "string"
        ? `${item.id}-output`
        : `${callId}-output`;
    return {
      type: "tool_search_output",
      id,
      call_id: callId,
      execution: "client",
      status: "completed",
      tools: [],
    };
  }
  return undefined;
}

function ensureCallOutputsPresent(items: ResponseItem[]): ResponseItem[] {
  const normalized: ResponseItem[] = [];
  for (const item of items) {
    normalized.push(item);
    const outputType = outputTypeForCallType(item.type);
    const pairId = outputPairId(item);
    if (!outputType || !pairId) continue;
    const hasOutput = items.some(
      (candidate) =>
        candidate.type === outputType &&
        outputPairId(candidate) === pairId,
    );
    if (hasOutput) continue;
    const synthetic = syntheticOutputForCall(item);
    if (synthetic) normalized.push(synthetic);
  }
  return normalized;
}

function removeOrphanOutputs(items: ResponseItem[]): ResponseItem[] {
  const functionCallIds = new Set<string>();
  const localShellCallIds = new Set<string>();
  const toolSearchCallIds = new Set<string>();
  const customToolCallIds = new Set<string>();

  for (const item of items) {
    const callId = responseItemCallId(item);
    if (!callId) continue;
    if (item.type === "function_call" || item.type === "local_shell_call") {
      if (item.type === "function_call") functionCallIds.add(callId);
      else localShellCallIds.add(callId);
    } else if (item.type === "tool_search_call") {
      toolSearchCallIds.add(callId);
    } else if (item.type === "custom_tool_call") {
      customToolCallIds.add(callId);
    }
  }

  return items.filter((item) => {
    const callId = responseItemCallId(item);
    if (item.type === "function_call_output") {
      return Boolean(callId && functionCallIds.has(callId));
    }
    if (item.type === "local_shell_call_output") {
      const id = responseItemIdentifier(item);
      return Boolean(id && localShellCallIds.has(id));
    }
    if (item.type === "custom_tool_call_output") {
      return Boolean(callId && customToolCallIds.has(callId));
    }
    if (item.type === "tool_search_output") {
      if (
        ("execution" in item && item.execution === "server") ||
        callId === undefined
      ) {
        return true;
      }
      return toolSearchCallIds.has(callId);
    }
    return true;
  });
}

function modelSupportsImageInput(model: {
  input?: readonly unknown[];
}): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}

function stripUnsupportedImageContentItems(
  items: ResponseContentItem[],
): ResponseContentItem[] {
  return items.map((item) =>
    item.type === "input_image"
      ? {
          type: "input_text",
          text: IMAGE_CONTENT_OMITTED_PLACEHOLDER,
        }
      : item,
  );
}

function stripUnsupportedOutputImages(
  output: unknown,
): unknown {
  if (!Array.isArray(output)) return output;
  return output.map((item) =>
    typeof item === "object" &&
    item !== null &&
    "type" in item &&
    item.type === "input_image"
      ? {
          type: "input_text",
          text: IMAGE_CONTENT_OMITTED_PLACEHOLDER,
        }
      : item,
  );
}

function stripImagesWhenUnsupported(
  items: ResponseItem[],
  model: { input?: readonly unknown[] },
): ResponseItem[] {
  if (modelSupportsImageInput(model)) return items;
  return items.map((item) => {
    const next = cloneResponseItem(item);
    if (
      next.type === "message" &&
      Array.isArray(next.content)
    ) {
      const content = next.content.flatMap((value) => {
        const parsed = Schema.decodeUnknownOption(ResponseContentItemSchema, {
          onExcessProperty: "preserve",
        })(value);
        return Option.isSome(parsed) ? [parsed.value] : [];
      });
      return parsedResponseItemOr(
        next,
        {
          ...next,
          content: stripUnsupportedImageContentItems(content),
        },
      );
    }
    if (
      (next.type === "function_call_output" ||
        next.type === "custom_tool_call_output") &&
      "output" in next
    ) {
      return parsedResponseItemOr(next, {
        ...next,
        output: stripUnsupportedOutputImages(next.output),
      });
    }
    if (
      next.type === "image_generation_call" &&
      "result" in next &&
      typeof next.result === "string"
    ) {
      return parsedResponseItemOr(next, { ...next, result: "" });
    }
    return next;
  });
}

function parsedResponseItemOr(
  fallback: ResponseItem,
  value: unknown,
): ResponseItem {
  return Option.getOrElse(
    Schema.decodeUnknownOption(ResponseItemSchema, {
      onExcessProperty: "preserve",
    })(value),
    () => fallback,
  );
}

export function normalizeResponseItemsForPrompt(
  items: ResponseItem[],
  model: { input?: readonly unknown[] },
): ResponseItem[] {
  const withoutGhostSnapshots = items
    .filter((item) => item.type !== "ghost_snapshot")
    .map(cloneResponseItem);
  const withCallOutputs = ensureCallOutputsPresent(
    withoutGhostSnapshots,
  );
  const withoutOrphanOutputs = removeOrphanOutputs(withCallOutputs);
  return stripImagesWhenUnsupported(withoutOrphanOutputs, model);
}

function imageUrl(image: ImageContent): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function inputContent(content: string | (TextContent | ImageContent)[]): ResponseContentItem[] {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : [];
  }
  const items: ResponseContentItem[] = [];
  for (const part of content) {
    items.push(
      part.type === "text"
        ? { type: "input_text", text: part.text }
        : { type: "input_image", detail: "auto", image_url: imageUrl(part) },
    );
  }
  return items;
}

function toolOutput(
  content: (TextContent | ImageContent)[],
): Extract<ResponseItem, { type: "function_call_output" }>["output"] {
  const output = content.map(
    (part): Exclude<Extract<ResponseItem, { type: "function_call_output" }>["output"], string>[number] =>
      part.type === "text"
        ? { type: "input_text", text: part.text }
        : { type: "input_image", detail: "auto", image_url: imageUrl(part) },
  );
  return output.length > 0 ? output : "(no tool output)";
}

function responseCallId(id: string): string {
  return id.split("|", 1)[0] || id;
}

function responseItemId(id: string): string | undefined {
  const separator = id.indexOf("|");
  return separator === -1 ? undefined : id.slice(separator + 1) || undefined;
}

function assistantTextMetadata(
  signature: string | undefined,
): { id?: string; phase?: AssistantPhase; annotations: JsonValue[] } {
  if (!signature) return { annotations: [] };
  const decoded = Schema.decodeUnknownOption(JsonText)(signature);
  if (Option.isNone(decoded)) return { annotations: [] };
  const parsed = Schema.decodeUnknownOption(JsonObjectSchema)(decoded.value);
  if (Option.isNone(parsed)) return { annotations: [] };
  const value = parsed.value;
  const phase = value.phase === "commentary" || value.phase === "final_answer"
    ? value.phase
    : undefined;
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(phase ? { phase } : {}),
    annotations: Array.isArray(value.annotations) ? value.annotations : [],
  };
}

function reasoningItem(signature: string | undefined): ResponseItem | undefined {
  if (!signature) return undefined;
  const decoded = Schema.decodeUnknownOption(JsonText)(signature);
  if (Option.isNone(decoded)) return undefined;
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(ResponseReasoningItemSchema, {
      onExcessProperty: "preserve",
    })(decoded.value),
  );
}

function messageToResponseItems(message: Message): ResponseItem[] {
  if (message.role === "user") {
    const content = inputContent(message.content);
    return content.length > 0 ? [{ type: "message", role: "user", content }] : [];
  }

  if (message.role === "toolResult") {
    return [
      {
        type: "function_call_output",
        call_id: responseCallId(message.toolCallId),
        output: toolOutput(message.content),
      },
    ];
  }

  const items: ResponseItem[] = [];
  let text = "";
  let textMetadata = assistantTextMetadata(undefined);
  const flushText = () => {
    if (!text) return;
    items.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: textMetadata.annotations }],
      status: "completed",
      ...(textMetadata.id ? { id: textMetadata.id } : {}),
      ...(textMetadata.phase ? { phase: textMetadata.phase } : {}),
    });
    text = "";
  };

  for (const part of message.content) {
    if (part.type === "thinking") {
      flushText();
      const reasoning = reasoningItem(part.thinkingSignature);
      if (reasoning) items.push(reasoning);
      continue;
    }
    if (part.type === "text") {
      const nextMetadata = assistantTextMetadata(part.textSignature);
      if (text && (nextMetadata.phase !== textMetadata.phase || nextMetadata.id !== textMetadata.id)) flushText();
      textMetadata = nextMetadata;
      text += part.text;
      continue;
    }
    flushText();
    items.push({
      type: "function_call",
      ...(responseItemId(part.id) ? { id: responseItemId(part.id) } : {}),
      call_id: responseCallId(part.id),
      name: part.name,
      arguments: JSON.stringify(part.arguments) ?? "{}",
    });
  }
  flushText();
  return items;
}

export function messagesToResponseItems(messages: AgentMessages): ResponseItem[] {
  return convertToLlm(messages).flatMap(messageToResponseItems);
}

import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import {
  JsonObjectSchema,
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

export function isCompactionArtifact(value: unknown): value is CompactionArtifact {
  const parsed = ResponseItemSchema.safeParse(value);
  return parsed.success && parsed.data.type === "compaction";
}

export function isResponseItem(value: unknown): value is ResponseItem {
  return ResponseItemSchema.safeParse(value).success;
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
  try {
    const parsed = JsonObjectSchema.safeParse(JSON.parse(signature));
    if (!parsed.success) return { annotations: [] };
    const value = parsed.data;
    const phase = value.phase === "commentary" || value.phase === "final_answer" ? value.phase : undefined;
    return {
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      ...(phase ? { phase } : {}),
      annotations: Array.isArray(value.annotations) ? value.annotations : [],
    };
  } catch {
    return { annotations: [] };
  }
}

function reasoningItem(signature: string | undefined): ResponseItem | undefined {
  if (!signature) return undefined;
  try {
    const parsed = ResponseReasoningItemSchema.safeParse(JSON.parse(signature));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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

import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

type AgentMessages = Parameters<typeof convertToLlm>[0];

export type AssistantPhase = "commentary" | "final_answer";

export type ResponseContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; detail: "auto"; image_url: string }
  | { type: "output_text"; text: string; annotations: unknown[] };

export type CompactionArtifact = {
  type: "compaction";
  encrypted_content: string;
  [key: string]: unknown;
};

export type ResponseItem =
  | {
      type: "message";
      role: "user" | "assistant";
      content: ResponseContentItem[];
      id?: string;
      status?: string;
      phase?: AssistantPhase;
    }
  | {
      type: "reasoning";
      summary: Array<Record<string, unknown>>;
      content?: Array<Record<string, unknown>>;
      encrypted_content?: string | null;
      id?: string;
      status?: string;
      [key: string]: unknown;
    }
  | { type: "function_call"; id?: string; name: string; arguments: string; call_id: string }
  | {
      type: "function_call_output";
      call_id: string;
      output:
        | string
        | Array<
            | { type: "input_text"; text: string }
            | { type: "input_image"; detail: "auto"; image_url: string }
        >;
    }
  | CompactionArtifact
  | { type: string; [key: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCompactionArtifact(value: unknown): value is CompactionArtifact {
  return (
    isRecord(value) &&
    value.type === "compaction" &&
    typeof value.encrypted_content === "string" &&
    value.encrypted_content.length > 0
  );
}

function isInputContentItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "input_text") return typeof value.text === "string";
  if (value.type === "input_image") {
    return value.detail === "auto" && typeof value.image_url === "string";
  }
  if (value.type === "output_text") return false;
  return typeof value.type === "string" && value.type.length > 0;
}

function isResponseContentItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (isInputContentItem(value)) return true;
  return (
    value.type === "output_text" &&
    typeof value.text === "string" &&
    Array.isArray(value.annotations)
  );
}

export function isResponseItem(value: unknown): value is ResponseItem {
  if (!isRecord(value) || typeof value.type !== "string" || value.type.length === 0) return false;
  switch (value.type) {
    case "message":
      return (
        (value.role === "user" || value.role === "assistant") &&
        Array.isArray(value.content) &&
        value.content.every(isResponseContentItem)
      );
    case "reasoning":
      return (
        Array.isArray(value.summary) &&
        value.summary.every(isRecord) &&
        (value.content === undefined ||
          (Array.isArray(value.content) && value.content.every(isRecord)))
      );
    case "function_call":
      return (
        typeof value.call_id === "string" &&
        typeof value.name === "string" &&
        typeof value.arguments === "string"
      );
    case "function_call_output":
      return (
        typeof value.call_id === "string" &&
        (typeof value.output === "string" ||
          (Array.isArray(value.output) && value.output.every(isInputContentItem)))
      );
    case "compaction":
      return isCompactionArtifact(value);
    default:
      return true;
  }
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
): { id?: string; phase?: AssistantPhase; annotations: unknown[] } {
  if (!signature) return { annotations: [] };
  try {
    const value = JSON.parse(signature) as unknown;
    if (!isRecord(value)) return { annotations: [] };
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
    const value = JSON.parse(signature) as unknown;
    if (!isRecord(value) || value.type !== "reasoning") return undefined;
    if (!Array.isArray(value.summary)) return undefined;
    const encrypted = value.encrypted_content;
    if (encrypted !== undefined && encrypted !== null && typeof encrypted !== "string") return undefined;
    return value as unknown as ResponseItem;
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

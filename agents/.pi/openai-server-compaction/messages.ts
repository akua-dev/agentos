import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

type AgentMessages = Parameters<typeof convertToLlm>[0];

export type AssistantPhase = "commentary" | "final_answer";

export type ResponseContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "output_text"; text: string };

export type CompactionArtifact = {
  type: "compaction";
  encrypted_content: string;
};

export type ResponseItem =
  | {
      type: "message";
      role: "user" | "assistant";
      content: ResponseContentItem[];
      phase?: AssistantPhase;
    }
  | {
      type: "reasoning";
      summary: Array<{ type: "summary_text"; text: string }>;
      content?: Array<{ type: "reasoning_text" | "text"; text: string }>;
      encrypted_content: string | null;
    }
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | {
      type: "function_call_output";
      call_id: string;
      output: string | Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }>;
    }
  | CompactionArtifact;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
        : { type: "input_image", image_url: imageUrl(part) },
    );
  }
  return items;
}

function toolOutput(content: (TextContent | ImageContent)[]) {
  const output = content.map((part) =>
    part.type === "text"
      ? { type: "input_text" as const, text: part.text }
      : { type: "input_image" as const, image_url: imageUrl(part) },
  );
  return output.length > 0 ? output : "(no tool output)";
}

function responseCallId(id: string): string {
  return id.split("|", 1)[0] || id;
}

function assistantPhase(signature: string | undefined): AssistantPhase | undefined {
  if (!signature) return undefined;
  try {
    const value = JSON.parse(signature) as unknown;
    if (!isRecord(value)) return undefined;
    return value.phase === "commentary" || value.phase === "final_answer" ? value.phase : undefined;
  } catch {
    return undefined;
  }
}

function reasoningItem(signature: string | undefined): ResponseItem | undefined {
  if (!signature) return undefined;
  try {
    const value = JSON.parse(signature) as unknown;
    if (!isRecord(value) || value.type !== "reasoning") return undefined;
    const summary = Array.isArray(value.summary)
      ? value.summary.flatMap((part) =>
          isRecord(part) && typeof part.text === "string"
            ? [{ type: "summary_text" as const, text: part.text }]
            : [],
        )
      : [];
    const content = Array.isArray(value.content)
      ? value.content.flatMap((part) =>
          isRecord(part) && typeof part.text === "string"
            ? [
                {
                  type: part.type === "reasoning_text" ? ("reasoning_text" as const) : ("text" as const),
                  text: part.text,
                },
              ]
            : [],
        )
      : [];
    const encrypted = value.encrypted_content;
    if (encrypted !== null && typeof encrypted !== "string") return undefined;
    return {
      type: "reasoning",
      summary,
      ...(content.length > 0 ? { content } : {}),
      encrypted_content: encrypted,
    };
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
  let phase: AssistantPhase | undefined;
  const flushText = () => {
    if (!text) return;
    items.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
      ...(phase ? { phase } : {}),
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
      const nextPhase = assistantPhase(part.textSignature);
      if (text && nextPhase !== phase) flushText();
      phase = nextPhase;
      text += part.text;
      continue;
    }
    flushText();
    items.push({
      type: "function_call",
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

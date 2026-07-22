import { createRequire } from "node:module";
import { join } from "node:path";
import type * as Zod from "zod";

type ZodNamespace = typeof import("zod");

const ZOD_VERSION = "4.4.3";
const requireFromSchemas = createRequire(import.meta.url);

function loadZod(): ZodNamespace {
  const releaseRoot = process.env.AGENTOS_RELEASE_ROOT ?? "/opt/agentos";
  const candidates = [
    "zod",
    join(releaseRoot, "node_modules", "zod"),
    join(releaseRoot, "services", "ai-gateway", "node_modules", "zod"),
    ...(process.env.PI_CODING_AGENT_DIR
      ? [join(process.env.PI_CODING_AGENT_DIR, "npm", "node_modules", "zod")]
      : []),
  ];

  for (const candidate of candidates) {
    try {
      const manifest: { version?: string } = requireFromSchemas(join(candidate, "package.json"));
      if (manifest.version !== ZOD_VERSION) continue;
      const module: ZodNamespace = requireFromSchemas(candidate);
      return module;
    } catch {
      continue;
    }
  }

  throw new Error(`AgentOS OpenAI server compaction requires zod@${ZOD_VERSION}.`);
}

const { z } = loadZod();

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema: Zod.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema: Zod.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);

const knownContentTypes = new Set(["input_text", "input_image", "output_text"]);
const knownResponseTypes = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "compaction",
]);

const InputTextSchema = z
  .object({ type: z.literal("input_text"), text: z.string() })
  .catchall(JsonValueSchema);
const InputImageSchema = z
  .object({ type: z.literal("input_image"), detail: z.literal("auto"), image_url: z.string() })
  .catchall(JsonValueSchema);
const OutputTextSchema = z
  .object({
    type: z.literal("output_text"),
    text: z.string(),
    annotations: z.array(JsonValueSchema),
  })
  .catchall(JsonValueSchema);
const OpaqueContentItemSchema = z
  .object({ type: z.string().min(1) })
  .catchall(JsonValueSchema)
  .refine((value) => !knownContentTypes.has(value.type))
  .brand<"OpaqueResponseContentItem">();

export const ResponseContentItemSchema = z.union([
  InputTextSchema,
  InputImageSchema,
  OutputTextSchema,
  OpaqueContentItemSchema,
]);

const ReasoningSummarySchema = z
  .object({ type: z.literal("summary_text"), text: z.string() })
  .catchall(JsonValueSchema);
const ReasoningContentSchema = z
  .object({ type: z.literal("reasoning_text"), text: z.string() })
  .catchall(JsonValueSchema);

const MessageItemSchema = z
  .object({
    type: z.literal("message"),
    role: z.enum(["user", "assistant"]),
    content: z.array(ResponseContentItemSchema),
    id: z.string().optional(),
    status: z.string().optional(),
    phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
  })
  .catchall(JsonValueSchema);

export const ResponseReasoningItemSchema = z
  .object({
    type: z.literal("reasoning"),
    summary: z.array(ReasoningSummarySchema),
    content: z.array(ReasoningContentSchema).optional(),
    encrypted_content: z.string().nullable().optional(),
    id: z.string().optional(),
    status: z.string().optional(),
  })
  .catchall(JsonValueSchema);

const FunctionCallSchema = z
  .object({
    type: z.literal("function_call"),
    id: z.string().optional(),
    name: z.string(),
    arguments: z.string(),
    call_id: z.string(),
  })
  .catchall(JsonValueSchema);

const FunctionCallOutputSchema = z
  .object({
    type: z.literal("function_call_output"),
    call_id: z.string(),
    output: z.union([
      z.string(),
      z.array(z.union([InputTextSchema, InputImageSchema, OpaqueContentItemSchema])),
    ]),
  })
  .catchall(JsonValueSchema);

export const CompactionArtifactSchema = z
  .object({
    type: z.literal("compaction"),
    encrypted_content: z.string().min(1),
    id: z.string().nullable().optional(),
  })
  .catchall(JsonValueSchema);

export const OpaqueProviderItemSchema = z
  .object({ type: z.string().min(1) })
  .catchall(JsonValueSchema)
  .refine((value) => !knownResponseTypes.has(value.type))
  .brand<"OpaqueProviderItem">();

export const ResponseItemSchema = z.union([
  MessageItemSchema,
  ResponseReasoningItemSchema,
  FunctionCallSchema,
  FunctionCallOutputSchema,
  CompactionArtifactSchema,
  OpaqueProviderItemSchema,
]);

export const ResponseItemsSchema = z.array(ResponseItemSchema);

const TokenCountSchema = z.number().finite().nonnegative();
const InputTokenDetailsSchema = z
  .object({
    cached_tokens: TokenCountSchema.optional(),
    cache_write_tokens: TokenCountSchema.optional(),
  })
  .catchall(JsonValueSchema);
const OutputTokenDetailsSchema = z
  .object({ reasoning_tokens: TokenCountSchema.optional() })
  .catchall(JsonValueSchema);

export const ResponseUsageSchema = z
  .object({
    input_tokens: TokenCountSchema.optional(),
    output_tokens: TokenCountSchema.optional(),
    total_tokens: TokenCountSchema.optional(),
    input_tokens_details: InputTokenDetailsSchema.optional(),
    output_tokens_details: OutputTokenDetailsSchema.optional(),
  })
  .catchall(JsonValueSchema)
  .refine(
    (value) =>
      value.input_tokens !== undefined ||
      value.output_tokens !== undefined ||
      value.total_tokens !== undefined ||
      value.input_tokens_details !== undefined ||
      value.output_tokens_details !== undefined,
  );

export const NativeCompactionStateSchema = z
  .object({
    version: z.literal(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    replacementInput: ResponseItemsSchema.min(1),
    usage: ResponseUsageSchema.optional(),
  })
  .catchall(JsonValueSchema)
  .refine(
    (value) => value.replacementInput.filter((item) => item.type === "compaction").length === 1,
  );

export const ProviderRequestPayloadSchema = z
  .object({
    model: z.string().optional(),
    input: z.array(JsonValueSchema),
  })
  .catchall(JsonValueSchema.optional());

export const DirectCompactResponseSchema = z
  .object({
    output: ResponseItemsSchema.min(1),
    usage: JsonValueSchema.optional(),
  })
  .catchall(JsonValueSchema);

export const ProviderEventSchema = z
  .object({ type: z.string().min(1) })
  .catchall(JsonValueSchema);

export const OutputItemDoneEventSchema = z
  .object({
    type: z.literal("response.output_item.done"),
    item: ResponseItemSchema,
  })
  .catchall(JsonValueSchema);

const TerminalResponseSchema = z
  .object({
    status: z.string().optional(),
    output: JsonValueSchema.optional(),
    usage: JsonValueSchema.optional(),
  })
  .catchall(JsonValueSchema);

export const TerminalEventSchema = z
  .object({
    type: z.enum(["response.completed", "response.done"]),
    response: TerminalResponseSchema,
  })
  .catchall(JsonValueSchema);

export type ResponseContentItem = Zod.infer<typeof ResponseContentItemSchema>;
export type CompactionArtifact = Zod.infer<typeof CompactionArtifactSchema>;
export type OpaqueProviderItem = Zod.infer<typeof OpaqueProviderItemSchema>;
export type ResponseItem = Zod.infer<typeof ResponseItemSchema>;
export type ResponseUsage = Zod.infer<typeof ResponseUsageSchema>;
export type NativeCompactionState = Zod.infer<typeof NativeCompactionStateSchema>;
export type ProviderRequestPayload = Zod.infer<typeof ProviderRequestPayloadSchema>;
export type ProviderEvent = Zod.infer<typeof ProviderEventSchema>;

export function parseResponseItem(value: unknown): ResponseItem | undefined {
  const parsed = ResponseItemSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseResponseItems(value: unknown): ResponseItem[] | undefined {
  const parsed = ResponseItemsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseResponseUsage(value: unknown): ResponseUsage | undefined {
  const parsed = ResponseUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

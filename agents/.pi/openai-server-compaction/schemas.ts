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

const knownContentTypes = new Set([
  "input_text",
  "input_image",
  "input_file",
  "output_text",
  "refusal",
]);
const knownResponseTypes = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "compaction",
  "file_search_call",
  "web_search_call",
  "computer_call",
  "computer_call_output",
  "image_generation_call",
  "code_interpreter_call",
  "local_shell_call",
  "local_shell_call_output",
  "shell_call",
  "shell_call_output",
  "apply_patch_call",
  "apply_patch_call_output",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
  "mcp_approval_response",
  "custom_tool_call",
  "custom_tool_call_output",
  "program",
  "program_output",
  "tool_search_call",
  "tool_search_output",
  "additional_tools",
]);

const PromptCacheBreakpointSchema = z
  .object({ mode: z.literal("explicit") })
  .catchall(JsonValueSchema);
const InputTextSchema = z
  .object({
    type: z.literal("input_text"),
    text: z.string(),
    prompt_cache_breakpoint: PromptCacheBreakpointSchema.optional(),
  })
  .catchall(JsonValueSchema);
const InputImageSchema = z
  .object({
    type: z.literal("input_image"),
    detail: z.enum(["low", "high", "auto", "original"]),
    file_id: z.string().optional(),
    image_url: z.string().optional(),
    prompt_cache_breakpoint: PromptCacheBreakpointSchema.optional(),
  })
  .catchall(JsonValueSchema)
  .refine((value) => value.file_id !== undefined || value.image_url !== undefined);
const InputFileSchema = z
  .object({
    type: z.literal("input_file"),
    detail: z.enum(["auto", "low", "high"]).optional(),
    file_data: z.string().optional(),
    file_id: z.string().optional(),
    file_url: z.string().optional(),
    filename: z.string().optional(),
    prompt_cache_breakpoint: PromptCacheBreakpointSchema.optional(),
  })
  .catchall(JsonValueSchema)
  .refine((value) => value.file_data !== undefined || value.file_id !== undefined || value.file_url !== undefined);
const OutputTextSchema = z
  .object({
    type: z.literal("output_text"),
    text: z.string(),
    annotations: z.array(JsonValueSchema),
    logprobs: z.array(JsonValueSchema).optional(),
  })
  .catchall(JsonValueSchema);
const OutputRefusalSchema = z
  .object({ type: z.literal("refusal"), refusal: z.string() })
  .catchall(JsonValueSchema);
const OpaqueContentItemSchema = z
  .object({ type: z.string().min(1) })
  .catchall(JsonValueSchema)
  .refine((value) => !knownContentTypes.has(value.type))
  .brand<"OpaqueResponseContentItem">();

export const ResponseContentItemSchema = z.union([
  InputTextSchema,
  InputImageSchema,
  InputFileSchema,
  OutputTextSchema,
  OutputRefusalSchema,
  OpaqueContentItemSchema,
]);

const FunctionCallOutputContentSchema = z.union([
  InputTextSchema,
  InputImageSchema,
  InputFileSchema,
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
    role: z.enum(["user", "assistant", "system", "developer"]),
    content: z.array(ResponseContentItemSchema),
    id: z.string().optional(),
    status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
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
    status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
  })
  .catchall(JsonValueSchema);

const FunctionCallSchema = z
  .object({
    type: z.literal("function_call"),
    id: z.string().optional(),
    name: z.string(),
    arguments: z.string(),
    call_id: z.string(),
    status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
  })
  .catchall(JsonValueSchema);

const FunctionCallOutputSchema = z
  .object({
    id: z.string().optional(),
    type: z.literal("function_call_output"),
    call_id: z.string(),
    output: z.union([
      z.string(),
      z.array(FunctionCallOutputContentSchema),
    ]),
    status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
  })
  .catchall(JsonValueSchema);

export const CompactionArtifactSchema = z
  .object({
    type: z.literal("compaction"),
    encrypted_content: z.string().min(1),
    id: z.string().nullable().optional(),
  })
  .catchall(JsonValueSchema);

const ProviderItemStatusSchema = z.enum(["in_progress", "completed", "incomplete"]);
const ProviderCallerSchema = z
  .union([
    z.object({ type: z.literal("direct") }).catchall(JsonValueSchema),
    z.object({ type: z.literal("program"), caller_id: z.string() }).catchall(JsonValueSchema),
  ])
  .nullable()
  .optional();
const ToolDefinitionSchema = z
  .object({ type: z.string().min(1), name: z.string().min(1) })
  .catchall(JsonValueSchema);
const WebSearchActionSchema = z.union([
  z
    .object({
      type: z.literal("search"),
      queries: z.array(z.string()).optional(),
      query: z.string().optional(),
      sources: z
        .array(z.object({ type: z.literal("url"), url: z.string() }).catchall(JsonValueSchema))
        .optional(),
    })
    .catchall(JsonValueSchema),
  z.object({ type: z.literal("open_page"), url: z.string().optional() }).catchall(JsonValueSchema),
  z
    .object({ type: z.literal("find_in_page"), pattern: z.string(), url: z.string() })
    .catchall(JsonValueSchema),
]);
const WebSearchCallSchema = z
  .object({
    type: z.literal("web_search_call"),
    id: z.string(),
    action: WebSearchActionSchema.optional(),
    status: z.enum(["in_progress", "searching", "completed", "failed"]),
  })
  .catchall(JsonValueSchema);
const FileSearchResultSchema = z
  .object({
    attributes: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])).optional(),
    file_id: z.string().optional(),
    filename: z.string().optional(),
    score: z.number().finite().optional(),
    text: z.string().optional(),
  })
  .catchall(JsonValueSchema);
const FileSearchCallSchema = z
  .object({
    type: z.literal("file_search_call"),
    id: z.string(),
    queries: z.array(z.string()),
    status: z.enum(["in_progress", "searching", "completed", "incomplete", "failed"]),
    results: z.array(FileSearchResultSchema).nullable().optional(),
  })
  .catchall(JsonValueSchema);
const SafetyCheckSchema = z
  .object({ id: z.string(), code: z.string().optional(), message: z.string().optional() })
  .catchall(JsonValueSchema);
const ComputerCallSchema = z
  .object({
    type: z.literal("computer_call"),
    id: z.string(),
    call_id: z.string(),
    pending_safety_checks: z.array(SafetyCheckSchema),
    status: ProviderItemStatusSchema,
    action: JsonObjectSchema.optional(),
    actions: z.array(JsonObjectSchema).optional(),
  })
  .catchall(JsonValueSchema);
const ComputerCallOutputSchema = z
  .object({
    type: z.literal("computer_call_output"),
    id: z.string().optional(),
    call_id: z.string(),
    output: JsonObjectSchema,
    status: z.enum(["in_progress", "completed", "incomplete", "failed"]).optional(),
    acknowledged_safety_checks: z.array(SafetyCheckSchema).optional(),
  })
  .catchall(JsonValueSchema);
const ImageGenerationCallSchema = z
  .object({
    type: z.literal("image_generation_call"),
    id: z.string(),
    result: z.string().nullable().optional(),
    status: z.enum(["in_progress", "completed", "generating", "failed"]),
  })
  .catchall(JsonValueSchema);
const CodeInterpreterOutputSchema = z.union([
  z.object({ type: z.literal("logs"), logs: z.string() }).catchall(JsonValueSchema),
  z.object({ type: z.literal("image"), url: z.string() }).catchall(JsonValueSchema),
]);
const CodeInterpreterCallSchema = z
  .object({
    type: z.literal("code_interpreter_call"),
    id: z.string(),
    code: z.string().nullable().optional(),
    container_id: z.string(),
    outputs: z.array(CodeInterpreterOutputSchema).nullable().optional(),
    status: z.enum(["in_progress", "completed", "incomplete", "interpreting", "failed"]),
  })
  .catchall(JsonValueSchema);
const LocalShellActionSchema = z
  .object({
    type: z.literal("exec"),
    command: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    timeout_ms: z.number().int().nonnegative().optional(),
    user: z.string().optional(),
    working_directory: z.string().optional(),
  })
  .catchall(JsonValueSchema);
const LocalShellCallSchema = z
  .object({
    type: z.literal("local_shell_call"),
    id: z.string(),
    call_id: z.string(),
    action: LocalShellActionSchema,
    status: ProviderItemStatusSchema,
  })
  .catchall(JsonValueSchema);
const LocalShellCallOutputSchema = z
  .object({
    type: z.literal("local_shell_call_output"),
    id: z.string(),
    output: z.string(),
    status: ProviderItemStatusSchema.optional(),
  })
  .catchall(JsonValueSchema);
const ShellCallActionSchema = z
  .object({
    commands: z.array(z.string()),
    max_output_length: z.number().int().nonnegative().optional(),
    timeout_ms: z.number().int().nonnegative().optional(),
  })
  .catchall(JsonValueSchema);
const ShellCallSchema = z
  .object({
    type: z.literal("shell_call"),
    id: z.string(),
    action: ShellCallActionSchema,
    call_id: z.string(),
    environment: JsonObjectSchema.optional(),
    status: ProviderItemStatusSchema,
    caller: ProviderCallerSchema,
  })
  .catchall(JsonValueSchema);
const ShellCallOutputContentSchema = z
  .object({
    outcome: z.union([
      z.object({ type: z.literal("timeout") }).catchall(JsonValueSchema),
      z.object({ type: z.literal("exit"), exit_code: z.number().int() }).catchall(JsonValueSchema),
    ]),
    stderr: z.string(),
    stdout: z.string(),
  })
  .catchall(JsonValueSchema);
const ShellCallOutputSchema = z
  .object({
    type: z.literal("shell_call_output"),
    id: z.string(),
    call_id: z.string(),
    max_output_length: z.number().int().nonnegative().optional(),
    output: z.array(ShellCallOutputContentSchema),
    status: ProviderItemStatusSchema,
    caller: ProviderCallerSchema,
  })
  .catchall(JsonValueSchema);
const ApplyPatchOperationSchema = z.union([
  z.object({ type: z.literal("create_file"), diff: z.string(), path: z.string() }).catchall(JsonValueSchema),
  z.object({ type: z.literal("delete_file"), path: z.string() }).catchall(JsonValueSchema),
  z.object({ type: z.literal("update_file"), diff: z.string(), path: z.string() }).catchall(JsonValueSchema),
]);
const ApplyPatchCallSchema = z
  .object({
    type: z.literal("apply_patch_call"),
    id: z.string(),
    call_id: z.string(),
    operation: ApplyPatchOperationSchema,
    status: z.enum(["in_progress", "completed"]),
    caller: ProviderCallerSchema,
  })
  .catchall(JsonValueSchema);
const ApplyPatchCallOutputSchema = z
  .object({
    type: z.literal("apply_patch_call_output"),
    id: z.string(),
    call_id: z.string(),
    status: z.enum(["completed", "failed"]),
    caller: ProviderCallerSchema,
    output: z.string().optional(),
  })
  .catchall(JsonValueSchema);
const McpToolSchema = z
  .object({
    input_schema: JsonObjectSchema,
    name: z.string(),
    annotations: JsonObjectSchema.optional(),
    description: z.string().optional(),
  })
  .catchall(JsonValueSchema);
const McpCallSchema = z
  .object({
    type: z.literal("mcp_call"),
    id: z.string(),
    arguments: z.string(),
    name: z.string(),
    server_label: z.string(),
    approval_request_id: z.string().optional(),
    error: z.string().optional(),
    output: z.string().optional(),
    status: z.string().optional(),
  })
  .catchall(JsonValueSchema);
const McpListToolsSchema = z
  .object({
    type: z.literal("mcp_list_tools"),
    id: z.string(),
    server_label: z.string(),
    tools: z.array(McpToolSchema),
    error: z.string().optional(),
  })
  .catchall(JsonValueSchema);
const McpApprovalRequestSchema = z
  .object({
    type: z.literal("mcp_approval_request"),
    id: z.string(),
    arguments: z.string(),
    name: z.string(),
    server_label: z.string(),
  })
  .catchall(JsonValueSchema);
const McpApprovalResponseSchema = z
  .object({
    type: z.literal("mcp_approval_response"),
    id: z.string().optional(),
    approval_request_id: z.string(),
    approve: z.boolean(),
    reason: z.string().optional(),
  })
  .catchall(JsonValueSchema);
const CustomToolCallSchema = z
  .object({
    type: z.literal("custom_tool_call"),
    call_id: z.string(),
    input: z.string(),
    name: z.string(),
    id: z.string().optional(),
    caller: ProviderCallerSchema,
    namespace: z.string().optional(),
  })
  .catchall(JsonValueSchema);
const CustomToolCallOutputSchema = z
  .object({
    type: z.literal("custom_tool_call_output"),
    call_id: z.string(),
    output: z.union([z.string(), z.array(FunctionCallOutputContentSchema)]),
    id: z.string().optional(),
    caller: ProviderCallerSchema,
    status: ProviderItemStatusSchema.optional(),
  })
  .catchall(JsonValueSchema);
const ProgramSchema = z
  .object({
    type: z.literal("program"),
    id: z.string(),
    call_id: z.string(),
    code: z.string(),
    fingerprint: z.string(),
  })
  .catchall(JsonValueSchema);
const ProgramOutputSchema = z
  .object({
    type: z.literal("program_output"),
    id: z.string(),
    call_id: z.string(),
    result: z.string(),
    status: z.enum(["completed", "incomplete"]),
  })
  .catchall(JsonValueSchema);
const ToolSearchCallSchema = z
  .object({
    type: z.literal("tool_search_call"),
    arguments: JsonObjectSchema,
    id: z.string().optional(),
    call_id: z.string().optional(),
    execution: z.enum(["server", "client"]).optional(),
    status: ProviderItemStatusSchema.optional(),
  })
  .catchall(JsonValueSchema);
const ToolSearchOutputSchema = z
  .object({
    type: z.literal("tool_search_output"),
    id: z.string(),
    call_id: z.string().optional(),
    execution: z.enum(["server", "client"]),
    status: ProviderItemStatusSchema,
    tools: z.array(ToolDefinitionSchema),
    created_by: z.string().optional(),
  })
  .catchall(JsonValueSchema);
const AdditionalToolsSchema = z
  .object({
    type: z.literal("additional_tools"),
    role: z.enum(["unknown", "user", "assistant", "system", "critic", "discriminator", "developer", "tool"]),
    tools: z.array(ToolDefinitionSchema),
    id: z.string().optional(),
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
  FileSearchCallSchema,
  WebSearchCallSchema,
  ComputerCallSchema,
  ComputerCallOutputSchema,
  ImageGenerationCallSchema,
  CodeInterpreterCallSchema,
  LocalShellCallSchema,
  LocalShellCallOutputSchema,
  ShellCallSchema,
  ShellCallOutputSchema,
  ApplyPatchCallSchema,
  ApplyPatchCallOutputSchema,
  McpCallSchema,
  McpListToolsSchema,
  McpApprovalRequestSchema,
  McpApprovalResponseSchema,
  CustomToolCallSchema,
  CustomToolCallOutputSchema,
  ProgramSchema,
  ProgramOutputSchema,
  ToolSearchCallSchema,
  ToolSearchOutputSchema,
  AdditionalToolsSchema,
  OpaqueProviderItemSchema,
]);

export const ResponseItemsSchema = z.array(ResponseItemSchema);

const TokenCountSchema = z.number().int().nonnegative();
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

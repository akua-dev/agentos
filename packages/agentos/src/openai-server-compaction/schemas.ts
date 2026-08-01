import { Option, Schema, Struct } from "effect";

export type JsonValue = Schema.Json;
export type JsonObject = Schema.JsonObject;

export const JsonValueSchema = Schema.Json;
export const JsonObjectSchema = Schema.Record(Schema.String, JsonValueSchema);

function optional<const S extends Schema.Top>(schema: S) {
  return Schema.optionalKey(Schema.UndefinedOr(schema));
}

function nullableOptional<const S extends Schema.Top>(schema: S) {
  return optional(Schema.NullOr(schema));
}

function mutableArray<const S extends Schema.Top>(schema: S) {
  return Schema.mutable(Schema.Array(schema));
}

function jsonObject<const Fields extends Schema.Struct.Fields>(fields: Fields) {
  return Schema.StructWithRest(
    Schema.Struct(fields).mapFields(Struct.map(Schema.mutableKey)),
    [JsonObjectSchema],
  );
}

const knownContentTypes = new Set([
  "input_text",
  "input_image",
  "input_file",
  "output_text",
  "refusal",
  "reasoning_text",
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
  "item_reference",
]);

const PromptCacheBreakpointSchema = jsonObject({
  mode: Schema.Literal("explicit"),
});
const InputTextSchema = jsonObject({
  type: Schema.Literal("input_text"),
  text: Schema.String,
  prompt_cache_breakpoint: optional(PromptCacheBreakpointSchema),
});
const InputImageSchema = jsonObject({
  type: Schema.Literal("input_image"),
  detail: Schema.Literals(["low", "high", "auto", "original"]),
  file_id: nullableOptional(Schema.String),
  image_url: nullableOptional(Schema.String),
  prompt_cache_breakpoint: optional(PromptCacheBreakpointSchema),
});
const InputFileSchema = jsonObject({
  type: Schema.Literal("input_file"),
  detail: optional(Schema.Literals(["low", "high"])),
  file_data: nullableOptional(Schema.String),
  file_id: nullableOptional(Schema.String),
  file_url: nullableOptional(Schema.String),
  filename: nullableOptional(Schema.String),
  prompt_cache_breakpoint: optional(PromptCacheBreakpointSchema),
});
const OutputTextSchema = jsonObject({
  type: Schema.Literal("output_text"),
  text: Schema.String,
  annotations: mutableArray(JsonValueSchema),
  logprobs: optional(mutableArray(JsonValueSchema)),
});
const OutputRefusalSchema = jsonObject({
  type: Schema.Literal("refusal"),
  refusal: Schema.String,
});
const ReasoningContentSchema = jsonObject({
  type: Schema.Literal("reasoning_text"),
  text: Schema.String,
});
const OpaqueContentItemSchema = jsonObject({
  type: Schema.NonEmptyString,
}).pipe(
  Schema.check(
    Schema.makeFilter((value) => !knownContentTypes.has(value.type), {
      expected: "an unknown response content-item type",
    }),
  ),
  Schema.brand("OpaqueResponseContentItem"),
);

export const ResponseContentItemSchema = Schema.Union([
  InputTextSchema,
  InputImageSchema,
  InputFileSchema,
  OutputTextSchema,
  OutputRefusalSchema,
  ReasoningContentSchema,
  OpaqueContentItemSchema,
]);

const FunctionCallOutputContentSchema = Schema.Union([
  InputTextSchema,
  InputImageSchema,
  InputFileSchema,
  OpaqueContentItemSchema,
]);

const ReasoningSummarySchema = jsonObject({
  type: Schema.Literal("summary_text"),
  text: Schema.String,
});
const MessageItemSchema = jsonObject({
  type: Schema.Literal("message"),
  role: Schema.Literals(["user", "assistant", "system", "developer"]),
  content: mutableArray(ResponseContentItemSchema),
  id: optional(Schema.String),
  status: optional(Schema.Literals(["in_progress", "completed", "incomplete"])),
  phase: nullableOptional(Schema.Literals(["commentary", "final_answer"])),
});

export const ResponseReasoningItemSchema = jsonObject({
  type: Schema.Literal("reasoning"),
  summary: mutableArray(ReasoningSummarySchema),
  content: optional(mutableArray(ReasoningContentSchema)),
  encrypted_content: nullableOptional(Schema.String),
  id: optional(Schema.String),
  status: optional(Schema.Literals(["in_progress", "completed", "incomplete"])),
});

const FunctionCallSchema = jsonObject({
  type: Schema.Literal("function_call"),
  id: optional(Schema.String),
  name: Schema.String,
  arguments: Schema.String,
  call_id: Schema.String,
  status: optional(Schema.Literals(["in_progress", "completed", "incomplete"])),
});

const FunctionCallOutputSchema = jsonObject({
  id: optional(Schema.String),
  type: Schema.Literal("function_call_output"),
  call_id: Schema.String,
  output: Schema.Union([
    Schema.String,
    mutableArray(FunctionCallOutputContentSchema),
  ]),
  status: optional(Schema.Literals(["in_progress", "completed", "incomplete"])),
});

export const CompactionArtifactSchema = jsonObject({
  type: Schema.Literal("compaction"),
  encrypted_content: Schema.NonEmptyString,
  id: nullableOptional(Schema.String),
});

const ProviderItemStatusSchema = Schema.Literals([
  "in_progress",
  "completed",
  "incomplete",
]);
const ProviderCallerSchema = nullableOptional(
  Schema.Union([
    jsonObject({ type: Schema.Literal("direct") }),
    jsonObject({
      type: Schema.Literal("program"),
      caller_id: Schema.String,
    }),
  ]),
);
const ToolDefinitionSchema = jsonObject({ type: Schema.NonEmptyString });
const WebSearchActionSchema = Schema.Union([
  jsonObject({
    type: Schema.Literal("search"),
    queries: optional(mutableArray(Schema.String)),
    query: Schema.String,
    sources: optional(
      mutableArray(
        jsonObject({
          type: Schema.Literal("url"),
          url: Schema.String,
        }),
      ),
    ),
  }),
  jsonObject({
    type: Schema.Literal("open_page"),
    url: nullableOptional(Schema.String),
  }),
  jsonObject({
    type: Schema.Literal("find_in_page"),
    pattern: Schema.String,
    url: Schema.String,
  }),
]);
const WebSearchCallSchema = jsonObject({
  type: Schema.Literal("web_search_call"),
  id: Schema.String,
  action: WebSearchActionSchema,
  status: Schema.Literals(["in_progress", "searching", "completed", "failed"]),
});
const FileSearchResultSchema = jsonObject({
  attributes: optional(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
    ),
  ),
  file_id: optional(Schema.String),
  filename: optional(Schema.String),
  score: optional(Schema.Finite),
  text: optional(Schema.String),
});
const FileSearchCallSchema = jsonObject({
  type: Schema.Literal("file_search_call"),
  id: Schema.String,
  queries: mutableArray(Schema.String),
  status: Schema.Literals([
    "in_progress",
    "searching",
    "completed",
    "incomplete",
    "failed",
  ]),
  results: nullableOptional(mutableArray(FileSearchResultSchema)),
});
const SafetyCheckSchema = jsonObject({
  id: Schema.String,
  code: optional(Schema.String),
  message: optional(Schema.String),
});
const ComputerCallSchema = jsonObject({
  type: Schema.Literal("computer_call"),
  id: Schema.String,
  call_id: Schema.String,
  pending_safety_checks: mutableArray(SafetyCheckSchema),
  status: ProviderItemStatusSchema,
  action: optional(JsonObjectSchema),
  actions: optional(mutableArray(JsonObjectSchema)),
});
const ComputerCallOutputSchema = jsonObject({
  type: Schema.Literal("computer_call_output"),
  id: optional(Schema.String),
  call_id: Schema.String,
  output: JsonObjectSchema,
  status: optional(
    Schema.Literals(["in_progress", "completed", "incomplete", "failed"]),
  ),
  acknowledged_safety_checks: optional(mutableArray(SafetyCheckSchema)),
});
const ImageGenerationCallSchema = jsonObject({
  type: Schema.Literal("image_generation_call"),
  id: Schema.String,
  result: nullableOptional(Schema.String),
  status: Schema.Literals(["in_progress", "completed", "generating", "failed"]),
});
const CodeInterpreterOutputSchema = Schema.Union([
  jsonObject({ type: Schema.Literal("logs"), logs: Schema.String }),
  jsonObject({ type: Schema.Literal("image"), url: Schema.String }),
]);
const CodeInterpreterCallSchema = jsonObject({
  type: Schema.Literal("code_interpreter_call"),
  id: Schema.String,
  code: nullableOptional(Schema.String),
  container_id: Schema.String,
  outputs: nullableOptional(mutableArray(CodeInterpreterOutputSchema)),
  status: Schema.Literals([
    "in_progress",
    "completed",
    "incomplete",
    "interpreting",
    "failed",
  ]),
});
const LocalShellActionSchema = jsonObject({
  type: Schema.Literal("exec"),
  command: mutableArray(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  timeout_ms: optional(Schema.Natural),
  user: optional(Schema.String),
  working_directory: optional(Schema.String),
});
const LocalShellCallSchema = jsonObject({
  type: Schema.Literal("local_shell_call"),
  id: Schema.String,
  call_id: Schema.String,
  action: LocalShellActionSchema,
  status: ProviderItemStatusSchema,
});
const LocalShellCallOutputSchema = jsonObject({
  type: Schema.Literal("local_shell_call_output"),
  id: Schema.String,
  output: Schema.String,
  status: optional(ProviderItemStatusSchema),
});
const ShellCallActionSchema = jsonObject({
  commands: mutableArray(Schema.String),
  max_output_length: optional(Schema.Natural),
  timeout_ms: optional(Schema.Natural),
});
const ShellCallSchema = jsonObject({
  type: Schema.Literal("shell_call"),
  id: Schema.String,
  action: ShellCallActionSchema,
  call_id: Schema.String,
  environment: optional(JsonObjectSchema),
  status: ProviderItemStatusSchema,
  caller: ProviderCallerSchema,
});
const ShellCallOutputContentSchema = jsonObject({
  outcome: Schema.Union([
    jsonObject({ type: Schema.Literal("timeout") }),
    jsonObject({
      type: Schema.Literal("exit"),
      exit_code: Schema.Int,
    }),
  ]),
  stderr: Schema.String,
  stdout: Schema.String,
});
const ShellCallOutputSchema = jsonObject({
  type: Schema.Literal("shell_call_output"),
  id: Schema.String,
  call_id: Schema.String,
  max_output_length: optional(Schema.Natural),
  output: mutableArray(ShellCallOutputContentSchema),
  status: ProviderItemStatusSchema,
  caller: ProviderCallerSchema,
});
const ApplyPatchOperationSchema = Schema.Union([
  jsonObject({
    type: Schema.Literal("create_file"),
    diff: Schema.String,
    path: Schema.String,
  }),
  jsonObject({
    type: Schema.Literal("delete_file"),
    path: Schema.String,
  }),
  jsonObject({
    type: Schema.Literal("update_file"),
    diff: Schema.String,
    path: Schema.String,
  }),
]);
const ApplyPatchCallSchema = jsonObject({
  type: Schema.Literal("apply_patch_call"),
  id: Schema.String,
  call_id: Schema.String,
  operation: ApplyPatchOperationSchema,
  status: Schema.Literals(["in_progress", "completed"]),
  caller: ProviderCallerSchema,
});
const ApplyPatchCallOutputSchema = jsonObject({
  type: Schema.Literal("apply_patch_call_output"),
  id: Schema.String,
  call_id: Schema.String,
  status: Schema.Literals(["completed", "failed"]),
  caller: ProviderCallerSchema,
  output: optional(Schema.String),
});
const McpToolSchema = jsonObject({
  input_schema: JsonObjectSchema,
  name: Schema.String,
  annotations: optional(JsonObjectSchema),
  description: optional(Schema.String),
});
const McpCallSchema = jsonObject({
  type: Schema.Literal("mcp_call"),
  id: Schema.String,
  arguments: Schema.String,
  name: Schema.String,
  server_label: Schema.String,
  approval_request_id: nullableOptional(Schema.String),
  error: nullableOptional(Schema.String),
  output: nullableOptional(Schema.String),
  status: optional(
    Schema.Literals([
      "in_progress",
      "completed",
      "incomplete",
      "calling",
      "failed",
    ]),
  ),
});
const McpListToolsSchema = jsonObject({
  type: Schema.Literal("mcp_list_tools"),
  id: Schema.String,
  server_label: Schema.String,
  tools: mutableArray(McpToolSchema),
  error: optional(Schema.String),
});
const McpApprovalRequestSchema = jsonObject({
  type: Schema.Literal("mcp_approval_request"),
  id: Schema.String,
  arguments: Schema.String,
  name: Schema.String,
  server_label: Schema.String,
});
const McpApprovalResponseSchema = jsonObject({
  type: Schema.Literal("mcp_approval_response"),
  id: optional(Schema.String),
  approval_request_id: Schema.String,
  approve: Schema.Boolean,
  reason: optional(Schema.String),
});
const CustomToolCallSchema = jsonObject({
  type: Schema.Literal("custom_tool_call"),
  call_id: Schema.String,
  input: Schema.String,
  name: Schema.String,
  id: optional(Schema.String),
  caller: ProviderCallerSchema,
  namespace: optional(Schema.String),
});
const CustomToolCallOutputSchema = jsonObject({
  type: Schema.Literal("custom_tool_call_output"),
  call_id: Schema.String,
  output: Schema.Union([
    Schema.String,
    mutableArray(FunctionCallOutputContentSchema),
  ]),
  id: optional(Schema.String),
  caller: ProviderCallerSchema,
  status: optional(ProviderItemStatusSchema),
});
const ProgramSchema = jsonObject({
  type: Schema.Literal("program"),
  id: Schema.String,
  call_id: Schema.String,
  code: Schema.String,
  fingerprint: Schema.String,
});
const ProgramOutputSchema = jsonObject({
  type: Schema.Literal("program_output"),
  id: Schema.String,
  call_id: Schema.String,
  result: Schema.String,
  status: Schema.Literals(["completed", "incomplete"]),
});
const ToolSearchCallSchema = jsonObject({
  type: Schema.Literal("tool_search_call"),
  arguments: JsonValueSchema,
  id: Schema.String,
  call_id: Schema.NullOr(Schema.String),
  execution: Schema.Literals(["server", "client"]),
  status: ProviderItemStatusSchema,
  created_by: optional(Schema.String),
});
const ToolSearchOutputSchema = jsonObject({
  type: Schema.Literal("tool_search_output"),
  id: Schema.String,
  call_id: Schema.NullOr(Schema.String),
  execution: Schema.Literals(["server", "client"]),
  status: ProviderItemStatusSchema,
  tools: mutableArray(ToolDefinitionSchema),
  created_by: optional(Schema.String),
});
const AdditionalToolsSchema = jsonObject({
  type: Schema.Literal("additional_tools"),
  role: Schema.Literals([
    "unknown",
    "user",
    "assistant",
    "system",
    "critic",
    "discriminator",
    "developer",
    "tool",
  ]),
  tools: mutableArray(ToolDefinitionSchema),
  id: optional(Schema.String),
});
const ItemReferenceSchema = jsonObject({
  type: Schema.Literal("item_reference"),
  id: Schema.String,
});

export const OpaqueProviderItemSchema = jsonObject({
  type: Schema.NonEmptyString,
}).pipe(
  Schema.check(
    Schema.makeFilter((value) => !knownResponseTypes.has(value.type), {
      expected: "an unknown provider-item type",
    }),
  ),
  Schema.brand("OpaqueProviderItem"),
);

export const ResponseItemSchema = Schema.Union([
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
  ItemReferenceSchema,
  OpaqueProviderItemSchema,
]);

export const ResponseItemsSchema = mutableArray(ResponseItemSchema);

const TokenCountSchema = Schema.Natural;
const InputTokenDetailsSchema = jsonObject({
  cached_tokens: optional(TokenCountSchema),
  cache_write_tokens: optional(TokenCountSchema),
});
const OutputTokenDetailsSchema = jsonObject({
  reasoning_tokens: optional(TokenCountSchema),
});
const CompleteInputTokenDetailsSchema = jsonObject({
  cached_tokens: TokenCountSchema,
  cache_write_tokens: optional(TokenCountSchema),
});
const CompleteOutputTokenDetailsSchema = jsonObject({
  reasoning_tokens: TokenCountSchema,
});
const CompleteResponseUsageSchema = jsonObject({
  input_tokens: TokenCountSchema,
  input_tokens_details: CompleteInputTokenDetailsSchema,
  output_tokens: TokenCountSchema,
  output_tokens_details: CompleteOutputTokenDetailsSchema,
  total_tokens: TokenCountSchema,
});

export const ResponseUsageSchema = jsonObject({
  input_tokens: optional(TokenCountSchema),
  output_tokens: optional(TokenCountSchema),
  total_tokens: optional(TokenCountSchema),
  input_tokens_details: optional(InputTokenDetailsSchema),
  output_tokens_details: optional(OutputTokenDetailsSchema),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (value) =>
        value.input_tokens !== undefined ||
        value.output_tokens !== undefined ||
        value.total_tokens !== undefined ||
        value.input_tokens_details !== undefined ||
        value.output_tokens_details !== undefined,
      { expected: "a non-empty response usage observation" },
    ),
  ),
);

const NativeReplacementInputSchema = mutableArray(ResponseItemSchema).pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.makeFilter(
      (value) =>
        value.filter((item) => item.type === "compaction").length === 1,
      { expected: "replacement input containing exactly one compaction item" },
    ),
  ),
);

export const NativeCompactionStateV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  provider: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  replacementInput: NativeReplacementInputSchema,
  usage: optional(ResponseUsageSchema),
});

const NativeCompactionStateV2Base = {
  version: Schema.Literal(2),
  implementation: Schema.Literal("responses_compaction_v2"),
  model: Schema.NonEmptyString,
  replacementInput: NativeReplacementInputSchema,
  usage: optional(ResponseUsageSchema),
};

export const NativeCompactionStateV2Schema = Schema.Union([
  Schema.Struct({
    ...NativeCompactionStateV2Base,
    provider: Schema.Literal("openai"),
    api: Schema.Literal("openai-responses"),
  }),
  Schema.Struct({
    ...NativeCompactionStateV2Base,
    provider: Schema.Literal("openai-codex"),
    api: Schema.Literal("openai-codex-responses"),
  }),
]);

export const NativeCompactionStateSchema = Schema.Union([
  NativeCompactionStateV1Schema,
  NativeCompactionStateV2Schema,
]);

export const ProviderRequestPayloadSchema = Schema.StructWithRest(
  Schema.Struct({
    model: optional(Schema.String),
    input: mutableArray(JsonValueSchema),
  }),
  [Schema.Record(Schema.String, Schema.optional(JsonValueSchema))],
);

export const DirectCompactResponseSchema = jsonObject({
  id: Schema.NonEmptyString,
  created_at: Schema.Finite,
  object: Schema.Literal("response.compaction"),
  output: mutableArray(ResponseItemSchema).pipe(
    Schema.check(Schema.isMinLength(1)),
  ),
  usage: CompleteResponseUsageSchema,
});

export const ProviderEventSchema = jsonObject({
  type: Schema.NonEmptyString,
});

export const OutputItemDoneEventSchema = jsonObject({
  type: Schema.Literal("response.output_item.done"),
  item: ResponseItemSchema,
});

const TerminalResponseSchema = jsonObject({
  status: optional(Schema.String),
  output: optional(JsonValueSchema),
  usage: optional(JsonValueSchema),
});

export const TerminalEventSchema = jsonObject({
  type: Schema.Literals(["response.completed", "response.done"]),
  response: TerminalResponseSchema,
});

type MutableProperties<T> = T extends object
  ? { -readonly [Key in keyof T]: T[Key] }
  : T;

export type ResponseContentItem = MutableProperties<
  typeof ResponseContentItemSchema.Type
>;
export type CompactionArtifact = MutableProperties<
  typeof CompactionArtifactSchema.Type
>;
export type OpaqueProviderItem = MutableProperties<
  typeof OpaqueProviderItemSchema.Type
>;
export type ResponseItem = MutableProperties<typeof ResponseItemSchema.Type>;
export type ResponseUsage = typeof ResponseUsageSchema.Type;
export type NativeCompactionStateV1 = typeof NativeCompactionStateV1Schema.Type;
export type NativeCompactionStateV2 = typeof NativeCompactionStateV2Schema.Type;
export type NativeCompactionState = typeof NativeCompactionStateSchema.Type;
export type NativeCompactionProvider = NativeCompactionStateV2["provider"];
export type NativeCompactionApi = NativeCompactionStateV2["api"];
export type ProviderRequestPayload = typeof ProviderRequestPayloadSchema.Type;
export type ProviderEvent = typeof ProviderEventSchema.Type;

function decodePreservingExcess<
  const S extends Schema.ConstraintDecoder<unknown>,
>(
  schema: S,
  value: unknown,
): S["Type"] | undefined {
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(schema, {
      onExcessProperty: "preserve",
    })(value),
  );
}

export function parseJsonValue(value: unknown): JsonValue | undefined {
  return decodePreservingExcess(JsonValueSchema, value);
}

export function parseJsonObject(value: unknown): JsonObject | undefined {
  return decodePreservingExcess(JsonObjectSchema, value);
}

export function parseResponseContentItem(
  value: unknown,
): ResponseContentItem | undefined {
  return decodePreservingExcess(ResponseContentItemSchema, value);
}

export function parseResponseReasoningItem(
  value: unknown,
): typeof ResponseReasoningItemSchema.Type | undefined {
  return decodePreservingExcess(ResponseReasoningItemSchema, value);
}

export function parseNativeCompactionState(
  value: unknown,
): NativeCompactionState | undefined {
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(NativeCompactionStateSchema, {
      onExcessProperty: "error",
    })(value),
  );
}

export function parseProviderRequestPayload(
  value: unknown,
): ProviderRequestPayload | undefined {
  return decodePreservingExcess(ProviderRequestPayloadSchema, value);
}

export function parseProviderEvent(value: unknown): ProviderEvent | undefined {
  return decodePreservingExcess(ProviderEventSchema, value);
}

export function parseOutputItemDoneEvent(
  value: unknown,
): typeof OutputItemDoneEventSchema.Type | undefined {
  return decodePreservingExcess(OutputItemDoneEventSchema, value);
}

export function parseTerminalEvent(
  value: unknown,
): typeof TerminalEventSchema.Type | undefined {
  return decodePreservingExcess(TerminalEventSchema, value);
}

export function parseDirectCompactResponse(
  value: unknown,
): typeof DirectCompactResponseSchema.Type | undefined {
  return decodePreservingExcess(DirectCompactResponseSchema, value);
}

export function parseResponseItem(value: unknown): ResponseItem | undefined {
  return decodePreservingExcess(ResponseItemSchema, value);
}

export function parseResponseItems(value: unknown): ResponseItem[] | undefined {
  return decodePreservingExcess(ResponseItemsSchema, value);
}

export function parseResponseUsage(value: unknown): ResponseUsage | undefined {
  return decodePreservingExcess(ResponseUsageSchema, value);
}

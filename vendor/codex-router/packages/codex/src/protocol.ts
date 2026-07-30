import { Schema } from "effect"

export const AccountKind = Schema.Literals(["codex_subscription", "openai_api_key"])
export type AccountKind = typeof AccountKind.Type

export type SupportedResponsePath =
  | "/responses"
  | "/v1/responses"
  | "/codex/responses"
  | "/responses/compact"
  | "/v1/responses/compact"

export const supportedResponsePaths: ReadonlyArray<SupportedResponsePath> = [
  "/responses",
  "/v1/responses",
  "/codex/responses",
  "/responses/compact",
  "/v1/responses/compact"
]

export const isSupportedResponsePath = (path: string): path is SupportedResponsePath =>
  supportedResponsePaths.some((supported) => supported === path)

export const resolveUpstreamTarget = (path: string, accountKind: AccountKind): string => {
  if (accountKind === "codex_subscription") {
    return "https://chatgpt.com/backend-api/codex/responses"
  }
  return path.endsWith("/compact")
    ? "https://api.openai.com/v1/responses/compact"
    : "https://api.openai.com/v1/responses"
}

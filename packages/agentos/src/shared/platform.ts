import { ConfigProvider } from "effect";

/** Explicit live configuration boundary for AgentOS Effect programs. */
export function environmentConfigLayer() {
  return ConfigProvider.layer(ConfigProvider.fromEnv());
}

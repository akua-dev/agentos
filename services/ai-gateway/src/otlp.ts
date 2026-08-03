import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import { Layer } from "effect";
import * as Otlp from "effect/unstable/observability/Otlp";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";

export const AIGatewayOtlpLive = Otlp.layerFromConfig({
  loggerExcludeLogSpans: true,
  resource: { serviceName: "agentos-ai-gateway" },
}).pipe(
  Layer.provide(OtlpSerialization.layerProtobuf),
  Layer.provide(BunHttpClient.layer),
);

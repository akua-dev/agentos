export interface OtlpSinkRequest {
  path: string;
  body: Uint8Array;
  accepted: boolean;
}

export interface OtlpTestSink {
  readonly requests: OtlpSinkRequest[];
  readonly remoteEndpoint: string;
  setAvailable(available: boolean): void;
  stop(): void;
}

export function createOtlpTestSink(): OtlpTestSink {
  let available = false;
  const requests: OtlpSinkRequest[] = [];
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      const encoded = new Uint8Array(await request.arrayBuffer());
      const body =
        request.headers.get("content-encoding")?.toLowerCase() === "gzip"
          ? Bun.gunzipSync(encoded)
          : encoded;
      requests.push({
        path: new URL(request.url).pathname,
        body,
        accepted: available,
      });
      return new Response(null, { status: available ? 200 : 503 });
    },
  });
  return {
    requests,
    remoteEndpoint: `http://host.docker.internal:${server.port}`,
    setAvailable(value) {
      available = value;
    },
    stop() {
      server.stop(true);
    },
  };
}

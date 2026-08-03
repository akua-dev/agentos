import { Effect, Schema } from "effect";

export class BunTestServerError extends Schema.TaggedErrorClass<BunTestServerError>()(
  "BunTestServerError",
  {
    operation: Schema.Literals(["start", "request"]),
    detail: Schema.String,
  },
) {}

function serverError(
  operation: typeof BunTestServerError.fields.operation.Type,
  detail: string,
) {
  return BunTestServerError.make({ operation, detail });
}

/** One-way adapter from Effect request programs into Bun's Promise HTTP ABI. */
export function acquireBunTestServer<E>(
  program: (request: Request) => Effect.Effect<Response, E>,
  options: {
    readonly hostname?: string;
    readonly port?: number;
  } = {},
) {
  return Effect.acquireRelease(
    Effect.try({
      try: () => Bun.serve({
        hostname: options.hostname ?? "127.0.0.1",
        port: options.port ?? 0,
        fetch: (request) => Effect.runPromise(program(request)),
      }),
      catch: () => serverError("start", "Bun test server failed to start"),
    }).pipe(
      Effect.flatMap((server) => {
        if (server.port !== undefined) {
          return Effect.succeed({ port: server.port, server });
        }
        return Effect.sync(() => server.stop(true)).pipe(
          Effect.andThen(serverError("start", "Bun allocated no test port")),
        );
      }),
    ),
    ({ server }) => Effect.sync(() => server.stop(true)),
  );
}

export const allocateBunTestPort = Effect.fn("test.bunHttp.allocatePort")(() =>
  Effect.acquireUseRelease(
    acquireBunTestServer(() => Effect.succeed(new Response())),
    ({ port }) => Effect.succeed(port),
    ({ server }) => Effect.sync(() => server.stop(true)),
  ));

export const readWebRequestText = Effect.fn("test.bunHttp.readText")(
  (request: Request) => Effect.tryPromise({
    try: () => request.text(),
    catch: () => serverError("request", "test request body could not be read"),
  }),
);

export const readWebRequestBytes = Effect.fn("test.bunHttp.readBytes")(
  (request: Request) => Effect.tryPromise({
    try: () => request.arrayBuffer().then((body) => new Uint8Array(body)),
    catch: () => serverError("request", "test request body could not be read"),
  }),
);

export function decodeWebRequestJson<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
) {
  return (request: Request) =>
    readWebRequestText(request).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
    );
}

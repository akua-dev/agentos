import type { DiscordGatewayDispatch } from "./events.ts";

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DiscordGatewayOptions {
  token: string;
  apiBaseUrl?: string;
  signal?: AbortSignal;
  random?: () => number;
  fetchImpl?: FetchImplementation;
  onDispatch(dispatch: DiscordGatewayDispatch): Promise<void>;
}

export async function runDiscordGateway(
  options: DiscordGatewayOptions,
): Promise<void> {
  const signal = options.signal;
  if (signal?.aborted) return;
  const gatewayUrl = await getGatewayUrl(options);
  let session: GatewaySession | undefined;
  let reconnectDelay = 250;

  while (!signal?.aborted) {
    const outcome = await connectOnce(gatewayUrl, session, options);
    if (outcome.kind === "stopped") return;
    if (outcome.kind === "fatal") throw outcome.error;
    session = outcome.session;
    if (signal?.aborted) return;
    await abortableDelay(reconnectDelay, signal);
    reconnectDelay = Math.min(reconnectDelay * 2, 5_000);
  }
}

type GatewaySession = {
  id: string;
  sequence: number;
  resumeUrl: string;
};

type ConnectionOutcome =
  | { kind: "stopped" }
  | { kind: "reconnect"; session?: GatewaySession }
  | { kind: "fatal"; error: Error };

const DISCORD_GATEWAY_INTENTS = 1 | 512 | 4_096 | 32_768;
const FATAL_CLOSE_CODES = new Set([4_004, 4_010, 4_011, 4_012, 4_013, 4_014]);
const NON_RESUMABLE_CLOSE_CODES = new Set([1_000, 1_001, 4_007, 4_009]);

async function getGatewayUrl(options: DiscordGatewayOptions): Promise<string> {
  const base = options.apiBaseUrl ?? "https://discord.com/api/v10";
  const response = await (options.fetchImpl ?? fetch)(
    `${base.replace(/\/$/, "")}/gateway/bot`,
    { headers: { authorization: `Bot ${options.token}` } },
  );
  if (!response.ok) {
    throw new Error(`Discord Gateway discovery returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { url?: unknown };
  if (typeof payload.url !== "string") {
    throw new Error("Discord Gateway discovery omitted its WebSocket URL");
  }
  const url = new URL(payload.url);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error("Discord Gateway discovery returned a non-WebSocket URL");
  }
  return url.toString();
}

function connectOnce(
  initialGatewayUrl: string,
  previousSession: GatewaySession | undefined,
  options: DiscordGatewayOptions,
): Promise<ConnectionOutcome> {
  const gatewayUrl = new URL(previousSession?.resumeUrl ?? initialGatewayUrl);
  gatewayUrl.searchParams.set("v", "10");
  gatewayUrl.searchParams.set("encoding", "json");
  const socket = new WebSocket(gatewayUrl);
  let session = previousSession;
  let sequence = previousSession?.sequence ?? 0;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatAcknowledged = true;
  let settled = false;
  let processing = Promise.resolve();

  return new Promise<ConnectionOutcome>((resolve) => {
    const cleanup = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      options.signal?.removeEventListener("abort", onAbort);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const settle = (outcome: ConnectionOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const close = () => {
      try {
        socket.close(4_000, "reconnect");
      } catch {
        // The connection outcome remains authoritative when close races setup.
      }
    };
    const reconnect = (canResume = true) => {
      settle({
        kind: "reconnect",
        ...(canResume && session
          ? { session: { ...session, sequence } }
          : {}),
      });
      close();
    };
    const afterProcessing = (callback: () => void) => {
      const pending = processing;
      void pending.then(() => {
        if (!settled) callback();
      });
    };
    const reconnectAfterProcessing = (canResume = true) => {
      afterProcessing(() => reconnect(canResume));
    };
    const fail = (error: Error) => {
      settle({ kind: "fatal", error });
      close();
    };
    const onAbort = () => {
      settle({ kind: "stopped" });
      try {
        socket.close(1_000, "shutdown");
      } catch {
        // An unopened socket still resolves through the stopped outcome.
      }
    };
    const sendHeartbeat = () => {
      if (settled || socket.readyState !== WebSocket.OPEN) return;
      if (!heartbeatAcknowledged) {
        reconnectAfterProcessing(true);
        return;
      }
      heartbeatAcknowledged = false;
      socket.send(JSON.stringify({ op: 1, d: sequence || null }));
    };
    const scheduleHeartbeat = (interval: number) => {
      const heartbeat = () => {
        sendHeartbeat();
        if (!settled) heartbeatTimer = setTimeout(heartbeat, interval);
      };
      heartbeatTimer = setTimeout(
        heartbeat,
        interval * (options.random ?? Math.random)(),
      );
    };
    const onMessage = (event: MessageEvent) => {
      processing = processing
        .then(async () => {
          if (settled) return;
          const payload = parseGatewayPayload(event.data);
          if (typeof payload.s === "number") sequence = payload.s;

          if (payload.op === 10) {
            const interval = asHeartbeatInterval(payload.d);
            scheduleHeartbeat(interval);
            if (session) {
              socket.send(
                JSON.stringify({
                  op: 6,
                  d: {
                    token: options.token,
                    session_id: session.id,
                    seq: sequence,
                  },
                }),
              );
            } else {
              socket.send(
                JSON.stringify({
                  op: 2,
                  d: {
                    token: options.token,
                    intents: DISCORD_GATEWAY_INTENTS,
                    properties: {
                      os: process.platform,
                      browser: "agentos-discord-ingress",
                      device: "agentos-discord-ingress",
                    },
                  },
                }),
              );
            }
            return;
          }
          if (payload.op === 11) {
            heartbeatAcknowledged = true;
            return;
          }
          if (payload.op === 1) {
            sendHeartbeat();
            return;
          }
          if (payload.op === 7) {
            reconnectAfterProcessing(true);
            return;
          }
          if (payload.op === 9) {
            reconnectAfterProcessing(payload.d === true);
            return;
          }
          if (payload.op !== 0 || !payload.t || typeof payload.s !== "number") {
            return;
          }

          const dispatch = payload as DiscordGatewayDispatch;
          if (dispatch.t === "READY") {
            const data = asObject(dispatch.d);
            const id = stringValue(data.session_id);
            const resumeUrl = stringValue(data.resume_gateway_url);
            if (!id || !resumeUrl) {
              throw new Error("Discord READY omitted resume state");
            }
            session = { id, resumeUrl, sequence };
          }
          await options.onDispatch(dispatch);
        })
        .catch((error) =>
          fail(error instanceof Error ? error : new Error(String(error))),
        );
    };
    const onClose = (event: CloseEvent) => {
      if (settled) return;
      if (FATAL_CLOSE_CODES.has(event.code)) {
        afterProcessing(() =>
          fail(new Error(`Discord Gateway closed with fatal code ${event.code}`)),
        );
      } else {
        reconnectAfterProcessing(!NON_RESUMABLE_CLOSE_CODES.has(event.code));
      }
    };
    const onError = () => undefined;

    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    if (options.signal?.aborted) onAbort();
  });
}

type GatewayPayload = {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
};

function parseGatewayPayload(value: unknown): GatewayPayload {
  const text = typeof value === "string" ? value : String(value);
  const payload = JSON.parse(text) as Record<string, unknown>;
  if (typeof payload.op !== "number") {
    throw new Error("Discord Gateway payload omitted its opcode");
  }
  return {
    op: payload.op,
    d: payload.d,
    ...(typeof payload.s === "number" || payload.s === null
      ? { s: payload.s }
      : {}),
    ...(typeof payload.t === "string" || payload.t === null
      ? { t: payload.t }
      : {}),
  };
}

function asHeartbeatInterval(value: unknown): number {
  const interval = asObject(value).heartbeat_interval;
  if (typeof interval !== "number" || interval <= 0) {
    throw new Error("Discord HELLO omitted its heartbeat interval");
  }
  return interval;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

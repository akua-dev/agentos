import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";

import { startBackgroundCommand } from "./command.ts";
import type {
  BackgroundCommandRequest,
  StartBackgroundCommand,
  TaskContext,
  TaskEvent,
  TaskHandle,
  TaskSnapshot,
  TaskTerminalResult,
} from "./types.ts";

type BrokerOptions = {
  rootDirectory: string;
  startCommand?: StartBackgroundCommand;
  createId?: () => string;
  now?: () => Date;
  tailBytes?: number;
  maxOutputBytes?: number;
  terminateGraceMs?: number;
};

type TaskRecord = {
  request: BackgroundCommandRequest;
  snapshot: TaskSnapshot;
  controller: AbortController;
  handle?: TaskHandle;
  terminal: Promise<void>;
  resolveTerminal(): void;
  blockingWaiters: number;
  suppressWake: boolean;
  finalizing?: Promise<void>;
};

export class BackgroundTaskBroker {
  readonly #records = new Map<string, TaskRecord>();
  readonly #listeners = new Set<(event: TaskEvent) => void>();
  readonly #rootDirectory: string;
  readonly #startCommand: StartBackgroundCommand;
  readonly #createId: () => string;
  readonly #now: () => Date;
  readonly #tailBytes: number;
  readonly #maxOutputBytes: number;
  readonly #terminateGraceMs: number;
  #shuttingDown = false;

  constructor(options: BrokerOptions) {
    this.#rootDirectory = options.rootDirectory;
    this.#startCommand = options.startCommand ?? startBackgroundCommand;
    this.#createId =
      options.createId ?? (() => `bg-${randomUUID().replaceAll("-", "").slice(0, 12)}`);
    this.#now = options.now ?? (() => new Date());
    this.#tailBytes = options.tailBytes ?? 64 * 1024;
    this.#maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024 * 1024;
    this.#terminateGraceMs = options.terminateGraceMs ?? 2_000;
  }

  onEvent(listener: (event: TaskEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(request: BackgroundCommandRequest): Promise<TaskSnapshot> {
    if (this.#shuttingDown) throw new Error("Background command broker is shutting down");
    const record = this.#createRecord(request);
    try {
      record.handle = await this.#startCommand(request, this.#context(record));
      void record.handle.completion.then(
        (result) => this.#finalize(record, result),
        (error: unknown) =>
          this.#finalize(record, {
            state: "failed",
            summary: "Background command failed",
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    } catch (error) {
      await this.#finalize(record, {
        state: "failed",
        summary: "Background command failed to start",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.get(record.snapshot.id);
  }

  async get(
    id: string,
    options: {
      waitMs?: number;
      outputBytes?: number;
      observeCompletion?: boolean;
    } = {},
  ): Promise<TaskSnapshot> {
    const record = this.#requiredRecord(id);
    if (record.snapshot.state === "running" && (options.waitMs ?? 0) > 0) {
      record.blockingWaiters += 1;
      const completed = await Promise.race([
        record.terminal.then(() => true),
        Bun.sleep(options.waitMs!).then(() => false),
      ]);
      record.blockingWaiters -= 1;
      if (completed) record.snapshot.completionObserved = true;
    }
    if (options.observeCompletion && record.snapshot.state !== "running") {
      record.snapshot.completionObserved = true;
    }
    await this.#refreshOutput(record, options.outputBytes ?? this.#tailBytes);
    return structuredClone(record.snapshot);
  }

  async list(): Promise<TaskSnapshot[]> {
    const snapshots = await Promise.all(
      [...this.#records.keys()].map((id) => this.get(id, { outputBytes: 0 })),
    );
    return snapshots.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async kill(id: string): Promise<TaskSnapshot> {
    const record = this.#requiredRecord(id);
    record.snapshot.explicitlyKilled = true;
    record.snapshot.completionObserved = true;
    record.suppressWake = true;
    if (record.snapshot.state !== "running") return this.get(id);
    record.controller.abort();
    if (record.handle) {
      await this.#finalize(record, await record.handle.stop());
    } else {
      await this.#finalize(record, {
        state: "cancelled",
        summary: "Background command killed before start",
      });
    }
    await record.terminal;
    return this.get(id);
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    await Promise.all(
      [...this.#records.values()].map(async (record) => {
        if (record.snapshot.state !== "running") return;
        record.suppressWake = true;
        record.controller.abort();
        if (record.handle) {
          await this.#finalize(record, await record.handle.stop());
        } else {
          await this.#finalize(record, {
            state: "cancelled",
            summary: "Background command stopped during Pi shutdown",
          });
        }
        await record.terminal;
      }),
    );
  }

  #createRecord(request: BackgroundCommandRequest): TaskRecord {
    const id = this.#createId();
    if (this.#records.has(id)) throw new Error(`Background command ${id} already exists`);
    const createdAt = this.#now().toISOString();
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const snapshot: TaskSnapshot = {
      id,
      command: request.command,
      description: request.description,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      state: "running",
      createdAt,
      startedAt: createdAt,
      outputPath: join(this.#rootDirectory, `${id}.log`),
      outputTail: "",
      outputTruncated: false,
      outputBytes: 0,
      completionObserved: false,
      explicitlyKilled: false,
    };
    const record: TaskRecord = {
      request: structuredClone(request),
      snapshot,
      controller: new AbortController(),
      terminal,
      resolveTerminal,
      blockingWaiters: 0,
      suppressWake: false,
    };
    this.#records.set(id, record);
    this.#emit({ type: "task_started", task: structuredClone(snapshot) });
    return record;
  }

  async #finalize(record: TaskRecord, result: TaskTerminalResult) {
    if (record.snapshot.state !== "running") return;
    if (record.finalizing) return record.finalizing;
    record.finalizing = (async () => {
      await this.#refreshOutput(record, this.#tailBytes);
      const finished = this.#now();
      record.snapshot.state = result.state;
      record.snapshot.finishedAt = finished.toISOString();
      record.snapshot.durationMs = Math.max(
        0,
        finished.getTime() - new Date(record.snapshot.startedAt).getTime(),
      );
      record.snapshot.summary = result.summary;
      record.snapshot.exitCode = result.exitCode;
      record.snapshot.signal = result.signal;
      record.snapshot.error = result.error;
      record.snapshot.completionObserved =
        record.suppressWake || record.blockingWaiters > 0;
      this.#emit({ type: "task_terminal", task: structuredClone(record.snapshot) });
      record.resolveTerminal();
    })();
    return record.finalizing;
  }

  #context(record: TaskRecord): TaskContext {
    return {
      outputPath: record.snapshot.outputPath,
      tailBytes: this.#tailBytes,
      maxOutputBytes: this.#maxOutputBytes,
      terminateGraceMs: this.#terminateGraceMs,
      signal: record.controller.signal,
    };
  }

  #requiredRecord(id: string) {
    const record = this.#records.get(id);
    if (!record) throw new Error(`Unknown background command: ${id}`);
    return record;
  }

  async #refreshOutput(record: TaskRecord, maximumBytes: number) {
    try {
      const info = await stat(record.snapshot.outputPath);
      const bytes = Math.max(0, Math.min(maximumBytes, info.size));
      const buffer = Buffer.alloc(bytes);
      const file = await open(record.snapshot.outputPath, "r");
      try {
        if (bytes > 0) await file.read(buffer, 0, bytes, info.size - bytes);
      } finally {
        await file.close();
      }
      record.snapshot.outputBytes = info.size;
      record.snapshot.outputTail = buffer.toString("utf8");
      record.snapshot.outputTruncated = info.size > bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  #emit(event: TaskEvent) {
    for (const listener of this.#listeners) listener(event);
  }
}

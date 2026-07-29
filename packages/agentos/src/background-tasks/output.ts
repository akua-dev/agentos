import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

export class TaskOutputLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Background task output reached the ${maxBytes}-byte limit`);
    this.name = "TaskOutputLimitError";
  }
}

export class BoundedTaskOutput {
  static async open(
    path: string,
    options: { tailBytes?: number; maxBytes?: number } = {},
  ) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, "w", 0o600);
    return new BoundedTaskOutput(
      path,
      file,
      options.tailBytes ?? DEFAULT_TAIL_BYTES,
      options.maxBytes ?? DEFAULT_MAX_BYTES,
    );
  }

  readonly path: string;
  bytesWritten = 0;
  truncated = false;
  limitReached = false;

  #tail = Buffer.alloc(0);
  #pending: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    path: string,
    private readonly file: FileHandle,
    private readonly tailBytes: number,
    private readonly maxBytes: number,
  ) {
    if (tailBytes < 0 || maxBytes <= 0) {
      throw new Error("Output limits must be positive");
    }
    this.path = path;
  }

  write(chunk: Uint8Array): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Task output is closed"));
    const copy = Buffer.from(chunk);
    const write = this.#pending.then(async () => {
      const remaining = Math.max(0, this.maxBytes - this.bytesWritten);
      const accepted = copy.subarray(0, remaining);
      if (accepted.length > 0) {
        await this.file.write(accepted);
        this.bytesWritten += accepted.length;
        this.#appendTail(accepted);
      }
      if (accepted.length !== copy.length) {
        this.limitReached = true;
        throw new TaskOutputLimitError(this.maxBytes);
      }
    });
    this.#pending = write.catch(() => undefined);
    return write;
  }

  tail(): string {
    return this.#tail.toString("utf8");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pending;
    await this.file.close();
  }

  #appendTail(chunk: Buffer) {
    if (this.tailBytes === 0) {
      this.truncated ||= this.bytesWritten > 0;
      return;
    }
    const combined = Buffer.concat([this.#tail, chunk]);
    if (combined.length > this.tailBytes) {
      this.#tail = combined.subarray(combined.length - this.tailBytes);
      this.truncated = true;
    } else {
      this.#tail = combined;
    }
  }
}

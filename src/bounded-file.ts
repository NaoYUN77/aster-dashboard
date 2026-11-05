import { constants } from "node:fs";
import { open } from "node:fs/promises";

export type BoundedFileFailure = "UNREADABLE" | "NOT_REGULAR_FILE" | "TOO_LARGE";

export class BoundedFileError extends Error {
  constructor(readonly code: BoundedFileFailure) {
    super(code);
    this.name = "BoundedFileError";
  }
}

/**
 * Read at most `limit` bytes from a regular file. The nonblocking open prevents a supplied FIFO
 * from hanging an offline check on POSIX; the caller decides how to report each failure.
 */
export async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    throw new BoundedFileError("UNREADABLE");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new BoundedFileError("NOT_REGULAR_FILE");
    if (stat.size > limit) throw new BoundedFileError("TOO_LARGE");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new BoundedFileError("TOO_LARGE");
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof BoundedFileError) throw error;
    throw new BoundedFileError("UNREADABLE");
  } finally {
    await file.close();
  }
}

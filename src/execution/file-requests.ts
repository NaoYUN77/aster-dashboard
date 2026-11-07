// One file primitive over a session's virtual roots.
//
// Interface: `handleFileRequest()` dispatches the wire method to `FileService` and translates
// its failures into the protocol's codes.
//
// Inputs: the service that owns the session's roots, the session key that owns opened handles, and
// the request as it arrived. The host never chooses a path; the service validates and maps it.
//
// Errors: a write may have reached its rename when it was interrupted, so its outcome is reported
// as unknown rather than as a clean failure. Every other file failure has no side effect to doubt.

import { FileServiceError, type FileService } from "./file-service.js";
import { DirectHostError } from "./direct-host.js";
import type { RpcErrorCode, RpcFileMethod } from "./rpc-protocol.js";

const FILE_ERROR_CODES = new Set<RpcErrorCode>([
  "invalid_request", "not_found", "permission_denied", "not_directory", "is_directory",
  "too_large", "aborted", "busy", "not_implemented", "internal",
]);

/** File failures never carry a side effect whose outcome could be unknown. */
export function fileHostError(error: unknown): DirectHostError {
  if (error instanceof FileServiceError) {
    const code: RpcErrorCode = FILE_ERROR_CODES.has(error.code as RpcErrorCode)
      ? error.code as RpcErrorCode
      : "internal";
    return new DirectHostError(code, error.message, "failed");
  }
  return new DirectHostError("internal", "the file operation failed", "failed");
}

export async function handleFileRequest(
  files: FileService,
  sessionId: string,
  input: {
    readonly method: RpcFileMethod;
    readonly payload: Record<string, unknown>;
    readonly signal: AbortSignal;
  },
): Promise<unknown> {
  try {
    switch (input.method) {
      case "file.stat":
        return await files.info(input.payload.path as string);
      case "file.exists":
        return { exists: await files.exists(input.payload.path as string) };
      case "file.canonical":
        return { path: await files.canonical(input.payload.path as string) };
      case "file.open":
        return await files.open(sessionId, input.payload.path as string, {
          ...(input.payload.noFollow === true ? { noFollow: true } : {}),
        });
      case "file.read":
        return await files.read(
          sessionId,
          input.payload.handle as string,
          input.payload.offset as number,
          input.payload.length as number,
        );
      case "file.scanLines":
        return await files.scanLines(
          sessionId,
          input.payload.handle as string,
          input.payload.startLine as number,
          input.payload.endLine as number | undefined,
          input.signal,
        );
      case "file.close":
        await files.close(sessionId, input.payload.handle as string);
        return {};
      case "file.readText":
        return await files.readText(input.payload.path as string, input.signal);
      case "file.write":
        return await files.write(input.payload.path as string, input.payload.content as string, input.signal);
    }
  } catch (error) {
    if (input.method === "file.write" && error instanceof FileServiceError
      && (error.code === "aborted" || error.code === "unknown")) {
      // The write may or may not have reached its rename: never report a clean failure.
      throw new DirectHostError(
        FILE_ERROR_CODES.has(error.code as RpcErrorCode) ? error.code as RpcErrorCode : "internal",
        error.message,
        "unknown",
      );
    }
    throw fileHostError(error);
  }
}

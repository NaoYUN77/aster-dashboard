// Configuration problems are reported to the operator, so their messages must never include
// secret values: only variable names and expected choices.
export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

// Startup state that blocks service without being a configuration mistake, such as a data directory
// bound to another identity. Its message is operator-facing and safe to log.
export class StateError extends Error {
  override name = "StateError";
}

// A requested object does not exist. Host surfaces answer it with a 404 instead of treating it as
// an invalid request, which keeps "you sent something wrong" and "it is not there" distinguishable.
export class NotFoundError extends StateError {
  override name = "NotFoundError";
}

// The request is well-formed but conflicts with the object's current state: a bot that is running,
// has queued input, or holds work whose outcome is unknown. `message` is a stable snake_case reason
// the console answers with verbatim, and `extra` carries only metadata the caller may act on.
export class ConflictError extends StateError {
  override name = "ConflictError";
  constructor(message: string, readonly extra?: Readonly<Record<string, unknown>>) {
    super(message);
  }
}

// The object was removed and will not come back: a bot whose deletion was already accepted. It stays
// distinct from "disabled" so an operator can tell "I deleted this" from "this is switched off".
export class GoneError extends StateError {
  override name = "GoneError";
}

export function failureCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z_]{0,63}$/.test(error.code)) return error.code;
  if (error instanceof Error && error.name === "TimeoutError") return "TIMEOUT";
  return "EXECUTION_ERROR";
}

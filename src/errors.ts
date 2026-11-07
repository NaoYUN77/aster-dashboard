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

export function failureCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z_]{0,63}$/.test(error.code)) return error.code;
  if (error instanceof Error && error.name === "TimeoutError") return "TIMEOUT";
  return "EXECUTION_ERROR";
}

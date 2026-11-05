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

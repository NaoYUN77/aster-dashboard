import { TextDecoder } from "node:util";

export type StrictJsonFailure = "TOO_LARGE" | "INVALID_JSON" | "DUPLICATE_KEY";

export class StrictJsonError extends Error {
  constructor(readonly code: StrictJsonFailure) {
    super(code);
    this.name = "StrictJsonError";
  }
}

// JSON.parse discards duplicate keys. Reject them, including escaped aliases, before trusting the result.
function rejectDuplicateKeys(text: string): void {
  const stack: (Set<string> | null)[] = [];
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]]/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (text.slice(match.index + token.length).trimStart().startsWith(":")) {
      const keys = stack.at(-1)!;
      const key: string = JSON.parse(token);
      if (keys?.has(key)) throw new StrictJsonError("DUPLICATE_KEY");
      keys?.add(key);
    }
  }
}

/**
 * Parse a bounded JSON document for contracts that must reject ambiguous input.
 * Rejects malformed UTF-8 and a BOM rather than hashing or parsing a different representation.
 */
export function parseStrictJson(bytes: Uint8Array, limit: number): unknown {
  if (bytes.byteLength > limit) throw new StrictJsonError("TOO_LARGE");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new StrictJsonError("INVALID_JSON");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StrictJsonError("INVALID_JSON");
  }
  rejectDuplicateKeys(text);
  return value;
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpOAuthState, McpOAuthStateStore } from "@earendil-works/pi-mcp/oauth";

/**
 * Durable OAuth state for one MCP server. The file contains tokens, so it lives under the data
 * directory with owner-only permissions and is replaced atomically. A missing file means "not
 * authorized yet"; any other read error is real and stops that server from connecting.
 */
export class FileOAuthStateStore implements McpOAuthStateStore {
  /** Never rejects: a failed write is reported to its own caller and does not poison later writes. */
  #writes: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async load(): Promise<McpOAuthState | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return JSON.parse(text) as McpOAuthState;
  }

  save(state: McpOAuthState): Promise<void> {
    // Swallow the previous outcome before queueing: keeping a rejected promise in the chain would make
    // every later save and load fail with that first error, even after the cause is gone.
    const write = this.#writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, this.path);
    });
    // The caller sees this write's failure; the stored chain never holds a rejection.
    this.#writes = write.catch(() => {});
    return write;
  }
}

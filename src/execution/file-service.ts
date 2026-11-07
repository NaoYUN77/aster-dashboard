// Bounded file primitives for remote execution.
//
// Interface
//   FileService.info/exists/canonical          metadata without opening the file
//   FileService.open/read/scanLines/close      one contiguous byte scan over an open handle
//   FileService.readText/write                 bounded whole-file reads and atomic writes
//   FileService.closeSession/closeAll          release handles with their owner
//
// Inputs: virtual roots mapped to host directories (`/workspace`, `/shared`, `/tmp`) and a session
// key that owns every opened handle. Paths are POSIX-shaped virtual paths; the service maps them to
// host paths and rejects anything that leaves its root, including through a symbolic link. The
// model never chooses a host path.
//
// Errors: every failure is a `FileServiceError` with a wire-compatible code and a message naming
// only the virtual path. A missing file, a symlink escape, a directory where a file was expected
// and an oversized transfer stay distinguishable; nothing is silently truncated.
//
// Side effects: `write` creates parent directories and replaces the target through a same-directory
// temporary file that is flushed and renamed, so a reader sees either the old or the new content.
// Writing through a symbolic link rewrites its target and keeps the link.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, mkdir, readlink, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { LineScanner, type FileInfo, type LineScan } from "@earendil-works/pi-durable/env";
import {
  FILE_MAX_HANDLES,
  FILE_MAX_READ_CHUNK_BYTES,
  FILE_MAX_READ_TEXT_BYTES,
  FILE_MAX_WRITE_BYTES,
  type RpcFileReadResult,
  type RpcFileScanResult,
  type RpcFileStatResult,
} from "./rpc-protocol.js";

export type FileFailureCode =
  | "not_found"
  | "permission_denied"
  | "not_directory"
  | "is_directory"
  | "invalid_request"
  | "too_large"
  | "aborted"
  | "busy"
  | "unknown";

export class FileServiceError extends Error {
  override name = "FileServiceError";

  constructor(
    readonly code: FileFailureCode,
    message: string,
  ) {
    super(message);
  }
}

export type FileRoot = {
  /** Absolute virtual path; `/` itself is refused because it would expose the host root. */
  readonly virtual: string;
  /** Absolute host directory the virtual root maps to. */
  readonly host: string;
  readonly writable: boolean;
};

export type FileServiceOptions = {
  readonly roots: readonly FileRoot[];
  readonly maxHandles?: number;
  readonly readChunkBytes?: number;
  readonly maxWriteBytes?: number;
  readonly maxReadTextBytes?: number;
};

type ResolvedRoot = FileRoot & {
  readonly realHost: string;
  readonly realPrefix: string;
};

type Handle = {
  readonly session: string;
  readonly fh: FileHandle;
  readonly info: FileInfo;
  readonly root: ResolvedRoot;
};

type ResolvedPath = {
  readonly root: ResolvedRoot;
  /** The configured mapping, before resolving symbolic links; metadata is read from here. */
  readonly hostPath: string;
  /** The real target after resolving every symbolic link; I/O uses this. */
  readonly realPath: string;
  readonly virtualPath: string;
};

const SCAN_CHUNK_BYTES = 256 * 1024;
const OPEN_FLAGS = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
/** Matches the kernel's own symlink limit closely enough to refuse cycles promptly. */
const MAX_LINK_HOPS = 40;

/** Result of resolving a root-relative path one component at a time. */
type WalkResult = {
  /** Host path of the deepest resolved component; always inside `root.realHost`. */
  readonly real: string;
  /** Components that do not exist yet, in order, relative to `real`. */
  readonly missing: readonly string[];
  /** True when the missing component came from a symbolic link's target. */
  readonly dangling: boolean;
};

function linkComponents(target: string): string[] {
  const raw = sep === "/" ? target.split("/") : target.split(/[\\/]/);
  return raw.filter((part) => part !== "" && part !== ".");
}

function normalizedVirtual(value: string): string {
  if (value.length === 0 || !value.startsWith("/") || value.includes("\0") || value.includes("\\")) {
    throw new FileServiceError("invalid_request", "the path is not an absolute POSIX path");
  }
  if (Buffer.byteLength(value, "utf8") > 4_096) {
    throw new FileServiceError("invalid_request", "the path is too long");
  }
  const normalized = posix.normalize(value);
  if (!normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new FileServiceError("invalid_request", "the path leaves its root");
  }
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function toVirtual(root: ResolvedRoot, realPath: string): string {
  const rel = relative(root.realHost, realPath);
  if (rel === "") return root.virtual;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new FileServiceError("permission_denied", "the path resolves outside its root");
  }
  return root.virtual === "/" ? `/${rel.split(sep).join("/")}` : `${root.virtual}/${rel.split(sep).join("/")}`;
}

function mapNodeError(error: unknown, virtualPath: string): FileServiceError {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  switch (code) {
    case "ENOENT":
      return new FileServiceError("not_found", `not found: ${virtualPath}`);
    case "EACCES":
    case "EPERM":
    case "ELOOP":
      return new FileServiceError("permission_denied", `permission denied: ${virtualPath}`);
    case "ENOTDIR":
      return new FileServiceError("not_directory", `a parent is not a directory: ${virtualPath}`);
    case "EISDIR":
      return new FileServiceError("is_directory", `the path is a directory: ${virtualPath}`);
    case "ENAMETOOLONG":
    case "EINVAL":
      return new FileServiceError("invalid_request", `the path is invalid: ${virtualPath}`);
    case "EMFILE":
    case "ENFILE":
      return new FileServiceError("busy", "the execution host ran out of file handles");
    default:
      return new FileServiceError("unknown", `the file operation failed: ${virtualPath}`);
  }
}

function infoFor(root: ResolvedRoot, virtualPath: string, stats: import("node:fs").Stats): FileInfo {
  const kind = stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : "file";
  return {
    name: basename(virtualPath),
    path: virtualPath,
    kind,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new FileServiceError("aborted", "the file operation was aborted");
}

function safeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new FileServiceError("invalid_request", "content is not valid base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new FileServiceError("invalid_request", "content is not canonical base64");
  }
  return decoded;
}

/**
 * One service instance owns one virtual namespace. The shared execution host creates one per
 * direct session; handles never cross a service or a session.
 */
export class FileService {
  readonly #roots: readonly FileRoot[];
  readonly #maxHandles: number;
  readonly #readChunkBytes: number;
  readonly #maxWriteBytes: number;
  readonly #maxReadTextBytes: number;
  readonly #handles = new Map<string, Handle>();
  #rootCache: Promise<readonly ResolvedRoot[]> | undefined;

  constructor(options: FileServiceOptions) {
    if (options.roots.length === 0) {
      throw new Error("a file service needs at least one root");
    }
    for (const root of options.roots) {
      const virtual = normalizedVirtual(root.virtual);
      if (virtual !== root.virtual || virtual === "/") {
        throw new Error(`file root ${JSON.stringify(root.virtual)} must be a normalized absolute path other than /`);
      }
      if (!isAbsolute(root.host) || root.host.includes("\0")) {
        throw new Error(`file root ${root.virtual} needs an absolute host path`);
      }
    }
    this.#roots = options.roots.map((root) => ({ ...root }));
    this.#maxHandles = options.maxHandles ?? FILE_MAX_HANDLES;
    this.#readChunkBytes = Math.min(options.readChunkBytes ?? FILE_MAX_READ_CHUNK_BYTES, FILE_MAX_READ_CHUNK_BYTES);
    this.#maxWriteBytes = Math.min(options.maxWriteBytes ?? FILE_MAX_WRITE_BYTES, FILE_MAX_WRITE_BYTES);
    this.#maxReadTextBytes = Math.min(options.maxReadTextBytes ?? FILE_MAX_READ_TEXT_BYTES, FILE_MAX_READ_TEXT_BYTES);
  }

  /** Resolve every configured root once; a root created later is picked up after a failed lookup. */
  async #resolvedRoots(): Promise<readonly ResolvedRoot[]> {
    this.#rootCache ??= (async () => {
      const resolved: ResolvedRoot[] = [];
      for (const root of this.#roots) {
        try {
          const realHost = await realpath(root.host);
          resolved.push({ ...root, realHost, realPrefix: realHost.endsWith(sep) ? realHost : `${realHost}${sep}` });
        } catch {
          throw new FileServiceError("not_found", `the root is unavailable: ${root.virtual}`);
        }
      }
      return resolved;
    })();
    try {
      return await this.#rootCache;
    } catch (error) {
      this.#rootCache = undefined;
      throw error;
    }
  }

  async #rootFor(virtualPath: string, write: boolean): Promise<{ root: ResolvedRoot; relativePath: string }> {
    const roots = await this.#resolvedRoots();
    const match = roots
      .filter((root) => virtualPath === root.virtual || virtualPath.startsWith(`${root.virtual}/`))
      .sort((left, right) => right.virtual.length - left.virtual.length)[0];
    if (match === undefined) {
      throw new FileServiceError("permission_denied", `the path is outside the exposed roots: ${virtualPath}`);
    }
    if (write && !match.writable) {
      throw new FileServiceError("permission_denied", `the path is read-only: ${virtualPath}`);
    }
    const relativePath = virtualPath === match.virtual ? "" : virtualPath.slice(match.virtual.length + 1);
    return { root: match, relativePath };
  }

  /**
   * A symbolic link inside the sandbox usually holds a virtual path (`/workspace/x`, `/shared/y`).
   * Reading the link and then asking the host for that path would look outside every root, so an
   * absolute target that names this root is mapped back to its host directory. Targets naming a
   * different root are not followed: each root has its own write permission, and crossing roots
   * through a link would let a read-only root be written through a writable one.
   */
  #virtualLinkTarget(root: ResolvedRoot, target: string): string[] | undefined {
    if (!isAbsolute(target) || target.includes("\0") || target.includes("\\")) return undefined;
    if (target === root.virtual) return [];
    if (!target.startsWith(`${root.virtual}/`)) return undefined;
    return linkComponents(target.slice(root.virtual.length + 1));
  }

  /**
   * Resolve a path inside one root component by component. Following links here rather than with
   * `realpath` is what lets a virtual absolute link target stay inside its root; every intermediate
   * result is containment-checked before it is used.
   */
  async #walk(root: ResolvedRoot, relativePath: string, virtualPath: string): Promise<WalkResult> {
    const pending: { readonly name: string; readonly fromLink: boolean }[] = linkComponents(relativePath)
      .reverse()
      .map((name) => ({ name, fromLink: false }));
    let current = root.realHost;
    let hops = 0;
    while (pending.length > 0) {
      const entry = pending.pop() as { readonly name: string; readonly fromLink: boolean };
      const name = entry.name;
      if (name === "..") {
        const parent = dirname(current);
        if (!inside(root.realHost, parent)) {
          throw new FileServiceError("permission_denied", `the path resolves outside its root: ${virtualPath}`);
        }
        current = parent;
        continue;
      }
      const candidate = join(current, name);
      if (!inside(root.realHost, candidate)) {
        throw new FileServiceError("permission_denied", `the path resolves outside its root: ${virtualPath}`);
      }
      let stats: import("node:fs").Stats;
      try {
        stats = await lstat(candidate);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return { real: current, missing: [name, ...pending.map((item) => item.name)], dangling: entry.fromLink };
        }
        throw mapNodeError(error, virtualPath);
      }
      if (!stats.isSymbolicLink()) {
        current = candidate;
        continue;
      }
      hops += 1;
      if (hops > MAX_LINK_HOPS) {
        throw new FileServiceError("permission_denied", `too many symbolic links: ${virtualPath}`);
      }
      let target: string;
      try {
        target = await readlink(candidate);
      } catch (error) {
        throw mapNodeError(error, virtualPath);
      }
      const virtual = this.#virtualLinkTarget(root, target);
      if (virtual !== undefined) {
        current = root.realHost;
        pending.push(...virtual.reverse().map((part) => ({ name: part, fromLink: true })));
        continue;
      }
      if (isAbsolute(target)) {
        const hostTarget = resolve(target);
        if (!inside(root.realHost, hostTarget)) {
          throw new FileServiceError("permission_denied", `the path resolves outside its root: ${virtualPath}`);
        }
        current = root.realHost;
        pending.push(...linkComponents(relative(root.realHost, hostTarget))
          .reverse()
          .map((part) => ({ name: part, fromLink: true })));
        continue;
      }
      // A relative target is resolved from the link's own directory, which is `current`.
      pending.push(...linkComponents(target).reverse().map((part) => ({ name: part, fromLink: true })));
    }
    return { real: current, missing: [], dangling: false };
  }

  /** Resolve an existing path and prove its real target stays inside its root. */
  async #existing(virtualPath: string, write = false): Promise<ResolvedPath> {
    const normalized = normalizedVirtual(virtualPath);
    const { root, relativePath } = await this.#rootFor(normalized, write);
    const hostPath = resolve(root.host, relativePath);
    const walked = await this.#walk(root, relativePath, normalized);
    if (walked.missing.length > 0) {
      throw new FileServiceError("not_found", `not found: ${normalized}`);
    }
    return { root, hostPath, realPath: walked.real, virtualPath: normalized };
  }

  /**
   * Resolve a path that may not exist yet. The nearest existing ancestor is resolved and must stay
   * inside the root; missing components are then appended. `write()` resolves the parent again just
   * before the rename, so a directory swapped for a symlink in between is still refused.
   */
  async #forWrite(virtualPath: string): Promise<ResolvedPath> {
    const normalized = normalizedVirtual(virtualPath);
    const { root, relativePath } = await this.#rootFor(normalized, true);
    const walked = await this.#walk(root, relativePath, normalized);
    let target: string;
    if (walked.missing.length === 0) {
      let stats: import("node:fs").Stats;
      try {
        stats = await lstat(walked.real);
      } catch (error) {
        throw mapNodeError(error, normalized);
      }
      if (stats.isDirectory()) {
        throw new FileServiceError("is_directory", `the path is a directory: ${normalized}`);
      }
      target = walked.real;
    } else {
      // A dangling symbolic link would make the write create a file nobody named; refuse it
      // instead of guessing at the intended target. A merely missing tail is created below.
      if (walked.dangling) {
        throw new FileServiceError("not_found", `the symbolic link target is missing: ${normalized}`);
      }
      target = join(walked.real, ...walked.missing);
    }
    if (!inside(root.realHost, dirname(target))) {
      throw new FileServiceError("permission_denied", `the path resolves outside its root: ${normalized}`);
    }
    // The root itself must be inside its own host directory after realpath.
    if (!inside(root.realHost, target) && target !== root.realHost) {
      throw new FileServiceError("permission_denied", `the path resolves outside its root: ${normalized}`);
    }
    return { root, hostPath: target, realPath: target, virtualPath: normalized };
  }

  async info(virtualPath: string): Promise<RpcFileStatResult> {
    const resolved = await this.#existing(virtualPath);
    try {
      const stats = await lstat(resolved.hostPath);
      return { info: infoFor(resolved.root, resolved.virtualPath, stats) };
    } catch (error) {
      throw mapNodeError(error, resolved.virtualPath);
    }
  }

  async exists(virtualPath: string): Promise<boolean> {
    try {
      await this.#existing(virtualPath);
      return true;
    } catch (error) {
      if (error instanceof FileServiceError && error.code === "not_found") return false;
      throw error;
    }
  }

  async canonical(virtualPath: string): Promise<string> {
    const resolved = await this.#existing(virtualPath);
    return toVirtual(resolved.root, resolved.realPath);
  }

  /**
   * Resolve a path whose final component must not be followed. The link itself is refused, not its
   * target: resolving first would run the containment check against a path the caller never named
   * and would make the kernel's `O_NOFOLLOW` check meaningless.
   */
  async #existingNoFollow(virtualPath: string): Promise<ResolvedPath> {
    const normalized = normalizedVirtual(virtualPath);
    const { root, relativePath } = await this.#rootFor(normalized, false);
    const hostPath = resolve(root.host, relativePath);
    try {
      if ((await lstat(hostPath)).isSymbolicLink()) {
        throw new FileServiceError("invalid_request", `symbolic links are refused: ${normalized}`);
      }
    } catch (error) {
      if (error instanceof FileServiceError) throw error;
      throw mapNodeError(error, normalized);
    }
    // Ancestors are still followed, so a directory symlink that leaves the root stays refused.
    const cut = relativePath.lastIndexOf("/");
    const parentRelative = cut === -1 ? "" : relativePath.slice(0, cut);
    const parent = await this.#walk(root, parentRelative, normalized);
    if (parent.missing.length > 0) {
      throw new FileServiceError("not_found", `not found: ${normalized}`);
    }
    const realPath = relativePath === "" ? parent.real : join(parent.real, basename(hostPath));
    return { root, hostPath, realPath, virtualPath: normalized };
  }

  async open(
    session: string,
    virtualPath: string,
    options: { readonly noFollow?: boolean } = {},
  ): Promise<{ handle: string; info: FileInfo }> {
    if (this.#handles.size >= this.#maxHandles) {
      throw new FileServiceError("busy", "the execution host has too many open files for this service");
    }
    const resolved = options.noFollow === true
      ? await this.#existingNoFollow(virtualPath)
      : await this.#existing(virtualPath);
    const flags = OPEN_FLAGS | (options.noFollow === true && process.platform !== "win32" ? constants.O_NOFOLLOW : 0);
    let fh: FileHandle;
    try {
      fh = await open(resolved.realPath, flags);
    } catch (error) {
      // The final component can be swapped for a link between the check and the open; the kernel's
      // ELOOP is the same refusal, not a permission failure of the target.
      if (options.noFollow === true && (error as { code?: string }).code === "ELOOP") {
        throw new FileServiceError("invalid_request", `symbolic links are refused: ${resolved.virtualPath}`);
      }
      throw mapNodeError(error, resolved.virtualPath);
    }
    try {
      const stats = await fh.stat();
      if (!stats.isFile()) {
        await fh.close().catch(() => undefined);
        throw stats.isDirectory()
          ? new FileServiceError("is_directory", `the path is a directory: ${resolved.virtualPath}`)
          : new FileServiceError("invalid_request", `the path is not a regular file: ${resolved.virtualPath}`);
      }
      const info = infoFor(resolved.root, resolved.virtualPath, stats);
      const handle = `f${randomBytes(8).toString("hex")}`;
      this.#handles.set(handle, {
        session,
        fh,
        info,
        root: resolved.root,
      });
      return { handle, info };
    } catch (error) {
      await fh.close().catch(() => undefined);
      throw error instanceof FileServiceError ? error : mapNodeError(error, resolved.virtualPath);
    }
  }

  #handle(session: string, handle: string): Handle {
    const entry = this.#handles.get(handle);
    if (entry === undefined || entry.session !== session) {
      throw new FileServiceError("not_found", "the file handle is not open");
    }
    return entry;
  }

  async read(session: string, handle: string, offset: number, length: number): Promise<RpcFileReadResult> {
    const entry = this.#handle(session, handle);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new FileServiceError("invalid_request", "offset is invalid");
    }
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new FileServiceError("invalid_request", "length is invalid");
    }
    const size = Math.min(length, this.#readChunkBytes);
    if (offset > Number.MAX_SAFE_INTEGER - size) {
      throw new FileServiceError("invalid_request", "offset is invalid");
    }
    const buffer = Buffer.allocUnsafe(size);
    let total = 0;
    try {
      while (total < size) {
        const { bytesRead } = await entry.fh.read(buffer, total, size - total, offset + total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
    } catch (error) {
      throw mapNodeError(error, entry.info.path);
    }
    const data = buffer.subarray(0, total);
    return { data: data.toString("base64"), bytesRead: total, nextOffset: offset + total, eof: total < size };
  }

  async scanLines(session: string, handle: string, startLine: number, endLine: number | undefined, signal?: AbortSignal): Promise<RpcFileScanResult> {
    const entry = this.#handle(session, handle);
    if (!Number.isSafeInteger(startLine) || startLine < 0) {
      throw new FileServiceError("invalid_request", "startLine is invalid");
    }
    if (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine <= startLine)) {
      throw new FileServiceError("invalid_request", "endLine is invalid");
    }
    const scanner = new LineScanner(startLine, endLine);
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    let offset = 0;
    try {
      for (;;) {
        checkAborted(signal);
        const { bytesRead } = await entry.fh.read(buffer, 0, buffer.length, offset);
        if (bytesRead === 0) break;
        scanner.push(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
    } catch (error) {
      if (error instanceof FileServiceError) throw error;
      throw mapNodeError(error, entry.info.path);
    }
    const scan: LineScan = scanner.finish();
    return { scan };
  }

  async close(session: string, handle: string): Promise<void> {
    const entry = this.#handle(session, handle);
    this.#handles.delete(handle);
    await entry.fh.close().catch(() => undefined);
  }

  async readText(virtualPath: string, signal?: AbortSignal): Promise<{ data: string }> {
    checkAborted(signal);
    const resolved = await this.#existing(virtualPath);
    let fh: FileHandle;
    try {
      fh = await open(resolved.realPath, OPEN_FLAGS);
    } catch (error) {
      throw mapNodeError(error, resolved.virtualPath);
    }
    try {
      const stats = await fh.stat();
      if (!stats.isFile()) {
        throw stats.isDirectory()
          ? new FileServiceError("is_directory", `the path is a directory: ${resolved.virtualPath}`)
          : new FileServiceError("invalid_request", `the path is not a regular file: ${resolved.virtualPath}`);
      }
      if (stats.size > this.#maxReadTextBytes) {
        throw new FileServiceError(
          "too_large",
          `the file exceeds ${this.#maxReadTextBytes} bytes: ${resolved.virtualPath}`,
        );
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        checkAborted(signal);
        const chunk = Buffer.allocUnsafe(this.#readChunkBytes);
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > this.#maxReadTextBytes) {
          throw new FileServiceError("too_large", `the file exceeds ${this.#maxReadTextBytes} bytes: ${resolved.virtualPath}`);
        }
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return { data: Buffer.concat(chunks, total).toString("base64") };
    } catch (error) {
      if (error instanceof FileServiceError) throw error;
      throw mapNodeError(error, resolved.virtualPath);
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  async write(virtualPath: string, contentBase64: string, signal?: AbortSignal): Promise<RpcFileStatResult> {
    checkAborted(signal);
    if (contentBase64.length > Math.ceil(this.#maxWriteBytes / 3) * 4) {
      throw new FileServiceError("too_large", `content exceeds ${this.#maxWriteBytes} bytes`);
    }
    const content = safeBase64(contentBase64);
    if (content.length > this.#maxWriteBytes) {
      throw new FileServiceError("too_large", `content exceeds ${this.#maxWriteBytes} bytes`);
    }
    const resolved = await this.#forWrite(virtualPath);
    const parent = dirname(resolved.hostPath);
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw mapNodeError(error, resolved.virtualPath);
    }
    // Re-prove containment after creating directories; a synchronous attacker could have replaced
    // an ancestor with a symlink between the first check and here.
    let realParent: string;
    try {
      realParent = await realpath(parent);
    } catch (error) {
      throw mapNodeError(error, resolved.virtualPath);
    }
    if (!inside(resolved.root.realHost, realParent)) {
      throw new FileServiceError("permission_denied", `the path resolves outside its root: ${resolved.virtualPath}`);
    }
    checkAborted(signal);

    const target = join(realParent, basename(resolved.hostPath));
    let mode = 0o666;
    try {
      const existing = await lstat(target);
      if (existing.isDirectory()) throw new FileServiceError("is_directory", `the path is a directory: ${resolved.virtualPath}`);
      mode = existing.mode & 0o777;
    } catch (error) {
      if (error instanceof FileServiceError) throw error;
      if ((error as { code?: string }).code !== "ENOENT") throw mapNodeError(error, resolved.virtualPath);
    }
    const tempPath = join(realParent, `.aster-tmp-${randomBytes(8).toString("hex")}`);
    let fh: FileHandle | undefined;
    try {
      fh = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
      await fh.writeFile(content);
      await fh.sync();
      await fh.close();
      fh = undefined;
      checkAborted(signal);
      await rename(tempPath, target);
    } catch (error) {
      await fh?.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      if (error instanceof FileServiceError) throw error;
      throw mapNodeError(error, resolved.virtualPath);
    }
    await this.#syncDirectory(realParent);
    try {
      const stats = await lstat(target);
      // Report the file the bytes landed in. Writing through a link replaces its target and keeps
      // the link, so naming the link here would claim a path whose content did not change.
      return { info: infoFor(resolved.root, toVirtual(resolved.root, target), stats) };
    } catch (error) {
      throw mapNodeError(error, resolved.virtualPath);
    }
  }

  /** Flush the directory entry so a crash after the rename cannot lose the new name. */
  async #syncDirectory(directory: string): Promise<void> {
    let fh: FileHandle | undefined;
    try {
      fh = await open(directory, constants.O_RDONLY);
      await fh.sync();
    } catch {
      // Directory fsync is not supported everywhere (notably Windows); the rename itself remains
      // atomic. This is the only failure the caller may ignore.
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  async closeSession(session: string): Promise<void> {
    const entries = [...this.#handles.entries()].filter(([, entry]) => entry.session === session);
    for (const [handle] of entries) this.#handles.delete(handle);
    await Promise.all(entries.map(([, entry]) => entry.fh.close().catch(() => undefined)));
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#handles.values()];
    this.#handles.clear();
    await Promise.all(entries.map((entry) => entry.fh.close().catch(() => undefined)));
  }
}

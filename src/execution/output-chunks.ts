/** Byte-bounded UTF-8 splitting shared by every path that windowed output to the wire. */
export function chunkText(text: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let bytes = 0;
    while (end < text.length) {
      const code = text.codePointAt(end);
      const width = code === undefined ? 1 : code > 0xffff ? 4 : Buffer.byteLength(String.fromCodePoint(code), "utf8");
      if (bytes + width > maxBytes && end > start) break;
      end += code !== undefined && code > 0xffff ? 2 : 1;
      bytes += width;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/** A signal's conventional shell exit status; zero when the process did not die from one. */
export function signalNumber(signal: NodeJS.Signals | null): number {
  if (signal === null) return 0;
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15,
  };
  return numbers[signal] ?? 1;
}

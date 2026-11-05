export interface TextRequest {
  requestId: string;
  conversationId: string;
  senderId: string;
  text: string;
}

export function splitReply(text: string, limit = 4000): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new Error("Reply chunk limit must be at least 2");
  const chunks: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > limit) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

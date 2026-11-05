// Child process fixture: persists a partially delivered reply, then blocks until the parent kills the process.
// The database is left mid-send so the parent can verify crash recovery of delivery state.
import { appendFileSync } from "node:fs";
import { Inbox } from "../../src/inbox.js";

const [database, startedFile] = process.argv.slice(2);
if (!database || !startedFile) throw new Error("Usage: crash-inbox <database> <started-marker>");

const requestId = "telegram:99:12";
const inbox = new Inbox(database);
inbox.accept(13, { requestId, conversationId: "42", senderId: "42", text: "hello" });
inbox.saveReply(requestId, "a".repeat(4000) + "tail");
inbox.beginPart(requestId, 0);
appendFileSync(startedFile, "started\n");
await new Promise(() => {});

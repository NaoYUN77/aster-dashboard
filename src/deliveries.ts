import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Inbox } from "./inbox.js";

const [action, requestId, partValue] = process.argv.slice(2);
if (!action || !["list", "retry", "sent"].includes(action)) {
  console.error("Usage: npm run deliveries -- list | retry <requestId> <part> | sent <requestId> <part>");
  process.exitCode = 1;
} else {
  const path = join(resolve(process.env.DATA_DIR || "data"), "inbox.sqlite");
  try {
    await access(path);
  } catch {
    console.error(`No delivery database at ${path}. Point DATA_DIR at the application data directory.`);
    process.exit(1);
  }
  const inbox = new Inbox(path);
  try {
    // A process killed mid-send leaves parts in `sending`; surface them for manual reconciliation first.
    inbox.recover();
    if (action === "list") {
      console.log(JSON.stringify({ blocked: inbox.blocked(), failures: inbox.diagnostics() }, null, 2));
    } else {
      if (!requestId || !partValue || !/^\d+$/.test(partValue)) throw new Error("Provide requestId and zero-based part number");
      inbox.resolvePart(requestId, Number(partValue), action as "retry" | "sent");
      console.info("Delivery state updated. Restart the application to continue pending delivery.");
    }
  } finally {
    inbox.close();
  }
}

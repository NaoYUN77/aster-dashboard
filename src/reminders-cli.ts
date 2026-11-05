import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ReminderStore } from "./reminders.js";

const [action, idValue, resolution] = process.argv.slice(2);
if (!action || !["list", "sent", "retry"].includes(action)) {
  console.error("Usage: npm run reminders -- list | sent <id> | retry <id>");
  process.exitCode = 1;
} else {
  const path = join(resolve(process.env.DATA_DIR || "data"), "reminders.sqlite");
  try {
    await access(path);
  } catch {
    console.error(`No reminder database at ${path}. Point DATA_DIR at the application data directory.`);
    process.exit(1);
  }
  const store = new ReminderStore(path);
  try {
    if (action === "list") {
      console.log(JSON.stringify({ reminders: store.listAll() }, null, 2));
    } else {
      if (!idValue || !/^\d+$/.test(idValue) || !["sent", "retry"].includes(resolution ?? "")) {
        throw new Error("Provide a numeric reminder id and either `sent` (confirmed delivered) or `retry` (re-queue once)");
      }
      // `sent` and `retry` are explicit operator decisions after checking Telegram; the app never
      // resends an uncertain reminder on its own.
      const reminder = store.resolve(Number(idValue), resolution as "sent" | "retry");
      console.info(`Reminder #${reminder.id} is now ${reminder.status}. A running application retries a pending row within about a minute; otherwise it is retried on the next start.`);
    }
  } finally {
    store.close();
  }
}

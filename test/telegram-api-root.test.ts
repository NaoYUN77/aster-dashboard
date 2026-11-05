import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";

const base = {
  TELEGRAM_BOT_TOKEN: "token",
  TELEGRAM_OWNER_ID: "42",
  MODEL_PROVIDER: "deepseek",
  MODEL_ID: "deepseek-flash",
  DEEPSEEK_API_KEY: "key",
};

test("TELEGRAM_API_ROOT defaults to undefined (the api.telegram.org root)", () => {
  assert.equal(readConfig(base).telegramApiRoot, undefined);
  assert.equal(readConfig({ ...base, TELEGRAM_API_ROOT: "  " }).telegramApiRoot, undefined);
});

test("TELEGRAM_API_ROOT accepts an https prefix and drops trailing slashes", () => {
  assert.equal(
    readConfig({ ...base, TELEGRAM_API_ROOT: "https://tg.example.com/tg-abc" }).telegramApiRoot,
    "https://tg.example.com/tg-abc",
  );
  assert.equal(
    readConfig({ ...base, TELEGRAM_API_ROOT: "https://tg.example.com/tg-abc/" }).telegramApiRoot,
    "https://tg.example.com/tg-abc",
  );
  assert.equal(
    readConfig({ ...base, TELEGRAM_API_ROOT: "https://example.com/" }).telegramApiRoot,
    "https://example.com",
  );
});

test("TELEGRAM_API_ROOT rejects non-https, malformed, and query/fragment values", () => {
  assert.throws(() => readConfig({ ...base, TELEGRAM_API_ROOT: "http://tg.example.com" }), /https/);
  assert.throws(() => readConfig({ ...base, TELEGRAM_API_ROOT: "not a url" }), /valid URL/);
  assert.throws(() => readConfig({ ...base, TELEGRAM_API_ROOT: "https://tg.example.com/x?y=1" }), /query or fragment/);
  assert.throws(() => readConfig({ ...base, TELEGRAM_API_ROOT: "https://tg.example.com/x#y" }), /query or fragment/);
});

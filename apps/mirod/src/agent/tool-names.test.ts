import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { AGENT_TOOLS } from "./tools";
import { buildOperationTools } from "./operation-tools";
import { buildMemoryTools } from "./memory-tools";
import { buildReadTools } from "./read-tools";
import { buildInteractionTools } from "./interaction-tools";
import { buildCapabilitiesTool } from "./context";
import { ensureExtensionsTable } from "../extensions/store";
import { sanitizeNamePart } from "./extension-tools";
import { ensureOperationsTable } from "../operations/store";
import { ensureMemoryTable } from "../memory/store";

// OpenAI's Responses API (the Codex provider) rejects any tool name outside ^[a-zA-Z0-9_-]+$ -
// found live testing Codex integration, since dotted names ("web.search", "memory.remember", ...)
// worked fine against Ollama's more lenient endpoint and silently broke against a stricter one.
// This is the real hygiene backstop: every static tool-name list gets checked here, so a future
// tool definition that reintroduces a dot (or any other disallowed character) fails a test
// immediately instead of surfacing as a live 400 against one specific provider.
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

function expectValidNames(names: string[]): void {
  for (const name of names) {
    expect(name).toMatch(VALID_TOOL_NAME);
  }
}

test("AGENT_TOOLS names all match OpenAI's tool-name pattern", () => {
  expectValidNames(AGENT_TOOLS.map((t) => t.name));
});

test("buildOperationTools names all match OpenAI's tool-name pattern", () => {
  const db = new Database(":memory:");
  ensureOperationsTable(db);
  const tools = buildOperationTools({ db, send: () => {}, waitForAnswer: async () => "approve" });
  expectValidNames(tools.map((t) => t.name));
});

test("buildReadTools names all match OpenAI's tool-name pattern", () => {
  expectValidNames(buildReadTools({ getSecret: () => null }).map((t) => t.name));
});

test("capabilities tool name matches OpenAI's tool-name pattern", () => {
  const db = new Database(":memory:");
  ensureExtensionsTable(db);
  expectValidNames([buildCapabilitiesTool(db).name]);
});

test("buildInteractionTools names all match OpenAI's tool-name pattern", () => {
  expectValidNames(buildInteractionTools({ send: () => {}, waitForAnswer: async () => "", setSecret: () => {} }).map((t) => t.name));
});

test("buildMemoryTools names all match OpenAI's tool-name pattern", () => {
  const db = new Database(":memory:");
  ensureMemoryTable(db);
  expectValidNames(buildMemoryTools(db).map((t) => t.name));
});

test("sanitizeNamePart strips anything outside the allowed character set", () => {
  expect(sanitizeNamePart("gotify")).toBe("gotify");
  expect(sanitizeNamePart("get.health")).toBe("get_health");
  expect(sanitizeNamePart("a b/c:d")).toBe("a_b_c_d");
  expect("ext_" + sanitizeNamePart("my.app") + "_" + sanitizeNamePart("get.status")).toMatch(VALID_TOOL_NAME);
});

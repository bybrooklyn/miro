import { test, expect } from "bun:test";
import { createFakeHttpClient, Type } from "./index";

test("createFakeHttpClient wraps a fixture as a 200 HttpResponse with a json() body", async () => {
  const client = createFakeHttpClient({ "/health": { health: "green" } });
  const res = await client.get("/health");
  expect(res.status).toBe(200);
  expect(res.ok).toBe(true);
  expect(res.json<{ health: string }>().health).toBe("green");
  expect(JSON.parse(res.body).health).toBe("green");
});

test("createFakeHttpClient ignores query strings and can fix a non-200", async () => {
  const client = createFakeHttpClient({ "/message": { messages: [] }, "/down": { status: 503, body: "loading" } });
  const msg = await client.get("/message", { query: { limit: "10" } });
  expect(JSON.parse(msg.body).messages).toEqual([]);
  const down = await client.get("/down");
  expect(down.status).toBe(503);
  expect(down.ok).toBe(false);
  expect(down.body).toBe("loading");
});

test("createFakeHttpClient throws for an unfixtured path", async () => {
  const client = createFakeHttpClient({ "/health": {} });
  await expect(client.get("/nope")).rejects.toThrow("No fixture for GET /nope");
});

test("re-exports the same Type schema builder every other tool file uses", () => {
  const schema = Type.Object({ id: Type.String() });
  // Not a plain JSON object any more (PLAN.md §5.17): the schema engine's Type carries its JSON
  // Schema behind toJsonSchema(), which is what the extension host serializes for the manifest.
  expect(schema.toJsonSchema()).toMatchObject({ type: "object", properties: { id: { type: "string" } }, required: ["id"] });
});

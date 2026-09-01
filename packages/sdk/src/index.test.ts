import { test, expect } from "bun:test";
import { createFakeHttpClient, Type } from "./index";

test("createFakeHttpClient routes an exact path to its fixture", async () => {
  const client = createFakeHttpClient({ "/health": { health: "green" } });
  expect(await client.get("/health")).toEqual({ health: "green" });
});

test("createFakeHttpClient ignores query strings when matching", async () => {
  const client = createFakeHttpClient({ "/message": { messages: [] } });
  expect(await client.get("/message", { query: { limit: "10" } })).toEqual({ messages: [] });
});

test("createFakeHttpClient throws for an unfixtured path", async () => {
  const client = createFakeHttpClient({ "/health": {} });
  await expect(client.get("/nope")).rejects.toThrow("No fixture for GET /nope");
});

test("re-exports the same Type schema builder every other tool file uses", () => {
  const schema = Type.Object({ id: Type.String() });
  expect(schema.type).toBe("object");
});

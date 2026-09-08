import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureMemoryTable } from "../memory/store";
import { recordRecipe, getRecipe, recipeWorked, recipeFailed } from "./recipes";

function db(): Database {
  const d = new Database(":memory:");
  ensureMemoryTable(d);
  return d;
}

const COMPOSE = "services:\n  immich:\n    image: ghcr.io/immich-app/immich-server\n";

test("record + get: a verified deploy becomes a reusable recipe", () => {
  const d = db();
  const id = recordRecipe(d, "immich", COMPOSE, "generated");
  const r = getRecipe(d, "immich");
  expect(r).not.toBeNull();
  expect(r!.id).toBe(id);
  expect(r!.compose).toBe(COMPOSE);
  expect(r!.timesSeen).toBe(1);
  expect(r!.reliable).toBe(true);
});

test("reinforcement + outcomes: helpful/harmful drive the reliable flag", () => {
  const d = db();
  const id = recordRecipe(d, "immich", COMPOSE, "generated");
  recordRecipe(d, "immich", COMPOSE, "reused"); // seen again
  expect(getRecipe(d, "immich")!.timesSeen).toBe(2);

  recipeWorked(d, id);
  expect(getRecipe(d, "immich")!.helpful).toBe(1);
  expect(getRecipe(d, "immich")!.reliable).toBe(true);

  recipeFailed(d, id);
  recipeFailed(d, id); // harmful 2 > helpful 1
  const r = getRecipe(d, "immich")!;
  expect(r.harmful).toBe(2);
  expect(r.reliable).toBe(false); // the agent should regenerate, not reuse
});

test("no recipe for an unknown app", () => {
  expect(getRecipe(db(), "nothing")).toBeNull();
});

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ImplementationError, Registry, toolNameOf, type Capability, type Implementation } from "./registry";
import { createUsageStore } from "./usage";

// A real Registry over a real usage store, with implementations that are plain functions with
// scripted delays and outcomes - the router's ordering, fan-out and health behaviour is the thing
// under test, and it needs nothing faked.

interface Req {
  q: string;
}
interface Res {
  items: string[];
}
const LIST: Capability<Req, Res> = { id: "test.list", isGood: (r) => r.items.length > 0 };

function impl(id: string, behave: (signal: AbortSignal) => Promise<Res>, opts: Partial<Implementation<Req, Res>> = {}): Implementation<Req, Res> {
  return { id, capability: LIST.id, provider: opts.provider ?? id, meta: { auth: "none", cost: "free" }, available: () => true, run: (_req, signal) => behave(signal), ...opts };
}
const after = (ms: number, res: Res) => (signal: AbortSignal) =>
  new Promise<Res>((resolve, reject) => {
    const t = setTimeout(() => resolve(res), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });
const failing = (message: string, status?: number) => async () => {
  throw status ? new ImplementationError(message, status) : new Error(message);
};

function registry() {
  return new Registry(createUsageStore(new Database(":memory:")));
}

test("toolNameOf maps a dotted id to the underscore form the providers accept", () => {
  expect(toolNameOf("web.search")).toBe("web_search");
  expect(() => toolNameOf("web search")).toThrow(/valid tool name/);
});

test("groups are tried in order; an empty result is not an answer, the next group is asked", async () => {
  const r = registry();
  r.registerCapability(LIST, { groups: [["first"], ["second"]] });
  r.registerImplementation(impl("first", after(5, { items: [] })));
  r.registerImplementation(impl("second", after(5, { items: ["x"] })));
  const routed = await r.route<Req, Res>(LIST.id, { q: "a" });
  expect(routed.impl).toBe("second");
  expect(routed.result).toEqual({ items: ["x"] });
  expect(routed.attempts).toEqual([
    { impl: "first", ok: true, ms: expect.any(Number), empty: true },
    { impl: "second", ok: true, ms: expect.any(Number) },
  ]);
  expect(r.usage.get("first")!.requests).toBe(1); // an empty answer is still a healthy provider
});

test("within a group the first GOOD result wins and the rest are aborted; errors and empties do not win", async () => {
  const r = registry();
  r.registerCapability(LIST, { groups: [["pool:*"]] });
  r.registerImplementation(impl("pool:fast-empty", after(5, { items: [] })));
  r.registerImplementation(impl("pool:fast-error", failing("boom")));
  r.registerImplementation(impl("pool:slow-good", after(60, { items: ["y"] })));
  const routed = await r.route<Req, Res>(LIST.id, { q: "a" });
  expect(routed.impl).toBe("pool:slow-good");
  expect(routed.attempts.map((a) => a.impl).sort()).toEqual(["pool:fast-empty", "pool:fast-error", "pool:slow-good"]);
  expect(r.usage.get("pool:fast-error")).toMatchObject({ failures: 1 });
});

test("a winner aborts the losers, which are not recorded as failures", async () => {
  const r = registry();
  r.registerCapability(LIST, { groups: [["a", "b"]] });
  let bAborted = false;
  r.registerImplementation(impl("a", after(5, { items: ["a"] })));
  r.registerImplementation(
    impl("b", (signal) => {
      signal.addEventListener("abort", () => {
        bAborted = true;
      });
      return after(500, { items: ["b"] })(signal);
    }),
  );
  const routed = await r.route<Req, Res>(LIST.id, { q: "a" });
  expect(routed.impl).toBe("a");
  expect(bAborted).toBe(true);
  expect(r.usage.get("b")).toBeNull();
});

test("a per-implementation timeout is a failure of that implementation only", async () => {
  const r = registry();
  r.registerCapability(LIST, { groups: [["slow"], ["ok"]] });
  r.registerImplementation(impl("slow", after(5_000, { items: ["late"] }), { timeoutMs: 30 }));
  r.registerImplementation(impl("ok", after(5, { items: ["ok"] })));
  const routed = await r.route<Req, Res>(LIST.id, { q: "a" });
  expect(routed.impl).toBe("ok");
  expect(routed.attempts[0]).toMatchObject({ impl: "slow", ok: false });
  expect(r.usage.get("slow")).toMatchObject({ failures: 1 });
});

test("a rate-limited provider is cooled and skipped on the next route; an unavailable one is never asked", async () => {
  const r = registry();
  r.registerCapability(LIST, { groups: [["limited"], ["unkeyed"], ["fallback"]] });
  let limitedCalls = 0;
  r.registerImplementation(
    impl("limited", async () => {
      limitedCalls++;
      throw new ImplementationError("429", 429);
    }),
  );
  let unkeyedCalls = 0;
  r.registerImplementation(
    impl("unkeyed", async () => {
      unkeyedCalls++;
      return { items: ["never"] };
    }, { available: () => false }),
  );
  r.registerImplementation(impl("fallback", after(5, { items: ["f"] })));
  expect((await r.route<Req, Res>(LIST.id, { q: "1" })).impl).toBe("fallback");
  expect((await r.route<Req, Res>(LIST.id, { q: "2" })).impl).toBe("fallback");
  expect(limitedCalls).toBe(1); // cooled after the 429, not asked again
  expect(unkeyedCalls).toBe(0);
  expect(r.usage.inCooldown("limited")).toBe(true);
});

test("candidates are the best-scored implementations of a group, at most the fan-out width", async () => {
  const r = registry();
  r.registerCapability(LIST, { groups: [["n:*"]] });
  for (const id of ["n:1", "n:2", "n:3", "n:4", "n:5"]) r.registerImplementation(impl(id, after(5, { items: [id] })));
  r.usage.record("n:5", { ok: true, ms: 10 });
  r.usage.record("n:4", { ok: false, ms: 10 });
  const picked = (await r.candidates(LIST.id, ["n:*"])).map((i) => i.id);
  expect(picked).toHaveLength(3);
  expect(picked[0]).toBe("n:5");
  expect(picked).not.toContain("n:4");
});

test("nothing registered or nothing available routes to null with the attempts it made; unregisterImplementations drops a family", async () => {
  const r = registry();
  r.registerCapability(LIST, { groups: [["p:*"]] });
  r.registerImplementation(impl("p:a", failing("down")));
  const routed = await r.route<Req, Res>(LIST.id, { q: "a" });
  expect(routed).toMatchObject({ result: null, impl: null });
  expect(routed.attempts).toHaveLength(1);
  r.unregisterImplementations("p:");
  expect(r.implementations(LIST.id)).toEqual([]);
  expect(await r.route<Req, Res>(LIST.id, { q: "a" })).toEqual({ result: null, impl: null, attempts: [] });
  expect(() => r.registerImplementation(impl("q", failing("x"), { capability: "nope" }))).toThrow(/unknown capability/);
});

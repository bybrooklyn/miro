import { test, expect } from "bun:test";
import { parseTicketOrInvite } from "./iroh-connect";

// MIRO_TICKET takes either kind of string, because the person pasting it should not have to know
// which they were handed.
test("a pairing invite yields both the ticket and the code", () => {
  const invite = Buffer.from(JSON.stringify({ v: 1, ticket: "node1abcdef", code: "123456789" })).toString("base64url");
  expect(parseTicketOrInvite(invite)).toEqual({ ticket: "node1abcdef", code: "123456789" });
});

test("a bare ticket is passed through with no code", () => {
  expect(parseTicketOrInvite("node1abcdefghij")).toEqual({ ticket: "node1abcdefghij" });
});

test("surrounding whitespace from a copy-paste is tolerated", () => {
  expect(parseTicketOrInvite("  node1abc\n")).toEqual({ ticket: "node1abc" });
  const invite = Buffer.from(JSON.stringify({ v: 1, ticket: "node1xyz", code: "999888777" })).toString("base64url");
  expect(parseTicketOrInvite(` ${invite} `).code).toBe("999888777");
});

test("something that decodes to JSON but is not an invite is treated as a ticket", () => {
  // A real ticket is base64-ish, so the parser must not mistake a decodable non-invite for one.
  const notAnInvite = Buffer.from(JSON.stringify({ hello: "world" })).toString("base64url");
  expect(parseTicketOrInvite(notAnInvite)).toEqual({ ticket: notAnInvite });
});

test("an invite without a code still gives the ticket (a ticket-only invite)", () => {
  const invite = Buffer.from(JSON.stringify({ v: 1, ticket: "node1only" })).toString("base64url");
  expect(parseTicketOrInvite(invite)).toEqual({ ticket: "node1only", code: undefined });
});

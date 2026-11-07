import { expect, test } from "bun:test";
import { spellings, transparent } from "../src/peel.ts";
import golden from "./spellings.json";
import carried from "./transparent.json";

// Exact lists: a missing spelling lets a denied command through, and an extra
// one can deny a command that never runs the denied program. coding-agent-sync
// replays this table against its port.
test.each(Object.entries(golden))("%s peels to %p", (command, expected) => {
  expect(spellings(command)).toEqual(expected);
});

// The one layer an allow is carried through, or null. coding-agent-sync
// replays this table against its Claude Code hook.
test.each(Object.entries(carried))("%s runs %p transparently", (command, expected) => {
  expect(transparent(command) ?? null).toEqual(expected);
});

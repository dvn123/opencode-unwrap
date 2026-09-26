import { expect, test } from "bun:test"
import { spellings } from "../src/peel.ts"
import golden from "./spellings.json"

// Exact lists: a missing spelling lets a denied command through, and an extra
// one can deny a command that never runs the denied program. coding-agent-sync
// replays this table against its port.
test.each(Object.entries(golden))("%s peels to %p", (command, expected) => {
  expect(spellings(command)).toEqual(expected)
})

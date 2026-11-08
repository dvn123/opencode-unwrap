/**
 * The Claude Code `PreToolUse` hook and the Cursor `beforeShellExecution` hook
 * as one bundle, so tree-sitter's WASM ships once. The host is the first
 * argument rather than read from the payload: a payload that fails to parse
 * cannot name its host, and the hosts fail differently, Claude by staying
 * silent and Cursor by asking.
 */

import { main as claude } from "./claude.ts";
import { main as cursor } from "./cursor.ts";

export { spellings, transparent } from "./peel.ts";

const HOSTS: Record<string, () => Promise<void>> = { claude, cursor };

if (import.meta.main) {
  const host = HOSTS[Bun.argv[2] ?? ""];
  if (!host) {
    console.error("usage: bun shell-unwrap.js claude|cursor");
    process.exit(2);
  }
  await host();
}

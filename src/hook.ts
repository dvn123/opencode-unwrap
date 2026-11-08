/**
 * The Claude Code and Codex `PreToolUse` hooks and the Cursor
 * `beforeShellExecution` hook as one bundle, so tree-sitter's WASM ships once.
 * The Pi extension runs the Codex host. The host is the first argument rather
 * than read from the payload: a payload that fails to parse cannot name its
 * host, and the hosts fail differently, Claude and Cursor by asking and Codex
 * by denying.
 */

import { main as claude } from "./claude.ts";
import { main as codex } from "./codex.ts";
import { main as cursor } from "./cursor.ts";

export { spellings, transparent } from "./peel.ts";
// Each host's rules and decision, for tools that replay the hook in process.
export * as claude from "./claude.ts";
export * as cursor from "./cursor.ts";

const HOSTS: Record<string, () => Promise<void>> = { claude, codex, cursor };

if (import.meta.main) {
  const host = HOSTS[Bun.argv[2] ?? ""];
  if (!host) {
    console.error("usage: bun shell-unwrap.js claude|codex|cursor");
    process.exit(2);
  }
  await host();
}

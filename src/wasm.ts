/**
 * A Bun macro: imported `with { type: "macro" }`, it runs when the source is
 * transpiled, so each bundle carries tree-sitter's WASM inline and the Claude
 * and Cursor hooks ship as one file each.
 */

import { readFileSync } from "node:fs";

export function base64(specifier: string): string {
  return readFileSync(Bun.resolveSync(specifier, import.meta.dir)).toBase64();
}

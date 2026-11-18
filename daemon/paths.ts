import fs from "node:fs";
import path from "node:path";
import { normalizePath } from "../shared/contract.ts";

/** Expand ~, normalize, then realpath the deepest existing ancestor so symlinks cannot hide an escape. */
export function resolvePathFor(p: string, home: string): string | null {
  const n = normalizePath(p, home);
  if (n === null) return null;
  let existing = n;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(existing);
      return path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return n;
      tail.push(path.basename(existing));
      existing = parent;
    }
  }
}

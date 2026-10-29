/** Protect architectural boundaries without tying tests to component filenames. */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
async function sources(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) result.push(...(await sources(file)));
    else if (/\.tsx?$/.test(file)) result.push(path.resolve(file));
  }
  return result;
}
test("local module graph has no cycles and frontend/storage do not depend on Blender implementation", async () => {
  const files = [...(await sources("apps")), ...(await sources("packages"))];
  const known = new Set(files);
  const edges = new Map<string, string[]>();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const targets: string[] = [];
    // Source-level literal import/export edges, including type-only imports.
    // Dynamic runtime imports and package resolution are outside this guard.
    for (const match of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*)["'](\.[^"']+)["']/g,
    )) {
      const target = path
        .resolve(path.dirname(file), match[1])
        .replace(/\.js$/, "");
      const resolved = [target, target + ".ts", target + ".tsx"].find((p) =>
        known.has(p),
      );
      if (!resolved) continue;
      targets.push(resolved);
      const relative = path
        .relative(process.cwd(), resolved)
        .replaceAll(path.sep, "/");
      if (file.startsWith(path.resolve("apps/web") + path.sep))
        assert.doesNotMatch(
          relative,
          /^(apps\/(server|runner)|packages\/(storage|blender-bridge|runtime-adapters))\//,
          file + " imports backend implementation",
        );
      if (file.startsWith(path.resolve("packages/storage") + path.sep))
        assert.doesNotMatch(
          relative,
          /^(apps\/|packages\/(blender-bridge|runtime-adapters)\/)/,
          file + " imports execution implementation",
        );
    }
    edges.set(file, targets);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(file: string, chain: string[]) {
    assert.ok(
      !visiting.has(file),
      "Dependency cycle: " +
        [...chain, file]
          .map((p) => path.relative(process.cwd(), p))
          .join(" -> "),
    );
    if (visited.has(file)) return;
    visiting.add(file);
    for (const next of edges.get(file) || []) visit(next, [...chain, file]);
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of files) visit(file, []);
});

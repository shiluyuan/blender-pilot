import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  AssetLibrary,
  libraryMetadataSchema,
} from "../packages/blender-bridge/library.js";
test("global library: durable copies, category/tag filters, edits, pagination and path confinement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-library-"));
  try {
    const library = new AssetLibrary(root),
      source = path.join(root, "source.blend");
    await writeFile(source, "fixture-blend");
    const a = await library.publish(
      libraryMetadataSchema.parse({
        name: "椅子",
        category: "prop",
        tags: ["木质"],
      }),
      {
        projectId: "one",
        file: source,
        mime: "application/x-blender",
        source: "upload",
      },
    );
    await rm(source);
    assert.equal(
      (await library.list({ search: "木质", category: "prop" })).items[0].id,
      a.id,
    );
    assert.equal((await library.list({ category: "character" })).total, 0);
    await library.update(a.id, { favorite: true, description: "餐厅家具" });
    const reopened = new AssetLibrary(root);
    assert.deepEqual((await reopened.get(a.id)).tags, ["木质"]);
    assert.equal((await reopened.get(a.id)).category, "prop");
    assert.equal(
      (await reopened.list({ favorite: true, search: "餐厅" })).total,
      1,
    );
    assert.equal((await reopened.list({ page: 1 })).items.length, 0);
    assert(await reopened.file(a.id));
    await assert.rejects(library.update(a.id, { category: "not-real" }));
    await assert.rejects(library.get("../outside"));
    await rm(a.path);
    await symlink("/etc/passwd", a.path);
    await assert.rejects(library.file(a.id));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

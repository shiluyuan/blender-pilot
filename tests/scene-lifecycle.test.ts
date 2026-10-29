import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SceneBridge } from "../packages/blender-bridge/scene.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-scene-lifecycle-"));
  const scene = new SceneBridge(root, { projectId: "project" });
  const directory = scene.projectRoot("project");
  await mkdir(directory, { recursive: true });
  const state = path.join(directory, "runtime-scene.json");
  const commands: string[] = [];
  scene.upstream.python = async (code: string) => {
    commands.push(code);
    return [] as any;
  };
  return {
    root,
    scene,
    directory,
    state,
    commands,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("scene recovery accepts only absent metadata as first start; corrupt or foreign state never mutates Blender", async () => {
  const f = await fixture();
  try {
    await f.scene.init();
    assert.equal(f.scene.generation, 1);
    assert.equal(f.commands.length, 0);
    await writeFile(
      f.state,
      JSON.stringify({ projectId: "project", generation: 1 }),
    );
    await assert.rejects(f.scene.init(), { code: "ENOENT" });
    assert.equal(
      f.commands.length,
      0,
      "lost persisted scene must not become a blank scene",
    );
    await writeFile(f.state, "{broken");
    await assert.rejects(f.scene.init());
    assert.equal(f.commands.length, 0);
    await writeFile(
      f.state,
      JSON.stringify({ projectId: "other", generation: 2 }),
    );
    await assert.rejects(f.scene.init(), /其他项目/);
    assert.equal(f.commands.length, 0);
    await rm(f.state);
    await mkdir(f.state);
    await assert.rejects(f.scene.init());
    assert.equal(f.commands.length, 0);
  } finally {
    await f.close();
  }
});
test("failed Blender restore propagates and never claims a usable project", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.state,
      JSON.stringify({ projectId: "project", generation: 3 }),
    );
    await writeFile(path.join(f.directory, "scene.blend"), "retained");
    f.scene.upstream.python = async () => {
      throw new Error("cannot load scene");
    };
    await assert.rejects(f.scene.init(), /cannot load/);
    assert.equal(f.scene.activeProject, undefined);
    await assert.rejects(f.scene.save(), /没有活动/);
    assert.equal(
      await readFile(path.join(f.directory, "scene.blend"), "utf8"),
      "retained",
    );
  } finally {
    await f.close();
  }
});
test("metadata commit failure keeps scene unbound, cleans temporary files and permits an explicit retry", async () => {
  const f = await fixture();
  try {
    await mkdir(f.state);
    await assert.rejects(f.scene.activate("project"));
    assert.equal(f.scene.activeProject, undefined);
    assert.ok(!(await readdir(f.directory)).some((n) => n.endsWith(".tmp")));
    await assert.rejects(f.scene.save(), /没有活动/);
    await rm(f.state, { recursive: true });
    await f.scene.activate("project");
    assert.equal(f.scene.activeProject, "project");
    assert.equal(
      JSON.parse(await readFile(f.state, "utf8")).projectId,
      "project",
    );
    await assert.rejects(f.scene.activate("other"), /不属于/);
  } finally {
    await f.close();
  }
});
test("existing invalid scene path does not fall back to creating or overwriting a scene", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.directory, "scene.blend"));
    await assert.rejects(f.scene.activate("project"), /不是文件/);
    assert.equal(f.commands.length, 0);
  } finally {
    await f.close();
  }
});

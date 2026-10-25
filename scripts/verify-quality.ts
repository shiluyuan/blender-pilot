/** Native Blender + upstream MCP acceptance. No model endpoint or credentials. */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { SceneBridge } from "../packages/blender-bridge/scene.js";
import { verifyAssetFormats } from "./asset-format-checks.js";

const directory = path.resolve(
  process.env.PILOT_TEST_DATA || ".data/quality-native",
);
await mkdir(directory, { recursive: true });
const display = Number(process.env.PILOT_TEST_DISPLAY_NUMBER || 97);
const port = Number(process.env.BLENDER_PORT || 19876);
const environment = {
  ...process.env,
  DISPLAY: `127.0.0.1:${display}`,
  BLENDER_PORT: String(port),
  DISABLE_TELEMETRY: "true",
};
const children: ChildProcess[] = [];
const bridge = new SceneBridge(directory, {
  environment: { DISPLAY: environment.DISPLAY, BLENDER_PORT: String(port) },
});
const checks: string[] = [];
let stopping = false;
let childFailure: Error | undefined;
function launch(name: string, command: string, args: string[]) {
  const output = createWriteStream(path.join(directory, name + ".log"));
  const child = spawn(command, args, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.pipe(output);
  child.stderr!.pipe(output);
  child.once("error", (error) => {
    childFailure = error;
  });
  child.once("exit", (code) => {
    if (!stopping) childFailure = new Error(`${name} exited ${code}`);
  });
  children.push(child);
}
async function waitPort(number: number) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (childFailure) throw childFailure;
    if (
      await new Promise<boolean>((resolve) => {
        const socket = connect(number, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      })
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for native port ${number}`);
}
const readView = () =>
  bridge.upstream.json(`import json
result=[]
for window in bpy.context.window_manager.windows:
    for area in window.screen.areas:
        if area.type=='VIEW_3D':
            region=area.spaces.active.region_3d
            result.append({'rotation':list(region.view_rotation),'location':list(region.view_location),'distance':region.view_distance,'perspective':region.view_perspective,'zoom':region.view_camera_zoom,'offset':list(region.view_camera_offset)})
print('PILOT_JSON:'+json.dumps(result))`);
try {
  launch("xvfb", process.env.XVFB_BIN || "Xvfb", [
    `:${display}`,
    "-screen",
    "0",
    "1440x960x24",
    "-ac",
    "-nolisten",
    "unix",
    "-listen",
    "tcp",
  ]);
  await waitPort(6000 + display);
  if (process.env.OPENBOX_BIN) launch("openbox", process.env.OPENBOX_BIN, []);
  launch("blender", process.env.BLENDER_BIN || "blender", [
    "--factory-startup",
    "-noaudio",
    "--python",
    path.resolve("deploy/bootstrap.py"),
  ]);
  await waitPort(port);
  if (process.env.PILOT_TEST_ASSET_FORMATS === "true")
    await verifyAssetFormats(bridge, directory);
  await bridge.activate("quality-native");
  await bridge.upstream.python(`from mathutils import Quaternion
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
def cube(name,location,scale,color):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj=bpy.context.object
    obj.name=name
    obj.scale=scale
    material=bpy.data.materials.new(name+' Paint')
    material.diffuse_color=(*color,1)
    material.use_nodes=True
    material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(*color,1)
    obj.data.materials.append(material)
    return obj
cube('Floor',(0,0,-0.1),(6,5,0.2),(0.3,0.3,0.35))
cube('Red block',(-1,0,0.6),(1,1,1.2),(0.85,0.15,0.1))
cube('Blue beam',(0.7,0.6,1.6),(2.4,0.5,0.4),(0.1,0.3,0.85))
cube('Green support',(1.4,0.6,0.7),(0.35,0.35,1.4),(0.15,0.65,0.25))
missing=bpy.data.images.new('Missing texture fixture',width=2,height=2)
missing.source='FILE'
missing.filepath='//fixture-missing-texture.png'
material=bpy.data.objects['Red block'].data.materials[0]
node=material.node_tree.nodes.new('ShaderNodeTexImage')
node.image=missing
for area in bpy.context.screen.areas:
    if area.type=='VIEW_3D':
        area.spaces.active.shading.color_type='MATERIAL'
        area.spaces.active.region_3d.view_perspective='PERSP'
        area.spaces.active.region_3d.view_distance=9
        area.spaces.active.region_3d.view_location=(0.3,0.2,0.5)`);
  await bridge.save();
  await bridge.capture("quality-native", "baseline", "quality-native-run");
  const before = await bridge.info();
  const viewsBefore = await readView();
  const inspection = await bridge.inspectQuality();
  assert.equal(inspection.summary.objectsTotal, 4);
  assert.equal(inspection.summary.meshObjects, 4);
  assert(inspection.issues.some((issue) => issue.code === "missing-texture"));
  assert(
    inspection.issues.some((issue) => issue.code === "floating-candidate"),
  );
  assert.equal(inspection.sceneRevision, before.revision);
  checks.push(
    "native world bounds, geometry, missing texture, and candidate-only floating findings",
  );
  const captures = await bridge.captureViews(
    "quality-native",
    "quality",
    "quality-native-run",
    ["front", "right", "top"],
  );
  const hashes: string[] = [];
  for (const item of captures) {
    const bytes = await readFile(item.capture.path);
    const info = await sharp(bytes).metadata();
    assert(info.width! >= 600 && info.height! >= 400);
    hashes.push(createHash("sha256").update(bytes).digest("hex"));
    await writeFile(path.join(directory, item.view + ".jpg"), bytes);
  }
  assert.equal(
    new Set(hashes).size,
    3,
    "three native views must produce different images",
  );
  checks.push(
    "three actual MCP JPEG images with distinct front/right/top geometry",
  );
  assert.deepEqual(
    await readView(),
    viewsBefore,
    "all original viewport fields are restored",
  );
  assert.equal(
    (await bridge.info()).revision,
    captures[0]!.capture.sceneRevision,
  );
  assert.deepEqual((await bridge.info()).objects, before.objects);
  const refreshedInspection = await bridge.inspectQuality();
  assert.equal(
    refreshedInspection.sceneRevision,
    captures[0]!.capture.sceneRevision,
  );
  checks.push(
    "all views share a current revision; subsequent structural report matches it and viewport/object transforms are restored",
  );
  const originalCall = bridge.upstream.call.bind(bridge.upstream);
  bridge.upstream.call = async (...args) => {
    const result = await originalCall(...args);
    if (args[0] === "look" && args[1].mode === "angles")
      throw new Error("deliberate screenshot delivery failure");
    return result;
  };
  await assert.rejects(
    bridge.captureViews("quality-native", "failure", "quality-native-run"),
    /deliberate screenshot delivery failure/,
  );
  bridge.upstream.call = originalCall;
  assert.deepEqual(await readView(), viewsBefore);
  assert.deepEqual((await bridge.info()).objects, before.objects);
  checks.push(
    "screenshot delivery failure after native drawing still restores viewport and objects without claiming evidence",
  );
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(
      {
        passed: true,
        timestamp: new Date().toISOString(),
        mode: "native-blender-mcp-no-model",
        blenderVersion: before.version,
        checks,
        inspection: refreshedInspection,
        captures: captures.map(({ capture, view }, i) => ({
          id: capture.id,
          view,
          sha256: hashes[i],
          sceneRevision: capture.sceneRevision,
        })),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      { passed: true, checks, report: path.join(directory, "result.json") },
      null,
      2,
    ),
  );
} finally {
  stopping = true;
  await bridge.upstream.close().catch(() => {});
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode) continue;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
  }
}

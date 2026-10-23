/** Actual Blender assertions for reusable assets; no model assertions or mocks. */
import assert from "node:assert/strict";
import { writeFile, stat, rm, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { AssetLibrary } from "../packages/blender-bridge/library.js";
import type { SceneBridge } from "../packages/blender-bridge/scene.js";
export async function verifyLibrary(bridge: SceneBridge, dir: string) {
  await bridge.activate("library-source");
  const texture = path.join(dir, "library-test-texture.png");
  await sharp({
    create: { width: 32, height: 32, channels: 3, background: "#ad7143" },
  })
    .png()
    .toFile(texture);
  await bridge.upstream.python(`
bpy.ops.object.select_all(action='DESELECT')
bpy.ops.mesh.primitive_cube_add(size=2,location=(4,1,2))
body=bpy.context.object
body.name='Reusable_Chair'
mat=bpy.data.materials.new('Reusable_Wood')
mat.use_nodes=True
mat.diffuse_color=(0.6,0.3,0.1,1)
tex=mat.node_tree.nodes.new('ShaderNodeTexImage')
tex.image=bpy.data.images.load(${JSON.stringify(texture)})
body.data.materials.append(mat)
bpy.ops.mesh.primitive_cube_add(size=0.5,location=(4,1,3.5))
child=bpy.context.object
child.name='Reusable_Child'
world=child.matrix_world.copy()
child.parent=body
child.matrix_world=world
bpy.ops.object.select_all(action='DESELECT')
body.select_set(True)
bpy.context.view_layer.objects.active=body
`);
  const before = await bridge.info();
  const library = new AssetLibrary(dir);
  const asset = await bridge.saveLibraryAsset({
    name: "木质座椅",
    category: "prop",
    tags: ["木质", "客厅"],
    description: "用于跨项目验收的带贴图父子对象",
    scope: "selection",
  });
  assert.deepEqual(asset.objectNames, ["Reusable_Chair", "Reusable_Child"]);
  assert((await stat(asset.path)).size > 100);
  assert((await sharp(asset.previewPath!).metadata()).width! > 200);
  assert.deepEqual(
    (await bridge.info()).objects,
    before.objects,
    "Saving an asset preserves the source scene",
  );
  await rm(texture); // The asset must be self-contained after the original image is gone.
  await bridge.activate("library-destination");
  const count = (await bridge.info()).objects.length;
  await bridge.importLibraryAsset(asset.id);
  assert.equal(
    (await bridge.info()).objects.length,
    count + 2,
    "Only selected hierarchy is appended",
  );
  const packed = await bridge.upstream.json(`import json
o=bpy.data.objects['Reusable_Chair']
print('PILOT_JSON:'+json.dumps({'parent':bpy.data.objects['Reusable_Child'].parent.name,'location':list(o.location),'material':o.data.materials[0].name,'packed':bool(next(n for n in o.data.materials[0].node_tree.nodes if n.type=='TEX_IMAGE').image.packed_file)}))`);
  assert.equal(packed.parent, "Reusable_Chair");
  assert.deepEqual(packed.location, [4, 1, 2]);
  assert.equal(packed.material, "Reusable_Wood");
  assert.equal(packed.packed, true);
  await bridge.upstream.python(
    "bpy.data.objects['Reusable_Chair'].location.x=99",
  );
  await bridge.importLibraryAsset(asset.id);
  const duplicates = (await bridge.info()).objects.filter((o) =>
    o.name.startsWith("Reusable_Chair"),
  );
  assert.equal(duplicates.length, 2);
  assert(duplicates.some((o) => o.location[0] === 4));
  assert(duplicates.some((o) => o.location[0] === 99));
  const independence = await bridge.upstream.json(`import json
objects=[o for o in bpy.context.scene.objects if o.name.startswith('Reusable_Chair')]
print('PILOT_JSON:'+json.dumps({'meshes':len({o.data.as_pointer() for o in objects}),'materials':len({o.data.materials[0].as_pointer() for o in objects})}))`);
  assert.equal(independence.meshes, 2);
  assert.equal(independence.materials, 2);
  const sceneAsset = await bridge.saveLibraryAsset({
    name: "组合场景",
    category: "scene",
    scope: "scene",
  });
  assert.equal(
    sceneAsset.objectNames.length,
    (await bridge.info()).objects.length,
  );
  await bridge.activate("library-scene-destination");
  const sceneCount = (await bridge.info()).objects.length;
  await bridge.importLibraryAsset(sceneAsset.id);
  assert.equal(
    (await bridge.info()).objects.length,
    sceneCount + sceneAsset.objectNames.length,
  );
  assert.equal(
    (await library.list({ category: "prop", search: "客厅" })).items[0].id,
    asset.id,
  );
  await library.update(asset.id, {
    favorite: true,
    description: "已验证贴图与层级",
  });
  assert.equal(
    (await new AssetLibrary(dir).list({ favorite: true })).items[0].id,
    asset.id,
  );
  await bridge.upstream.python("bpy.ops.object.select_all(action='DESELECT')");
  await assert.rejects(
    bridge.saveLibraryAsset({ name: "empty-selection" }),
    /选择|assert|Error/i,
  );
  const report = {
    passed: true,
    blender: before.version,
    checks: [
      "selected hierarchy only",
      "packed texture survives deletion of original",
      "materials and transforms",
      "source scene unchanged",
      "cross-project append",
      "repeated imports have independent meshes and materials",
      "scene collection merge",
      "category/tag search",
      "favorite survives reload",
      "empty selection rejected",
    ],
    assetIds: [asset.id, sceneAsset.id],
  };
  await writeFile(
    path.join(dir, "library-result.json"),
    JSON.stringify(report, null, 2),
  );
  await bridge.activate("native-smoke");
  console.log(
    "PASS reusable asset library: real Blender hierarchy, packed texture, independent copies, scene merge and persistence",
  );
  return report;
}

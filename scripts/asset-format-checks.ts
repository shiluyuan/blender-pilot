import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SceneBridge } from "../packages/blender-bridge/scene.js";
import { AssetLibrary } from "../packages/blender-bridge/library.js";
import { libraryMetadataSchema } from "../packages/blender-bridge/library.js";

/** Real Blender exports/imports; no model or network is used. */
export async function verifyAssetFormats(bridge: SceneBridge, root: string) {
  const directory = path.join(root, "format-fixtures");
  await mkdir(directory, { recursive: true });
  await bridge.activate("format-source");
  await bridge.upstream.python(`import os,zipfile
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add(size=1)
bpy.context.object.name='PackageCube'
root=${JSON.stringify(directory)}
image=bpy.data.images.new('PackageTexture',width=16,height=16)
image.filepath_raw=os.path.join(root,'texture.png')
image.file_format='PNG'
image.save()
mat=bpy.data.materials.new('PackageMaterial');mat.use_nodes=True
node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=image
mat.node_tree.links.new(node.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
bpy.context.object.data.materials.append(mat)
exports={
 'glb':lambda f:bpy.ops.export_scene.gltf(filepath=f,export_format='GLB'),
 'gltf':lambda f:bpy.ops.export_scene.gltf(filepath=f,export_format='GLTF_SEPARATE'),
 'fbx':lambda f:bpy.ops.export_scene.fbx(filepath=f),
 'obj':lambda f:bpy.ops.wm.obj_export(filepath=f),
 'stl':lambda f:bpy.ops.wm.stl_export(filepath=f),
 'ply':lambda f:bpy.ops.wm.ply_export(filepath=f),
 'usd':lambda f:bpy.ops.wm.usd_export(filepath=f),
 'usda':lambda f:bpy.ops.wm.usd_export(filepath=f),
 'usdc':lambda f:bpy.ops.wm.usd_export(filepath=f),
 'usdz':lambda f:bpy.ops.wm.usd_export(filepath=f),
 'abc':lambda f:bpy.ops.wm.alembic_export(filepath=f),
}
for ext,exporter in exports.items():
    result=exporter(os.path.join(root,'model.'+ext))
    assert 'FINISHED' in result,(ext,str(result))
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(root,'model.blend'),copy=True,check_existing=False)
with zipfile.ZipFile(os.path.join(root,'gltf-package.zip'),'w',zipfile.ZIP_DEFLATED) as package:
    for name in os.listdir(root):
        if name.endswith(('.gltf','.bin','.png')): package.write(os.path.join(root,name),name)
with zipfile.ZipFile(os.path.join(root,'obj-package.zip'),'w',zipfile.ZIP_DEFLATED) as package:
    for name in os.listdir(root):
        if name.endswith(('.obj','.mtl','.png')): package.write(os.path.join(root,name),name)
`);
  const checks: string[] = [];
  for (const extension of [
    "blend",
    "glb",
    "gltf",
    "fbx",
    "obj",
    "stl",
    "ply",
    "usd",
    "usda",
    "usdc",
    "usdz",
    "abc",
  ]) {
    await bridge.activate("format-" + extension);
    const before = (await bridge.info()).objects.length;
    await bridge.import(path.join(directory, "model." + extension));
    assert(
      (await bridge.info()).objects.length > before,
      extension + " imported real objects",
    );
    checks.push(extension + " export/import roundtrip");
  }
  const library = new AssetLibrary(root);
  for (const name of ["gltf-package.zip", "obj-package.zip"]) {
    const asset = await library.publish(
      libraryMetadataSchema.parse({ name, category: "prop" }),
      {
        file: path.join(directory, name),
        mime: "application/zip",
        source: "upload",
      },
    );
    assert(asset.package);
    await bridge.activate("zip-" + name.split("-")[0]);
    const before = (await bridge.info()).objects.length;
    await bridge.importLibraryAsset(asset.id);
    assert((await bridge.info()).objects.length > before);
    const packed = await bridge.upstream.json(`import json,os
images=[i for i in bpy.data.images if i.source=='FILE']
print('PILOT_JSON:'+json.dumps({'images':len(images),'missing':[i.name for i in images if not i.packed_file and not os.path.exists(bpy.path.abspath(i.filepath))]}))`);
    assert(packed.images > 0, name + " material images imported");
    assert.equal(packed.missing.length, 0);
    assert((await readFile(await library.file(asset.id))).length > 0);
    checks.push(name + " library publish/import preserves relative resources");
  }
  const report = {
    passed: true,
    scope: "actual Blender roundtrips and ZIP library import, no model",
    checks,
  };
  await writeFile(
    path.join(root, "asset-formats-result.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}

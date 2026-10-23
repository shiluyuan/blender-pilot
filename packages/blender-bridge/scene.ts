import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, stat, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { AssetLibrary, saveLibrarySchema } from "./library.js";
import { Upstream } from "./upstream.js";
import {
  atomicJson,
  now,
  safePath,
  existingSafePath,
} from "../contracts/fs.js";
import type { Capture, SceneInfo, Snapshot } from "../contracts/index.js";
const py = (v: unknown) => JSON.stringify(v);
export class SceneBridge {
  upstream: Upstream;
  private stateFile: string;
  activeProject?: string;
  generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    public dataRoot: string,
    options: { environment?: Record<string, string>; projectId?: string } = {},
  ) {
    this.upstream = new Upstream(options.environment);
    this.stateFile = options.projectId
      ? path.join(this.projectRoot(options.projectId), "runtime-scene.json")
      : path.join(dataRoot, "scene.json");
  }
  projectRoot(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error("无效项目");
    return safePath(this.dataRoot, "projects", id);
  }
  async init() {
    try {
      const s = JSON.parse(await readFile(this.stateFile, "utf8"));
      this.generation = s.generation + 1;
      // A restarted Blender starts with its factory scene. Reload the saved
      // project instead of trusting the previous process's in-memory binding.
      await this.activate(s.projectId);
    } catch {
      this.generation = 1;
    }
  }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(fn);
    this.queue = next;
    return next;
  }
  async idle() {
    await this.queue.catch(() => {});
  }
  async activate(projectId: string) {
    if (this.activeProject === projectId) return;
    if (this.activeProject) await this.save();
    const root = this.projectRoot(projectId);
    await mkdir(root, { recursive: true });
    const target = path.join(root, "scene.blend");
    let exists = false;
    try {
      await stat(target);
      exists = true;
    } catch {}
    await this.upstream.python(
      exists
        ? `bpy.ops.wm.open_mainfile(filepath=${py(target)}, load_ui=False, use_scripts=False)`
        : `bpy.ops.wm.read_factory_settings(use_empty=False)\nbpy.ops.wm.save_as_mainfile(filepath=${py(target)}, check_existing=False)`,
    );
    this.activeProject = projectId;
    this.generation++;
    await atomicJson(this.stateFile, {
      projectId,
      generation: this.generation,
    });
  }
  async info(): Promise<SceneInfo> {
    const info = await this.upstream.json(
      `import json\nbpy.context.view_layer.update()\nobjects=[]\nfor o in bpy.context.scene.objects:\n    objects.append({'name':o.name,'type':o.type,'location':list(o.location),'rotation':list(o.rotation_euler),'scale':list(o.scale),'dimensions':list(o.dimensions),'materials':[m.name if m else '' for m in getattr(o.data,'materials',[])],'vertices':len(o.data.vertices) if o.type=='MESH' else 0})\nprint('PILOT_JSON:'+json.dumps({'objects':objects,'active':bpy.context.view_layer.objects.active.name if bpy.context.view_layer.objects.active else None,'selected':[o.name for o in bpy.context.selected_objects],'mode':bpy.context.mode,'frame':bpy.context.scene.frame_current,'version':bpy.app.version_string,'filepath':bpy.data.filepath,'dirtyCounter':bpy.app.driver_namespace.get('pilot_revision',0)}))`,
    );
    return {
      ...info,
      revision: createHash("sha256")
        .update(JSON.stringify(info))
        .digest("hex")
        .slice(0, 20),
    };
  }
  assertProject(id: string) {
    if (this.activeProject !== id)
      throw new Error("场景绑定已失效，请重新打开项目");
  }
  async capture(
    projectId: string,
    phase: string,
    runId?: string,
    args: Record<string, unknown> = {},
  ): Promise<{ capture: Capture; image: any }> {
    this.assertProject(projectId);
    let content: any[] = [];
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        content = await this.upstream.call(
          "look",
          { mode: "viewport", max_size: 1280, ...args },
          30000,
        );
        if (!content.some((x) => x.type === "image"))
          throw new Error("MCP 没有返回图像");
        last = undefined;
        break;
      } catch (e) {
        last = e;
      }
    }
    if (last) throw last;
    const raw = content.find((x) => x.type === "image");
    const bytes = await sharp(Buffer.from(raw.data, "base64"), {
      limitInputPixels: 20_000_000,
    })
      .resize({
        width: 1600,
        height: 1600,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 82 })
      .toBuffer();
    if (bytes.length > 2 * 1024 * 1024) throw new Error("截图超过模型输入预算");
    const info = await this.info();
    const id = randomUUID();
    const file = path.join(
      this.projectRoot(projectId),
      "captures",
      id + ".jpg",
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    const capture: Capture = {
      id,
      projectId,
      runId,
      path: file,
      mime: "image/jpeg",
      sceneRevision: info.revision,
      generation: this.generation,
      mode: String(args.mode || "viewport"),
      phase,
      createdAt: now(),
    };
    return {
      capture,
      image: {
        type: "image",
        mimeType: "image/jpeg",
        data: bytes.toString("base64"),
      },
    };
  }
  async save() {
    if (!this.activeProject) throw new Error("没有活动场景");
    const file = path.join(this.projectRoot(this.activeProject), "scene.blend");
    await this.upstream.python(
      `bpy.ops.wm.save_as_mainfile(filepath=${py(file)}, check_existing=False)`,
    );
    await stat(file);
    return file;
  }
  async snapshot(name: string, runId?: string): Promise<Snapshot> {
    if (!this.activeProject) throw new Error("没有活动场景");
    const id = randomUUID();
    const file = path.join(
      this.projectRoot(this.activeProject),
      "snapshots",
      id + ".blend",
    );
    await mkdir(path.dirname(file), { recursive: true });
    await this.upstream.python(
      `bpy.ops.file.pack_all()\nbpy.ops.wm.save_as_mainfile(filepath=${py(file + ".tmp.blend")}, check_existing=False, copy=True)`,
    );
    const s = await stat(file + ".tmp.blend");
    if (s.size < 12) throw new Error("快照文件不完整");
    await rename(file + ".tmp.blend", file);
    return {
      id,
      projectId: this.activeProject,
      name,
      path: file,
      createdAt: now(),
      runId,
    };
  }
  async restore(projectId: string, file: string) {
    this.assertProject(projectId);
    const checked = safePath(
      this.projectRoot(projectId),
      path.relative(this.projectRoot(projectId), file),
    );
    const before = await this.snapshot("恢复前自动备份");
    await this.upstream.python(
      `bpy.ops.wm.open_mainfile(filepath=${py(checked)}, load_ui=False, use_scripts=False)`,
    );
    this.generation++;
    await this.save();
    await atomicJson(this.stateFile, {
      projectId,
      generation: this.generation,
    });
    return before;
  }
  async export(format: "glb" | "gltf" | "blend") {
    if (!this.activeProject) throw new Error("没有活动场景");
    if (format === "blend") {
      const snap = await this.snapshot("Blender 导出");
      return snap.path;
    }
    const file = path.join(
      this.projectRoot(this.activeProject),
      "exports",
      randomUUID(),
      "scene." + format,
    );
    await mkdir(path.dirname(file), { recursive: true });
    await this.upstream.python(
      `result=bpy.ops.export_scene.gltf(filepath=${py(file)}, export_format=${py(format === "glb" ? "GLB" : "GLTF_SEPARATE")})\nassert 'FINISHED' in result, str(result)`,
    );
    await stat(file);
    if (format === "gltf") {
      // Blender 4.5 removed GLTF_EMBEDDED. Embed the exporter-produced resources
      // into a standalone glTF, so downloading it never loses .bin/textures.
      const doc = JSON.parse(await readFile(file, "utf8"));
      for (const resource of [...(doc.buffers || []), ...(doc.images || [])]) {
        if (!resource.uri || resource.uri.startsWith("data:")) continue;
        const source = await existingSafePath(
          path.dirname(file),
          path.resolve(path.dirname(file), decodeURIComponent(resource.uri)),
        );
        const mime =
          resource.mimeType ||
          (source.endsWith(".png")
            ? "image/png"
            : /\.jpe?g$/.test(source)
              ? "image/jpeg"
              : "application/octet-stream");
        resource.uri = `data:${mime};base64,${(await readFile(source)).toString("base64")}`;
      }
      await atomicJson(file, doc);
    }
    return file;
  }
  async import(file: string) {
    const ext = path.extname(file).toLowerCase();
    const f = py(file);
    const commands: Record<string, string> = {
      ".glb": `bpy.ops.import_scene.gltf(filepath=${f})`,
      ".gltf": `bpy.ops.import_scene.gltf(filepath=${f})`,
      ".fbx": `bpy.ops.import_scene.fbx(filepath=${f})`,
      ".obj": `bpy.ops.wm.obj_import(filepath=${f})`,
    };
    if (commands[ext])
      return this.upstream.python(
        `result=${commands[ext]}\nassert 'FINISHED' in result, str(result)`,
      );
    if ([".png", ".jpg", ".jpeg", ".webp", ".hdr", ".exr"].includes(ext))
      return this.upstream.python(
        `image=bpy.data.images.load(${f},check_existing=True)\nprint('Loaded image datablock:',image.name)`,
      );
    if (ext === ".blend")
      return this.upstream.python(
        `with bpy.data.libraries.load(${f},link=False) as (source,target):\n    target.objects=source.objects\nfor obj in target.objects:\n    if obj is not None: bpy.context.collection.objects.link(obj)\nprint('Appended objects from Blender file')`,
      );
    throw new Error("不支持的导入格式");
  }
  async saveLibraryAsset(input: unknown) {
    if (!this.activeProject) throw new Error("没有活动场景");
    const options = saveLibrarySchema.parse(input);
    const library = new AssetLibrary(this.dataRoot),
      id = randomUUID();
    const dir = library.root(id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "asset.blend");
    try {
      const objects = await this.upstream.json(`import json
assert bpy.context.mode == 'OBJECT', '请先切换到对象模式'
names=json.loads(${py(JSON.stringify(options.objectNames || []))})
if ${py(options.scope)} == 'scene':
    chosen=set(bpy.context.scene.objects)
elif names:
    assert all(n in bpy.context.scene.objects for n in names), '指定对象不存在'
    chosen={bpy.context.scene.objects[n] for n in names}
else:
    chosen=set(bpy.context.selected_objects)
assert chosen, '请先选择需要保存的对象'
# Preserve hierarchy, rigs and common modifier/constraint object dependencies.
pending=list(chosen)
while pending:
    obj=pending.pop()
    dependencies=list(obj.children)
    if obj.parent: dependencies.append(obj.parent)
    dependencies += [getattr(m,'object',None) for m in obj.modifiers]
    dependencies += [getattr(c,'target',None) for c in obj.constraints]
    for dep in dependencies:
        if dep is not None and dep not in chosen:
            chosen.add(dep)
            pending.append(dep)
bpy.ops.file.pack_all()
collection=bpy.data.collections.new('PILOT_ASSET')
try:
    for obj in chosen: collection.objects.link(obj)
    collection.asset_mark()
    collection.asset_data.description=${py(options.description)}
    bpy.data.libraries.write(${py(file)}, {collection}, path_remap='ABSOLUTE', fake_user=True, compress=True)
    print('PILOT_JSON:'+json.dumps({'names':sorted(o.name for o in chosen),'sources':sorted({o.get('pilot_asset_id') for o in chosen if o.get('pilot_asset_id')})}))
finally:
    bpy.data.collections.remove(collection)`);
      // A real viewport capture, explicitly labelled as the saved view in the UI.
      const preview = await this.capture(this.activeProject, "library-preview");
      return library.publish(options, {
        id,
        projectId: this.activeProject,
        file,
        preview: preview.capture.path,
        mime: "application/x-blender",
        source: "blender",
        objectNames: objects.names,
        sourceAssetIds: objects.sources,
      });
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
  }
  async importLibraryAsset(id: string) {
    const library = new AssetLibrary(this.dataRoot),
      asset = await library.get(id);
    const file = await library.file(id);
    const before = new Set((await this.info()).objects.map((o) => o.name));
    if (asset.source !== "blender") {
      await this.import(file);
      const names = (await this.info()).objects
        .filter((o) => !before.has(o.name))
        .map((o) => o.name);
      await this.upstream.python(
        `for name in ${py(names)}:\n    bpy.data.objects[name]['pilot_asset_id']=${py(id)}`,
      );
      return {
        assetId: id,
        objects: names,
        mode: names.length ? "independent-copy" : "image-datablock",
      };
    }
    return this.upstream.json(`import json
with bpy.data.libraries.load(${py(file)}, link=False) as (source,target):
    target.collections=[n for n in source.collections if n.startswith('PILOT_ASSET')]
assert target.collections, '素材集合缺失'
names=[]
for collection in target.collections:
    if collection:
        collection.name=${py(asset.name)}
        bpy.context.scene.collection.children.link(collection)
        for obj in collection.all_objects: obj["pilot_asset_id"]=${py(id)}
        names += [o.name for o in collection.all_objects]
print('PILOT_JSON:'+json.dumps({'assetId':${py(id)},'objects':names,'mode':'independent-copy'}))`);
  }
  async queryApi(target: string) {
    if (!/^(bpy\.)?(types\.[A-Za-z_][\w]*|ops\.[a-z_]+\.[a-z_]+)$/.test(target))
      throw new Error(
        "请输入 bpy.types.Mesh 或 bpy.ops.mesh.primitive_cube_add",
      );
    const expression = target.startsWith("bpy.") ? target : "bpy." + target;
    return this.upstream.json(
      `import json\nobj=${expression}\nrna=obj.get_rna_type() if hasattr(obj,'get_rna_type') else obj.bl_rna\nresult={'name':rna.identifier,'properties':[]}\nfor p in rna.properties:\n    result['properties'].append({'name':p.identifier,'type':p.type,'description':p.description,'readonly':p.is_readonly,'enum':[i.identifier for i in p.enum_items] if p.type=='ENUM' else []})\nprint('PILOT_JSON:'+json.dumps(result))`,
    );
  }
}
export function receipt(before: SceneInfo, after: SceneInfo) {
  const old = new Map(before.objects.map((o) => [o.name, o])),
    current = new Map(after.objects.map((o) => [o.name, o]));
  return {
    created: after.objects.filter((o) => !old.has(o.name)).map((o) => o.name),
    deleted: before.objects
      .filter((o) => !current.has(o.name))
      .map((o) => o.name),
    modified: after.objects
      .filter(
        (o) =>
          old.has(o.name) &&
          JSON.stringify(o) !== JSON.stringify(old.get(o.name)),
      )
      .map((o) => ({ name: o.name, before: old.get(o.name), after: o })),
    scope: "对象名称、变换、尺寸、材质关联和顶点数；不代表完整拓扑差异",
  };
}

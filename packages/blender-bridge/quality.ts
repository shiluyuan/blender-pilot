import type {
  QualityBounds,
  QualityIssue,
  SceneQualityInspection,
} from "../contracts/quality.js";

export const MAX_QUALITY_OBJECTS = 500;
export const MAX_QUALITY_ISSUES = 100;
export const MAX_OVERLAP_CANDIDATES = 20;

export interface RawQualityObject {
  name: string;
  type: string;
  visible: boolean;
  parent: string | null;
  scale: number[];
  finiteTransform: boolean;
  bounds: QualityBounds | null;
  materialSlots: Array<string | null>;
  vertices: number;
  polygons: number;
}
export interface RawQualityScene {
  objectsTotal: number;
  objects: RawQualityObject[];
  lights: number;
  cameras: number;
  missingTextures: Array<{ name: string; users: string[] }>;
  worldIllumination: boolean;
}

const geometric = (o: RawQualityObject) =>
  o.visible && ["MESH", "CURVE", "SURFACE", "FONT", "META"].includes(o.type);
const validBounds = (bounds: QualityBounds | null): bounds is QualityBounds =>
  !!bounds &&
  bounds.min.length === 3 &&
  bounds.max.length === 3 &&
  bounds.min.every(
    (v, index) =>
      Number.isFinite(v) &&
      Number.isFinite(bounds.max[index]) &&
      v <= bounds.max[index],
  );

export function summarizeQuality(
  raw: RawQualityScene,
  metadata: Pick<
    SceneQualityInspection,
    "id" | "projectId" | "createdAt" | "sceneRevision" | "generation"
  >,
  options: { groundZ: number; overlapCandidates: boolean },
): SceneQualityInspection {
  const objects = raw.objects.slice(0, MAX_QUALITY_OBJECTS);
  const issues: QualityIssue[] = [];
  let issueCount = 0;
  let warningCount = 0;
  let errorCount = 0;
  const add = (issue: QualityIssue) => {
    issueCount++;
    if (issue.severity === "warning") warningCount++;
    if (issue.severity === "error") errorCount++;
    if (issues.length < MAX_QUALITY_ISSUES) issues.push(issue);
  };
  for (const object of objects) {
    if (!object.finiteTransform)
      add({
        code: "invalid-transform",
        severity: "error",
        objects: [object.name],
        message: "对象变换包含非有限数值。",
        requiresVisualReview: false,
      });
    if (!geometric(object)) continue;
    if (
      object.type === "MESH" &&
      (object.vertices === 0 || object.polygons === 0)
    )
      add({
        code: "empty-mesh",
        severity: "warning",
        objects: [object.name],
        message: "网格没有可见面；请确认是否为辅助对象。",
        requiresVisualReview: true,
      });
    if (!validBounds(object.bounds))
      add({
        code: "degenerate-bounds",
        severity: "warning",
        objects: [object.name],
        message: "无法读取有效世界包围盒。",
        requiresVisualReview: true,
      });
    else if (
      object.bounds.min.every((v, i) => object.bounds!.max[i] - v < 0.000001)
    )
      add({
        code: "degenerate-bounds",
        severity: "warning",
        objects: [object.name],
        message: "对象的三个方向尺寸都接近零。",
        requiresVisualReview: true,
      });
    if (object.scale.some((v) => v < 0))
      add({
        code: "negative-scale",
        severity: "info",
        objects: [object.name],
        message: "对象带负缩放；导出前检查镜像和法线效果。",
        requiresVisualReview: true,
      });
    if (!object.materialSlots.length || object.materialSlots.some((v) => !v))
      add({
        code: "missing-material",
        severity: "info",
        objects: [object.name],
        message: "对象含空材质槽；白模或辅助对象可能是有意的。",
        requiresVisualReview: true,
      });
    if (
      !object.parent &&
      validBounds(object.bounds) &&
      object.bounds.min[2] > options.groundZ + 0.01
    )
      add({
        code: "floating-candidate",
        severity: "info",
        objects: [object.name],
        message: `底部高于参考平面 Z=${options.groundZ}；可能是悬空、承托关系或设计所需，需要看图确认。`,
        requiresVisualReview: true,
      });
  }
  for (const texture of raw.missingTextures)
    add({
      code: "missing-texture",
      severity: "warning",
      objects: texture.users,
      message: `图像 ${texture.name} 没有打包且文件不存在。`,
      requiresVisualReview: true,
    });
  if (!raw.lights && !raw.worldIllumination)
    add({
      code: "no-light",
      severity: "info",
      objects: [],
      message: "没有检测到灯光或世界背景照明；材质预览与最终渲染可能不同。",
      requiresVisualReview: true,
    });
  const geometry = objects.filter((o) => geometric(o) && validBounds(o.bounds));
  let overlaps = 0;
  let overlapCandidatesTruncated = false;
  if (options.overlapCandidates) {
    outer: for (let i = 0; i < geometry.length; i++) {
      for (let j = i + 1; j < geometry.length; j++) {
        const a = geometry[i],
          b = geometry[j];
        // A parent and its child deliberately share space. Full containment is
        // also common for room shells and furniture, not intersection proof.
        if (a.parent === b.name || b.parent === a.name) continue;
        const aa = a.bounds!,
          bb = b.bounds!;
        const contains = (x: QualityBounds, y: QualityBounds) =>
          x.min.every((v, k) => v <= y.min[k] && x.max[k] >= y.max[k]);
        if (contains(aa, bb) || contains(bb, aa)) continue;
        if (
          !aa.min.every(
            (v, k) =>
              Math.min(aa.max[k], bb.max[k]) - Math.max(v, bb.min[k]) > 0.0001,
          )
        )
          continue;
        if (overlaps >= MAX_OVERLAP_CANDIDATES) {
          overlapCandidatesTruncated = true;
          break outer;
        }
        overlaps++;
        add({
          code: "overlap-candidate",
          severity: "info",
          objects: [a.name, b.name],
          message:
            "世界包围盒重叠；这不是网格穿模的判定，请从多个角度检查接触是否合理。",
          requiresVisualReview: true,
        });
      }
    }
  }
  const bounds: QualityBounds | null = geometry.length
    ? {
        min: [0, 1, 2].map((i) =>
          Math.min(...geometry.map((o) => o.bounds!.min[i])),
        ) as [number, number, number],
        max: [0, 1, 2].map((i) =>
          Math.max(...geometry.map((o) => o.bounds!.max[i])),
        ) as [number, number, number],
      }
    : null;
  return {
    schemaVersion: 1,
    ...metadata,
    status: errorCount
      ? "structural-errors"
      : issueCount
        ? "review-needed"
        : "no-structural-issues",
    summary: {
      objectsTotal: raw.objectsTotal,
      objectsInspected: objects.length,
      meshObjects: objects.filter((o) => o.type === "MESH").length,
      vertices: objects.reduce((n, o) => n + o.vertices, 0),
      polygons: objects.reduce((n, o) => n + o.polygons, 0),
      lights: raw.lights,
      cameras: raw.cameras,
      warningCount,
      errorCount,
    },
    bounds,
    issues,
    limits: {
      maxObjects: MAX_QUALITY_OBJECTS,
      objectsTruncated: raw.objectsTotal > objects.length,
      issuesTruncated: issueCount > issues.length,
      overlapCandidatesTruncated,
      groundZ: options.groundZ,
      limitations: [
        "结构检查不代表作品视觉质量通过，构图、光照和需求符合度必须查看实际图像。",
        "包围盒重叠和离地仅是候选线索，不做精确网格相交或支撑分析，不应据此自动删除或移动对象。",
        "只检查当前帧和前 500 个场景对象；顶点数来自原始网格，不是完整修改器、实例或动画验证。",
      ],
    },
  };
}

/** Read-only bpy data collection. No operators and no mutation of scene data. */
export const inspectQualityPython = `import json, math, os
from mathutils import Vector
bpy.context.view_layer.update()
scene=bpy.context.scene
depsgraph=bpy.context.evaluated_depsgraph_get()
objects=[]
for obj in list(scene.objects)[:${MAX_QUALITY_OBJECTS}]:
    transform=[float(x) for row in obj.matrix_world for x in row]
    finite=all(math.isfinite(v) for v in transform)
    bounds=None
    if finite and obj.type in {'MESH','CURVE','SURFACE','FONT','META'}:
        evaluated=obj.evaluated_get(depsgraph)
        corners=[evaluated.matrix_world @ Vector(c) for c in evaluated.bound_box]
        if corners and all(math.isfinite(float(v)) for c in corners for v in c):
            bounds={'min':[min(float(c[i]) for c in corners) for i in range(3)],'max':[max(float(c[i]) for c in corners) for i in range(3)]}
    objects.append({'name':obj.name,'type':obj.type,'visible':obj.visible_get(),'parent':obj.parent.name if obj.parent else None,'scale':[float(v) if math.isfinite(float(v)) else 0 for v in obj.scale],'finiteTransform':finite,'bounds':bounds,'materialSlots':[s.material.name if s.material else None for s in obj.material_slots],'vertices':len(obj.data.vertices) if obj.type=='MESH' else 0,'polygons':len(obj.data.polygons) if obj.type=='MESH' else 0})
missing=[]
for img in bpy.data.images:
    if img.source!='FILE' or img.packed_file or not img.filepath: continue
    if os.path.isfile(bpy.path.abspath(img.filepath,library=img.library)): continue
    names=[]
    for obj in list(scene.objects)[:${MAX_QUALITY_OBJECTS}]:
        if any(slot.material and slot.material.use_nodes and any(getattr(node,'image',None)==img for node in slot.material.node_tree.nodes) for slot in obj.material_slots): names.append(obj.name)
    if names: missing.append({'name':img.name,'users':names[:20]})
    if len(missing)>=100: break
world=scene.world
lit=bool(world and not world.use_nodes and any(float(v)>0 for v in world.color))
if world and world.use_nodes:
    lit=any(node.type=='BACKGROUND' and float(node.inputs['Strength'].default_value)>0 and (node.inputs['Color'].is_linked or any(float(v)>0 for v in node.inputs['Color'].default_value[:3])) for node in world.node_tree.nodes)
print('PILOT_JSON:'+json.dumps({'objectsTotal':len(scene.objects),'objects':objects,'lights':sum(1 for o in scene.objects if o.type=='LIGHT' and not o.hide_render),'cameras':sum(1 for o in scene.objects if o.type=='CAMERA'),'missingTextures':missing,'worldIllumination':lit},allow_nan=False))`;

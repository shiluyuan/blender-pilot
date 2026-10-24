/** A fresh real-model recipe → library reuse → new geometry → reusable asset
 * check. Never uses the protocol fixture. Test geometry is deliberately simple
 * so bpy readback, source-file hash and restore are independent ground truth. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  renderTemplate,
  type CreationTemplate,
} from "../packages/contracts/templates.js";
import type { TestApi } from "./real-model-checks.js";

export async function verifyTemplateRealModel(options: {
  api: TestApi;
  projectId: string;
  sessionId: string;
  libraryAssetId: string;
  dir: string;
  secret: string;
}) {
  const { api, projectId, sessionId, libraryAssetId, dir, secret } = options;
  const suffix = randomUUID().slice(0, 8),
    marker = `Recipe_${suffix}`,
    savedName = `RecipeBundle_${suffix}`;
  const source = await api(`/library/${libraryAssetId}`);
  const hash = async (file: string) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  const originalHash = await hash(source.path);
  const template: CreationTemplate = await api("/templates", {
    name: `真实模型组合验收 ${suffix}`,
    category: "composition",
    description:
      "真实模型与真实 Blender 的合成几何验收，不代表生产级艺术效果。",
    prompt:
      "读取本条引用的唯一共享素材的元数据与预览，再调用 import_library_asset 导入一次。保留当前已有对象与材质，保留导入对象的原始名称。新增一个黄色立方体，准确命名 {{objectName}}，位置 (0, -3, 0.5)，实际 dimensions=(0.4, 0.6, 1.0)，不要修改已有物体。将导入的 Reusable_Chair 及其子对象和新立方体通过 save_library_asset 保存为新素材，名称 {{assetName}}，category=scene，scope=selection，objectNames 明确指定 Reusable_Chair 与新立方体。不要保存整个场景，不要覆盖原素材。调整视口使新立方体和导入对象可见，检查自动截图，用 report_verification 给出具体观察。",
    variables: [
      { key: "objectName", label: "新部件名称", defaultValue: marker },
      { key: "assetName", label: "组合素材名称", defaultValue: savedName },
    ],
    libraryAssetIds: [libraryAssetId],
  });
  const detail = await api(`/templates/${template.id}`);
  assert.equal(detail.missingLibraryAssetIds.length, 0);
  assert.equal(detail.libraryAssets[0].id, libraryAssetId);
  const prompt = renderTemplate(detail.template, {
    objectName: marker,
    assetName: savedName,
  });
  const body = {
    text: prompt,
    libraryAssetIds: template.libraryAssetIds,
    assetIds: [],
    clientRequestId: randomUUID(),
  };
  const run = await api(`/sessions/${sessionId}/turns`, body);
  assert.equal((await api(`/sessions/${sessionId}/turns`, body)).id, run.id);
  // Codex permits a 15-minute turn. Complex combinations can keep producing
  // valid tool receipts after four minutes, so allow that turn plus teardown.
  const modelWaitBudgetMs = Number(
    process.env.PILOT_LIVE_TASK_TIMEOUT_MS || 16 * 60_000,
  );
  if (
    !Number.isSafeInteger(modelWaitBudgetMs) ||
    modelWaitBudgetMs < 30000 ||
    modelWaitBudgetMs > 20 * 60_000
  )
    throw new Error("PILOT_LIVE_TASK_TIMEOUT_MS must be 30000–1200000");
  const deadline = Date.now() + modelWaitBudgetMs;
  let finished: any;
  while (Date.now() < deadline) {
    const current = (await api(`/sessions/${sessionId}/runs`)).find(
      (item: any) => item.id === run.id,
    );
    if (
      ["succeeded", "failed", "interrupted", "cancelled"].includes(
        current?.status,
      )
    ) {
      finished = current;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!finished) {
    await api(`/runs/${run.id}/cancel`, {});
    throw new Error(
      `Template model acceptance exceeded ${modelWaitBudgetMs}ms; cancellation requested before service teardown`,
    );
  }
  assert.equal(
    finished?.status,
    "succeeded",
    finished?.error || "template model task timed out",
  );
  const journal = await readFile(
    path.join(dir, "jobs", run.id + ".ndjson"),
    "utf8",
  );
  assert(!journal.includes(secret));
  const events = journal
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (const name of [
    "get_library_asset",
    "import_library_asset",
    "execute_blender_code",
    "save_library_asset",
    "report_verification",
  ])
    assert(
      events.some(
        (event) =>
          event.type === "tool.completed" && event.payload.name === name,
      ),
      `missing real tool ${name}`,
    );
  const actual = (await api(`/projects/${projectId}/scene`)).objects.find(
    (item: any) => item.name === marker,
  );
  assert(actual, "new geometry must exist in real Blender");
  for (const [key, expected] of [
    ["location", [0, -3, 0.5]],
    ["dimensions", [0.4, 0.6, 1]],
  ] as const)
    assert(
      actual[key].every(
        (value: number, index: number) =>
          Math.abs(value - expected[index]) < 0.01,
      ),
      key,
    );
  const bundle = (await api(`/library?search=${savedName}`)).items.find(
    (item: any) => item.name === savedName,
  );
  assert(
    bundle && bundle.sourceAssetIds.includes(libraryAssetId),
    "saved combination must retain direct source lineage",
  );
  assert(
    bundle.objectNames.includes(marker) &&
      bundle.objectNames.includes("Reusable_Chair") &&
      bundle.objectNames.includes("Reusable_Child"),
  );
  assert(
    !bundle.objectNames.includes("Live_Reference_Sphere"),
    "selected combination must exclude unrelated scene objects",
  );
  const target = await api("/projects", { name: `模板组合复用 ${suffix}` });
  // External-desktop acceptance has one physical Blender. Save and close it
  // before switching projects, just as a user with --max-studios 1 would.
  await api(`/projects/${projectId}/close`, {});
  await api(`/library/${bundle.id}/import`, { projectId: target.id });
  const reused = (await api(`/projects/${target.id}/scene`)).objects.find(
    (item: any) => item.name === marker,
  );
  assert(
    reused &&
      reused.dimensions.every(
        (value: number, index: number) =>
          Math.abs(value - [0.4, 0.6, 1][index]) < 0.01,
      ),
  );
  assert.equal(
    await hash(source.path),
    originalHash,
    "original library file remains byte-identical",
  );
  await api(`/projects/${target.id}/close`, {});
  const before = events.find(
    (event) =>
      event.type === "snapshot.created" &&
      event.payload.snapshot.name === "AI 操作前",
  )?.payload.snapshot;
  assert(before && before.projectId === projectId);
  const restored = await api(`/snapshots/${before.id}/restore`, {});
  assert(
    restored.before?.id && restored.before.id !== before.id,
    "restore must preserve a new backup",
  );
  assert(
    !(await api(`/projects/${projectId}/scene`)).objects.some(
      (item: any) => item.name === marker,
    ),
  );
  await api(`/projects/${projectId}/close`, {});
  assert(
    (await api(`/projects/${target.id}/scene`)).objects.some(
      (item: any) => item.name === marker,
    ),
    "restoring source project must preserve target copy",
  );
  // Leave the original project active for the following browser acceptance.
  await api(`/projects/${target.id}/close`, {});
  await api(`/projects/${projectId}/activate`, {});
  const report = {
    passed: true,
    mode: "live-model",
    modelWaitBudgetMs,
    time: new Date().toISOString(),
    runId: run.id,
    templateId: template.id,
    libraryAssetId,
    combinationAssetId: bundle.id,
    targetProjectId: target.id,
    geometryReadback: actual,
    sourceFileUnchanged: true,
    preTurnSnapshotRestored: true,
    checks: [
      "PostgreSQL custom template + parameters + accurate library references",
      "real model preview/import/create/save/visual report tools",
      "independent bpy geometry readback",
      "combination source lineage and selected hierarchy",
      "cross-project reuse",
      "original asset SHA256 preserved",
      "pre-turn restore creates backup and preserves other project",
    ],
  };
  await writeFile(
    path.join(dir, "template-model-result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    "PASS real model: template → library preview/import → new geometry → save combination → cross-project reuse → restore",
  );
  return report;
}

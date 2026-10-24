import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildApp } from "../apps/server/app.js";
import {
  BUILTIN_TEMPLATES,
  renderTemplate,
  templateInputSchema,
  type TemplateInput,
} from "../packages/contracts/templates.js";
import { LibraryCatalog } from "../packages/storage/library-catalog.js";
import { TemplateCatalog } from "../packages/storage/template-catalog.js";

const recipe = (patch: Partial<TemplateInput> = {}): TemplateInput => ({
  name: "办公室休息区",
  description: "复用家具，组合新的休息区",
  category: "composition",
  prompt: "组合一个 {{goal}}。把引用素材导入为独立副本。",
  variables: [{ key: "goal", label: "创作目标", defaultValue: "温暖的休息区" }],
  libraryAssetIds: [],
  ...patch,
});

test("template rendering preserves user values in one pass and rejects incomplete or excessive recipes", () => {
  assert.equal(BUILTIN_TEMPLATES.length, 9);
  for (const template of BUILTIN_TEMPLATES) {
    assert(renderTemplate(template).includes("截图"));
    const {
      id: _id,
      source: _source,
      version: _version,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...input
    } = template;
    assert(templateInputSchema.safeParse(input).success);
  }
  const template = recipe();
  assert.equal(
    renderTemplate(template),
    "组合一个 温暖的休息区。把引用素材导入为独立副本。",
  );
  assert.equal(
    renderTemplate(template, { goal: "{{goal}} $& $1" }),
    "组合一个 {{goal}} $& $1。把引用素材导入为独立副本。",
  );
  assert.throws(() => renderTemplate(template, { unknown: "x" }), /未知参数/);
  assert.throws(() => renderTemplate(template, { goal: " " }), /请填写参数/);
  assert.throws(
    () => renderTemplate(template, { goal: "x".repeat(2001) }),
    /2000/,
  );
  assert.throws(
    () =>
      renderTemplate(
        { prompt: "{{goal}}".repeat(20), variables: template.variables },
        { goal: "x".repeat(2000) },
      ),
    /展开后的模板/,
  );
  assert(
    !templateInputSchema.safeParse(recipe({ prompt: "{{missing}}" })).success,
  );
  assert(
    !templateInputSchema.safeParse(recipe({ prompt: "{{ goal }}" })).success,
  );
  assert(
    !templateInputSchema.safeParse(
      recipe({ variables: [...template.variables, ...template.variables] }),
    ).success,
  );
  assert(
    !templateInputSchema.safeParse(recipe({ prompt: "不含参数" })).success,
  );
  assert(
    !templateInputSchema.safeParse(recipe({ prompt: "x".repeat(12001) }))
      .success,
  );
  const asset = randomUUID();
  assert(
    !templateInputSchema.safeParse(recipe({ libraryAssetIds: [asset, asset] }))
      .success,
  );
});

test("numeric template parameters enforce units, bounds and decimal steps without changing legacy text", () => {
  const desk = BUILTIN_TEMPLATES.find((item) => item.id === "builtin:desk")!;
  const shelf = BUILTIN_TEMPLATES.find((item) => item.id === "builtin:shelf")!;
  const office = BUILTIN_TEMPLATES.find(
    (item) => item.id === "builtin:office-layout",
  )!;
  assert.match(
    renderTemplate(desk, { width: "1.55", height: "0.76" }),
    /外宽 1.55 米.*总高 0.76 米/,
  );
  assert.match(renderTemplate(shelf, { levels: "6" }), /承载搁板共 6 层/);
  assert.match(renderTemplate(office, { aisle: "1.3" }), /通道净宽至少 1.3 米/);
  for (const value of [
    "0.5",
    "3.1",
    "1.53",
    "Infinity",
    "NaN",
    "0x10",
    "1e2",
    "1.4; bpy.ops.wm.quit_blender()",
    "",
    "1000000001",
  ])
    assert.throws(() => renderTemplate(desk, { width: value }), /参数/);
  assert.throws(() => renderTemplate(shelf, { levels: "2.5" }), /按 1 递增/);
  assert.match(renderTemplate(desk, { width: " 1.4 " }), /外宽  1.4  米/);
  const numberRecipe = (overrides: Record<string, unknown> = {}) =>
    recipe({
      prompt: "宽 {{width}} 米",
      variables: [
        {
          key: "width",
          label: "宽度",
          defaultValue: "1.2",
          type: "number",
          unit: "米",
          min: 0.2,
          max: 2,
          step: 0.1,
          ...overrides,
        },
      ],
    });
  assert(templateInputSchema.safeParse(numberRecipe()).success);
  for (const overrides of [
    { min: 3 },
    { step: 0 },
    { step: -1 },
    { defaultValue: "2.1" },
    { defaultValue: "1.25" },
    { defaultValue: "" },
    { type: "text" },
    { max: Infinity },
  ])
    assert(
      !templateInputSchema.safeParse(numberRecipe(overrides)).success,
      JSON.stringify(overrides),
    );
  const parsed = templateInputSchema.parse(recipe());
  assert.equal(parsed.variables[0].type, undefined);
  assert.equal(
    renderTemplate(parsed, { goal: "1.2 米 {{width}} $&" }),
    "组合一个 1.2 米 {{width}} $&。把引用素材导入为独立副本。",
  );
});

test("template API persists custom recipes and references, protects builtins and rejects stale edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-templates-"));
  const { app, store } = await buildApp({
    dataRoot: root,
    password: "test-password-1234",
    internalToken: "test-token-1234567890",
    runnerUrl: "http://127.0.0.1:1",
    poll: false,
  });
  try {
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/templates" })).statusCode,
      401,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "test-password-1234" },
    });
    const headers = { cookie: `pilot_session=${login.cookies[0].value}` };
    const call = (method: any, url: string, payload?: any) =>
      app.inject({ method, url: "/api" + url, headers, payload });
    const assetId = randomUUID();
    await new LibraryCatalog(store.db).create({
      id: assetId,
      name: "Fixture chair",
      description: "Metadata fixture, not a Blender mesh",
      category: "prop",
      tags: [],
      favorite: false,
      sourceUrl: "",
      license: "test-only",
      author: "test",
      path: path.join(root, "fixture.blend"),
      mime: "application/x-blender",
      size: 0,
      sha256: "a".repeat(64),
      createdAt: new Date().toISOString(),
      source: "upload",
      objectNames: [],
    });
    const builtins = await call("GET", "/templates?source=builtin");
    assert.equal(builtins.statusCode, 200);
    assert.equal(builtins.json().total, 9);
    const builtin = builtins.json().items[0];
    assert.equal(
      (
        await call("PATCH", `/templates/${builtin.id}`, {
          ...recipe(),
          expectedVersion: 1,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await call("DELETE", `/templates/${builtin.id}`, { expectedVersion: 1 }))
        .statusCode,
      403,
    );
    const input = recipe({ libraryAssetIds: [assetId] });
    const numeric = recipe({
      name: "数值尺寸模板",
      prompt: "制作 {{width}} 米宽的书桌",
      variables: [
        {
          key: "width",
          label: "宽度",
          defaultValue: "1.4",
          type: "number",
          unit: "米",
          min: 0.6,
          max: 3,
          step: 0.05,
        },
      ],
    });
    const numericCreated = await call("POST", "/templates", numeric);
    assert.equal(numericCreated.statusCode, 201, numericCreated.body);
    const numericSaved = await new TemplateCatalog(store.db).get(
      numericCreated.json().id,
    );
    assert.deepEqual(numericSaved?.variables, numeric.variables);
    assert.match(renderTemplate(numericSaved!, { width: "1.65" }), /1.65 米/);
    assert.equal(
      (
        await call("POST", "/templates", {
          ...numeric,
          variables: [{ ...numeric.variables[0], defaultValue: "-1" }],
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await call("PATCH", `/templates/${numericCreated.json().id}`, {
          ...numeric,
          variables: [{ ...numeric.variables[0], defaultValue: "1.42" }],
          expectedVersion: 1,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await new TemplateCatalog(store.db).get(numericCreated.json().id))
        ?.version,
      1,
    );
    assert.equal(
      (
        await call("DELETE", `/templates/${numericCreated.json().id}`, {
          expectedVersion: 1,
        })
      ).statusCode,
      200,
    );
    const created = await call("POST", "/templates", input);
    assert.equal(created.statusCode, 201, created.body);
    const template = created.json();
    assert.equal(template.source, "custom");
    assert.equal(template.version, 1);
    const detail = (await call("GET", `/templates/${template.id}`)).json();
    assert.deepEqual(
      detail.libraryAssets.map((asset: any) => asset.id),
      [assetId],
    );
    assert.deepEqual(detail.missingLibraryAssetIds, []);
    const reopened = new TemplateCatalog(store.db);
    assert.deepEqual((await reopened.get(template.id))?.libraryAssetIds, [
      assetId,
    ]);
    const updated = await call("PATCH", `/templates/${template.id}`, {
      ...input,
      name: "Updated office",
      expectedVersion: 1,
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().version, 2);
    assert.equal(updated.json().createdAt, template.createdAt);
    assert.equal(
      (
        await call("PATCH", `/templates/${template.id}`, {
          ...input,
          expectedVersion: 1,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await call("DELETE", `/templates/${template.id}`, {
          expectedVersion: 1,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await call(
          "GET",
          "/templates?source=custom&search=Updated&category=composition",
        )
      ).json().total,
      1,
    );
    assert.equal(
      (await call("GET", "/templates?source=custom&category=material")).json()
        .total,
      0,
    );
    const missing = randomUUID();
    const failedCreate = await call(
      "POST",
      "/templates",
      recipe({ libraryAssetIds: [missing] }),
    );
    assert.equal(failedCreate.statusCode, 400, failedCreate.body);
    const failedUpdate = await call("PATCH", `/templates/${template.id}`, {
      ...input,
      libraryAssetIds: [missing],
      expectedVersion: 2,
    });
    assert.equal(failedUpdate.statusCode, 400, failedUpdate.body);
    const preserved = await reopened.get(template.id);
    assert.equal(preserved?.version, 2);
    assert.deepEqual(preserved?.libraryAssetIds, [assetId]);
    assert.equal(
      (await call("GET", "/templates?source=custom")).json().total,
      1,
    );
    assert.equal(
      (await call("POST", "/templates", { ...input, source: "builtin" }))
        .statusCode,
      400,
    );
    assert.equal(
      (await call("GET", "/templates?category=unknown")).statusCode,
      400,
    );
    assert.equal(
      (
        await call("DELETE", `/templates/${template.id}`, {
          expectedVersion: 2,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await call("GET", `/templates/${template.id}`)).statusCode,
      404,
    );
    assert.equal(
      (
        await store.db.query(
          `SELECT * FROM ${store.db.table("creation_template_assets")} WHERE template_id=$1`,
          [template.id],
        )
      ).rowCount,
      0,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

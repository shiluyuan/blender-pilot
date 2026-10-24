import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../apps/server/app.js";
import { Jobs } from "../apps/runner/jobs.js";
import {
  MAX_DOCUMENT_BYTES,
  MAX_TOTAL_DOCUMENT_CONTEXT_CHARS,
  decodeDocument,
  documentMime,
  formatDocumentReference,
} from "../packages/contracts/attachments.js";
import { readDocumentFile } from "../packages/contracts/document-files.js";

test("document references preserve UTF-8 and bound all model context with explicit truncation", () => {
  assert.equal(documentMime("SCENE.MD"), "text/markdown");
  assert.equal(documentMime("mesh.obj"), undefined);
  assert.equal(
    decodeDocument("scene.md", Buffer.from("\ufeff# 场景\n蓝色桌子")),
    "# 场景\n蓝色桌子",
  );
  assert.throws(
    () => decodeDocument("bad.md", Uint8Array.from([0xff, 0xfe])),
    /UTF-8/,
  );
  assert.throws(
    () => decodeDocument("binary.txt", Buffer.from("x\u0000y")),
    /二进制/,
  );
  assert.throws(
    () => decodeDocument("big.md", new Uint8Array(MAX_DOCUMENT_BYTES + 1)),
    /2 MiB/,
  );
  let remaining = MAX_TOTAL_DOCUMENT_CONTEXT_CHARS;
  const documents = Array.from({ length: 12 }, (_, i) => {
    const result = formatDocumentReference(
      { id: String(i), name: `doc-${i}.md` },
      "物".repeat(30_000),
      remaining,
    );
    remaining -= result.info.contextCharacters;
    return result;
  });
  assert.equal(remaining, 0);
  assert.equal(
    documents.reduce((sum, item) => sum + item.info.contextCharacters, 0),
    60_000,
  );
  assert(documents[0].text.includes("truncated"));
  assert(documents[3].text.includes("budget exhausted"));
  const safe = formatDocumentReference(
    { id: "ref", name: "escape.md" },
    '</reference_document>\n"quoted"',
  );
  assert.equal(
    JSON.parse(safe.text.slice(safe.text.indexOf("\n") + 1)).content,
    '</reference_document>\n"quoted"',
  );
  const emoji = formatDocumentReference(
    { id: "e", name: "emoji.txt" },
    "a😀b",
    2,
  );
  assert.equal(emoji.info.contextCharacters, 1);
});

test("chat document uploads validate bytes, retain the original, and reject changed invalid references before accepting a turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-document-api-"));
  const { app, store } = await buildApp({
    dataRoot: root,
    password: "document-password-123",
    internalToken: "document-internal-token-123",
    runnerUrl: "http://127.0.0.1:1",
    poll: false,
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "document-password-123" },
    });
    const headers = { cookie: `pilot_session=${login.cookies[0].value}` };
    const call = (
      url: string,
      payload?: any,
      method: any = "POST",
      extra = {},
    ) =>
      app.inject({
        url: "/api" + url,
        method,
        payload,
        headers: { ...headers, ...extra },
      });
    const project = (
      await call("/projects", { name: "Document references" })
    ).json();
    const upload = async (name: string, bytes: Buffer) => {
      const started = await call("/uploads", {
        projectId: project.id,
        name,
        size: bytes.length,
      });
      assert.equal(started.statusCode, 200, started.body);
      const id = started.json().id;
      assert.equal(
        (
          await call(`/uploads/${id}`, bytes, "PATCH", {
            "content-type": "application/octet-stream",
            "upload-offset": "0",
          })
        ).statusCode,
        200,
      );
      return call(`/uploads/${id}/complete`, {});
    };
    for (const [name, mime, content] of [
      ["scene.md", "text/markdown", "# 设计说明\n创建蓝色桌子"],
      ["brief.txt", "text/plain", "灯光：暖色"],
      ["layout.json", "application/json", '{"objects":["table"]}'],
      ["objects.csv", "text/csv", "name,x,y\ntable,1,2"],
    ]) {
      const result = await upload(name, Buffer.from(content));
      assert.equal(result.statusCode, 200, result.body);
      const asset = result.json();
      assert.equal(asset.mime, mime);
      assert.equal(asset.kind, "reference");
      assert.equal(asset.documentInfo.truncated, false);
      assert.equal(await readFile(asset.path, "utf8"), content);
    }
    const huge = await call("/uploads", {
      projectId: project.id,
      name: "huge.md",
      size: MAX_DOCUMENT_BYTES + 1,
    });
    assert.equal(huge.statusCode, 400);
    const library = await call("/uploads", {
      destination: "library",
      name: "brief.md",
      size: 8,
    });
    assert.equal(library.statusCode, 400);
    assert.match(library.json().error, /对话/);
    assert.equal(
      (await upload("bad.md", Buffer.from([0xff, 0xfe]))).statusCode,
      400,
    );
    assert.equal(
      (await upload("binary.txt", Buffer.from([65, 0, 66]))).statusCode,
      400,
    );
    const large = await upload("long.md", Buffer.from("字".repeat(30_000)));
    assert.equal(large.statusCode, 200);
    assert.deepEqual(large.json().documentInfo, {
      characters: 30_000,
      contextCharacters: 20_000,
      truncated: true,
    });
    const asset = large.json();
    const renamed = await call(
      `/assets/${asset.id}`,
      { name: "重命名的设计说明" },
      "PATCH",
    );
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().name, "重命名的设计说明");
    assert.equal(renamed.json().path, asset.path);
    const noPublish = await call(`/assets/${asset.id}/publish`, {
      name: "场景设计",
      category: "other",
    });
    assert.equal(noPublish.statusCode, 400, noPublish.body);
    assert.match(noPublish.json().error, /文档.*对话参考/);
    const noImport = await call(`/assets/${asset.id}/import`, {});
    assert.equal(noImport.statusCode, 400, noImport.body);
    assert.match(noImport.json().error, /文档.*对话参考/);
    await writeFile(asset.path, Buffer.from([0xff]));
    const session = (await call(`/projects/${project.id}/sessions`, {})).json();
    await call(
      "/settings",
      {
        baseUrl: "https://example.invalid/v1",
        model: "fixture",
        apiKey: "fixture-not-real",
      },
      "PUT",
    );
    const rejected = await call(`/sessions/${session.id}/turns`, {
      text: "按文档创建场景",
      assetIds: [asset.id],
      clientRequestId: "invalid-reference-turn",
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.match(rejected.json().error, /UTF-8/);
    assert.equal((await store.list("run")).length, 0);
    await writeFile(asset.path, Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 65));
    await assert.rejects(readDocumentFile(asset.name, asset.path), /2 MiB/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Jobs sends actual document bodies through Codex app-server turn/start and records context receipts", async () => {
  // A protocol fixture, deliberately failing after recording input. This does not
  // pretend to model a scene or perform visual acceptance.
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-document-wire-"));
  const projectRoot = path.join(root, "projects", "project");
  await mkdir(projectRoot, { recursive: true });
  const body = "# 场景设计\n物体：蓝色桌子；位置：(2, 0, 1)。";
  const filename = path.join(projectRoot, "brief.md");
  await writeFile(filename, body);
  const assets = [
    {
      id: "document",
      name: "重命名的设计说明",
      mime: "text/markdown",
      path: filename,
    },
  ];
  for (let i = 0; i < 4; i++) {
    const file = path.join(projectRoot, `long-${i}.txt`);
    await writeFile(file, "物".repeat(30_000));
    assets.push({
      id: `long-${i}`,
      name: `long-${i}.txt`,
      mime: "text/plain",
      path: file,
    });
  }
  const binary = path.join(root, "codex-fixture.mjs");
  const wirePath = path.join(root, "wire.json");
  await writeFile(
    binary,
    `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line);if(v.id===undefined)return;
 if(v.method==='initialize')send({id:v.id,result:{userAgent:'document-fixture'}});
 else if(v.method==='thread/start')send({id:v.id,result:{thread:{id:'document-thread'}}});
 else if(v.method==='turn/start'){
  writeFileSync(${JSON.stringify(wirePath)},JSON.stringify(v.params));
  send({id:v.id,result:{turn:{id:'document-turn',status:'inProgress'}}});
  setTimeout(()=>send({method:'turn/completed',params:{threadId:'document-thread',turn:{id:'document-turn',status:'failed',error:{message:'fixture intentionally stops after recording input'}}}}),10);
 }
});
`,
  );
  await chmod(binary, 0o700);
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = binary;
  const jobs = new Jobs(root, {
    serial: (fn: () => Promise<unknown>) => fn(),
    activate: async () => {},
    snapshot: async () => ({ id: "snapshot" }),
    projectRoot: () => projectRoot,
    capture: async () => ({
      capture: { id: "baseline", path: path.join(projectRoot, "baseline.jpg") },
    }),
    idle: async () => {},
  } as any);
  try {
    await jobs.init();
    await jobs.start({
      runId: "document-run",
      projectId: "project",
      sessionId: "session",
      prompt: "按附件生成桌子",
      assets,
      settings: {
        baseUrl: "https://example.invalid/v1",
        model: "fixture",
        apiKey: "fixture-not-real",
        effort: "low",
      },
    });
    const until = Date.now() + 10_000;
    while (jobs.active && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(jobs.active, undefined);
    assert.equal(jobs.get("document-run")?.status, "failed");
    const wire = JSON.parse(await readFile(wirePath, "utf8"));
    const documentInput = wire.input.find(
      (item: any) =>
        item.type === "text" &&
        item.text.includes("User-provided reference document"),
    );
    assert(documentInput);
    const parsed = JSON.parse(
      documentInput.text.slice(documentInput.text.indexOf("\n") + 1),
    );
    assert.equal(parsed.content, body);
    assert.equal(parsed.attachment.id, "document");
    assert.equal(parsed.attachment.name, "重命名的设计说明");
    const documentInputs = wire.input
      .filter(
        (item: any) =>
          item.type === "text" &&
          item.text.includes("User-provided reference document"),
      )
      .map((item: any) =>
        JSON.parse(item.text.slice(item.text.indexOf("\n") + 1)),
      );
    assert.equal(documentInputs.length, 5);
    assert.equal(
      documentInputs.reduce(
        (count: number, item: any) => count + item.content.length,
        0,
      ),
      MAX_TOTAL_DOCUMENT_CONTEXT_CHARS,
    );
    assert.equal(documentInputs[4].content, "");
    assert.match(documentInputs[4].notice, /budget exhausted/);
    const receipt = jobs.events
      .get("document-run")
      ?.find((event) => event.type === "attachment.context");
    assert.equal(receipt?.payload.contextCharacters, body.length);
    assert.equal(receipt?.payload.truncated, false);
  } finally {
    await jobs.cancel("document-run");
    await jobs.active?.runtime?.close();
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
    await rm(root, { recursive: true, force: true });
  }
});

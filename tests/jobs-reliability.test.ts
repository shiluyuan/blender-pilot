import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Jobs } from "../apps/runner/jobs.js";
import { StudioPool, type Studio } from "../apps/runner/pool.js";
import { SceneBridge } from "../packages/blender-bridge/scene.js";
import type { CodexRuntime } from "../packages/runtime-adapters/codex.js";
import type { StartJob } from "../packages/contracts/index.js";

const input = (): StartJob => ({
  runId: "run",
  projectId: "project",
  sessionId: "session",
  prompt: "inspect scene",
  assets: [],
  settings: {
    baseUrl: "https://example.invalid",
    model: "fixture",
    apiKey: "fixture-secret",
    effort: "low",
  },
});

async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Job did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("failed job admission releases the active token and credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-job-admit-"));
  const jobs = new Jobs(root, new SceneBridge(root));
  try {
    await jobs.init();
    await rm(path.join(root, "jobs"), { recursive: true });
    await writeFile(path.join(root, "jobs"), "not a directory");
    await assert.rejects(jobs.start(input()), /ENOTDIR/);
    assert.equal(jobs.active, undefined);
    assert.ok(jobs.storageFailure);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed final journal write revokes the token without leaving a permanently busy studio", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-job-finish-"));
  const scene = new SceneBridge(root);
  const jobs = new Jobs(root, scene);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  scene.activate = async () => {
    entered = true;
    await gate;
    throw new Error("fixture desktop disconnected");
  };
  try {
    await jobs.init();
    await jobs.start(input());
    await until(() => entered);
    await rename(path.join(root, "jobs"), path.join(root, "saved-journal"));
    await writeFile(path.join(root, "jobs"), "not a directory");
    release();
    await until(() => jobs.active === undefined);
    assert.ok(jobs.storageFailure);
    assert.equal(jobs.states.get("run")?.status, "failed");
    await assert.rejects(jobs.tool("get_scene_info", {}), /任务已停止/);
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation while waiting for the scene lock skips activation and snapshot writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-job-cancel-"));
  const scene = new SceneBridge(root);
  const jobs = new Jobs(root, scene);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let touches = 0;
  scene.serial = async (fn) => {
    await gate;
    return fn();
  };
  scene.activate = async () => {
    touches++;
  };
  try {
    await jobs.init();
    await jobs.start(input());
    await jobs.cancel("run");
    release();
    await until(() => jobs.active === undefined);
    assert.equal(touches, 0);
    assert.equal(jobs.get("run")?.status, "cancelled");
    assert.equal(jobs.events.get("run")?.at(-1)?.payload.status, "cancelled");
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("three identical tool failures stop another identical attempt but allow a corrected call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-tool-loop-"));
  const scene = new SceneBridge(root);
  scene.activeProject = "project";
  const jobs = new Jobs(root, scene);
  let actualCalls = 0;
  scene.queryApi = async (target) => {
    actualCalls++;
    if (target === "bpy.types.Missing") throw new Error("unknown RNA target");
    return "actual API information";
  };
  try {
    await jobs.init();
    const time = new Date().toISOString();
    jobs.active = {
      state: {
        id: "run",
        projectId: "project",
        sessionId: "session",
        status: "running",
        verification: "pending",
        seq: 0,
        createdAt: time,
        updatedAt: time,
      },
      input: input(),
      token: "fixture-token",
      abort: new AbortController(),
      captures: [],
      mutations: 0,
      calls: 0,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await jobs.tool("query_blender_api", {
        target: "bpy.types.Missing",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /unknown RNA/);
    }
    const stopped = await jobs.tool("query_blender_api", {
      target: "bpy.types.Missing",
    });
    assert.equal(stopped.isError, true);
    assert.match(stopped.content[0].text, /TOOL_RETRY_LIMIT/);
    assert.equal(actualCalls, 3);
    const corrected = await jobs.tool("query_blender_api", {
      target: "bpy.types.Object",
    });
    assert.notEqual(corrected.isError, true);
    assert.equal(actualCalls, 4);
    assert.equal(jobs.active.lastFailure, undefined);
    jobs.active.state.status = "succeeded";
    await assert.rejects(jobs.tool("query_blender_api", {}), /任务已停止/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool budget interrupts the native turn, stops scene access and ends as interrupted rather than cancelled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-job-budget-"));
  const scene = new SceneBridge(root);
  const jobs = new Jobs(root, scene);
  let actualCalls = 0;
  let attempts = 0;
  scene.activate = async (projectId) => {
    scene.activeProject = projectId;
    await mkdir(scene.projectRoot(projectId), { recursive: true });
  };
  scene.snapshot = async (name, runId) => ({
    id: "snapshot",
    projectId: "project",
    name,
    runId,
    path: path.join(root, "fixture.blend"),
    createdAt: new Date().toISOString(),
  });
  scene.capture = async (projectId, phase, runId) => ({
    capture: {
      id: "baseline",
      projectId,
      runId,
      phase,
      path: path.join(root, "fixture.jpg"),
      mime: "image/jpeg",
      sceneRevision: "fixture",
      generation: 1,
      mode: "viewport",
      createdAt: new Date().toISOString(),
    },
    image: { type: "image", mimeType: "image/jpeg", data: "fixture" },
  });
  scene.queryApi = async () => {
    actualCalls++;
    return "fixture API readback";
  };
  const server = createServer(async (_req, res) => {
    attempts++;
    res.setHeader("content-type", "application/json");
    try {
      res.end(
        JSON.stringify(
          await jobs.tool("query_blender_api", { target: "bpy.types.Mesh" }),
        ),
      );
    } catch (error) {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const binary = path.join(root, "codex-fixture.mjs");
  await writeFile(
    binary,
    `#!/usr/bin/env node
import {createInterface} from 'node:readline';
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
createInterface({input:process.stdin}).on('line',async line=>{
 const v=JSON.parse(line);if(v.id===undefined)return;
 if(v.method==='initialize')send({id:v.id,result:{}});
 else if(v.method==='thread/start')send({id:v.id,result:{thread:{id:'native-budget'}}});
 else if(v.method==='turn/start'){
  send({id:v.id,result:{turn:{id:'turn-budget',status:'inProgress'}}});
  for(let i=0;i<45;i++)await (await fetch('http://127.0.0.1:${address.port}/call')).text();
  send({method:'turn/completed',params:{threadId:'native-budget',turn:{id:'turn-budget',status:'completed'}}});
 }else if(v.method==='turn/interrupt')send({id:v.id,result:{}});
});

`,
  );
  await chmod(binary, 0o700);
  const prior = process.env.CODEX_BIN;
  process.env.CODEX_BIN = binary;
  try {
    await jobs.init();
    await jobs.start(input());
    await until(() => jobs.active === undefined);
    assert.equal(actualCalls, 40);
    assert.equal(attempts, 45);
    assert.equal(jobs.get("run")?.status, "interrupted");
    assert.equal(jobs.get("run")?.verification, "unavailable");
    assert.match(jobs.get("run")?.error || "", /TOOL_BUDGET_EXCEEDED/);
    const events = jobs.events.get("run")!;
    assert.equal(
      events.filter((event) => event.payload.code === "TOOL_BUDGET_EXCEEDED")
        .length,
      1,
    );
    assert.equal(events.at(-1)?.payload.status, "interrupted");
    assert(!JSON.stringify(events).includes("fixture-secret"));
  } finally {
    await jobs.active?.runtime?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop shutdown closes model, MCP and processes despite cancellation journal failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-shutdown-fault-"));
  const pool = new StudioPool(root);
  const cleanup: string[] = [];
  const scene = new SceneBridge(root);
  const jobs = new Jobs(root, scene);
  const time = new Date().toISOString();
  jobs.active = {
    state: {
      id: "run",
      projectId: "project",
      sessionId: "session",
      status: "running",
      verification: "pending",
      seq: 0,
      createdAt: time,
      updatedAt: time,
    },
    input: input(),
    token: "fixture-token",
    abort: new AbortController(),
    captures: [],
    mutations: 0,
    calls: 0,
    runtime: {
      close: async () => {
        cleanup.push("model");
      },
    } as unknown as CodexRuntime,
  };
  jobs.cancel = async () => {
    jobs.active?.abort.abort();
    jobs.active = undefined;
    throw new Error("ENOSPC fixture journal failure");
  };
  scene.idle = async () => {
    cleanup.push("scene-idle");
  };
  scene.save = async () => {
    cleanup.push("scene-save");
    return "fixture.blend";
  };
  scene.upstream.close = async () => {
    cleanup.push("mcp");
  };
  pool.stopProcesses = async () => {
    cleanup.push("native-processes");
  };
  const studio: Studio = {
    projectId: "project",
    slot: 0,
    scene,
    jobs,
    children: [],
    status: "ready",
    vncPort: 1,
  };
  pool.studios.set("project", studio);
  try {
    await pool.shutdown();
    assert.deepEqual(cleanup, [
      "model",
      "scene-idle",
      "scene-save",
      "mcp",
      "native-processes",
    ]);
    assert.equal(studio.status, "closing");
    assert.equal(pool.stopping, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

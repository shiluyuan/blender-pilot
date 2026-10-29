import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StudioPool } from "../apps/runner/pool.js";
import { SceneBridge } from "../packages/blender-bridge/scene.js";
import { Upstream } from "../packages/blender-bridge/upstream.js";

async function wait(check: () => boolean, message: string) {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > until) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = (server.address() as any).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-pool-startup-"));
  const prior = { ...process.env };
  const displayPort = await port();
  Object.assign(process.env, {
    PILOT_EXTERNAL_DESKTOP: "false",
    PILOT_X11_TCP: "true",
    PILOT_DISPLAY_BASE: String(displayPort - 6000),
    PILOT_BLENDER_PORT_BASE: String(await port()),
    PILOT_VNC_PORT_BASE: String(await port()),
    PILOT_POOL_FIXTURE_ROOT: root,
  });
  const source = `#!${process.execPath}
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const kind = path.basename(process.argv[1]);
let port;
if (kind === 'xvfb') port = 6000 + Number(process.argv[2].slice(1));
if (kind === 'blender') port = Number(process.env.BLENDER_PORT);
if (kind === 'vnc') port = Number(process.argv[process.argv.indexOf('-rfbport') + 1]);
if (port) {
  const server = net.createServer(socket => socket.end());
  server.listen(port, '127.0.0.1', () => {
    fs.writeFileSync(path.join(process.env.PILOT_POOL_FIXTURE_ROOT, kind + '.json'), JSON.stringify({pid:process.pid,instanceId:process.env.PILOT_STUDIO_ID}));
  });
} else setInterval(() => {}, 1000);
`;
  for (const [variable, name] of [
    ["XVFB_BIN", "xvfb"],
    ["OPENBOX_BIN", "openbox"],
    ["BLENDER_BIN", "blender"],
    ["X11VNC_BIN", "vnc"],
  ]) {
    const file = path.join(root, name);
    await writeFile(file, source, { mode: 0o755 });
    process.env[variable] = file;
  }
  const originals = {
    init: SceneBridge.prototype.init,
    activate: SceneBridge.prototype.activate,
    info: SceneBridge.prototype.info,
    json: Upstream.prototype.json,
    close: Upstream.prototype.close,
  };
  let mutations = 0;
  SceneBridge.prototype.init = async () => {};
  SceneBridge.prototype.activate = async () => {
    mutations++;
  };
  SceneBridge.prototype.info = async () =>
    ({ version: "fixture-version" }) as any;
  Upstream.prototype.json = async () =>
    JSON.parse(await readFile(path.join(root, "blender.json"), "utf8"));
  Upstream.prototype.close = async () => {};
  const pool = new StudioPool(root);
  return {
    root,
    pool,
    displayPort,
    get mutations() {
      return mutations;
    },
    close: async () => {
      for (const studio of pool.studios.values()) {
        studio.status = "closing";
        await pool.stopProcesses(studio);
      }
      Object.assign(SceneBridge.prototype, {
        init: originals.init,
        activate: originals.activate,
        info: originals.info,
      });
      Upstream.prototype.json = originals.json;
      Upstream.prototype.close = originals.close;
      for (const key of Object.keys(process.env))
        if (!(key in prior)) delete process.env[key];
      Object.assign(process.env, prior);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("managed startup rejects occupied orphan endpoints before launching children or mutating a scene", async () => {
  const f = await fixture();
  const stale = createServer((socket) => socket.end());
  await new Promise<void>((resolve) =>
    stale.listen(f.displayPort, "127.0.0.1", resolve),
  );
  try {
    await assert.rejects(f.pool.open("project"), /端口已被占用/);
    const studio = f.pool.studios.get("project")!;
    assert.equal(studio.status, "failed");
    assert.equal(studio.children.length, 0);
    assert.equal(f.mutations, 0);
    assert.equal(stale.listening, true, "unknown listener must not be killed");
  } finally {
    await new Promise<void>((resolve) => stale.close(() => resolve()));
    await f.close();
  }
});

test("managed startup refuses the wrong MCP process identity before loading or saving any project", async () => {
  const f = await fixture();
  Upstream.prototype.json = async () => ({
    instanceId: "stale-instance",
    pid: 1,
  });
  try {
    await assert.rejects(f.pool.open("project"), /拒绝复用遗留实例/);
    const studio = f.pool.studios.get("project")!;
    assert.equal(studio.status, "failed");
    assert.equal(f.mutations, 0);
    assert(studio.children.length >= 3);
    assert(
      studio.children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    );
  } finally {
    await f.close();
  }
});

test("process exits during each asynchronous scene startup phase cannot be overwritten by ready", async () => {
  for (const phase of ["init", "activate", "info"] as const) {
    const f = await fixture();
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (SceneBridge.prototype[phase] as any) = async () => {
      entered = true;
      await gate;
      return { version: "fixture-version" };
    };
    const starting = f.pool.open("project");
    // Attach the rejection handler before inducing the native process fault.
    const rejected = assert.rejects(starting, /xvfb|进程/);
    try {
      await wait(() => entered, "startup did not reach " + phase);
      const studio = f.pool.studios.get("project")!;
      studio.children[0].kill("SIGKILL");
      await wait(
        () => studio.status === "failed",
        "native exit was not recorded",
      );
      release();
      await rejected;
      assert.equal(studio.status, "failed", phase);
      assert.match(studio.error!, /xvfb/);
      assert(
        studio.children.every(
          (child) => child.exitCode !== null || child.signalCode !== null,
        ),
      );
      assert.equal(f.pool.pending.size, 0);
    } finally {
      release();
      await starting.catch(() => {});
      await f.close();
    }
  }
});

test("shutdown intent during scene startup cannot transition the instance to ready", async () => {
  const f = await fixture();
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  SceneBridge.prototype.info = async () => {
    entered = true;
    await gate;
    return { version: "fixture-version" } as any;
  };
  const starting = f.pool.open("project");
  const rejected = assert.rejects(starting, /正在关闭/);
  try {
    await wait(() => entered, "startup did not reach scene info");
    f.pool.stopping = true;
    release();
    await rejected;
    const studio = f.pool.studios.get("project")!;
    assert.notEqual(studio.status, "ready");
    assert(
      studio.children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    );
  } finally {
    release();
    await starting.catch(() => {});
    await f.close();
  }
});

test("native window mode launches only owned Blender, shares pending open and releases its process", async () => {
  const f = await fixture();
  f.pool.nativeWindow = true;
  try {
    const [a, b] = await Promise.all([
      f.pool.open("native-project"),
      f.pool.open("native-project"),
    ]);
    assert.equal(a, b);
    assert.equal(a.status, "ready");
    assert.equal(a.children.length, 1);
    assert.equal(f.mutations, 1);
    assert.equal(
      a.children[0].spawnargs.includes("--window-fullscreen"),
      false,
    );
    await assert.rejects(readFile(path.join(f.root, "xvfb.json")));
    await assert.rejects(readFile(path.join(f.root, "vnc.json")));
    a.status = "closing";
    await f.pool.stopProcesses(a);
    assert.ok(
      a.children.every((c) => c.exitCode !== null || c.signalCode !== null),
    );
  } finally {
    await f.close();
  }
});

import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { SceneBridge } from "../../packages/blender-bridge/scene.js";
import { idSchema } from "../../packages/contracts/index.js";
import { Jobs } from "./jobs.js";
export interface Studio {
  projectId: string;
  slot: number;
  scene: SceneBridge;
  jobs: Jobs;
  children: ChildProcess[];
  status: "starting" | "ready" | "failed" | "closing";
  error?: string;
  vncPort: number;
  blenderVersion?: string;
}
const problem = (message: string, statusCode = 409) =>
  Object.assign(new Error(message), { statusCode });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function reachable(port: number, unix?: string) {
  return new Promise<boolean>((resolve) => {
    const socket = unix ? connect(unix) : connect(port, "127.0.0.1");
    socket.setTimeout(800);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}
export class StudioPool {
  studios = new Map<string, Studio>();
  stopping = false;
  pending = new Map<string, Promise<Studio>>();
  private closing = new Map<string, Promise<void>>();
  history: Jobs;
  external = process.env.PILOT_EXTERNAL_DESKTOP === "true";
  nativeWindow = process.env.PILOT_DESKTOP_MODE === "native-window";
  max = Math.max(
    1,
    Math.min(16, Math.floor(Number(process.env.PILOT_MAX_STUDIOS)) || 3),
  );
  constructor(public root: string) {
    this.history = new Jobs(root, new SceneBridge(root));
  }
  async init() {
    await this.history.init();
  }
  status() {
    return [...this.studios.values()].map((s) => ({
      projectId: s.projectId,
      blenderVersion: s.blenderVersion,
      status: s.status,
      error: s.error,
      runId: s.jobs.active?.state.id,
      sessionId: s.jobs.active?.state.sessionId,
    }));
  }
  byRun(id: string) {
    const p = this.history.states.get(id)?.projectId;
    return (p && this.studios.get(p)?.jobs) || this.history;
  }
  byToken(token: string) {
    return [...this.studios.values()].find(
      (s) => s.jobs.active?.token === token,
    )?.jobs;
  }
  async open(projectId: string): Promise<Studio> {
    idSchema.parse(projectId);
    if (this.stopping) throw problem("执行服务正在关闭", 503);
    if (this.pending.has(projectId)) return this.pending.get(projectId)!;
    const existing = this.studios.get(projectId);
    if (existing) {
      if (existing.status !== "ready")
        throw problem(existing.error || "项目实例尚未就绪");
      return existing;
    }
    if (this.studios.size >= (this.external ? 1 : this.max))
      throw problem("打开的 Blender 实例已达上限，请先保存并关闭一个项目");
    const slot = Array.from({ length: this.max }, (_, i) => i).find(
      (i) => ![...this.studios.values()].some((s) => s.slot === i),
    )!;
    const baseDisplay = Number(process.env.PILOT_DISPLAY_BASE || 150),
      displayNumber = baseDisplay + slot;
    const tcpX = process.env.PILOT_X11_TCP === "true";
    const display = this.external
      ? process.env.DISPLAY || ":99"
      : this.nativeWindow
        ? process.env.DISPLAY || ""
        : (tcpX ? "127.0.0.1:" : ":") + displayNumber;
    const blenderPort = this.external
      ? Number(process.env.BLENDER_PORT || 9876)
      : Number(process.env.PILOT_BLENDER_PORT_BASE || 9900) + slot;
    const vncPort = this.external
      ? Number(process.env.VNC_PORT || 5900)
      : Number(process.env.PILOT_VNC_PORT_BASE || 60000) + slot;
    const scene = new SceneBridge(this.root, {
      projectId,
      environment: { DISPLAY: display, BLENDER_PORT: String(blenderPort) },
    });
    const jobs = new Jobs(this.root, scene);
    jobs.states = this.history.states;
    jobs.events = this.history.events;
    const studio: Studio = {
      projectId,
      slot,
      scene,
      jobs,
      vncPort,
      children: [],
      status: "starting",
    };
    this.studios.set(projectId, studio);
    const start = (async () => {
      const instanceId = randomUUID();
      const environment = {
        ...process.env,
        DISPLAY: display,
        BLENDER_PORT: String(blenderPort),
        PILOT_STUDIO_ID: instanceId,
      };
      const assertStarting = () => {
        if (this.stopping || studio.status === "closing")
          throw problem("执行服务正在关闭", 503);
        if (
          this.studios.get(projectId) !== studio ||
          studio.status !== "starting" ||
          studio.error
        )
          throw problem(studio.error || "项目实例启动已取消", 503);
        if (
          studio.children.some(
            (child) =>
              child.pid === undefined ||
              child.exitCode !== null ||
              child.signalCode !== null ||
              child.killed,
          )
        )
          throw problem("项目实例的桌面进程已退出", 503);
      };
      const failed = (name: string, reason: string) => {
        if (studio.status === "closing" || studio.status === "failed") return;
        studio.status = "failed";
        studio.error = `${name}: ${reason}`;
        if (jobs.active) {
          jobs.active.abort.abort();
          void jobs.active.runtime?.close().catch(() => {});
        }
        void scene.upstream.close().catch(() => {});
        void this.stopProcesses(studio);
      };
      const logDir = path.join(scene.projectRoot(projectId), "runtime");
      const launch = async (name: string, bin: string, args: string[]) => {
        assertStarting();
        const stream = createWriteStream(path.join(logDir, name + ".log"), {
          flags: "a",
        });
        stream.on("error", (error) => failed(name, error.message));
        const child = spawn(bin, args, {
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        });
        studio.children.push(child);
        child.stdout!.pipe(stream, { end: false });
        child.stderr!.pipe(stream, { end: false });
        child.once("error", (e) => {
          failed(name, e.message);
        });
        child.once("close", () => stream.end());
        child.once("exit", (code) => {
          if (studio.status !== "failed") failed(name, "进程退出 " + code);
        });
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        assertStarting();
        return child;
      };
      const wait = async (port: number, unix?: string) => {
        const end = Date.now() + 120000;
        while (Date.now() < end) {
          assertStarting();
          const available = await reachable(port, unix);
          assertStarting();
          if (available) return;
          await delay(200);
        }
        throw new Error("Blender 桌面启动超时");
      };
      try {
        await mkdir(logDir, { recursive: true });
        assertStarting();
        if (!this.external) {
          // A Runner process crash may leave desktops behind. Never interpret
          // somebody else's display/MCP/VNC listener as our new child's readiness.
          const occupied = await Promise.all([
            ...(this.nativeWindow
              ? []
              : [
                  reachable(6000 + displayNumber),
                  reachable(
                    6000 + displayNumber,
                    `/tmp/.X11-unix/X${displayNumber}`,
                  ),
                ]),
            reachable(blenderPort),
            ...(this.nativeWindow ? [] : [reachable(vncPort)]),
          ]);
          assertStarting();
          if (occupied.some(Boolean))
            throw problem(
              "项目桌面端口已被占用；请检查遗留实例并重启执行容器后重试",
              503,
            );
          if (!this.nativeWindow) {
            await launch("xvfb", process.env.XVFB_BIN || "Xvfb", [
              `:${displayNumber}`,
              "-screen",
              "0",
              process.env.PILOT_RESOLUTION || "1440x900x24",
              "-ac",
              ...(tcpX
                ? ["-nolisten", "unix", "-listen", "tcp"]
                : ["-nolisten", "tcp"]),
            ]);
            await wait(
              6000 + displayNumber,
              tcpX ? undefined : `/tmp/.X11-unix/X${displayNumber}`,
            );
            await launch("openbox", process.env.OPENBOX_BIN || "openbox", [
              "--sm-disable",
            ]);
          }
          const blender = await launch(
            "blender",
            process.env.BLENDER_BIN || "blender",
            [
              "--factory-startup",
              "-noaudio",
              ...(this.nativeWindow ? [] : ["--window-fullscreen"]),
              "--python",
              process.env.PILOT_BOOTSTRAP_PATH || "/opt/pilot/bootstrap.py",
            ],
          );
          await wait(blenderPort);
          if (!this.nativeWindow) {
            await launch("vnc", process.env.X11VNC_BIN || "x11vnc", [
              "-display",
              display,
              "-forever",
              "-shared",
              "-nopw",
              "-listen",
              "127.0.0.1",
              "-rfbport",
              String(vncPort),
              "-noxdamage",
              "-noshm",
              "-quiet",
            ]);
            await wait(vncPort);
          }
          // This read-only handshake precedes scene loading or saving. A
          // listener which raced our port preflight cannot receive mutations.
          const identity = await scene.upstream.json(
            "import json,os\nprint('PILOT_JSON:'+json.dumps({'instanceId':os.environ.get('PILOT_STUDIO_ID'),'pid':os.getpid()}))",
          );
          assertStarting();
          if (
            identity.instanceId !== instanceId ||
            identity.pid !== blender.pid
          )
            throw problem(
              "Blender 连接不属于本次启动，已拒绝复用遗留实例",
              503,
            );
        }
        await scene.init();
        assertStarting();
        await scene.activate(projectId);
        assertStarting();
        studio.blenderVersion = (await scene.info()).version;
        // Drain already queued exit/error callbacks before committing ready.
        await new Promise<void>((resolve) => setImmediate(resolve));
        assertStarting();
        studio.status = "ready";
        return studio;
      } catch (e) {
        if (studio.status !== "closing") studio.status = "failed";
        studio.error ||= String(e);
        await scene.upstream.close().catch(() => {});
        await this.stopProcesses(studio);
        throw e;
      }
    })();
    this.pending.set(projectId, start);
    try {
      return await start;
    } finally {
      this.pending.delete(projectId);
    }
  }
  async stopProcesses(s: Studio) {
    for (const child of s.children)
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    await Promise.all(
      s.children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (
              child.exitCode !== null ||
              child.signalCode !== null ||
              child.pid === undefined
            ) {
              resolve();
              return;
            }
            const t = setTimeout(() => {
              child.kill("SIGKILL");
              resolve();
            }, 4000);
            t.unref();
            child.once("exit", () => {
              clearTimeout(t);
              resolve();
            });
          }),
      ),
    );
  }
  async close(projectId: string) {
    const pendingClose = this.closing.get(projectId);
    if (pendingClose) return pendingClose;
    if (this.pending.has(projectId)) throw problem("项目正在启动，请稍后关闭");
    const s = this.studios.get(projectId);
    if (!s) return;
    if (s.jobs.active) throw problem("该项目正在执行，请先停止任务");
    const wasReady = s.status === "ready";
    // Reserve the lifecycle before save yields: open()/job admission must not
    // reuse a desktop that is about to be terminated.
    s.status = "closing";
    const task = (async () => {
      try {
        if (wasReady) await s.scene.serial(() => s.scene.save());
      } catch (error) {
        const alive = s.children.every(
          (c) => c.exitCode === null && c.signalCode === null && !c.killed,
        );
        s.status = !this.stopping && alive ? "ready" : "failed";
        if (s.status === "failed") s.error = "关闭时场景保存失败，实例已不可用";
        throw error;
      }
      await s.scene.upstream.close().catch(() => {});
      await this.stopProcesses(s);
      if (this.studios.get(projectId) === s) this.studios.delete(projectId);
    })();
    this.closing.set(projectId, task);
    try {
      await task;
    } finally {
      if (this.closing.get(projectId) === task) this.closing.delete(projectId);
    }
  }
  async shutdown() {
    this.stopping = true;
    await Promise.allSettled([
      ...this.pending.values(),
      ...this.closing.values(),
    ]);
    for (const s of this.studios.values()) {
      try {
        const active = s.jobs.active;
        if (active) {
          // Cancellation aborts before journaling. A disk fault must not stop
          // teardown of this model, its MCP process, or the other desktops.
          await s.jobs.cancel(active.state.id).catch(() => {});
          await active.runtime?.close().catch(() => {});
          const until = Date.now() + 15000;
          while (s.jobs.active && Date.now() < until) await delay(100);
        }
        await s.scene.idle();
        if (s.status === "ready") await s.scene.save().catch(() => {});
      } finally {
        s.status = "closing";
        await s.scene.upstream.close().catch(() => {});
        await this.stopProcesses(s);
      }
    }
  }
}

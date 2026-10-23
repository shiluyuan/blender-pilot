import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
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
  history: Jobs;
  external = process.env.PILOT_EXTERNAL_DESKTOP === "true";
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
      const logDir = path.join(scene.projectRoot(projectId), "runtime");
      await mkdir(logDir, { recursive: true });
      const environment = {
        ...process.env,
        DISPLAY: display,
        BLENDER_PORT: String(blenderPort),
      };
      const launch = (name: string, bin: string, args: string[]) => {
        const stream = createWriteStream(path.join(logDir, name + ".log"), {
          flags: "a",
        });
        const child = spawn(bin, args, {
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        });
        studio.children.push(child);
        child.stdout!.pipe(stream, { end: false });
        child.stderr!.pipe(stream, { end: false });
        const failed = (reason: string) => {
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
        child.once("error", (e) => {
          failed(e.message);
        });
        child.once("close", () => stream.end());
        child.once("exit", (code) => {
          if (studio.status !== "failed") failed("进程退出 " + code);
        });
      };
      const wait = async (port: number, unix?: string) => {
        const end = Date.now() + 120000;
        while (Date.now() < end) {
          if (studio.status === "failed" || this.stopping)
            throw new Error(studio.error || "服务正在关闭");
          if (await reachable(port, unix)) return;
          await delay(200);
        }
        throw new Error("Blender 桌面启动超时");
      };
      try {
        if (!this.external) {
          launch("xvfb", process.env.XVFB_BIN || "Xvfb", [
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
          launch("openbox", process.env.OPENBOX_BIN || "openbox", [
            "--sm-disable",
          ]);
          launch("blender", process.env.BLENDER_BIN || "blender", [
            "--factory-startup",
            "-noaudio",
            "--window-fullscreen",
            "--python",
            process.env.PILOT_BOOTSTRAP_PATH || "/opt/pilot/bootstrap.py",
          ]);
          await wait(blenderPort);
          launch("vnc", process.env.X11VNC_BIN || "x11vnc", [
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
        await scene.init();
        await scene.activate(projectId);
        studio.status = "ready";
        return studio;
      } catch (e) {
        studio.status = "failed";
        studio.error = String(e);
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
    if (this.pending.has(projectId)) throw problem("项目正在启动，请稍后关闭");
    const s = this.studios.get(projectId);
    if (!s) return;
    if (s.jobs.active) throw problem("该项目正在执行，请先停止任务");
    if (s.status === "ready") await s.scene.serial(() => s.scene.save());
    s.status = "closing";
    await s.scene.upstream.close().catch(() => {});
    await this.stopProcesses(s);
    this.studios.delete(projectId);
  }
  async shutdown() {
    this.stopping = true;
    await Promise.allSettled([...this.pending.values()]);
    for (const s of this.studios.values()) {
      if (s.jobs.active) {
        await s.jobs.cancel(s.jobs.active.state.id);
        await s.jobs.active?.runtime?.close();
        const until = Date.now() + 15000;
        while (s.jobs.active && Date.now() < until) await delay(100);
      }
      await s.scene.idle();
      if (s.status === "ready") await s.scene.save().catch(() => {});
      s.status = "closing";
      await s.scene.upstream.close().catch(() => {});
      await this.stopProcesses(s);
    }
  }
}

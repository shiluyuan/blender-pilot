/** Test launcher: real PostgreSQL by DATABASE_URL or an isolated Docker service.
 * Restricted hosts may explicitly select wasm-wire for protocol/SQL coverage;
 * it is never an application backend or an automatic substitute for PostgreSQL.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import pg from "pg";
async function availablePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
const command = process.argv.slice(process.argv.indexOf("--") + 1);
if (!command.length) throw new Error("Pass a command after --");
let url = process.env.PILOT_TEST_DATABASE_URL || process.env.DATABASE_URL;
let stop: () => Promise<void> = async () => {};
if (!url) {
  const port = await availablePort();
  if (process.env.PILOT_TEST_POSTGRES_MODE === "wasm-wire") {
    const { PGlite } = await import("@electric-sql/pglite");
    const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
    const db = await PGlite.create();
    const upstreamPort = await availablePort();
    const server = new PGLiteSocketServer({
      db,
      port: upstreamPort,
      host: "127.0.0.1",
      maxConnections: 40,
    });
    await server.start();
    const { wasmWireProxy } = await import("./wasm-wire-proxy.js");
    const proxy = await wasmWireProxy(upstreamPort, port);
    url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    stop = async () => {
      await proxy.close();
      await server.stop();
      await db.close();
    };
    console.log(
      "TEST DATABASE: PostgreSQL WASM over TCP protocol (explicit restricted-host mode; not native PostgreSQL).",
    );
  } else {
    const name = "pilot-test-pg-" + randomUUID().slice(0, 8),
      password = randomUUID();
    const args = [
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      "-e",
      "POSTGRES_PASSWORD=" + password,
      "-p",
      `127.0.0.1:${port}:5432`,
      "postgres:18.6-bookworm",
    ];
    const code = await new Promise<number | null>((r) => {
      const c = spawn("docker", args, {
        stdio: ["ignore", "ignore", "inherit"],
      });
      c.once("error", () => r(-1));
      c.once("exit", r);
    });
    if (code !== 0)
      throw new Error(
        "Provide DATABASE_URL for a disposable PostgreSQL database, or install Docker. Restricted cloud checks must explicitly set PILOT_TEST_POSTGRES_MODE=wasm-wire.",
      );
    url = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
    stop = () =>
      new Promise((r) => {
        const c = spawn("docker", ["stop", name], { stdio: "ignore" });
        c.once("exit", () => r());
      });
  }
}
const env = {
  ...process.env,
  DATABASE_URL: url,
  PILOT_TEST_DATABASE_URL: url,
  PILOT_DB_SCHEMA: "pilot_test_" + randomUUID().replaceAll("-", ""),
};

try {
  const until = Date.now() + 45000;
  while (true) {
    const probe = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: 2000,
    });
    try {
      await probe.connect();
      await probe.end();
      break;
    } catch (e) {
      await probe.end().catch(() => {});
      if (Date.now() > until) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      env,
      stdio: "inherit",
    });
    const kill = () => child.kill("SIGTERM");
    process.once("SIGTERM", kill);
    process.once("SIGINT", kill);
    child.once("exit", (c) => {
      process.removeListener("SIGTERM", kill);
      process.removeListener("SIGINT", kill);
      resolve(c);
    });
    child.once("error", () => resolve(1));
  });
  process.exitCode = code ?? 1;
} finally {
  await stop();
}

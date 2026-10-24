import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";

type Mode =
  | "missing-opt-in"
  | "active-worker"
  | "queued-api"
  | "unready"
  | "disposable-idle";

async function preflight(mode: Mode) {
  const calls: Array<{ method: string; url: string }> = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method || "GET", url: req.url || "" });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/auth/login") {
      res.setHeader("set-cookie", "pilot_session=fixture; Path=/; HttpOnly");
      res.end('{"ok":true}');
    } else if (req.url === "/api/health") {
      res.end(
        JSON.stringify({
          database: { ok: true },
          execution: {
            ok: mode !== "unready",
            activeRuns:
              mode === "active-worker" ? [{ id: "worker-fixture" }] : [],
          },
        }),
      );
    } else if (req.url === "/api/projects") {
      res.end(
        JSON.stringify(
          mode === "queued-api" ? [{ id: "project-fixture" }] : [],
        ),
      );
    } else if (req.url === "/api/projects/project-fixture/sessions") {
      res.end(JSON.stringify([{ id: "session-fixture" }]));
    } else if (req.url === "/api/sessions/session-fixture/runs") {
      res.end(JSON.stringify([{ status: "queued" }]));
    } else if (req.url === "/api/settings" && req.method === "PUT") {
      res.statusCode = 409;
      res.end(
        JSON.stringify({
          error:
            "PREFLIGHT_REACHED_MODEL_SETTINGS (explicit test sentinel; nothing persisted)",
        }),
      );
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Unexpected preflight request" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(
      process.execPath,
      ["--import", "tsx", path.resolve("scripts/verify-deployment.ts")],
      {
        env: {
          ...process.env,
          PILOT_TEST_DISPOSABLE: mode === "missing-opt-in" ? "" : "1",
          PILOT_PASSWORD: "fixture-only-password",
          PILOT_TEST_URL: `http://127.0.0.1:${port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout!.on("data", (data) => {
      output += String(data);
    });
    child.stderr!.on("data", (data) => {
      output += String(data);
    });
    const timer = setTimeout(() => child?.kill("SIGTERM"), 10000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", resolve);
    }).finally(() => clearTimeout(timer));
    assert.equal(code, 1, output);
    return { calls, output };
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("deployment mutation suite requires disposable opt-in before connecting to a target", async () => {
  const { calls, output } = await preflight("missing-opt-in");
  assert.deepEqual(calls, []);
  assert.match(output, /PILOT_TEST_DISPOSABLE=1/);
});

test("deployment mutation suite rejects active worker tasks before settings writes", async () => {
  const { calls, output } = await preflight("active-worker");
  assert.match(output, /Active worker tasks exist/);
  assert(!calls.some((call) => call.url === "/api/settings"));
});

test("deployment mutation suite catches queued gateway tasks absent from worker health", async () => {
  const { calls, output } = await preflight("queued-api");
  assert.match(output, /Active or queued application tasks exist/);
  assert(calls.some((call) => call.url.endsWith("/runs")));
  assert(!calls.some((call) => call.url === "/api/settings"));
});

test("deployment mutation suite refuses an unready execution service", async () => {
  const { calls, output } = await preflight("unready");
  assert.match(output, /Deployment is not ready/);
  assert(!calls.some((call) => call.url === "/api/settings"));
});

test("explicit idle disposable target passes preflight and reaches the controlled settings sentinel", async () => {
  const { calls, output } = await preflight("disposable-idle");
  assert.match(output, /PREFLIGHT_REACHED_MODEL_SETTINGS/);
  assert.equal(
    calls.filter(
      (call) => call.url === "/api/settings" && call.method === "PUT",
    ).length,
    1,
  );
});

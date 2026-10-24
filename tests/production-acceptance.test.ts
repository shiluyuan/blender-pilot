/** Orchestrator tests use an explicit command fixture. They are not evidence of
 * a Docker or native PostgreSQL run; verify-production on a target provides it. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  verifyProduction,
  type CommandRunner,
} from "../scripts/verify-production.js";

function fixture(
  options: {
    external?: boolean;
    busy?: boolean;
    staleRestart?: boolean;
    wasm?: boolean;
    sameBackend?: boolean;
    cleanupFails?: boolean;
    unhealthy?: boolean;
  } = {},
) {
  const calls: string[][] = [];
  let restarted = false;
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    if (argv[0] === "python3")
      return JSON.stringify({
        compose: [
          "docker",
          "compose",
          "--env-file",
          "/test/.env",
          "-f",
          "/test/compose.yaml",
        ],
        config: {
          PILOT_BUNDLED_DB: options.external ? "false" : "true",
          PILOT_PASSWORD: "private-password",
          DATABASE_URL: "postgresql://private-password",
        },
      });
    if (argv.includes("--version")) return "Docker fixture";
    if (argv.includes("info"))
      return JSON.stringify({
        OSType: "linux",
        ServerVersion: "fixture-docker",
      });
    if (argv.includes("ps")) return argv.at(-1) + "-id";
    if (argv.includes("inspect")) {
      const service = argv.at(-1)!.replace(/-id$/, "");
      return JSON.stringify([
        {
          Config: {
            Image: service + ":fixture",
            Labels: { "com.docker.compose.service": service },
          },
          State: {
            Running: true,
            Health: { Status: options.unhealthy ? "unhealthy" : "healthy" },
            StartedAt: restarted && !options.staleRestart ? "after" : "before",
          },
        },
      ]);
    }
    if (argv.includes("restart")) {
      restarted = true;
      return "";
    }
    if (argv.includes("up")) return "";
    const code = argv.at(-1) || "";
    if (code.includes("pg_backend_pid"))
      return JSON.stringify({
        ok: true,
        version: options.wasm
          ? "PostgreSQL on wasm"
          : "PostgreSQL fixture-native",
        pids: options.sameBackend ? [10, 10] : [10, 11],
        transactionIsolation: true,
      });
    if (code.includes("verifyReadiness"))
      return JSON.stringify({ ok: true, modelConfigured: false });
    if (code.includes("/sessions"))
      return JSON.stringify({ ok: !options.busy });
    if (code.includes("DROP SCHEMA") && options.cleanupFails)
      throw Error("sql failed: secret-password");
    if (code.includes("pilot_accept_")) return JSON.stringify({ ok: true });
    throw Error("Unexpected test command");
  };
  return { calls, run };
}

test("production restart acceptance refuses before any target command without disposable opt-in", async () => {
  const f = fixture();
  const report = await verifyProduction({
    root: "/test",
    envFile: "/test/.env",
    restart: true,
    run: f.run,
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.passed, false);
  assert.deepEqual(f.calls, []);
  assert.match(report.checks[0].message, /PILOT_TEST_DISPOSABLE/);
});

test("production read-only mode checks real-command boundaries without restarting or creating markers", async () => {
  const f = fixture();
  const report = await verifyProduction({
    root: "/test",
    envFile: "/test/.env",
    run: f.run,
  });
  assert.equal(report.passed, true);
  assert.equal(report.mode, "read-only");
  assert.equal(report.observed.modelConfigured, false);
  assert.equal(report.exercised.restartPersistence, false);
  assert.equal(report.exercised.freshImageBuild, false);
  assert.equal(report.exercised.modelInference, false);
  assert(
    !f.calls.some(
      (c) => c.includes("restart") || c.at(-1)?.includes("CREATE SCHEMA"),
    ),
  );
  assert(!JSON.stringify(report).includes("private-password"));
});

test("production acceptance rejects WASM, shared backend and unhealthy containers", async () => {
  for (const mode of [
    { wasm: true },
    { sameBackend: true },
    { unhealthy: true },
  ]) {
    const f = fixture(mode);
    const report = await verifyProduction({
      root: "/test",
      envFile: "/test/.env",
      run: f.run,
    });
    assert.equal(report.passed, false);
    assert.equal(report.status, "failed");
    assert.equal(report.exercised.nativePostgres, false);
  }
});

test("disposable bundled restart proves service start-time changes and cleans only its own marker", async () => {
  const f = fixture();
  const report = await verifyProduction({
    root: "/test",
    envFile: "/test/.env",
    restart: true,
    disposable: true,
    run: f.run,
  });
  assert.equal(report.passed, true);
  assert.equal(report.exercised.restartPersistence, true);
  assert.equal(report.exercised.databaseServerRestart, true);
  assert.deepEqual(report.observed.restartedServices, ["db", "studio", "web"]);
  const creations = f.calls.filter((c) => c.at(-1)?.includes("CREATE SCHEMA"));
  const cleanups = f.calls.filter((c) => c.at(-1)?.includes("DROP SCHEMA"));
  assert.equal(creations.length, 1);
  assert.equal(cleanups.length, 1);
  const marker = creations[0].at(-1)!.match(/const id="([a-f0-9]{32})"/)![1];
  assert(cleanups[0].at(-1)!.includes(marker));
  assert.equal(
    f.calls.filter((c) => c.at(-1)?.includes("/sessions")).length,
    2,
  );
});

test("external database restart scope stays limited to application containers", async () => {
  const f = fixture({ external: true });
  const report = await verifyProduction({
    root: "/test",
    envFile: "/test/.env",
    restart: true,
    disposable: true,
    run: f.run,
  });
  assert.equal(report.passed, true);
  assert.equal(report.exercised.databaseServerRestart, false);
  assert.deepEqual(report.observed.restartedServices, ["studio", "web"]);
  assert(!f.calls.find((c) => c.includes("restart"))!.includes("db"));
});

test("busy instances cannot reach marker creation or restart", async () => {
  const f = fixture({ busy: true });
  const report = await verifyProduction({
    root: "/test",
    envFile: "/test/.env",
    restart: true,
    disposable: true,
    run: f.run,
  });
  assert.equal(report.passed, false);
  assert(
    !f.calls.some(
      (c) => c.includes("restart") || c.at(-1)?.includes("CREATE SCHEMA"),
    ),
  );
});

test("unchanged container start times and cleanup failures cannot produce passing acceptance", async () => {
  for (const mode of [{ staleRestart: true }, { cleanupFails: true }]) {
    const f = fixture(mode);
    const report = await verifyProduction({
      root: "/test",
      envFile: "/test/.env",
      restart: true,
      disposable: true,
      run: f.run,
    });
    assert.equal(report.passed, false);
    assert.equal(report.status, "failed");
    assert(f.calls.some((c) => c.at(-1)?.includes("DROP SCHEMA")));
    assert(!JSON.stringify(report).includes("secret-password"));
  }
});

test("failed commands never leak connection strings or model credentials into reports", async () => {
  const report = await verifyProduction({
    root: "/test",
    envFile: "/test/.env",
    run: async () => {
      throw new Error(
        "postgresql://user:private-password@database key=private-key",
      );
    },
  });
  assert.equal(report.status, "blocked");
  assert(!JSON.stringify(report).includes("private-password"));
  assert(!JSON.stringify(report).includes("private-key"));
});

test("container probe programs parse as standalone Node modules", async () => {
  const f = fixture();
  await verifyProduction({
    root: "/test",
    envFile: "/test/.env",
    restart: true,
    disposable: true,
    run: f.run,
  });
  const programs = new Set(
    f.calls
      .filter((args) => args.includes("--input-type=module"))
      .map((args) => args.at(-1)!),
  );
  assert.equal(programs.size, 6);
  for (const code of programs) {
    const parsed = spawnSync(
      process.execPath,
      ["--input-type=module", "--check"],
      {
        input: code,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});

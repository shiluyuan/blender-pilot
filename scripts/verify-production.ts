/** Actual target-host acceptance. Never substitutes a fixture for Docker or
 * native PostgreSQL, and never reads or changes the configured model key. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

type Check = { name: string; passed: boolean; message: string };
export interface ProductionReport {
  time: string;
  scope: "target-container-deployment";
  passed: boolean;
  status: "passed" | "failed" | "blocked";
  mode: "read-only" | "disposable-restart";
  checks: Check[];
  observed: {
    dockerVersion?: string;
    containers?: Array<{ service: string; image: string; startedAt: string }>;
    databaseVersion?: string;
    databaseBackends?: number[];
    modelConfigured?: boolean;
    restartedServices?: string[];
    cleanupRequired?: { schema: string; relativeFile: string };
  };
  exercised: {
    nativePostgres: boolean;
    dockerContainers: boolean;
    restartPersistence: boolean;
    databaseServerRestart: boolean;
    freshImageBuild: false;
    modelInference: false;
  };
}
export interface CommandRunner {
  (
    argv: string[],
    options?: { env?: NodeJS.ProcessEnv; timeout?: number },
  ): Promise<string>;
}
const exec = promisify(execFile);
class AcceptanceError extends Error {}
const runCommand: CommandRunner = async (argv, options) => {
  try {
    const result = await exec(argv[0], argv.slice(1), {
      env: options?.env,
      timeout: options?.timeout ?? 45000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    return result.stdout.trim();
  } catch (error: any) {
    // A failed Compose command can contain interpolated passwords or a DB URL.
    // Deliberately do not include argv, stdout, stderr or the original message.
    throw new AcceptanceError(
      error?.code === "ENOENT"
        ? `Required executable is unavailable: ${path.basename(argv[0])}`
        : error?.killed
          ? "Deployment command timed out"
          : "Deployment command failed; inspect the target service locally",
    );
  }
};

const contextProgram = `
import importlib.util,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); envfile=pathlib.Path(sys.argv[2])
spec=importlib.util.spec_from_file_location("pilot_deploy",root/"scripts/deploy.py")
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
c=module.read_env(envfile)
if not c: raise RuntimeError("Deployment configuration is missing")
module.pin_compose_environment(c)
print(json.dumps({"compose":module.compose_command(envfile,c),"config":c}))
`;

function wrappedProbe(code: string) {
  return `try { ${code} } catch { console.log(JSON.stringify({ok:false,error:"Target probe failed; inspect service health and permissions locally"})); process.exitCode=1; }`;
}

export const nativeDatabaseProbe = wrappedProbe(`
  const {default:pg}=await import("pg");
  const clients=[0,1].map(()=>new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000,query_timeout:10000}));
  try {
    await Promise.all(clients.map(c=>c.connect()));
    const details=await Promise.all(clients.map(c=>c.query("SELECT version() AS version, pg_backend_pid() AS pid")));
    const version=details[0].rows[0].version;
    const pids=details.map(x=>Number(x.rows[0].pid));
    if(!/^PostgreSQL /.test(version)||/wasm|emscripten/i.test(version)||pids[0]===pids[1]) throw Error("Native backend required");
    const lock=[Math.floor(Math.random()*2147483647),Math.floor(Math.random()*2147483647)];
    await clients[0].query("BEGIN");
    await clients[0].query("SELECT pg_advisory_xact_lock($1,$2)",lock);
    const blocked=await clients[1].query("SELECT pg_try_advisory_lock($1,$2) AS acquired",lock);
    if(blocked.rows[0].acquired!==false) throw Error("Independent transaction lock missing");
    await clients[0].query("ROLLBACK");
    const released=await clients[1].query("SELECT pg_try_advisory_lock($1,$2) AS acquired",lock);
    if(released.rows[0].acquired!==true) throw Error("Transaction lock was not released");
    await clients[1].query("SELECT pg_advisory_unlock($1,$2)",lock);
    console.log(JSON.stringify({ok:true,version,pids,transactionIsolation:true}));
  } finally { await Promise.allSettled(clients.map(c=>c.end())); }
`);

const readinessProbe = wrappedProbe(`
  const {verifyReadiness}=await import("./dist/server/apps/server/readiness.js");
  const report=await verifyReadiness({baseUrl:"http://127.0.0.1:8090",password:process.env.PILOT_PASSWORD});
  const model=report.checks.find(c=>c.name==="model-configured");
  console.log(JSON.stringify({ok:report.checks.filter(c=>c.name!=="model-configured").every(c=>c.passed),modelConfigured:model?.passed===true,checks:report.checks.map(c=>({name:c.name,passed:c.passed}))}));
`);

const idleProbe = wrappedProbe(`
  let cookie="";
  async function api(route,body) {
    const response=await fetch("http://127.0.0.1:8090/api"+route,{method:body?"POST":"GET",redirect:"error",headers:{cookie,"content-type":"application/json"},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw Error("API unavailable");
    if(route==="/auth/login") cookie=response.headers.getSetCookie().find(x=>x.startsWith("pilot_session="))?.split(";")[0]||"";
    return response.json();
  }
  try {
    await api("/auth/login",{password:process.env.PILOT_PASSWORD});
    if(!cookie) throw Error("Missing session");
    const health=await api("/health");
    if(!health.execution?.ok||health.execution.activeRuns?.length) throw Error("Worker busy");
    if(health.execution.studios?.some(s=>s.runId||s.status==="starting"||s.status==="closing")) throw Error("Studio transition in progress");
    for(const project of await api("/projects")) for(const session of await api("/projects/"+project.id+"/sessions"))
      if((await api("/sessions/"+session.id+"/runs")).some(r=>!["succeeded","failed","interrupted","cancelled"].includes(r.status))) throw Error("Queued application task");
    console.log(JSON.stringify({ok:true}));
  } finally { if(cookie) await api("/auth/logout",{}); }
`);

function persistenceProbe(id: string, action: "create" | "read" | "cleanup") {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid acceptance marker");
  return wrappedProbe(`
    const {default:pg}=await import("pg");
    const fs=await import("node:fs/promises");
    const path=await import("node:path");
    const id=${JSON.stringify(id)}, schema="pilot_accept_"+id;
    const dir=path.join(process.env.PILOT_DATA||"/data",".acceptance");
    const file=path.join(dir,id+".json");
    const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000,query_timeout:10000});
    try {
      await client.connect();
      ${
        action === "create"
          ? `
      await client.query('CREATE SCHEMA "'+schema+'"');
      await client.query('CREATE TABLE "'+schema+'".marker (value text NOT NULL)');
      await client.query('INSERT INTO "'+schema+'".marker VALUES ($1)',[id]);
      await fs.mkdir(dir,{recursive:true,mode:0o700});
      const handle=await fs.open(file,"wx",0o600);
      try { await handle.writeFile(JSON.stringify({id})); await handle.sync(); } finally { await handle.close(); }
      `
          : action === "read"
            ? `
      const row=await client.query('SELECT value FROM "'+schema+'".marker');
      if(row.rows.length!==1||row.rows[0].value!==id||JSON.parse(await fs.readFile(file,"utf8")).id!==id) throw Error("Persistence mismatch");
      `
            : `
      await client.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
      await fs.rm(file,{force:true});
      `
      }
      console.log(JSON.stringify({ok:true}));
    } finally { await client.end(); }
  `);
}

export async function verifyProduction(options: {
  root: string;
  envFile: string;
  restart?: boolean;
  disposable?: boolean;
  run?: CommandRunner;
}): Promise<ProductionReport> {
  const report: ProductionReport = {
    time: new Date().toISOString(),
    scope: "target-container-deployment",
    passed: false,
    status: "blocked",
    mode: options.restart ? "disposable-restart" : "read-only",
    checks: [],
    observed: {},
    exercised: {
      nativePostgres: false,
      dockerContainers: false,
      restartPersistence: false,
      databaseServerRestart: false,
      freshImageBuild: false,
      modelInference: false,
    },
  };
  const check = (name: string, passed: boolean, message: string) =>
    report.checks.push({ name, passed, message });
  if (options.restart && !options.disposable) {
    check(
      "disposable-opt-in",
      false,
      "--restart requires PILOT_TEST_DISPOSABLE=1 for this dedicated test stack; no command was executed",
    );
    return report;
  }
  const run = options.run ?? runCommand;
  let compose: string[] = [];
  let env: NodeJS.ProcessEnv | undefined;
  let marker: string | undefined;
  let stage = "deployment-context";
  const execute = async (args: string[], timeout?: number) =>
    run(args, { env, timeout });
  const probe = async (service: string, code: string) => {
    const value = JSON.parse(
      await execute([
        ...compose,
        "exec",
        "-T",
        service,
        "node",
        "--input-type=module",
        "-e",
        code,
      ]),
    );
    if (value.ok !== true) throw new Error("Target probe did not pass");
    return value;
  };
  try {
    await run(["docker", "--version"]);
    const context = JSON.parse(
      await run([
        "python3",
        "-c",
        contextProgram,
        path.resolve(options.root),
        path.resolve(options.envFile),
      ]),
    );
    if (
      !Array.isArray(context.compose) ||
      !context.compose.every((x: unknown) => typeof x === "string") ||
      !context.config
    )
      throw Error("Invalid Compose context");
    compose = context.compose;
    // Match docker-up.sh: checked .env values override unrelated exported vars.
    env = { ...process.env };
    for (const [key, value] of Object.entries(context.config))
      if (key === "DATABASE_URL" || /^(PILOT_|POSTGRES_|BLENDER_)/.test(key))
        env[key] = String(value);
    const composeIndex = compose.indexOf("compose");
    if (composeIndex < 1) throw Error("Invalid Docker command");
    const docker = compose.slice(0, composeIndex);
    const info = JSON.parse(
      await execute([...docker, "info", "--format", "{{json .}}"]),
    );
    if (info.OSType !== "linux" || typeof info.ServerVersion !== "string")
      throw Error("A Linux Docker daemon is required");
    report.observed.dockerVersion = info.ServerVersion;
    check(
      stage,
      true,
      "Actual Linux Docker daemon and deployment configuration are accessible",
    );
    const bundled = context.config.PILOT_BUNDLED_DB === "true";
    const services = bundled ? ["db", "studio", "web"] : ["studio", "web"];
    const inspect = async () => {
      const containers = [];
      for (const service of services) {
        const ids = (await execute([...compose, "ps", "-q", service]))
          .split(/\s+/)
          .filter(Boolean);
        if (ids.length !== 1)
          throw Error("Each required service must have one running container");
        const value = JSON.parse(await execute([...docker, "inspect", ids[0]]));
        const c = value[0];
        if (
          value.length !== 1 ||
          c.Config?.Labels?.["com.docker.compose.service"] !== service ||
          !c.State?.Running ||
          c.State?.Health?.Status !== "healthy"
        )
          throw Error("Container is not healthy");
        containers.push({
          service,
          image: String(c.Config.Image),
          startedAt: String(c.State.StartedAt),
        });
      }
      return containers;
    };
    stage = "container-health";
    const before = await inspect();
    report.observed.containers = before;
    report.exercised.dockerContainers = true;
    check(
      stage,
      true,
      "All required running Compose containers have passed their real healthchecks",
    );
    stage = "native-postgresql";
    const database = await probe("web", nativeDatabaseProbe);
    if (
      typeof database.version !== "string" ||
      /wasm|emscripten/i.test(database.version) ||
      !Array.isArray(database.pids) ||
      database.pids.length !== 2 ||
      !database.pids.every(
        (pid: unknown) => Number.isSafeInteger(pid) && Number(pid) > 0,
      ) ||
      database.pids[0] === database.pids[1] ||
      database.transactionIsolation !== true
    )
      throw Error("Native PostgreSQL proof is incomplete");
    report.observed.databaseVersion = database.version;
    report.observed.databaseBackends = database.pids;
    report.exercised.nativePostgres = true;
    check(
      stage,
      true,
      "Two independent PostgreSQL backend processes enforce and release a transaction advisory lock",
    );
    stage = "authenticated-readiness";
    const ready = await probe("web", readinessProbe);
    report.observed.modelConfigured = ready.modelConfigured === true;
    check(
      stage,
      true,
      "Authentication, gateway, Runner, database and local disk readiness passed; model configuration is reported separately",
    );
    if (options.restart) {
      stage = "idle-before-restart";
      await probe("web", idleProbe);
      check(
        stage,
        true,
        "No active or queued application task or studio transition was found",
      );
      marker = randomUUID().replaceAll("-", "");
      stage = "persistence-setup";
      await probe("web", persistenceProbe(marker, "create"));
      await probe("studio", persistenceProbe(marker, "read"));
      check(
        stage,
        true,
        "An isolated SQL schema and a unique synced local file are shared by both app containers",
      );
      // Recheck immediately before the only service-interrupting operation.
      await probe("web", idleProbe);
      stage = "container-restart";
      await execute([...compose, "restart", ...services], 180000);
      await execute(
        [
          ...compose,
          "up",
          "-d",
          "--no-build",
          "--wait",
          "--wait-timeout",
          "180",
          ...services,
        ],
        210000,
      );
      const after = await inspect();
      if (
        after.some(
          (c) =>
            c.startedAt ===
            before.find((b) => b.service === c.service)?.startedAt,
        )
      )
        throw Error("A requested container did not restart");
      report.observed.containers = after;
      report.observed.restartedServices = services;
      report.exercised.databaseServerRestart = bundled;
      check(
        stage,
        true,
        bundled
          ? "Web, Runner and bundled PostgreSQL containers restarted and recovered"
          : "Web and Runner containers restarted; the external PostgreSQL server was not restarted",
      );
      stage = "restart-persistence";
      await probe("web", nativeDatabaseProbe);
      await probe("web", persistenceProbe(marker, "read"));
      await probe("studio", persistenceProbe(marker, "read"));
      await probe("web", readinessProbe);
      report.exercised.restartPersistence = true;
      check(
        stage,
        true,
        "Database and local-file markers survived restart, and authenticated service readiness recovered",
      );
    }
    report.status = "passed";
  } catch (error) {
    check(
      stage,
      false,
      error instanceof AcceptanceError
        ? error.message
        : "Target check failed; inspect container health and configuration locally (command output is omitted to protect credentials)",
    );
    report.status = stage === "deployment-context" ? "blocked" : "failed";
  } finally {
    if (marker) {
      try {
        await probe("web", persistenceProbe(marker, "cleanup"));
        check(
          "marker-cleanup",
          true,
          "Only this run's isolated marker schema and file were removed",
        );
      } catch {
        report.observed.cleanupRequired = {
          schema: "pilot_accept_" + marker,
          relativeFile: ".acceptance/" + marker + ".json",
        };
        check(
          "marker-cleanup",
          false,
          "Marker cleanup failed; restore the test stack and remove only the pilot_accept_<run-id> schema and .acceptance/<run-id>.json created by this run",
        );
        report.status = "failed";
      }
    }
    report.passed =
      report.status === "passed" && report.checks.every((c) => c.passed);
  }
  return report;
}

export async function runProductionCli() {
  const args = parseArgs({
    options: {
      "env-file": { type: "string" },
      output: { type: "string" },
      restart: { type: "boolean", default: false },
      root: { type: "string" },
    },
  });
  const root = path.resolve(args.values.root || ".");
  const envFile = path.resolve(
    args.values["env-file"] || path.join(root, ".env"),
  );
  // Missing Docker should produce a useful blocked report even before .env exists.
  const report = await verifyProduction({
    root,
    envFile,
    restart: args.values.restart,
    disposable: process.env.PILOT_TEST_DISPOSABLE === "1",
  });
  if (args.values.output) {
    const file = path.resolve(args.values.output);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await runProductionCli();

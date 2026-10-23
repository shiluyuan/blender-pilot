/** Credential-free startup diagnostic. Does not perform inference or edit a scene. */
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { CodexRuntime } from "../packages/runtime-adapters/codex.js";
const diagnosticRoot = path.resolve(".data");
await mkdir(diagnosticRoot, { recursive: true, mode: 0o700 });
const home = await mkdtemp(path.join(diagnosticRoot, "codex-doctor-"));
const gateway = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ tools: [] }));
});
await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(gateway.address() as any).port}`;
process.env.CODEX_BIN ||= path.resolve("node_modules/.bin/codex");
const runtime = new CodexRuntime({
  home,
  cwd: home,
  settings: {
    baseUrl: url + "/v1",
    model: "gpt-5.1-codex",
    apiKey: "diagnostic-placeholder",
    effort: "low",
  },
  proxyCommand: process.execPath,
  proxyArgs: [
    "--import",
    import.meta.resolve("tsx"),
    path.resolve("packages/blender-bridge/mcp-proxy.ts"),
  ],
  runnerUrl: url,
  runToken: "diagnostic-placeholder",
  onEvent: (method, params) => {
    if (method === "diagnostic") process.stderr.write(params.message);
  },
});
try {
  const started = Date.now();
  await runtime.start();
  console.log(
    `PASS native Codex initialize + thread/start (${Date.now() - started}ms). No model inference performed.`,
  );
} catch (e) {
  console.error(String(e));
  process.exitCode = 1;
} finally {
  await runtime.close();
  await new Promise<void>((r) => gateway.close(() => r()));
  await rm(home, { recursive: true, force: true });
}

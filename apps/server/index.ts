import path from "node:path";
import { buildApp } from "./app.js";
const { app } = await buildApp({
  dataRoot: process.env.PILOT_DATA || path.resolve(".data"),
  password: process.env.PILOT_PASSWORD || "",
  internalToken: process.env.PILOT_INTERNAL_TOKEN || "",
  runnerUrl: process.env.PILOT_RUNNER_URL || "http://127.0.0.1:8091",
  webRoot: path.resolve(process.env.PILOT_WEB_ROOT || "dist/web"),
  secureCookie: process.env.PILOT_SECURE_COOKIE === "true",
});
await app.listen({
  port: Number(process.env.PORT || 8090),
  host: process.env.HOST || "0.0.0.0",
});
console.log("Blender Pilot web ready");
process.on("SIGTERM", () => void app.close());
process.on("SIGINT", () => void app.close());

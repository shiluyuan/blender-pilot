import path from "node:path";
import { pathToFileURL } from "node:url";
import { runReadinessCli } from "../apps/server/readiness.js";
export {
  verifyReadiness,
  type ReadinessReport,
} from "../apps/server/readiness.js";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await runReadinessCli();

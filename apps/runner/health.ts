import type { StudioPool } from "./pool.js";
import type { Database } from "../../packages/storage/database.js";
import { terminal, type RunStatus } from "../../packages/contracts/index.js";

/** Idle journaling is not proof that PostgreSQL is still reachable. */
export async function collectRunnerHealth(
  pool: StudioPool,
  database: Pick<Database, "health">,
  activeRuns: Array<{
    id: string;
    projectId: string;
    sessionId: string;
    status: RunStatus;
  }>,
) {
  const db = await database.health().catch(() => ({
    ok: false,
    engine: "PostgreSQL",
    error: "执行服务无法连接 PostgreSQL",
  }));
  const failedStorage =
    pool.history.storageFailure ||
    [...pool.studios.values()].find((studio) => studio.jobs.storageFailure)
      ?.jobs.storageFailure;
  const studios = pool.status();
  return {
    ok: !failedStorage && db.ok && !pool.stopping,
    checkedAt: new Date().toISOString(),
    database: db,
    storage: {
      ok: !failedStorage,
      ...(failedStorage
        ? { error: "执行事件存储不可用，请修复磁盘并重启执行服务" }
        : {}),
    },
    ...(pool.stopping
      ? { error: "执行服务正在关闭" }
      : failedStorage
        ? { error: "执行事件存储不可用，请修复磁盘并重启执行服务" }
        : !db.ok
          ? { error: "执行服务无法连接 PostgreSQL" }
          : {}),
    blender: studios.some((studio) => studio.status === "ready"),
    mode: pool.external
      ? "external-desktop"
      : pool.nativeWindow
        ? "native-window"
        : "project-pool",
    maxStudios: pool.external ? 1 : pool.max,
    studios,
    activeRuns: activeRuns
      .filter((run) => !terminal.has(run.status))
      .map((run) => ({
        id: run.id,
        projectId: run.projectId,
        sessionId: run.sessionId,
      })),
  };
}

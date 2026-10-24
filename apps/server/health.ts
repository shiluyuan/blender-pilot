import { z } from "zod";
import { idSchema } from "../../packages/contracts/index.js";
import { redact } from "../../packages/contracts/fs.js";

const componentHealth = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
const executionHealth = z.object({
  ok: z.boolean(),
  checkedAt: z.string().optional(),
  error: z.string().optional(),
  storage: componentHealth.optional(),
  database: componentHealth
    .extend({
      engine: z.string().optional(),
      version: z.string().optional(),
      schema: z.string().optional(),
    })
    .optional(),
  blender: z.boolean().optional(),
  mode: z.string().optional(),
  maxStudios: z.number().int().positive().optional(),
  studios: z
    .array(
      z.object({
        projectId: idSchema,
        status: z.enum(["starting", "ready", "failed", "closing"]),
        blenderVersion: z.string().optional(),
        error: z.string().optional(),
        runId: idSchema.optional(),
        sessionId: idSchema.optional(),
      }),
    )
    .default([]),
  activeRuns: z
    .array(
      z.object({
        id: idSchema,
        projectId: idSchema,
        sessionId: idSchema,
      }),
    )
    .default([]),
});
export type ExecutionHealth = z.output<typeof executionHealth> & {
  reachable: boolean;
  httpStatus?: number;
};

/** Health snapshots stay useful when a single component is unavailable. The
 * execution transport and the Runner's readiness are deliberately separate. */
export async function probeExecution(options: {
  runnerUrl: string;
  internalToken: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<ExecutionHealth> {
  let response: Response;
  try {
    response = await fetch(options.runnerUrl + "/health", {
      headers: { authorization: `Bearer ${options.internalToken}` },
      redirect: "error",
      signal: AbortSignal.any([
        options.signal,
        AbortSignal.timeout(options.timeoutMs ?? 5000),
      ]),
    });
  } catch {
    return {
      ok: false,
      reachable: false,
      error: "执行服务未响应，请检查 Runner 连接",
      studios: [],
      activeRuns: [],
    };
  }
  try {
    // Validate the arrays and rendered fields before forwarding them to the UI.
    // A reachable old/misconfigured service must not crash the health endpoint.
    const value = executionHealth.parse(await response.json());
    const cleanError = (error: string | undefined) =>
      error === undefined ? undefined : redact(error, [options.internalToken]);
    return {
      ...value,
      error: cleanError(value.error),
      studios: value.studios.map((studio) =>
        studio.error === undefined
          ? studio
          : { ...studio, error: cleanError(studio.error) },
      ),
      ...(value.storage
        ? {
            storage: {
              ...value.storage,
              error: cleanError(value.storage.error),
            },
          }
        : {}),
      ...(value.database
        ? {
            database: {
              ...value.database,
              error: cleanError(value.database.error),
            },
          }
        : {}),
      ok: response.ok && value.ok === true,
      reachable: true,
      httpStatus: response.status,
      ...(!response.ok && !value.error
        ? { error: `执行服务报告异常（HTTP ${response.status}）` }
        : {}),
    };
  } catch {
    return {
      ok: false,
      reachable: true,
      httpStatus: response.status,
      error: "执行服务健康响应无效，请检查 Runner 版本与日志",
      studios: [],
      activeRuns: [],
    };
  }
}

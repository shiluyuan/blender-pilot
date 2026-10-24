import { z } from "zod";

export const workPlanSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    steps: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
            step: z.string().trim().min(1).max(300),
            status: z.enum(["pending", "in_progress", "completed", "blocked"]),
            objectNames: z
              .array(z.string().min(1).max(160))
              .max(30)
              .default([]),
            note: z.string().max(800).default(""),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (new Set(plan.steps.map((s) => s.id)).size !== plan.steps.length)
      ctx.addIssue({ code: "custom", message: "阶段编号不能重复" });
    if (plan.steps.filter((s) => s.status === "in_progress").length > 1)
      ctx.addIssue({
        code: "custom",
        message: "同一时间只能有一个进行中的阶段",
      });
  });
export type WorkPlan = z.infer<typeof workPlanSchema>;
export interface WorkContext {
  runId: string;
  plan: WorkPlan;
}
export type WorkPhase =
  "preparing" | "waiting_model" | "modeling" | "inspecting" | "saving";
export const workPhaseLabels: Record<WorkPhase, string> = {
  preparing: "准备场景与恢复点",
  waiting_model: "等待模型响应",
  modeling: "正在操作 Blender",
  inspecting: "检查结构与多角度画面",
  saving: "保存场景与结果",
};

import { useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  Loader2,
} from "lucide-react";
import type { ChatBlock } from "./timeline";

export const toolNames: Record<string, string> = {
  get_scene_info: "读取场景",
  execute_blender_code: "执行 Blender 操作",
  capture: "观察当前画面",
  query_blender_api: "查询 Blender API",
  import_asset: "导入资源",
  search_library: "搜索素材库",
  get_library_asset: "查看素材预览",
  save_library_asset: "保存可复用素材",
  import_library_asset: "复用素材",
  save_scene: "保存场景",
  export_scene: "导出场景",
  report_verification: "检查创作结果",
  inspect_scene_quality: "检查场景结构与材质",
  capture_views: "检查多个角度",
  update_work_plan: "更新创作阶段",
  read_skill_resource: "读取技能资料",
};
const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
export function ToolCard({
  block,
  finished,
}: {
  block: Extract<ChatBlock, { kind: "tool" }>;
  finished: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const interrupted = finished && block.status === "running";
  const elapsed =
    Date.parse(block.completedAt || "") - Date.parse(block.startedAt || "");
  const duration =
    Number.isFinite(elapsed) && elapsed >= 0
      ? elapsed < 1000
        ? "<1 秒"
        : `${(elapsed / 1000).toFixed(elapsed < 10000 ? 1 : 0)} 秒`
      : "";
  const receipt =
    block.receipt ||
    (block.result &&
    typeof block.result === "object" &&
    "receipt" in block.result
      ? (block.result.receipt as Record<string, unknown>)
      : undefined);
  return (
    <details
      className={
        "tool-row chat-tool " + (block.status === "failed" ? "failed" : "")
      }
      data-call-id={block.callId}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        {block.status === "running" && !finished ? (
          <Loader2 className="spin" size={13} />
        ) : block.status === "failed" || interrupted ? (
          <AlertCircle size={13} />
        ) : (
          <Check size={13} />
        )}
        <span>{toolNames[block.name] || block.name}</span>
        <small>
          {interrupted
            ? "未收到完成回执"
            : block.status === "running"
              ? "执行中"
              : block.status === "failed"
                ? "失败"
                : "完成"}
          {duration && ` · ${duration}`}
        </small>
        <ChevronRight size={12} />
      </summary>
      {expanded && receipt && (
        <div className="chat-change-receipt">
          {[
            ["created", "新增"],
            ["modified", "修改"],
            ["deleted", "删除"],
          ].map(([key, label]) => {
            const values = receipt[key];
            if (!Array.isArray(values) || !values.length) return null;
            const names = values
              .slice(0, 8)
              .map((v) =>
                typeof v === "string"
                  ? v
                  : typeof v?.name === "string"
                    ? v.name
                    : "",
              )
              .filter(Boolean);
            return (
              <div key={key}>
                <strong>
                  {label} {values.length}
                </strong>
                <span>
                  {names.join("、")}
                  {values.length > 8 ? "…" : ""}
                </span>
              </div>
            );
          })}
          <small>对象变化回读；完整范围见结果。</small>
        </div>
      )}
      {expanded && block.args !== undefined && (
        <div className="chat-tool-detail">
          <span>输入</span>
          <pre>{pretty(block.args)}</pre>
        </div>
      )}
      {expanded && block.result !== undefined && (
        <div className="chat-tool-detail">
          <span>结果</span>
          <pre>{pretty(block.result)}</pre>
        </div>
      )}
      {expanded && block.error && (
        <div className="chat-notice error">{block.error}</div>
      )}
    </details>
  );
}

export function PlanRow({
  block,
  finished,
}: {
  block: Extract<ChatBlock, { kind: "plan" }>;
  finished: boolean;
}) {
  return (
    <details className="chat-plan" open={!finished}>
      <summary>
        创作计划
        <span>
          {block.steps.filter((s) => s.status === "completed").length}/
          {block.steps.length}
        </span>
      </summary>
      {block.explanation && <p>{block.explanation}</p>}
      <ol>
        {block.steps.map((s, i) => (
          <li key={i} data-status={s.status}>
            {s.status === "completed" ? (
              <CheckCircle2 size={12} />
            ) : ["in_progress", "inProgress"].includes(s.status) ? (
              <Loader2 size={12} className="spin" />
            ) : (
              <span className="chat-plan-dot" />
            )}
            {s.step}
          </li>
        ))}
      </ol>
    </details>
  );
}

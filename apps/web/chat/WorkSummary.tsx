import {
  CheckCircle2,
  AlertCircle,
  ArrowUpRight,
  RotateCcw,
  Save,
} from "lucide-react";
import type {
  PilotEvent,
  Snapshot,
  Capture,
} from "../../../packages/contracts/index";
import type { SceneQualityInspection } from "../../../packages/contracts/quality";
import { fileUrl } from "../api";
import "./work.css";

export function WorkSummary({
  events,
  projectId,
  lightbox,
  restore,
  busy,
}: {
  events: PilotEvent[];
  projectId: string;
  lightbox: (v: { src: string; title: string }) => void;
  restore?: (s: Snapshot) => void;
  busy: boolean;
}) {
  const event = events.filter((e) => e.type === "work.summary").at(-1);
  if (!event) return null;
  const s = event.payload;
  const inspection = s.inspection as SceneQualityInspection | undefined;
  const before = s.beforeCapture as Capture | undefined;
  const after = ((s.afterCaptures || []) as Capture[]).filter(
    (c) =>
      c.projectId === projectId && c.phase !== "before" && c.id !== before?.id,
  );
  const viewLabels: Record<string, string> = {
    front: "正面",
    right: "右侧",
    top: "俯视",
    isometric: "透视",
  };
  const resultView = /^(?:final|inspection):(front|right|top|isometric)$/.exec(
    after[0]?.phase || "",
  )?.[1];
  const afterLabel = resultView
    ? `结果检查 · ${viewLabels[resultView]}`
    : "最新画面";
  const snapshot = s.beforeSnapshot as Snapshot | undefined;
  const changes = s.changes as
    Record<string, Array<string | { name?: string }>> | undefined;
  return (
    <section
      className="work-summary"
      data-testid="work-summary"
      aria-label="本轮结果"
    >
      <div className="work-summary-heading">
        <strong>本轮结果</strong>
        <span>
          {s.verification === "passed" ? (
            <>
              <CheckCircle2 size={13} />
              检查通过
            </>
          ) : (
            <>
              <AlertCircle size={13} />
              仍需检查
            </>
          )}
        </span>
      </div>
      {changes && (
        <div className="work-change-list">
          {(
            [
              ["created", "新增"],
              ["modified", "修改"],
              ["deleted", "移除"],
            ] as const
          ).map(([key, label]) => {
            const values = Array.isArray(changes[key]) ? changes[key] : [];
            return values.length ? (
              <div key={key}>
                <b>
                  {label} {values.length}
                </b>
                <span>
                  {values
                    .slice(0, 8)
                    .map((v) => (typeof v === "string" ? v : v.name))
                    .join("、")}
                  {values.length > 8 ? "…" : ""}
                </span>
              </div>
            ) : null;
          })}
        </div>
      )}
      {s.sceneChanged === true &&
        changes &&
        !["created", "modified", "deleted"].some(
          (key) => Array.isArray(changes[key]) && changes[key].length,
        ) && (
          <p className="work-remaining">
            场景版本已变化，当前回执无法细分到对象；请结合画面与检查报告确认。
          </p>
        )}
      {before?.projectId === projectId && after[0] && (
        <div className="work-comparison">
          {[
            { capture: before, label: "操作前" },
            { capture: after[0], label: afterLabel },
          ].map(({ capture, label }) => (
            <button
              type="button"
              key={capture.id}
              onClick={() =>
                lightbox({ src: fileUrl("capture", capture.id), title: label })
              }
            >
              <img
                src={fileUrl("capture", capture.id)}
                alt={label}
                loading="lazy"
              />
              <span>
                {label}
                <ArrowUpRight size={12} />
              </span>
            </button>
          ))}
        </div>
      )}
      {before?.projectId === projectId && !after.length && (
        <p className="work-remaining">
          本轮未取得操作后截图，无法显示前后对比。
        </p>
      )}
      {inspection && (
        <details className="work-inspection">
          <summary>
            结构检查 · {inspection.summary?.errorCount || 0} 项错误，
            {inspection.summary?.warningCount || 0} 项提醒
          </summary>
          <p>机器检查辅助判断；穿插和悬空提示需要结合画面确认。</p>
          {inspection.issues?.slice(0, 12).map((issue, i) => (
            <div className={"work-issue " + issue.severity} key={i}>
              <b>{issue.objects.join("、") || "场景"}</b>
              <span>{issue.message}</span>
            </div>
          ))}
          {!!inspection.limits?.objectsTruncated && (
            <p>对象数量超过检查上限，尚未覆盖整个场景。</p>
          )}
        </details>
      )}
      <div className="work-save">
        <span>
          <Save size={13} />
          {s.saved
            ? `已保存：${String(s.savedFile || "scene.blend")}`
            : "未确认本轮结果已保存"}
        </span>
        {restore && snapshot?.projectId === projectId && (
          <button
            type="button"
            disabled={busy}
            onClick={() => restore(snapshot)}
          >
            <RotateCcw size={12} />
            恢复到操作前
          </button>
        )}
      </div>
      {Array.isArray(s.remainingSteps) && s.remainingSteps.length > 0 && (
        <p className="work-remaining">
          未完成阶段：{s.remainingSteps.map((x: any) => x.step).join("、")}
          。可在下一轮指定继续的阶段；系统不会自动重放。
        </p>
      )}
    </section>
  );
}

import { useRef, useState } from "react";
import { projectNameSchema } from "../../../packages/contracts/projects";
import { Modal } from "../components/Modal";

/** Local form state and synchronous submission ownership, shared by both flows. */
export function ProjectDialog({
  mode,
  initialName = "",
  onSubmit,
  onClose,
}: {
  mode: "create" | "rename";
  initialName?: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const close = () => {
    if (!lock.current) onClose();
  };
  const creating = mode === "create";
  return (
    <Modal title={creating ? "创建项目" : "重命名项目"} onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (lock.current) return;
          const input = projectNameSchema.safeParse(name);
          if (!input.success) {
            setError("请输入 1–80 个字符的项目名称");
            return;
          }
          lock.current = true;
          setSubmitting(true);
          setError("");
          void onSubmit(input.data)
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => {
              lock.current = false;
              setSubmitting(false);
            });
        }}
      >
        {creating && <p className="muted">独立保存场景、参考资源和对话。</p>}
        <label>
          项目名称
          <input
            autoFocus
            required
            maxLength={80}
            disabled={submitting}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={creating ? "例如：海边工作室" : undefined}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={submitting} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={submitting || !name.trim()}>
            {submitting
              ? creating
                ? "正在创建…"
                : "保存中…"
              : creating
                ? "创建并打开"
                : "保存名称"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

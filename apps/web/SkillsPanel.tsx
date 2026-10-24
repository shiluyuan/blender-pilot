import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  CheckCircle2,
  FileArchive,
  FileText,
  FolderOpen,
  LoaderCircle,
  Package,
  Plus,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { InstalledSkill } from "../../packages/contracts/skills";
import { api, bytes, date } from "./api";
import { Markdown } from "./chat/Markdown";
import "./skills.css";

type SkillList = {
  items: InstalledSkill[];
  installer: { package: string; available: boolean; reason?: string };
};
type SkillDetail = { skill: InstalledSkill; content: string; files: string[] };
type ProjectSkills = { skillIds: string[]; items: InstalledSkill[] };
type Dialog = "upload" | "install" | "remove";
const maxUpload = 10 * 1024 * 1024;
const message = (error: unknown) =>
  error instanceof Error
    ? error.name === "TimeoutError"
      ? "请求超时，请检查连接后重试"
      : error.message
    : String(error);
const readSignal = (controller: AbortController) =>
  AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
const repository =
  /^(?:https:\/\/github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取文件，请重新选择"));
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error("文件内容无效"));
      else resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Skill ownership stays on the server. A project switch invalidates pending
 * selection reads/writes, while each run receives an immutable server snapshot. */
export function SkillsPanel({
  projectId,
  projectName,
  notify,
  onChanged,
  busy = false,
}: {
  projectId?: string;
  projectName?: string;
  notify: (text: string) => void;
  onChanged?: () => void;
  busy?: boolean;
}) {
  const [items, setItems] = useState<InstalledSkill[]>([]);
  const [installer, setInstaller] = useState<SkillList["installer"]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<SkillDetail>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [projectError, setProjectError] = useState("");
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectSkillIds, setProjectSkillIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "project">("all");
  const [revision, setRevision] = useState(0);
  const [operation, setOperation] = useState("");
  const [dialogKind, setDialogKind] = useState<Dialog>();
  const [dialogError, setDialogError] = useState("");
  const [file, setFile] = useState<File>();
  const [source, setSource] = useState("");
  const [skillNames, setSkillNames] = useState("");
  const [removing, setRemoving] = useState<InstalledSkill>();
  const [receipt, setReceipt] = useState<string[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const projectRequest = useRef(0);
  const working = operation !== "";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      projectRequest.current++;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<SkillList>("/skills", { signal: readSignal(controller) })
      .then((result) => {
        if (controller.signal.aborted) return;
        setItems(result.items);
        setInstaller(result.installer);
        setSelectedId((id) =>
          result.items.some((item) => item.id === id)
            ? id
            : result.items[0]?.id,
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    const seq = ++projectRequest.current;
    const controller = new AbortController();
    setProjectSkillIds([]);
    setProjectError("");
    setProjectLoading(!!projectId);
    if (projectId)
      void api<ProjectSkills>(`/projects/${projectId}/skills`, {
        signal: readSignal(controller),
      })
        .then((result) => {
          if (seq === projectRequest.current && !controller.signal.aborted)
            setProjectSkillIds(result.skillIds);
        })
        .catch((e) => {
          if (seq === projectRequest.current && !controller.signal.aborted)
            setProjectError(message(e));
        })
        .finally(() => {
          if (seq === projectRequest.current && !controller.signal.aborted)
            setProjectLoading(false);
        });
    return () => controller.abort();
  }, [projectId, revision]);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(undefined);
    setDetailError("");
    setDetailLoading(!!selectedId);
    if (selectedId)
      void api<SkillDetail>(`/skills/${selectedId}`, {
        signal: readSignal(controller),
      })
        .then((result) => {
          if (!controller.signal.aborted) setDetail(result);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setDetailError(message(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setDetailLoading(false);
        });
    return () => controller.abort();
  }, [selectedId, revision]);

  useEffect(() => {
    if (dialogKind) dialogRef.current?.showModal();
  }, [dialogKind]);

  function refresh() {
    setRevision((value) => value + 1);
    onChanged?.();
  }
  function openDialog(kind: Dialog, skill?: InstalledSkill) {
    setDialogError("");
    setFile(undefined);
    setRemoving(skill);
    setDialogKind(kind);
  }
  function closeDialog() {
    if (working) return;
    dialogRef.current?.close();
    setDialogKind(undefined);
    setDialogError("");
  }
  async function toggleProject(skill: InstalledSkill) {
    const owner = projectId;
    if (!owner || busy || working || projectLoading || projectError) return;
    const seq = ++projectRequest.current;
    const selected = projectSkillIds.includes(skill.id);
    const ids = selected
      ? projectSkillIds.filter((id) => id !== skill.id)
      : [...projectSkillIds, skill.id];
    setOperation("project");
    setProjectError("");
    try {
      const result = await api<ProjectSkills>(`/projects/${owner}/skills`, {
        method: "PUT",
        body: JSON.stringify({ skillIds: ids }),
      });
      if (!mounted.current) return;
      if (projectRef.current === owner && seq === projectRequest.current) {
        setProjectSkillIds(result.skillIds);
        notify(
          selected
            ? "已从当前项目移除技能"
            : "已添加到当前项目，下次发送时生效",
        );
        onChanged?.();
      }
    } catch (e) {
      if (
        mounted.current &&
        projectRef.current === owner &&
        seq === projectRequest.current
      )
        setProjectError(message(e));
    } finally {
      if (mounted.current) setOperation("");
    }
  }
  async function toggleEnabled(skill: InstalledSkill) {
    if (working) return;
    setOperation("enabled");
    try {
      await api(`/skills/${skill.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !skill.enabled }),
      });
      if (!mounted.current) return;
      notify(
        skill.enabled
          ? "技能已停用，后续任务不再加载"
          : "技能已启用，可添加到项目",
      );
      refresh();
    } catch (e) {
      if (mounted.current) notify(message(e));
    } finally {
      if (mounted.current) setOperation("");
    }
  }
  async function submitDialog() {
    if (working) return;
    setDialogError("");
    if (dialogKind === "upload") {
      if (!file) return setDialogError("请选择 SKILL.md 或 ZIP 技能包");
      if (file.size > maxUpload) return setDialogError("文件不能超过 10 MB");
      if (file.name.toLowerCase() !== "skill.md" && !/\.zip$/i.test(file.name))
        return setDialogError("请上传 SKILL.md 或 .zip 技能包");
    }
    if (dialogKind === "install" && !repository.test(source.trim()))
      return setDialogError("请输入 GitHub 的 owner/repository 或仓库链接");
    setOperation(dialogKind || "");
    try {
      if (dialogKind === "remove" && removing) {
        const result = await api<{ deleted: boolean; warning?: string }>(
          `/skills/${removing.id}`,
          { method: "DELETE" },
        );
        if (!mounted.current) return;
        notify(result.warning || "技能已卸载，已开始的任务保留自己的技能副本");
      } else {
        const result =
          dialogKind === "upload"
            ? await api<{ items: InstalledSkill[] }>("/skills/upload", {
                method: "POST",
                body: JSON.stringify({
                  name: file!.name,
                  dataBase64: await fileBase64(file!),
                }),
              })
            : await api<{ items: InstalledSkill[] }>("/skills/install", {
                method: "POST",
                // Server installation has its own 180-second deadline. Let the
                // client receive the final failure instead of timing out first.
                signal: AbortSignal.timeout(210000),
                body: JSON.stringify({
                  source: source.trim(),
                  ...(skillNames.trim()
                    ? {
                        skillNames: skillNames
                          .split(/[\s,，]+/)
                          .filter(Boolean),
                      }
                    : {}),
                }),
              });
        if (!mounted.current) return;
        setReceipt(result.items.map((item) => item.name));
        setSelectedId(result.items[0]?.id);
        setFilter("all");
        setSearch("");
        notify(`已安装 ${result.items.length} 个技能，请在项目中选用`);
      }
      dialogRef.current?.close();
      setDialogKind(undefined);
      refresh();
    } catch (e) {
      if (mounted.current) setDialogError(message(e));
    } finally {
      if (mounted.current) setOperation("");
    }
  }

  const selected = items.find((item) => item.id === selectedId);
  const visible = items.filter(
    (item) =>
      (filter === "all" || projectSkillIds.includes(item.id)) &&
      `${item.name} ${item.description} ${item.sourceLabel}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const inProject = !!selected && projectSkillIds.includes(selected.id);
  const selectionDisabled =
    !projectId ||
    busy ||
    loading ||
    working ||
    projectLoading ||
    !!projectError ||
    (!!selected && !selected.enabled && !inProject);

  return (
    <div className="page-content skills-page" data-testid="skills-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SKILLS LIBRARY</div>
          <h1>技能库</h1>
          <p>把熟悉的建模方法交给 Codex，在每个项目中自由组合使用。</p>
        </div>
        <div className="heading-actions skills-heading-actions">
          <button disabled={working} onClick={() => openDialog("upload")}>
            <Upload size={15} />
            上传技能
          </button>
          <button
            className="primary"
            disabled={working || !installer?.available}
            onClick={() => openDialog("install")}
            title={
              installer && !installer.available
                ? installer.reason || "服务器尚未提供 npx 安装器"
                : undefined
            }
          >
            <Plus size={15} />
            npx 安装
          </button>
        </div>
      </div>

      <div
        className="skills-project-context"
        data-testid="skills-project-context"
      >
        <div className="skills-project-icon">
          <FolderOpen size={18} />
        </div>
        <div>
          <strong>
            {projectId ? projectName || "当前项目" : "先打开一个项目"}
          </strong>
          <p>
            {projectLoading
              ? "正在读取项目技能…"
              : projectId
                ? `已选择 ${projectSkillIds.length} 个技能 · 下次发送对话时生效`
                : "安装的技能由所有项目共享，项目单独选择需要的技能。"}
          </p>
        </div>
        <span className="badge">Codex 原生技能</span>
      </div>
      {projectError && (
        <div className="skills-alert" role="alert">
          <span>无法更新项目技能：{projectError}</span>
          <button onClick={refresh} disabled={working}>
            <RefreshCw size={13} />
            重新读取
          </button>
        </div>
      )}
      {receipt.length > 0 && (
        <div className="skills-receipt" role="status">
          <CheckCircle2 size={16} />
          <span>
            已安装 {receipt.join("、")}。选中技能后，添加到当前项目即可使用。
          </span>
          <button aria-label="关闭安装提示" onClick={() => setReceipt([])}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="skills-toolbar">
        <div className="skills-tabs" role="tablist" aria-label="技能范围">
          <button
            role="tab"
            aria-selected={filter === "all"}
            onClick={() => setFilter("all")}
          >
            全部技能 <span>{items.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={filter === "project"}
            disabled={!projectId}
            onClick={() => setFilter("project")}
          >
            项目已选 <span>{projectSkillIds.length}</span>
          </button>
        </div>
        <label className="search">
          <Search size={15} />
          <input
            aria-label="搜索技能"
            placeholder="搜索技能或使用场景"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button
          aria-label="刷新技能库"
          title="刷新技能库"
          disabled={loading || working}
          onClick={refresh}
        >
          <RefreshCw size={15} className={loading ? "skills-spin" : ""} />
        </button>
      </div>
      {error && (
        <div className="skills-alert" role="alert">
          <span>技能库读取失败：{error}。已有列表可能已过期。</span>
          <button onClick={refresh} disabled={loading}>
            重试
          </button>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="skills-empty" role="status">
          <LoaderCircle className="skills-spin" size={25} />
          <h3>正在读取技能库</h3>
          <p>加载已安装的技能和项目设置。</p>
        </div>
      ) : items.length === 0 && !error ? (
        <div className="skills-empty skills-first-use">
          <div className="skills-empty-icon">
            <BookOpen size={29} />
          </div>
          <div className="eyebrow">YOUR METHODS, REUSABLE</div>
          <h2>让好用的创作方法，成为技能</h2>
          <p>
            上传自己的技能包，或从 GitHub 安装社区技能。
            <br />
            建模规范、材质流程和场景检查，都可以在多个项目中复用。
          </p>
          <div className="skills-empty-actions">
            <button
              className="primary"
              disabled={working}
              onClick={() => openDialog("upload")}
            >
              <Upload size={15} />
              上传第一个技能
            </button>
            <button
              disabled={working || !installer?.available}
              onClick={() => openDialog("install")}
            >
              <Terminal size={15} />
              通过 npx 安装
            </button>
          </div>
          <div className="skills-format-hint">
            <FileText size={14} />
            SKILL.md <span>或</span>
            <FileArchive size={14} />
            ZIP 技能包 <span>· 最大 10 MB</span>
          </div>
        </div>
      ) : (
        <div className="skills-workspace" aria-busy={loading}>
          <div className="skills-list" aria-label="已安装技能">
            <div className="skills-list-count">
              <span>{visible.length} 个技能</span>
              <span>全局共享 · 项目独立选用</span>
            </div>
            {visible.length === 0 && (
              <div className="skills-empty compact">
                <Search size={23} />
                <h3>{search ? "没有匹配的技能" : "项目还没有选择技能"}</h3>
                <p>
                  {search
                    ? "换个关键词试试。"
                    : "在全部技能中选中一个，添加到当前项目。"}
                </p>
                {!search && (
                  <button onClick={() => setFilter("all")}>浏览全部技能</button>
                )}
              </div>
            )}
            {visible.map((item) => (
              <button
                key={item.id}
                className={`skill-card${item.id === selectedId ? " selected" : ""}${item.enabled ? "" : " disabled"}`}
                data-testid="skill-card"
                aria-pressed={item.id === selectedId}
                onClick={() => setSelectedId(item.id)}
              >
                <div className="skill-card-heading">
                  <span className="skill-card-icon">
                    <BookOpen size={17} />
                  </span>
                  <span
                    className={`skill-state${item.enabled ? "" : " muted"}`}
                  >
                    {item.enabled ? "已启用" : "已停用"}
                  </span>
                </div>
                <strong>{item.name}</strong>
                <p>{item.description}</p>
                <div className="skill-card-footer">
                  <span>
                    {item.source === "npx" ? "npx 安装" : "本地上传"} ·{" "}
                    {item.fileCount} 个文件
                  </span>
                  {projectSkillIds.includes(item.id) && (
                    <span className="skill-selected-tag">
                      <Check size={12} />
                      项目已选
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
          <section className="skill-detail" aria-label="技能详情">
            {!selected ? (
              <div className="skills-empty">
                <BookOpen size={25} />
                <p>选择一个技能查看详情。</p>
              </div>
            ) : (
              <>
                <header className="skill-detail-header">
                  <div className="skill-detail-title">
                    <div className="eyebrow">
                      {selected.source === "npx"
                        ? "COMMUNITY SKILL"
                        : "YOUR SKILL"}
                    </div>
                    <h2>{selected.name}</h2>
                    <p>{selected.description}</p>
                  </div>
                  <div className="skill-detail-tools">
                    <button
                      role="switch"
                      aria-checked={selected.enabled}
                      aria-label={`启用 ${selected.name}`}
                      disabled={working || loading || !!error}
                      className="skill-switch"
                      onClick={() => void toggleEnabled(selected)}
                    >
                      <span />
                    </button>
                    <button
                      aria-label={`卸载 ${selected.name}`}
                      title="卸载技能"
                      disabled={working || loading || !!error}
                      onClick={() => openDialog("remove", selected)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </header>
                <div className="skill-project-selection">
                  <div>
                    <strong>
                      {inProject ? "当前项目已选择" : "添加到当前项目"}
                    </strong>
                    <p>
                      {!projectId
                        ? "打开项目后，可以为项目选择技能。"
                        : !selected.enabled
                          ? "技能已停用。重新启用后即可选择。"
                          : "每次新任务会加载选中的技能，已开始的任务保持原版本。"}
                    </p>
                  </div>
                  <button
                    data-testid="skill-project-toggle"
                    className={inProject ? "skill-project-added" : "primary"}
                    aria-pressed={inProject}
                    disabled={selectionDisabled || !!error}
                    onClick={() => void toggleProject(selected)}
                  >
                    {operation === "project" ? (
                      <LoaderCircle size={14} className="skills-spin" />
                    ) : inProject ? (
                      <Check size={14} />
                    ) : (
                      <Plus size={14} />
                    )}
                    {operation === "project"
                      ? "保存中…"
                      : inProject
                        ? "已添加"
                        : "添加到项目"}
                  </button>
                </div>
                <dl className="skill-metadata">
                  <div>
                    <dt>来源</dt>
                    <dd>{selected.sourceLabel}</dd>
                  </div>
                  <div>
                    <dt>内容</dt>
                    <dd>
                      {selected.fileCount} 个文件 · {bytes(selected.size)}
                    </dd>
                  </div>
                  <div>
                    <dt>安装时间</dt>
                    <dd>{date(selected.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>内容版本</dt>
                    <dd>
                      <code title={selected.sha256}>
                        {selected.sha256.slice(0, 12)}
                      </code>
                    </dd>
                  </div>
                </dl>
                <div className="skill-detail-content">
                  {detailLoading ? (
                    <div className="skills-inline-status" role="status">
                      <LoaderCircle size={15} className="skills-spin" />
                      正在读取说明…
                    </div>
                  ) : detailError ? (
                    <div className="skills-alert" role="alert">
                      <span>{detailError}</span>
                      <button onClick={refresh}>重试</button>
                    </div>
                  ) : (
                    detail && (
                      <>
                        <div className="skill-section-title">
                          <FileText size={15} />
                          <h3>使用说明</h3>
                          <span>SKILL.md</span>
                        </div>
                        <div
                          className="skill-instructions"
                          data-testid="skill-instructions"
                        >
                          <Markdown
                            text={detail.content.replace(
                              /^---\r?\n[\s\S]*?\r?\n---\r?\n?/,
                              "",
                            )}
                          />
                        </div>
                        <details className="skill-files">
                          <summary>
                            <Package size={14} />
                            技能文件 <span>{detail.files.length}</span>
                          </summary>
                          <ul>
                            {detail.files.map((name) => (
                              <li key={name}>
                                <FileText size={12} />
                                <code>{name}</code>
                              </li>
                            ))}
                          </ul>
                        </details>
                      </>
                    )
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
      <div className="skills-capabilities">
        <BookOpen size={15} />
        <p>
          技能提供操作说明与参考资源，通过 Blender MCP
          执行建模。当前运行时不执行技能中的终端脚本；需要 shell
          的技能可能无法完整使用。
        </p>
      </div>
      {dialogKind && (
        <dialog
          ref={dialogRef}
          className="modal skill-modal"
          onCancel={(event) => {
            if (working) event.preventDefault();
            else setDialogKind(undefined);
          }}
          onClose={() => {
            if (!working) setDialogKind(undefined);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitDialog();
            }}
          >
            <div className="modal-head">
              <h2>
                {dialogKind === "upload"
                  ? "上传技能"
                  : dialogKind === "install"
                    ? "通过 npx 安装"
                    : "卸载技能"}
              </h2>
              <button
                type="button"
                aria-label="关闭技能窗口"
                disabled={working}
                onClick={closeDialog}
              >
                <X size={16} />
              </button>
            </div>
            {dialogKind === "upload" ? (
              <>
                <p>
                  上传单个 SKILL.md，或包含说明、参考文件和素材的 ZIP 技能包。
                </p>
                <label
                  className={`skill-upload-area${file ? " selected" : ""}`}
                >
                  <FileArchive size={27} />
                  <strong>{file?.name || "选择技能文件"}</strong>
                  <span>
                    {file ? bytes(file.size) : "SKILL.md / .zip · 最大 10 MB"}
                  </span>
                  <input
                    type="file"
                    accept=".md,.zip"
                    aria-label="技能文件"
                    disabled={working}
                    onChange={(event) => {
                      setFile(event.target.files?.[0]);
                      setDialogError("");
                    }}
                  />
                </label>
                <div className="skill-dialog-note">
                  SKILL.md 需要包含 name 和 description。ZIP
                  中可有多个独立技能目录，安装时会校验路径和文件大小。
                </div>
              </>
            ) : dialogKind === "install" ? (
              <>
                <p>
                  从 GitHub
                  仓库安装技能。服务器使用固定版本的安装器，下载后校验并加入技能库。
                </p>
                <label className="skill-field">
                  <span>GitHub 仓库</span>
                  <input
                    autoFocus
                    aria-label="GitHub 仓库"
                    value={source}
                    disabled={working}
                    placeholder="owner/repository"
                    onChange={(event) => setSource(event.target.value)}
                  />
                  <small>也可以粘贴 https://github.com/owner/repository</small>
                </label>
                <label className="skill-field">
                  <span>
                    技能名称 <em>可选</em>
                  </span>
                  <input
                    aria-label="技能名称"
                    value={skillNames}
                    disabled={working}
                    placeholder="留空安装仓库中的全部技能"
                    onChange={(event) => setSkillNames(event.target.value)}
                  />
                  <small>多个名称用逗号分隔，与技能的 name 字段一致。</small>
                </label>
                <div className="skill-command-preview">
                  <span>
                    <Terminal size={13} />
                    安装命令预览
                  </span>
                  <code>
                    npx --yes --package={installer?.package || "skills@1.7.4"}{" "}
                    skills add{" "}
                    {repository.test(source.trim())
                      ? source.trim()
                      : "owner/repository"}{" "}
                    --agent codex --skill{" "}
                    {skillNames.trim()
                      ? skillNames
                          .split(/[\s,，]+/)
                          .filter(Boolean)
                          .map((name) => `'${name.replaceAll("'", "")}'`)
                          .join(" ")
                      : "'*'"}{" "}
                    --copy --yes
                  </code>
                </div>
                <div className="skill-dialog-note">
                  只安装你信任的来源。安装目录与项目分离；技能加入项目后才会在新对话任务中加载。
                </div>
              </>
            ) : (
              <p>
                卸载 <strong>{removing?.name}</strong>{" "}
                后，项目不再加载这个技能。已开始的任务保留原有副本；需要时可以重新安装。
              </p>
            )}
            {dialogError && (
              <div className="skills-alert" role="alert">
                {dialogError}
              </div>
            )}
            {working && (
              <div className="skills-install-progress" role="status">
                <LoaderCircle className="skills-spin" size={17} />
                <span>
                  {operation === "install"
                    ? "正在下载并校验技能，最多等待 3 分钟…"
                    : operation === "upload"
                      ? "正在上传并校验技能文件…"
                      : "正在卸载技能…"}
                  <small>完成后自动更新技能库。</small>
                </span>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" disabled={working} onClick={closeDialog}>
                取消
              </button>
              <button
                className={
                  dialogKind === "remove" ? "skill-delete-confirm" : "primary"
                }
                type="submit"
                disabled={working || (dialogKind === "upload" && !file)}
              >
                {working
                  ? "处理中…"
                  : dialogKind === "upload"
                    ? "上传并安装"
                    : dialogKind === "install"
                      ? "安装技能"
                      : "确认卸载"}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
}

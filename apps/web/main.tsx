import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Box,
  Layers3,
  FolderOpen,
  Settings2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  ArrowUp,
  Square,
  Paperclip,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Search,
  Sun,
  Moon,
  Activity,
  ArrowDownToLine,
  Upload,
  Image,
  FileBox,
  Clock3,
  RotateCcw,
  X,
  Loader2,
  Link,
  KeyRound,
  Terminal,
  CheckCircle2,
  AlertCircle,
  Send,
  Maximize2,
  Grid2X2,
  List,
  MoreHorizontal,
  ArrowLeft,
  LogOut,
  Save,
  Sparkles,
  MessageSquare,
  Command,
  HardDrive,
  Server,
  Database as DatabaseIcon,
  RefreshCw,
  SlidersHorizontal,
  ExternalLink,
  Copy,
} from "lucide-react";
import type {
  Project,
  Session,
  Run,
  Asset,
  PilotEvent,
  Capture,
  Snapshot,
} from "../../packages/contracts/index";
import { terminal } from "../../packages/contracts/index";
import { api, post, fileUrl, bytes, date, upload } from "./api";
import { LibraryPanel } from "./LibraryPanel";
import { TemplatesPanel } from "./TemplatesPanel";
import { Viewport } from "./Viewport";
import { ChatComposer } from "./chat/ChatComposer";
import { ConversationTimeline } from "./chat/ConversationTimeline";
import { RunView } from "./chat/RunView";
import { useChatComposer } from "./chat/useChatComposer";
import { mergePilotEvents } from "./chat/timeline";
import { documentMime } from "../../packages/contracts/attachments";

import "./styles.css";
const labels: Record<string, string> = {
  queued: "等待执行",
  running: "执行中",
  cancelling: "正在停止",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已停止",
  interrupted: "需要检查",
};
function Mark() {
  return (
    <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
      <path
        d="M5 7h12l7 7-7 7H5l8-7z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="14" r="2.5" fill="currentColor" />
    </svg>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "modal wide" : "modal"}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon" aria-label="关闭" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-screen">
      <div className="login-box">
        <div className="brand">
          <Mark /> blender pilot<span className="version">STUDIO</span>
        </div>
        <div className="eyebrow">YOUR PRIVATE CREATIVE SPACE</div>
        <h1>让想法，进入三维。</h1>
        <p>
          登录你的 Blender 工作台。
          <br />
          用对话创作，让每一步都看得见。
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await post("/auth/login", { password });
              onLogin();
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            工作台访问密码
            <input
              autoFocus
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="部署时设置的 PILOT_PASSWORD"
              required
            />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="primary full" disabled={busy}>
            {busy ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <ArrowUp size={16} />
            )}
            进入工作台
          </button>
        </form>
        <small>自托管 · 项目与资源保存在你的服务器</small>
      </div>
      <div className="login-art">
        <div className="orbit one" />
        <div className="orbit two" />
        <div className="orbit three" />
        <Box size={130} strokeWidth={0.6} />
        <span>CREATE IN CONVERSATION.</span>
      </div>
    </div>
  );
}
function App() {
  const [auth, setAuth] = useState<boolean | null>(null),
    [page, setPage] = useState("studio"),
    [projects, setProjects] = useState<Project[]>([]),
    [openIds, setOpenIds] = useState<string[]>([]),
    [opening, setOpening] = useState<string>(),
    [sidebarOpen, setSidebarOpen] = useState(
      localStorage.getItem("pilot-sidebar") !== "closed",
    ),
    [project, setProject] = useState<Project>(),
    [sessions, setSessions] = useState<Session[]>([]),
    [session, setSession] = useState<Session>(),
    [runs, setRuns] = useState<Run[]>([]),
    [events, setEvents] = useState<Record<string, PilotEvent[]>>({}),
    [health, setHealth] = useState<any>(),
    [assets, setAssets] = useState<Asset[]>([]),
    [assetTotal, setAssetTotal] = useState(0),
    [assetPage, setAssetPage] = useState(0),
    [assetSearch, setAssetSearch] = useState(""),
    [assetKind, setAssetKind] = useState("all"),
    [assetView, setAssetView] = useState("grid"),
    [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [panel, setPanel] = useState(true),
    [panelWidth, setPanelWidth] = useState(
      Number(localStorage.getItem("pilot-panel-width")) || 400,
    ),
    [theme, setTheme] = useState(localStorage.getItem("pilot-theme") || "dark"),
    [toast, setToast] = useState(""),
    [modal, setModal] = useState<
      "project" | "sessions" | "attach" | "export" | null
    >(null),
    [projectName, setProjectName] = useState(""),
    [lightbox, setLightbox] = useState<{ src: string; title: string }>(),
    [uploadRows, setUploadRows] = useState<
      Array<{ name: string; progress: number; error?: string }>
    >([]),
    [renaming, setRenaming] = useState<Asset>();
  const [restoringProject, setRestoringProject] = useState<string>();
  const assetRequest = useRef(0);
  const projectRequest = useRef(0);
  useEffect(() => {
    localStorage.setItem("pilot-sidebar", sidebarOpen ? "open" : "closed");
  }, [sidebarOpen]);
  const currentProject = useRef<string | undefined>(undefined);
  currentProject.current = project?.id;
  const active = runs.find((r) => !terminal.has(r.status));
  const projectRunInfo = health?.execution?.activeRuns?.find(
    (r: any) => r.projectId === project?.id,
  );
  const projectRun =
    projectRunInfo &&
    !runs.some((r) => r.id === projectRunInfo.id && terminal.has(r.status))
      ? projectRunInfo
      : undefined;
  const busy =
    !!active ||
    !!projectRun ||
    (restoringProject === project?.id && !!restoringProject);
  const files = useRef<HTMLInputElement>(null),
    draftRef = useRef<HTMLTextAreaElement>(null),
    sessionRef = useRef<string | undefined>(undefined);
  sessionRef.current = session?.id;
  const [streamStates, setStreamStates] = useState<Record<string, string>>({});
  const notify = (s: string) => setToast(s);
  const chat = useChatComposer({
    projectId: project?.id,
    sessionId: session?.id,
    onError: notify,
    onAccepted: (run) => {
      if (
        sessionRef.current !== run.sessionId ||
        currentProject.current !== run.projectId
      )
        return;
      setRuns((current) =>
        current.some((r) => r.id === run.id) ? current : [...current, run],
      );
      void api<Session[]>(`/projects/${run.projectId}/sessions`)
        .then((ss) => {
          if (currentProject.current === run.projectId) setSessions(ss);
        })
        .catch(() => {});
      if (run.error) notify(run.error);
    },
  });
  const { draft, setDraft, attachments, setAttachments } = chat;
  const action = async (fn: () => Promise<any>, success?: string) => {
    try {
      const r = await fn();
      if (success) notify(success);
      return r;
    } catch (e) {
      notify(String(e));
      return undefined;
    }
  };
  useEffect(() => {
    api("/auth/status")
      .then((s) => setAuth(s.authenticated))
      .catch(() => setAuth(false));
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pilot-theme", theme);
  }, [theme]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 6000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const loadHealth = useCallback(async () => {
    try {
      setHealth(await api("/health"));
    } catch {}
  }, []);
  const loadAssets = useCallback(async () => {
    if (!project) return;
    const request = ++assetRequest.current;
    const r = await api(
      `/projects/${project.id}/assets?search=${encodeURIComponent(assetSearch)}&kind=${assetKind}&page=${assetPage}`,
    );
    if (
      request !== assetRequest.current ||
      project.id !== currentProject.current
    )
      return;
    setAssets(r.items);
    setAssetTotal(r.total);
  }, [project?.id, assetSearch, assetKind, assetPage]);
  const loadSnapshots = useCallback(async () => {
    if (project) {
      const r = await api(`/projects/${project.id}/snapshots`);
      if (currentProject.current === project.id) setSnapshots(r);
    }
  }, [project?.id]);
  const restoreSnapshot = async (snapshot: Snapshot) => {
    if (currentProject.current !== snapshot.projectId || busy) return;
    if (
      !confirm(
        `恢复「${snapshot.name}」？系统会先保存当前场景，再加载所选版本。`,
      )
    )
      return;
    setRestoringProject(snapshot.projectId);
    try {
      await post(`/snapshots/${snapshot.id}/restore`);
      await loadSnapshots();
      notify("已恢复，并保留恢复前备份");
    } catch (error) {
      notify(String(error));
    } finally {
      setRestoringProject((current) =>
        current === snapshot.projectId ? undefined : current,
      );
    }
  };
  const loadRuns = useCallback(async () => {
    if (!session) return;
    const id = session.id;
    const result = await api<Run[]>(`/sessions/${id}/runs`);
    if (sessionRef.current === id)
      setRuns((current) => {
        const byId = new Map(result.map((r) => [r.id, r]));
        for (const run of current) byId.set(run.id, run);
        return [...byId.values()].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
      });
  }, [session?.id]);
  useEffect(() => {
    sessionRef.current = session?.id;
    setRuns([]);
    setEvents({});
    if (session) void loadRuns();
  }, [session?.id]);
  const chooseProject = async (p: Project, resumeSession?: string) => {
    const request = ++projectRequest.current;
    setOpening(p.id);
    try {
      await post(`/projects/${p.id}/activate`);
      setOpenIds((ids) => (ids.includes(p.id) ? ids : [...ids, p.id]));
      let ss = await api<Session[]>(`/projects/${p.id}/sessions`);
      if (!ss.length) ss = [await post<Session>(`/projects/${p.id}/sessions`)];
      if (request !== projectRequest.current) return;
      let cached: { sessionId?: string } | undefined;
      try {
        cached = {
          sessionId:
            localStorage.getItem("pilot-chat-active:" + p.id) ||
            JSON.parse(
              localStorage.getItem("pilot-workspace:" + p.id) || "null",
            )?.sessionId,
        };
      } catch {}
      currentProject.current = p.id;
      setOpenIds((ids) => (ids.includes(p.id) ? ids : [...ids, p.id]));
      setProject(p);
      setSessions(ss);
      setSession(
        ss.find((s) => s.id === (resumeSession || cached?.sessionId)) || ss[0],
      );
      setRuns([]);
      setEvents({});
      setAssetPage(0);
      setSnapshots([]);
      localStorage.setItem("pilot-project", p.id);
      void loadHealth();
    } finally {
      if (request === projectRequest.current) setOpening(undefined);
    }
  };
  const closeProject = async (p: Project) => {
    await post(`/projects/${p.id}/close`);
    const remaining = openIds.filter((id) => id !== p.id);
    setOpenIds(remaining);
    if (currentProject.current === p.id) {
      const next = projects.find((x) => x.id === remaining.at(-1));
      if (next) await chooseProject(next);
      else {
        setProject(undefined);
        setSession(undefined);
        setRuns([]);
        localStorage.removeItem("pilot-project");
      }
    }
    void loadHealth();
  };
  useEffect(() => {
    if (!auth) return;
    void api<Project[]>("/projects")
      .then(async (ps) => {
        setProjects(ps);
        const status = await api("/health");
        setHealth(status);
        setOpenIds(
          (status.execution?.studios || [])
            .filter((s: any) => s.status === "ready")
            .map((s: any) => s.projectId),
        );
        const running = status.execution?.activeRuns?.find(
          (r: any) => r.projectId === localStorage.getItem("pilot-project"),
        );
        const saved =
          running?.projectId || localStorage.getItem("pilot-project");
        if (ps.length)
          await chooseProject(
            ps.find((p) => p.id === saved) ||
              ps.find((p) =>
                status.execution?.studios?.some(
                  (s: any) => s.projectId === p.id && s.status === "ready",
                ),
              ) ||
              ps[0],
            running?.sessionId,
          );
      })
      .catch((e) => notify(String(e)));
    void loadHealth();
    const timer = setInterval(() => void loadHealth(), 10000);
    return () => clearInterval(timer);
  }, [auth]);
  useEffect(() => {
    void loadAssets().catch((e) => notify(String(e)));
    void loadSnapshots().catch(() => {});
  }, [loadAssets, loadSnapshots]);
  useEffect(() => {
    if (!session) return;
    const sourceList: EventSource[] = [];
    const boundSession = session.id;
    for (const run of runs) {
      if (
        events[run.id]?.some(
          (e) =>
            e.type === "run.status" && terminal.has(e.payload.status as any),
        )
      )
        continue;
      const es = new EventSource(
        `/api/runs/${run.id}/events?after=${events[run.id]?.at(-1)?.seq || 0}`,
      );
      sourceList.push(es);
      es.onopen = () => {
        if (sessionRef.current === boundSession)
          setStreamStates((s) => ({ ...s, [run.id]: "live" }));
      };
      es.onerror = () => {
        if (sessionRef.current === boundSession)
          setStreamStates((s) => ({ ...s, [run.id]: "reconnecting" }));
      };
      es.onmessage = (e) => {
        if (sessionRef.current !== boundSession) return;
        const item = JSON.parse(e.data) as PilotEvent;
        setEvents((current) => {
          const prev = current[run.id] || [];
          if (prev.some((x) => x.seq === item.seq)) return current;
          return { ...current, [run.id]: mergePilotEvents(prev, [item]) };
        });
        if (item.type === "run.status") {
          if (terminal.has(item.payload.status as any)) void loadHealth();
          setRuns((current) =>
            current.map((r) =>
              r.id === run.id
                ? {
                    ...r,
                    status: item.payload.status as any,
                    verification: String(
                      item.payload.verification || r.verification,
                    ),
                    error: item.payload.error as string,
                  }
                : r,
            ),
          );
        }
      };
      es.addEventListener("done", (event) => {
        // A dispatch failure can finish a queued run before worker events exist.
        try {
          const finalRun = JSON.parse((event as MessageEvent).data).run as
            Run | undefined;
          if (
            finalRun?.id === run.id &&
            finalRun.sessionId === boundSession &&
            sessionRef.current === boundSession
          )
            setRuns((current) =>
              current.map((r) => (r.id === run.id ? finalRun : r)),
            );
        } catch {
          /* Legacy completion frames have no final receipt. */
        }
        es.close();
        void loadSnapshots();
        void loadHealth();
      });
    }
    return () => sourceList.forEach((s) => s.close());
  }, [runs.map((r) => r.id).join(","), session?.id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setPanel((x) => !x);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const newSession = async () => {
    if (!project) return;
    const boundProject = project.id;
    const s = await post<Session>(`/projects/${boundProject}/sessions`);
    if (currentProject.current !== boundProject) return;
    setSessions((current) => [s, ...current]);
    setSession(s);
    setModal(null);
  };
  const send = async () => {
    if (!busy) await chat.send();
  };
  const capture = async () => {
    if (!project) return;
    const c = await action(() =>
      post<Capture>(`/projects/${project.id}/captures`),
    );
    if (c) {
      setAttachments((prev) => [
        ...prev,
        { id: c.id, name: "当前场景截图", kind: "capture" },
      ]);
      setPanel(true);
      notify("截图已加入输入区，发送后供模型查看");
    }
  };
  const uploadFiles = async (list: FileList | File[]) => {
    if (!project) return;
    const fs = Array.from(list);
    setUploadRows(fs.map((f) => ({ name: f.name, progress: 0 })));
    let next = 0;
    const task = async () => {
      while (next < fs.length) {
        const i = next++,
          file = fs[i];
        try {
          await upload(file, project.id, (progress) =>
            setUploadRows((rows) =>
              rows.map((r, j) => (j === i ? { ...r, progress } : r)),
            ),
          );
        } catch (e) {
          setUploadRows((rows) =>
            rows.map((r, j) => (j === i ? { ...r, error: String(e) } : r)),
          );
        }
      }
    };
    await Promise.all([task(), task(), task()]);
    await loadAssets();
    notify("上传处理结束，可在资源库引用或导入");
  };
  const resize = (event: React.PointerEvent) => {
    const start = event.clientX,
      width = panelWidth;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) =>
      setPanelWidth(Math.max(340, Math.min(640, width + start - e.clientX)));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  useEffect(() => {
    localStorage.setItem("pilot-panel-width", String(panelWidth));
  }, [panelWidth]);
  if (auth === null)
    return (
      <div className="boot">
        <Mark />
        <span>打开工作台</span>
        <Loader2 className="spin" size={16} />
      </div>
    );
  if (!auth) return <Login onLogin={() => setAuth(true)} />;
  const nav = [
    ["projects", "项目", FolderOpen],
    ["studio", "工作台", Box],
    ["library", "素材库", Layers3],
    ["templates", "模板中心", Grid2X2],
    ["assets", "资源库", FolderOpen],
    ["history", "快照与恢复", Clock3],
    ["console", "运行控制台", Activity],
  ] as const;
  return (
    <div className="app-shell">
      <aside className={"rail " + (sidebarOpen ? "expanded" : "compact")}>
        <div className="rail-brand" title="Blender Pilot">
          <Mark />
          {sidebarOpen && (
            <span>
              Blender Pilot<small>创作工作台</small>
            </span>
          )}
          <button
            className="icon"
            aria-label={sidebarOpen ? "收起导航" : "展开导航"}
            onClick={() => setSidebarOpen((x) => !x)}
          >
            {sidebarOpen ? (
              <PanelLeftClose size={16} />
            ) : (
              <PanelLeftOpen size={16} />
            )}
          </button>
        </div>
        <nav>
          {nav.map(([id, title, Icon]) => (
            <button
              key={id}
              className={page === id ? "rail-button selected" : "rail-button"}
              title={title}
              aria-label={title}
              onClick={() => setPage(id)}
            >
              <Icon size={18} />
              {sidebarOpen && <span>{title}</span>}
            </button>
          ))}
        </nav>
        {sidebarOpen && (
          <div className="project-explorer">
            <div className="section-label">
              项目空间
              <button
                className="icon"
                aria-label="新建项目"
                onClick={() => {
                  setProjectName("");
                  setModal("project");
                }}
              >
                <Plus size={14} />
              </button>
            </div>
            {projects.map((p) => (
              <button
                key={p.id}
                className={project?.id === p.id ? "selected" : ""}
                onClick={() =>
                  void action(async () => {
                    await chooseProject(p);
                    setPage("studio");
                  })
                }
              >
                <Box size={14} />
                <span>{p.name}</span>
                {health?.execution?.activeRuns?.some(
                  (r: any) => r.projectId === p.id,
                ) ? (
                  <Loader2 size={12} className="spin" />
                ) : openIds.includes(p.id) ? (
                  <span className="dot green" />
                ) : null}
              </button>
            ))}
            <small>
              {openIds.length} 个项目打开 · 上限{" "}
              {health?.execution?.maxStudios || 3}
            </small>
          </div>
        )}
        <div className="rail-bottom">
          <button
            className="rail-button"
            title="切换浅色/深色"
            aria-label="切换主题"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
          </button>
          <button
            className={"rail-button " + (page === "settings" ? "selected" : "")}
            title="模型设置"
            aria-label="模型设置"
            onClick={() => setPage("settings")}
          >
            <Settings2 size={20} />
          </button>
          <button
            className="avatar"
            title="退出登录"
            onClick={() => void post("/auth/logout").then(() => setAuth(false))}
          >
            P
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="brand-text">
            blender <strong>pilot</strong>
            <span className="beta">STUDIO</span>
          </div>
          <span className="divider" />
          <div className="project-picker">
            <FolderOpen size={14} />
            <select
              aria-label="当前项目"
              value={project?.id || ""}
              disabled={!!opening}
              onChange={(e) => {
                const p = projects.find((p) => p.id === e.target.value);
                if (p) void action(() => chooseProject(p));
              }}
            >
              <option value="" disabled>
                选择项目
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <ChevronDown size={12} />
          </div>
          <button
            className="icon"
            title="新建项目"
            onClick={() => {
              setProjectName("");
              setModal("project");
            }}
          >
            <Plus size={15} />
          </button>
          <div className="topbar-right">
            <span className="status">
              <span
                className={"dot " + (health?.execution?.ok ? "green" : "amber")}
              />
              {health?.execution?.ok ? "执行环境就绪" : "执行环境未连接"}
            </span>
            <button className="quiet" onClick={() => setPage("settings")}>
              <span className="model-dot" />
              {health?.model?.model || "配置模型"}
              <ChevronDown size={12} />
            </button>
            <button
              className="icon"
              aria-label={panel ? "收起助手" : "展开助手"}
              title="AI 助手 · Alt J"
              onClick={() => {
                setPage("studio");
                setPanel((x) => !x);
              }}
            >
              {panel ? (
                <PanelRightClose size={18} />
              ) : (
                <PanelRightOpen size={18} />
              )}
            </button>
          </div>
        </header>
        <div
          className="project-tabs"
          role="tablist"
          aria-label="打开的 Blender 项目"
        >
          {openIds
            .map((id) => projects.find((p) => p.id === id))
            .filter((p): p is Project => !!p)
            .map((p) => (
              <div
                className={
                  "project-tab " + (project?.id === p.id ? "active" : "")
                }
                key={p.id}
              >
                <button
                  role="tab"
                  aria-selected={project?.id === p.id}
                  onClick={() =>
                    void action(async () => {
                      await chooseProject(p);
                      setPage("studio");
                    })
                  }
                >
                  <Box size={13} />
                  {p.name}
                  {health?.execution?.activeRuns?.some(
                    (r: any) => r.projectId === p.id,
                  ) && <Loader2 className="spin" size={12} />}
                </button>
                <button
                  className="icon"
                  aria-label={`保存并关闭 ${p.name}`}
                  onClick={() =>
                    void action(() => closeProject(p), "项目已保存并关闭")
                  }
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          {opening && (
            <span className="opening-project">
              <Loader2 className="spin" size={12} />
              正在打开项目…
            </span>
          )}
          <button
            className="icon"
            aria-label="打开项目列表"
            onClick={() => setPage("projects")}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="body">
          <main className="main-content">
            <div
              className={"studio-page " + (page !== "studio" ? "hidden" : "")}
            >
              <div className="workspace-toolbar">
                <div className="workspace-tab">
                  <Box size={15} />
                  <span>{project?.name || "创作工作台"}</span>
                  <span className="muted">.blend</span>
                </div>
                <div className="toolbar-buttons">
                  <button
                    disabled={!project || busy}
                    onClick={() => void capture()}
                  >
                    <Camera size={14} />
                    截图
                  </button>
                  <button
                    disabled={!project || busy}
                    onClick={() =>
                      void action(
                        () => post(`/projects/${project!.id}/save`),
                        "场景已保存",
                      )
                    }
                  >
                    <Save size={14} />
                    保存
                  </button>
                  <button
                    disabled={!project || busy}
                    onClick={() => setModal("export")}
                  >
                    <ArrowDownToLine size={14} />
                    导出
                  </button>
                </div>
              </div>
              {project ? (
                <div className="project-viewports">
                  {openIds.map((id) => (
                    <div
                      key={id}
                      className={
                        "project-viewport " +
                        (project.id === id ? "" : "hidden")
                      }
                    >
                      <Viewport
                        projectId={id}
                        busy={
                          id === project.id
                            ? busy
                            : !!health?.execution?.activeRuns?.some(
                                (r: any) => r.projectId === id,
                              )
                        }
                        onCapture={() => void capture()}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-workspace">
                  <div className="workspace-emblem">
                    <Box size={58} strokeWidth={0.8} />
                  </div>
                  <div className="eyebrow">FROM IDEA TO SCENE</div>
                  <h1>你的下一个场景，从这里开始。</h1>
                  <p>
                    打开 Blender，用自然语言塑造模型、材质与光线。
                    <br />
                    参考图、实时画面和每次修改，都在同一个空间。
                  </p>
                  <button
                    className="primary"
                    onClick={() => setModal("project")}
                  >
                    <Plus size={16} />
                    创建第一个项目
                  </button>
                  <div className="empty-steps">
                    <span>
                      <Image size={15} />
                      添加参考
                    </span>
                    <ChevronRight size={12} />
                    <span>
                      <MessageSquare size={15} />
                      描述想法
                    </span>
                    <ChevronRight size={12} />
                    <span>
                      <Box size={15} />
                      查看成果
                    </span>
                  </div>
                </div>
              )}
            </div>
            {page === "projects" && (
              <div className="page-content projects-page">
                <PageHeading
                  eyebrow="WORKSPACES"
                  title="项目"
                  description="每个项目拥有独立 Blender 场景和对话，共享可复用素材。"
                  action={
                    <button
                      className="primary"
                      onClick={() => {
                        setProjectName("");
                        setModal("project");
                      }}
                    >
                      <Plus size={14} />
                      新建项目
                    </button>
                  }
                />
                <div className="project-list">
                  {projects.map((p) => (
                    <div key={p.id} className="project-row">
                      <Box size={20} />
                      <div>
                        <strong>{p.name}</strong>
                        <small>
                          {date(p.updatedAt)} ·{" "}
                          {openIds.includes(p.id) ? "实例已打开" : "按需启动"}
                        </small>
                        {health?.execution?.studios?.find(
                          (s: any) => s.projectId === p.id,
                        )?.status === "failed" && (
                          <p className="error">
                            {
                              health.execution.studios.find(
                                (s: any) => s.projectId === p.id,
                              ).error
                            }
                            <button
                              onClick={() =>
                                void action(
                                  () => closeProject(p),
                                  "故障实例已关闭，可以重新打开",
                                )
                              }
                            >
                              关闭故障实例
                            </button>
                          </p>
                        )}
                      </div>
                      <button
                        disabled={opening === p.id}
                        onClick={() =>
                          void action(async () => {
                            await chooseProject(p);
                            setPage("studio");
                          })
                        }
                      >
                        {opening === p.id ? "启动中…" : "打开项目"}
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {page === "library" && (
              <LibraryPanel
                projectId={project?.id}
                busy={busy}
                notify={notify}
                onUse={(selected) => {
                  if (
                    attachments.length +
                      selected.filter(
                        (a) => !attachments.some((p) => p.id === a.id),
                      ).length >
                    12
                  ) {
                    notify("每次对话最多引用 12 项，请减少选择");
                    return;
                  }
                  setAttachments((prev) =>
                    [
                      ...prev,
                      ...selected
                        .filter((a) => !prev.some((p) => p.id === a.id))
                        .map((a) => ({
                          id: a.id,
                          name: a.name,
                          kind: "library",
                        })),
                    ].slice(0, 12),
                  );
                  setPage("studio");
                  setPanel(true);
                }}
              />
            )}
            {page === "templates" && (
              <TemplatesPanel
                projectId={project?.id}
                sessionId={session?.id}
                busy={busy || chat.loading || !!chat.outbox}
                blockedReason={
                  chat.outbox
                    ? "当前对话有待确认的发送，请先返回对话处理"
                    : undefined
                }
                notify={notify}
                onUse={({ prompt, libraryAssets }) => {
                  if (
                    !project ||
                    !session ||
                    currentProject.current !== project.id ||
                    sessionRef.current !== session.id
                  )
                    throw new Error("当前项目或对话已切换，请重新应用模板");
                  chat.applyTemplate({
                    projectId: project.id,
                    sessionId: session.id,
                    prompt,
                    attachments: libraryAssets.map((asset) => ({
                      id: asset.id,
                      name: asset.name,
                      kind: "library",
                    })),
                  });
                  setPage("studio");
                  setPanel(true);
                  notify("模板已加入当前对话草稿，确认要求后发送");
                  requestAnimationFrame(() => draftRef.current?.focus());
                }}
              />
            )}
            {page === "assets" && (
              <div className="page-content">
                <PageHeading
                  eyebrow="PROJECT LIBRARY"
                  title="资源库"
                  description="保留灵感，组织素材。在对话中引用，或明确导入场景。"
                  action={
                    <button
                      className="primary"
                      disabled={!project}
                      onClick={() => files.current?.click()}
                    >
                      <Upload size={15} />
                      上传资源
                    </button>
                  }
                />
                <div className="filterbar">
                  <div className="search">
                    <Search size={15} />
                    <input
                      placeholder="搜索名称或标签"
                      value={assetSearch}
                      onChange={(e) => {
                        setAssetSearch(e.target.value);
                        setAssetPage(0);
                      }}
                    />
                  </div>
                  <div className="segmented">
                    {[
                      ["all", "全部"],
                      ["reference", "参考图"],
                      ["model", "模型"],
                      ["texture", "纹理"],
                    ].map(([k, l]) => (
                      <button
                        className={assetKind === k ? "active" : ""}
                        key={k}
                        onClick={() => {
                          setAssetKind(k);
                          setAssetPage(0);
                        }}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                  <span className="count">{assetTotal} 项</span>
                  <button
                    className="icon"
                    aria-label="切换网格列表"
                    onClick={() =>
                      setAssetView(assetView === "grid" ? "list" : "grid")
                    }
                  >
                    {assetView === "grid" ? (
                      <List size={16} />
                    ) : (
                      <Grid2X2 size={16} />
                    )}
                  </button>
                </div>
                <div
                  className={"asset-collection " + assetView}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void uploadFiles(e.dataTransfer.files);
                  }}
                >
                  {assets.map((a) => (
                    <div className="asset-card" key={a.id}>
                      <div
                        className="asset-preview"
                        onClick={() =>
                          a.previewPath &&
                          setLightbox({
                            src: fileUrl("asset", a.id),
                            title: a.name,
                          })
                        }
                      >
                        {a.previewPath ? (
                          <img
                            src={fileUrl("asset", a.id, true)}
                            alt={a.name}
                          />
                        ) : (
                          <FileBox size={40} strokeWidth={1} />
                        )}
                        <span className="file-ext">
                          {a.name.split(".").pop()?.toUpperCase()}
                        </span>
                      </div>
                      <div className="asset-info">
                        <strong title={a.name}>{a.name}</strong>
                        <small>
                          {bytes(a.size)}
                          <span>·</span>
                          {date(a.createdAt)}
                        </small>
                        {a.tags.length > 0 && (
                          <div className="tags">
                            {a.tags.map((t) => (
                              <span key={t}>{t}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="asset-actions">
                        <button
                          onClick={() => {
                            setAttachments((prev) =>
                              prev.some((x) => x.id === a.id)
                                ? prev
                                : [
                                    ...prev,
                                    {
                                      id: a.id,
                                      name: a.name,
                                      kind: "asset",
                                      mime: a.mime,
                                      documentInfo: a.documentInfo,
                                    },
                                  ],
                            );
                            setPage("studio");
                            setPanel(true);
                          }}
                        >
                          <Paperclip size={13} />
                          引用
                        </button>
                        <button
                          disabled={busy || !!documentMime(a.path)}
                          title={
                            documentMime(a.path)
                              ? "文档用于对话参考，请使用引用"
                              : "导入 Blender"
                          }
                          onClick={() =>
                            void action(
                              () => post(`/assets/${a.id}/import`),
                              "资源已导入 Blender",
                            )
                          }
                        >
                          <Box size={13} />
                          导入
                        </button>
                        <button
                          disabled={!!documentMime(a.path)}
                          title={
                            documentMime(a.path)
                              ? "文档用于项目对话参考"
                              : "加入跨项目素材库"
                          }
                          onClick={() =>
                            void action(async () => {
                              await post(`/assets/${a.id}/publish`, {
                                name: a.name,
                                category: "other",
                                tags: a.tags,
                                description: "",
                              });
                              setPage("library");
                            }, "已加入素材库，可编辑分类和标签")
                          }
                        >
                          入库
                        </button>
                        <button
                          className="icon"
                          title="编辑资源信息"
                          onClick={() => setRenaming(a)}
                        >
                          <MoreHorizontal size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                {!assets.length && (
                  <Empty
                    icon={<FolderOpen size={32} strokeWidth={1} />}
                    title="把素材放进创作空间"
                    text="拖入场景参考图、人物图片、模型或纹理。上传不会自动修改 Blender。"
                  />
                )}
                <div className="pagination">
                  <button
                    disabled={assetPage === 0}
                    onClick={() => setAssetPage((p) => p - 1)}
                  >
                    上一页
                  </button>
                  <span>
                    {assetPage + 1} / {Math.max(1, Math.ceil(assetTotal / 60))}
                  </span>
                  <button
                    disabled={(assetPage + 1) * 60 >= assetTotal}
                    onClick={() => setAssetPage((p) => p + 1)}
                  >
                    下一页
                  </button>
                </div>
                <small className="muted">
                  支持 PNG、JPG、WebP、GLB、内嵌资源
                  glTF、FBX、OBJ、BLEND、HDR、EXR。单文件最大 2 GB。
                </small>
              </div>
            )}
            {page === "history" && (
              <div className="page-content">
                <PageHeading
                  eyebrow="HISTORY & RECOVERY"
                  title="快照与恢复"
                  description="AI 修改前自动备份。每一个恢复点，都对应真实的 Blender 文件。"
                  action={
                    <button
                      className="primary"
                      disabled={!project || busy}
                      onClick={() =>
                        void action(async () => {
                          await post(`/projects/${project!.id}/snapshots`, {
                            name: "手动保存点",
                          });
                          await loadSnapshots();
                        }, "快照已建立")
                      }
                    >
                      <Plus size={15} />
                      建立快照
                    </button>
                  }
                />
                <div className="snapshot-list">
                  {snapshots.map((s, i) => (
                    <div className="snapshot-row" key={s.id}>
                      <div className="snapshot-icon">
                        <Layers3 size={20} />
                      </div>
                      <div>
                        <strong>{s.name}</strong>
                        <small>
                          {date(s.createdAt)} ·{" "}
                          {s.runId ? "AI 任务" : "手动操作"}
                        </small>
                      </div>
                      {i === 0 && <span className="badge">最近</span>}
                      <div className="grow" />
                      <a
                        className="button quiet"
                        href={fileUrl("snapshot", s.id)}
                      >
                        <ArrowDownToLine size={14} />
                        下载
                      </a>
                      <button
                        disabled={busy}
                        onClick={() => void restoreSnapshot(s)}
                      >
                        <RotateCcw size={14} />
                        恢复
                      </button>
                    </div>
                  ))}
                </div>
                {!snapshots.length && (
                  <Empty
                    icon={<Clock3 size={32} />}
                    title="还没有快照"
                    text="开始 AI 创作后会自动建立，或先保存一个手动恢复点。"
                  />
                )}
                <div className="note">
                  <AlertCircle size={16} />
                  <p>
                    快照恢复以磁盘文件为准。Blender
                    撤销栈只适用于部分操作，不能替代快照。
                  </p>
                </div>
              </div>
            )}
            {page === "console" && (
              <div className="page-content">
                <PageHeading
                  eyebrow="SYSTEM CONSOLE"
                  title="运行控制台"
                  description="查看真实连接、存储与执行状态。"
                  action={
                    <button onClick={() => void loadHealth()}>
                      <RefreshCw size={14} />
                      刷新
                    </button>
                  }
                />
                <div className="metrics">
                  <Metric
                    icon={<Server size={20} />}
                    title="Blender 环境"
                    value={health?.execution?.ok ? "已连接" : "未连接"}
                    detail={`${health?.execution?.studios?.filter((s: any) => s.status === "ready").length || 0} 个项目就绪 · 上限 ${health?.execution?.maxStudios || 0}`}
                  />
                  <Metric
                    icon={<Command size={20} />}
                    title="Codex 内核"
                    value={health?.versions?.codex || "—"}
                    detail={health?.model?.model || "尚未配置模型"}
                  />
                  <Metric
                    icon={<DatabaseIcon size={20} />}
                    title="数据库"
                    value={health?.database?.ok ? "PostgreSQL" : "未连接"}
                    detail={health?.database?.version || "检查数据库服务"}
                  />
                  <Metric
                    icon={<HardDrive size={20} />}
                    title="可用存储"
                    value={bytes(health?.storage?.free || 0)}
                    detail={"总容量 " + bytes(health?.storage?.total || 0)}
                  />
                </div>
                <h3 className="section-heading">组件版本</h3>
                <div className="component-table">
                  {Object.entries(health?.versions || {}).map(([k, v]) => (
                    <div key={k}>
                      <span>{k}</span>
                      <code>{String(v)}</code>
                      <span className="muted">固定版本</span>
                    </div>
                  ))}
                </div>
                {health?.execution?.error && (
                  <div className="error">{health.execution.error}</div>
                )}
                <h3 className="section-heading">当前对话执行记录</h3>
                <div className="console-log">
                  {Object.values(events)
                    .flat()
                    .filter((e) => e.type !== "message.delta")
                    .slice(-50)
                    .map((e) => (
                      <div key={e.runId + e.seq}>
                        <time>{new Date(e.time).toLocaleTimeString()}</time>
                        <span>{e.type}</span>
                        <code>{JSON.stringify(e.payload).slice(0, 800)}</code>
                      </div>
                    ))}
                  {!Object.values(events).flat().length && (
                    <p className="muted">执行记录会在开始任务后出现。</p>
                  )}
                </div>
              </div>
            )}
            {page === "settings" && (
              <Settings onSaved={() => void loadHealth()} notify={notify} />
            )}
          </main>
          {page === "studio" && panel && (
            <>
              <div
                className="resize-handle"
                role="separator"
                aria-label="调整助手宽度"
                aria-orientation="vertical"
                tabIndex={0}
                onPointerDown={resize}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft")
                    setPanelWidth((w) => Math.min(w + 20, 640));
                  if (e.key === "ArrowRight")
                    setPanelWidth((w) => Math.max(w - 20, 340));
                }}
              />
              <aside className="chat-panel" style={{ width: panelWidth }}>
                <div className="chat-header">
                  <div>
                    <Sparkles size={16} />
                    <strong>创作助手</strong>
                    <span className="badge small">CODEX</span>
                  </div>
                  <div>
                    <button
                      className="icon"
                      title="对话历史"
                      onClick={() => setModal("sessions")}
                    >
                      <Clock3 size={15} />
                    </button>
                    <button
                      className="icon"
                      title="新建对话"
                      disabled={!project}
                      onClick={() => void action(newSession)}
                    >
                      <Plus size={17} />
                    </button>
                    <button
                      className="icon"
                      title="收起助手"
                      onClick={() => setPanel(false)}
                    >
                      <PanelRightClose size={16} />
                    </button>
                  </div>
                </div>
                <div className="chat-context">
                  <span
                    className={
                      "dot " +
                      (active && streamStates[active.id] === "reconnecting"
                        ? ""
                        : "green")
                    }
                  />
                  {active && streamStates[active.id] === "reconnecting"
                    ? "正在重连，恢复消息中…"
                    : "自动截图已开启"}
                  <span className="grow" />
                  <span>{session?.title || "新对话"}</span>
                </div>
                <ConversationTimeline
                  sessionId={session?.id}
                  version={
                    runs.length +
                    ":" +
                    Object.values(events).reduce(
                      (n, list) => n + list.length,
                      0,
                    )
                  }
                >
                  {!runs.length && (
                    <div className="chat-welcome">
                      <div className="assistant-emblem">
                        <Mark />
                      </div>
                      <h2>一起，把场景做好。</h2>
                      <p>
                        描述你想创建或调整的内容。
                        <br />
                        我会观察场景，执行修改，再截图检查。
                      </p>
                      <div className="suggestions">
                        {[
                          "创建一个有柔和灯光的产品展示台",
                          "检查当前场景的构图和材质",
                          "把选中的对象改成磨砂金属",
                        ].map((s, i) => (
                          <button
                            key={s}
                            onClick={() => {
                              setDraft(s);
                              draftRef.current?.focus();
                            }}
                          >
                            <span>{["01", "02", "03"][i]}</span>
                            {s}
                            <ChevronRight size={14} />
                          </button>
                        ))}
                      </div>
                      <div className="welcome-tip">
                        <Image size={16} />
                        <span>添加参考图，让空间、人物与风格更明确。</span>
                      </div>
                      <button
                        className="chat-template-entry"
                        onClick={() => setPage("templates")}
                      >
                        <Grid2X2 size={14} />
                        从模板与素材组合开始
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  )}
                  {runs.map((run) => (
                    <RunView
                      key={run.id}
                      run={run}
                      events={events[run.id] || []}
                      lightbox={setLightbox}
                      busy={busy}
                      onRestoreSnapshot={(snapshot) =>
                        void restoreSnapshot(snapshot)
                      }
                    />
                  ))}
                </ConversationTimeline>
                <ChatComposer
                  draft={draft}
                  setDraft={setDraft}
                  attachments={attachments}
                  uploads={chat.uploads}
                  outbox={chat.outbox}
                  busy={busy}
                  loading={chat.loading}
                  disabled={!project || !session}
                  model={health?.model?.model}
                  status={
                    active ? labels[active.status] : "项目中有任务正在运行"
                  }
                  inputRef={draftRef}
                  onSend={() => void send()}
                  onStop={() => {
                    const id = active?.id || projectRun?.id;
                    if (id) void action(() => post(`/runs/${id}/cancel`));
                  }}
                  onCapture={() => void capture()}
                  onReference={() => setModal("attach")}
                  onFiles={chat.uploadFiles}
                  onRemove={(id) =>
                    setAttachments((prev) => prev.filter((a) => a.id !== id))
                  }
                  onRetryUpload={chat.retryUpload}
                  onRemoveUpload={chat.removeUpload}
                  onRetrySend={() => void chat.retry()}
                  onMoveBack={chat.moveBack}
                />
              </aside>
            </>
          )}
        </div>
        <footer className="statusbar">
          <span>
            <span className="dot green" />
            本地项目
          </span>
          <span>Blender Pilot 0.1.0</span>
          <div className="grow" />
          <span>{busy ? "AI 正在操作场景" : "就绪"}</span>
          <span>
            {location.protocol === "https:" ? "HTTPS / WSS" : "HTTP / WS"}
          </span>
        </footer>
      </div>
      <input
        ref={files}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void uploadFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {toast && (
        <div className="toast" role="status">
          <AlertCircle size={16} />
          <span>{toast}</span>
          <button className="icon" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {uploadRows.length > 0 && (
        <div className="upload-panel">
          <div>
            <strong>文件上传</strong>
            <button className="icon" onClick={() => setUploadRows([])}>
              <X size={16} />
            </button>
          </div>
          {uploadRows.map((r, i) => (
            <div className="upload-row" key={i}>
              <span title={r.name}>{r.name}</span>
              {r.error ? (
                <small className="error-text" title={r.error}>
                  失败 · 重新选择文件可续传
                </small>
              ) : (
                <>
                  <progress value={r.progress} max={100} />
                  <small>{r.progress}%</small>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {modal === "project" && (
        <Modal title="创建项目" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const p = await post<Project>("/projects", {
                  name: projectName,
                });
                setProjects((prev) => [p, ...prev]);
                await chooseProject(p);
                setModal(null);
                setPage("studio");
              });
            }}
          >
            <p className="muted">独立保存场景、参考资源和对话。</p>
            <label>
              项目名称
              <input
                autoFocus
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="例如：海边工作室"
                maxLength={80}
                required
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setModal(null)}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                创建并打开
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "sessions" && (
        <Modal title="项目对话" onClose={() => setModal(null)}>
          <div className="session-list">
            {sessions.map((s) => (
              <button
                key={s.id}
                className={session?.id === s.id ? "selected" : ""}
                onClick={() => {
                  setSession(s);
                  setModal(null);
                }}
              >
                <MessageSquare size={16} />
                <span>
                  {s.title}
                  <small>{date(s.createdAt)}</small>
                </span>
                {session?.id === s.id && <Check size={15} />}
              </button>
            ))}
          </div>
          <button
            className="full"
            disabled={!project}
            onClick={() => void action(newSession)}
          >
            <Plus size={15} />
            新建对话
          </button>
        </Modal>
      )}
      {modal === "attach" && (
        <Modal title="引用项目资源" onClose={() => setModal(null)}>
          <p className="muted">引用供模型理解；需要导入时，再明确告诉助手。</p>
          <div className="attach-list">
            {assets.map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  setAttachments((prev) =>
                    prev.some((x) => x.id === a.id)
                      ? prev
                      : [
                          ...prev,
                          {
                            id: a.id,
                            name: a.name,
                            kind: "asset",
                            mime: a.mime,
                            documentInfo: a.documentInfo,
                          },
                        ],
                  );
                  setModal(null);
                }}
              >
                {a.previewPath ? (
                  <img src={fileUrl("asset", a.id, true)} />
                ) : (
                  <FileBox size={24} />
                )}
                <span>
                  {a.name}
                  <small>{bytes(a.size)}</small>
                </span>
                <Plus size={16} />
              </button>
            ))}
          </div>
          <button
            className="full"
            onClick={() => {
              setModal(null);
              setPage("assets");
            }}
          >
            打开完整资源库
          </button>
        </Modal>
      )}
      {modal === "export" && (
        <Modal title="导出场景" onClose={() => setModal(null)}>
          <p className="muted">
            导出后可交给网页开发、游戏引擎或其他创作软件。
          </p>
          <div className="export-options">
            {[
              ["glb", "GLB", "单文件模型，适合网页和游戏"],
              ["gltf", "glTF", "内嵌资源的 glTF 文件"],
              ["blend", "Blender", "完整场景与打包资源"],
            ].map(([format, title, desc]) => (
              <button
                key={format}
                onClick={() =>
                  void action(async () => {
                    const a = await post(`/projects/${project!.id}/export`, {
                      format,
                    });
                    const link = document.createElement("a");
                    link.href = fileUrl("artifact", a.id);
                    link.click();
                    setModal(null);
                  }, "导出完成")
                }
              >
                <FileBox size={23} />
                <span>
                  <strong>{title}</strong>
                  <small>{desc}</small>
                </span>
                <ArrowDownToLine size={16} />
              </button>
            ))}
          </div>
        </Modal>
      )}
      {renaming && (
        <Modal title="编辑资源" onClose={() => setRenaming(undefined)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void action(async () => {
                await api(`/assets/${renaming.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({
                    name: form.get("name"),
                    tags: String(form.get("tags"))
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    folder: form.get("folder"),
                  }),
                });
                setRenaming(undefined);
                await loadAssets();
              });
            }}
          >
            <label>
              名称
              <input name="name" defaultValue={renaming.name} required />
            </label>
            <label>
              标签（逗号分隔）
              <input name="tags" defaultValue={renaming.tags.join(", ")} />
            </label>
            <label>
              文件夹
              <input name="folder" defaultValue={renaming.folder} />
            </label>
            <div className="modal-actions">
              <button className="primary">保存</button>
            </div>
          </form>
        </Modal>
      )}
      {lightbox && (
        <Modal
          title={lightbox.title}
          onClose={() => setLightbox(undefined)}
          wide
        >
          <img
            className="lightbox-image"
            src={lightbox.src}
            alt={lightbox.title}
          />
          <div className="modal-actions">
            <a
              className="button"
              href={
                lightbox.src +
                (lightbox.src.includes("?") ? "&" : "?") +
                "download=1"
              }
            >
              <ArrowDownToLine size={14} />
              下载图片
            </a>
          </div>
        </Modal>
      )}
    </div>
  );
}
function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function Empty({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function Metric({
  icon,
  title,
  value,
  detail,
}: {
  icon: ReactNode;
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="metric">
      <div>
        {icon}
        <span>{title}</span>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
function Settings({
  onSaved,
  notify,
}: {
  onSaved: () => void;
  notify: (s: string) => void;
}) {
  const [form, setForm] = useState({
      baseUrl: "",
      model: "",
      apiKey: "",
      effort: "medium",
      hasKey: false,
    }),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState("");
  useEffect(() => {
    api("/settings")
      .then((s) => setForm({ ...s, apiKey: "" }))
      .catch((e) => notify(String(e)));
  }, []);
  const save = async () => {
    const r = await api("/settings", {
      method: "PUT",
      body: JSON.stringify({
        baseUrl: form.baseUrl,
        model: form.model,
        effort: form.effort,
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      }),
    });
    setForm({ ...r, apiKey: "" });
    onSaved();
  };
  return (
    <div className="page-content settings-page">
      <PageHeading
        eyebrow="WORKSPACE SETTINGS"
        title="模型与连接"
        description="连接你的模型服务。配置仅保存在服务器，Key 不会回传到浏览器。"
      />
      <div className="settings-layout">
        <div className="settings-nav">
          <span className="active">
            <Command size={16} />
            Codex 模型
          </span>
          <span>
            <Camera size={16} />
            自动视觉检查
          </span>
          <span>
            <Server size={16} />
            执行环境
          </span>
        </div>
        <div className="settings-main">
          <div className="settings-title">
            <div className="engine-icon">
              <Command size={24} />
            </div>
            <div>
              <h2>Codex</h2>
              <p>原生 Agent 内核 · Responses API</p>
            </div>
            <span className="badge">首版引擎</span>
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await save();
                notify("模型配置已保存，下次任务生效");
              } catch (e) {
                notify(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Base URL
              <div className="input-with-icon">
                <Link size={15} />
                <input
                  type="url"
                  required
                  value={form.baseUrl}
                  onChange={(e) =>
                    setForm({ ...form, baseUrl: e.target.value })
                  }
                  placeholder="https://your-provider.example/v1"
                />
              </div>
              <small>
                填写服务商提供的 API 根地址。按服务商要求保留 /v1，不要填写
                /responses。
              </small>
            </label>
            <label>
              API Key
              <div className="input-with-icon">
                <KeyRound size={15} />
                <input
                  type="password"
                  autoComplete="new-password"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder={
                    form.hasKey
                      ? "已保存 · 留空保留现有 Key"
                      : "输入你的 API Key"
                  }
                  required={!form.hasKey}
                />
              </div>
              <small>
                {form.hasKey
                  ? "密钥已加密保存。支持自定义中转站 Key，不限制前缀。"
                  : "密钥以加密形式保存在持久卷中。"}
              </small>
            </label>
            <div className="form-row">
              <label>
                模型名称
                <input
                  required
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  placeholder="服务商提供的准确模型 ID"
                />
              </label>
              <label>
                推理强度
                <select
                  value={form.effort}
                  onChange={(e) => setForm({ ...form, effort: e.target.value })}
                >
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                </select>
              </label>
            </div>
            <div className="form-actions">
              <button className="primary" disabled={busy}>
                {busy ? (
                  <Loader2 className="spin" size={14} />
                ) : (
                  <Check size={14} />
                )}
                保存配置
              </button>
              <button
                type="button"
                disabled={busy || !form.model || !form.baseUrl}
                onClick={async () => {
                  setBusy(true);
                  setResult("");
                  try {
                    await save();
                    const r = await post("/settings/test");
                    setResult(r.message);
                  } catch (e) {
                    setResult(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Activity size={14} />
                保存并测试连接
              </button>
            </div>
            {result && <div className="test-result">{result}</div>}
          </form>
          <div className="settings-section">
            <h3>
              <Camera size={16} />
              自动截图与视觉检查<span className="badge">默认开启</span>
            </h3>
            <p>
              操作前、关键修改后、完成前自动取图。图片会发送至当前模型服务，用于理解场景与检查结果。
            </p>
            <div className="settings-facts">
              <span>
                最多修正<strong>2 轮</strong>
              </span>
              <span>
                每轮截图预算<strong>8 张</strong>
              </span>
              <span>
                预览分辨率<strong>≤ 1600 px</strong>
              </span>
            </div>
            <small>
              模型接口需支持图像输入、工具调用和 Responses
              流式协议。连接测试通过后，仍需用真实创作任务验证。
            </small>
          </div>
          <div className="settings-section">
            <h3>
              <Server size={16} />
              执行环境
            </h3>
            <p>
              Blender、MCP 与 Codex 运行在服务器。工作台经同源 WebSocket
              显示桌面；不需要本机安装 Blender。
            </p>
            <small>
              修改模型配置对新任务生效；现有会话会保留。更换服务商后若不兼容，可创建新对话。
            </small>
          </div>
        </div>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

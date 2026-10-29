import { Mark } from "./components/Mark";
import { Login } from "./auth/Login";
import { PageHeading } from "./components/PageHeading";
import { Empty } from "./components/Empty";
import { Settings } from "./settings/Settings";
import { useConversationState } from "./chat/useConversationState";
import { ChatPanel } from "./chat/ChatPanel";
import { ChatWelcome } from "./chat/ChatWelcome";
import { Modal } from "./components/Modal";
import { ProjectDialog } from "./projects/ProjectDialog";
import { requestId } from "./request-id";
import React, { useState, useEffect, useRef, useCallback } from "react";
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
  AlertCircle,
  Grid2X2,
  List,
  MoreHorizontal,
  Save,
  Sparkles,
  MessageSquare,
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
import {
  api,
  post,
  fileUrl,
  bytes,
  date,
  upload,
  AUTHENTICATION_REQUIRED,
  checkAuthentication,
} from "./api";
import { LibraryPanel } from "./LibraryPanel";
import { TemplatesPanel } from "./TemplatesPanel";
import { SkillsPanel } from "./SkillsPanel";
import { Viewport } from "./Viewport";
import { ChatComposer } from "./chat/ChatComposer";
import { ConversationTimeline } from "./chat/ConversationTimeline";
import { RunView } from "./chat/RunView";
import { useChatComposer } from "./chat/useChatComposer";
import { mergePilotEvents } from "./chat/timeline";
import { documentMime } from "../../packages/contracts/attachments";

import { useSystemHealth } from "./useSystemHealth";
import { SystemStatus, workspaceHealth } from "./SystemStatus";
import "./styles.css";
import "./chat/conversation.css";
const labels: Record<string, string> = {
  queued: "等待执行",
  running: "执行中",
  cancelling: "正在停止",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已停止",
  interrupted: "需要检查",
};
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
    [assets, setAssets] = useState<Asset[]>([]),
    [assetTotal, setAssetTotal] = useState(0),
    [assetPage, setAssetPage] = useState(0),
    [assetSearch, setAssetSearch] = useState(""),
    [assetKind, setAssetKind] = useState("all"),
    [assetView, setAssetView] = useState("grid"),
    [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const { runs, events, setRuns, setEvents } = useConversationState(
    session?.id,
    auth === true,
  );
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const pendingProject = useRef<string | undefined>(undefined);
  const {
    health,
    loading: healthLoading,
    error: healthError,
    stale: healthStale,
    lastSuccessAt,
    refresh: loadHealth,
  } = useSystemHealth(auth === true);
  const systemState = workspaceHealth(
    health,
    healthStale,
    healthError,
    project?.id,
  );
  const [authExpired, setAuthExpired] = useState(false);
  const [panel, setPanel] = useState(true),
    [theme, setTheme] = useState(localStorage.getItem("pilot-theme") || "dark"),
    [toast, setToast] = useState(""),
    [modal, setModal] = useState<
      "project" | "sessions" | "attach" | "export" | null
    >(null),
    [lightbox, setLightbox] = useState<{ src: string; title: string }>(),
    [uploadRows, setUploadRows] = useState<
      Array<{ name: string; progress: number; error?: string }>
    >([]),
    [renaming, setRenaming] = useState<Asset>();
  const [restoringProject, setRestoringProject] = useState<string>();
  const [editingProject, setEditingProject] = useState<Project>();
  const creationReceipt = useRef<
    { name: string; requestId: string } | undefined
  >(undefined);
  const assetRequest = useRef(0);
  const projectRequest = useRef(0);
  useEffect(() => {
    if (auth !== true) {
      projectRequest.current++;
      setOpening(undefined);
      pendingProject.current = undefined;
    }
  }, [auth]);
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
  const notify = useCallback((s: string) => setToast(s), []);
  const chat = useChatComposer({
    authenticated: auth === true,
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
    const expired = () => {
      setAuthExpired(true);
      setAuth(false);
    };
    window.addEventListener(AUTHENTICATION_REQUIRED, expired);
    return () => window.removeEventListener(AUTHENTICATION_REQUIRED, expired);
  }, []);
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
  const restoreSnapshot = useCallback(
    async (snapshot: Snapshot) => {
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
    },
    [busy, loadSnapshots, notify],
  );
  const loadRuns = useCallback(async () => {
    if (!session) return;
    const id = session.id;
    const baseline = new Map(runsRef.current.map((run) => [run.id, run]));
    const result = await api<Run[]>(`/sessions/${id}/runs`);
    if (sessionRef.current === id)
      setRuns((current) => {
        const byId = new Map(result.map((r) => [r.id, r]));
        // Preserve updates received while this refresh was in flight. Cached
        // statuses otherwise yield to the fresh server receipt.
        for (const run of current)
          if (!byId.has(run.id) || baseline.get(run.id) !== run)
            byId.set(run.id, run);
        return [...byId.values()].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
      });
  }, [session?.id]);
  useEffect(() => {
    sessionRef.current = session?.id;
    if (auth === true && session)
      void loadRuns().catch((error) => notify(String(error)));
  }, [session?.id, auth]);
  const chooseProject = async (p: Project, resumeSession?: string) => {
    if (pendingProject.current === p.id) return;
    if (
      !pendingProject.current &&
      currentProject.current === p.id &&
      !resumeSession
    )
      return;
    const request = ++projectRequest.current;
    pendingProject.current = p.id;
    setOpening(p.id);
    try {
      // Reading conversations does not depend on Blender starting. Only commit
      // the new workspace after both succeed, preserving ownership on failure.
      const [, available] = await Promise.all([
        post(`/projects/${p.id}/activate`),
        api<Session[]>(`/projects/${p.id}/sessions`),
      ]);
      if (request !== projectRequest.current) return;
      let ss = available;
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
      setAssetPage(0);
      setSnapshots([]);
      localStorage.setItem("pilot-project", p.id);
      void loadHealth();
    } finally {
      if (request === projectRequest.current) {
        pendingProject.current = undefined;
        setOpening(undefined);
      }
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
        localStorage.removeItem("pilot-project");
      }
    }
    void loadHealth();
  };
  useEffect(() => {
    if (!auth) return;
    let disposed = false;
    void api<Project[]>("/projects")
      .then(async (ps) => {
        if (disposed) return;
        setProjects(ps);
        const status = await loadHealth();
        if (disposed) return;
        setOpenIds(
          (status?.execution?.studios || [])
            .filter((s: any) => s.status === "ready")
            .map((s: any) => s.projectId),
        );
        const running = status?.execution?.activeRuns?.find(
          (r: any) => r.projectId === localStorage.getItem("pilot-project"),
        );
        const saved =
          running?.projectId || localStorage.getItem("pilot-project");
        if (ps.length)
          await chooseProject(
            ps.find((p) => p.id === saved) ||
              ps.find((p) =>
                status?.execution?.studios?.some(
                  (s: any) => s.projectId === p.id && s.status === "ready",
                ),
              ) ||
              ps[0],
            running?.sessionId,
          );
      })
      .catch((e) => {
        if (!disposed) notify(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [auth]);
  useEffect(() => {
    void loadAssets().catch((e) => notify(String(e)));
    void loadSnapshots().catch(() => {});
  }, [loadAssets, loadSnapshots]);
  useEffect(() => {
    if (!auth || !session) return;
    const sourceList: EventSource[] = [];
    let disposed = false;
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
        if (disposed) return;
        if (sessionRef.current === boundSession)
          setStreamStates((s) => ({ ...s, [run.id]: "reconnecting" }));
        void checkAuthentication();
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
      es.addEventListener("auth.expired", () => {
        es.close();
        if (!disposed) void checkAuthentication();
      });
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
    return () => {
      disposed = true;
      sourceList.forEach((s) => s.close());
    };
  }, [runs.map((r) => r.id).join(","), session?.id, auth]);
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
    if (!project || opening) return;
    const boundProject = project.id;
    const s = await post<Session>(`/projects/${boundProject}/sessions`);
    if (currentProject.current !== boundProject) return;
    setSessions((current) => [s, ...current]);
    setSession(s);
    setModal(null);
  };
  const send = async () => {
    if (!busy && !opening) await chat.send();
  };
  const capture = async () => {
    if (!project || opening) return;
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
  if (auth === null)
    return (
      <div className="boot">
        <Mark />
        <span>打开工作台</span>
        <Loader2 className="spin" size={16} />
      </div>
    );
  if (!auth)
    return (
      <Login
        notice={
          authExpired
            ? "登录已过期，请重新登录。对话草稿、附件和待确认消息已保留。"
            : undefined
        }
        onLogin={() => {
          setAuthExpired(false);
          setAuth(true);
        }}
      />
    );
  const nav = [
    ["projects", "项目", FolderOpen],
    ["studio", "工作台", Box],
    ["library", "素材库", Layers3],
    ["templates", "模板中心", Grid2X2],
    ["skills", "技能中心", Sparkles],
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
                {!healthStale &&
                health?.execution?.activeRuns?.some(
                  (r: any) => r.projectId === p.id,
                ) ? (
                  <Loader2 size={12} className="spin" />
                ) : openIds.includes(p.id) ? (
                  <span
                    data-testid={"project-state-" + p.id}
                    data-tone={
                      healthStale
                        ? "unknown"
                        : health?.execution?.studios?.find(
                              (studio) => studio.projectId === p.id,
                            )?.status === "ready"
                          ? "good"
                          : health?.execution?.studios?.find(
                                (studio) => studio.projectId === p.id,
                              )?.status === "failed"
                            ? "bad"
                            : "unknown"
                    }
                    title={
                      healthStale
                        ? "状态待确认"
                        : health?.execution?.studios?.find(
                              (studio) => studio.projectId === p.id,
                            )?.status === "failed"
                          ? "实例异常"
                          : "项目实例"
                    }
                  >
                    <i className="health-dot" aria-hidden="true" />
                  </span>
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
            onClick={() =>
              void action(async () => {
                await post("/auth/logout");
                setAuthExpired(false);
                setAuth(false);
              })
            }
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
              setModal("project");
            }}
          >
            <Plus size={15} />
          </button>
          <div className="topbar-right">
            <button
              className="status workspace-health"
              data-testid="workspace-health"
              data-tone={systemState.tone}
              onClick={() => setPage("console")}
              title="查看系统状态"
            >
              <i className="health-dot" aria-hidden="true" />
              {systemState.label}
            </button>
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
                    disabled={!project || busy || !!opening}
                    onClick={() => void capture()}
                  >
                    <Camera size={14} />
                    截图
                  </button>
                  <button
                    disabled={!project || busy || !!opening}
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
                    disabled={!project || busy || !!opening}
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
                        nativeWindow={
                          health?.execution?.mode === "native-window"
                        }
                        projectId={id}
                        busy={
                          id === project.id
                            ? busy || !!opening
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
                              health?.execution?.studios?.find(
                                (s: any) => s.projectId === p.id,
                              )?.error
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
                        onClick={() => {
                          setEditingProject(p);
                        }}
                      >
                        重命名
                      </button>
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
                busy={busy || !!opening}
                notify={notify}
                onUse={(selected) => {
                  if (opening) {
                    notify("正在切换项目，请稍候再引用素材");
                    return;
                  }
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
                busy={busy || !!opening || chat.loading || !!chat.outbox}
                blockedReason={
                  opening
                    ? "正在切换项目，请稍候"
                    : chat.outbox
                      ? "当前对话有待确认的发送，请先返回对话处理"
                      : undefined
                }
                notify={notify}
                onUse={({ prompt, libraryAssets }) => {
                  if (
                    opening ||
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
            {page === "skills" && (
              <SkillsPanel
                projectId={project?.id}
                projectName={project?.name}
                notify={notify}
                busy={busy || !!opening || !!chat.outbox}
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
                      disabled={!project || busy || !!opening}
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
                <SystemStatus
                  health={health}
                  stale={healthStale}
                  loading={healthLoading}
                  error={healthError}
                  lastSuccessAt={lastSuccessAt}
                  onRefresh={() => void loadHealth()}
                  projectId={project?.id}
                  projects={projects}
                />
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
              <ChatPanel
                sessionTitle={session?.title || "新对话"}
                reconnecting={
                  !!active && streamStates[active.id] === "reconnecting"
                }
                canCreate={!!project && !opening}
                onHistory={() => setModal("sessions")}
                onNew={() => void action(newSession)}
                onClose={() => setPanel(false)}
              >
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
                    <ChatWelcome
                      onSuggestion={(text) => {
                        setDraft(text);
                        draftRef.current?.focus();
                      }}
                      onTemplates={() => setPage("templates")}
                    />
                  )}
                  {runs.map((run) => (
                    <RunView
                      key={run.id}
                      run={run}
                      events={events[run.id] || []}
                      lightbox={setLightbox}
                      busy={busy || !!opening}
                      onRestoreSnapshot={restoreSnapshot}
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
                  disabled={!project || !session || !!opening}
                  disabledReason={opening ? "正在切换项目，请稍候…" : undefined}
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
              </ChatPanel>
            </>
          )}
        </div>
        <footer className="statusbar">
          <span>
            <span className="dot" />
            本地项目
          </span>
          <span>Blender Pilot 0.1.0</span>
          <div className="grow" />
          <button
            className="text-button footer-health"
            data-tone={systemState.tone}
            onClick={() => setPage("console")}
            title="查看系统状态"
          >
            <i className="health-dot" aria-hidden="true" />
            {busy ? "AI 正在操作场景" : systemState.label}
          </button>
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
        <ProjectDialog
          mode="create"
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            if (creationReceipt.current?.name !== name)
              creationReceipt.current = { name, requestId: requestId() };
            const p = await post<Project>("/projects", creationReceipt.current);
            creationReceipt.current = undefined;
            setProjects((prev) => [p, ...prev.filter((x) => x.id !== p.id)]);
            setModal(null);
            setPage("projects");
            try {
              await chooseProject(p);
              setPage("studio");
            } catch (error) {
              notify(
                `项目已创建，打开失败；请在项目列表重试打开。${String(error)}`,
              );
            }
          }}
        />
      )}
      {editingProject && (
        <ProjectDialog
          key={editingProject.id}
          mode="rename"
          initialName={editingProject.name}
          onClose={() => setEditingProject(undefined)}
          onSubmit={async (name) => {
            const id = editingProject.id;
            const updated = await api<Project>(`/projects/${id}`, {
              method: "PATCH",
              body: JSON.stringify({ name }),
            });
            setProjects((prev) => prev.map((p) => (p.id === id ? updated : p)));
            setProject((prev) => (prev?.id === id ? updated : prev));
            setEditingProject(undefined);
            notify("项目名称已更新");
          }}
        />
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
createRoot(document.getElementById("root")!).render(<App />);

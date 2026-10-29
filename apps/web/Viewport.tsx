import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import { Monitor, RefreshCw, Maximize2, MousePointer2 } from "lucide-react";
import { api, fileUrl, checkAuthentication } from "./api";
export function Viewport({
  busy,
  nativeWindow = false,
  projectId,
  onCapture,
}: {
  busy: boolean;
  nativeWindow?: boolean;
  projectId: string;
  onCapture: () => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    rfb = useRef<any>(null);
  const [status, setStatus] = useState("connecting"),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!host.current || nativeWindow) return;
    let disposed = false;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/desktop?projectId=${encodeURIComponent(projectId)}`;
    const client = new RFB(host.current, url, { shared: true });
    rfb.current = client;
    client.scaleViewport = true;
    client.resizeSession = true;
    client.background = "#1c1e20";
    client.viewOnly = busy;
    client.addEventListener("connect", () => setStatus("connected"));
    const disconnected = () => {
      if (disposed) return;
      setStatus("disconnected");
      void checkAuthentication();
    };
    client.addEventListener("disconnect", disconnected);
    client.addEventListener("securityfailure", disconnected);
    return () => {
      disposed = true;
      client.disconnect();
      rfb.current = null;
    };
  }, [attempt, projectId, nativeWindow]);
  useEffect(() => {
    if (rfb.current) rfb.current.viewOnly = busy;
  }, [busy]);
  const [preview, setPreview] = useState<string>();
  const [previewError, setPreviewError] = useState("");
  useEffect(() => {
    if (!nativeWindow) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const captures = await api<Array<{ id: string }>>(
          `/projects/${projectId}/captures`,
        );
        if (!disposed) {
          setPreview(captures[0]?.id);
          setPreviewError("");
        }
      } catch {
        if (!disposed) setPreviewError("截图列表暂时不可用");
      }
    };
    setPreview(undefined);
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [nativeWindow, projectId]);
  if (nativeWindow)
    return (
      <div className="viewport">
        <div className="viewport-strip">
          <span>本机 Blender · 独立窗口</span>
          <button disabled={busy} onClick={onCapture}>
            更新截图
          </button>
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "grid",
            placeItems: "center",
            overflow: "hidden",
          }}
        >
          {preview ? (
            <img
              src={fileUrl("capture", preview)}
              alt="最近的 Blender 场景截图"
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
              }}
            />
          ) : (
            <p>在本机 Blender 窗口操作，点击“更新截图”查看场景。</p>
          )}
        </div>
        <div className="viewport-bottom">
          <span>{previewError || "最近截图预览 · 非实时桌面"}</span>
          <span>AI 通过 MCP 操作本机 Blender</span>
        </div>
      </div>
    );
  return (
    <div className="viewport">
      <div className="viewport-strip">
        <span>
          <span
            className={"dot " + (status === "connected" ? "green" : "amber")}
          />
          {status === "connected"
            ? "Blender 实时视口"
            : status === "connecting"
              ? "正在连接 Blender"
              : "Blender 连接已断开"}
        </span>
        <span className="viewport-actions">
          <span className="muted">
            <MousePointer2 size={12} />
            {busy ? "AI 操作中 · 只读" : "手动控制"}
          </span>
          <button
            className="icon"
            title="全屏视口"
            onClick={() => host.current?.parentElement?.requestFullscreen()}
          >
            <Maximize2 size={14} />
          </button>
        </span>
      </div>
      <div ref={host} className="rfb-host" tabIndex={0} />
      {status !== "connected" && (
        <div className="viewport-offline">
          <Monitor size={34} strokeWidth={1} />
          <h3>
            {status === "connecting"
              ? "连接你的创作空间"
              : "等待 Blender 执行环境"}
          </h3>
          <p>
            真实 Blender 画面会显示在这里。
            <br />
            首次启动需要加载桌面与 MCP 插件。
          </p>
          <button
            onClick={() => {
              setStatus("connecting");
              setAttempt((x) => x + 1);
            }}
          >
            <RefreshCw size={14} />
            重新连接
          </button>
        </div>
      )}
      <div className="viewport-bottom">
        <span>原生 Blender · 键鼠直接操作</span>
        <span>
          {busy
            ? "等待当前操作完成后可接管"
            : "滚轮缩放 · 中键旋转 · Shift + 中键平移"}
        </span>
      </div>
    </div>
  );
}

import { useState, useEffect } from "react";
import {
  Activity,
  Camera,
  Check,
  Command,
  KeyRound,
  Link,
  Loader2,
  Server,
} from "lucide-react";
import { api, post } from "../api";
import { PageHeading } from "../components/PageHeading";
export function Settings({
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

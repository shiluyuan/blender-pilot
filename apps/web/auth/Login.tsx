import { useState } from "react";
import { ArrowUp, Box, Loader2 } from "lucide-react";
import { post } from "../api";
import { Mark } from "../components/Mark";
export function Login({
  onLogin,
  notice,
}: {
  onLogin: () => void;
  notice?: string;
}) {
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
          {notice && (
            <p className="login-notice" role="status">
              {notice}
            </p>
          )}
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

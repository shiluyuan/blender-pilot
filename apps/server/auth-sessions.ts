import { createHash } from "node:crypto";
import type { Database } from "../../packages/storage/database.js";
import type { Vault } from "./security.js";

/** Browser authentication sessions are distinct from Blender/Codex sessions.
 * Only hashes are stored. Revocation survives gateway restarts and never changes
 * the vault encryption key or any other browser's active login. */
export class AuthSessions {
  private watchers = new Map<string, Set<() => void>>();
  private closed = false;
  constructor(
    private db: Database,
    private vault: Vault,
  ) {}
  hash(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }
  async create() {
    if (this.closed)
      throw Object.assign(new Error("认证服务正在关闭"), { statusCode: 503 });
    const token = this.vault.session();
    const expiresAt = this.vault.expiresAt(token)!;
    await this.db.query(
      `DELETE FROM ${this.db.table("auth_sessions")} WHERE expires_at <= now()`,
    );
    await this.db.query(
      `INSERT INTO ${this.db.table("auth_sessions")}(token_hash,expires_at) VALUES($1,$2)`,
      [this.hash(token), new Date(expiresAt).toISOString()],
    );
    return token;
  }
  async valid(token: string | undefined) {
    if (this.closed || !this.vault.valid(token)) return false;
    const result = await this.db.query(
      `SELECT 1 FROM ${this.db.table("auth_sessions")} WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`,
      [this.hash(token!)],
    );
    return !this.closed && !!result.rowCount;
  }
  async revoke(token: string | undefined) {
    if (!token || token.length > 256) return;
    const hash = this.hash(token);
    await this.db.query(
      `UPDATE ${this.db.table("auth_sessions")} SET revoked_at=coalesce(revoked_at,now()) WHERE token_hash=$1`,
      [hash],
    );
    for (const invalidate of [...(this.watchers.get(hash) || [])]) invalidate();
  }
  /** End long-lived transports on logout immediately in this gateway, and on
   * expiration / remote revocation / unavailable storage within one second. */
  watch(token: string | undefined, onInvalid: () => void) {
    if (this.closed) {
      queueMicrotask(() => {
        try {
          onInvalid();
        } catch {}
      });
      return () => {};
    }
    const hash = this.hash(token || "");
    let stopped = false,
      checking = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const listeners = this.watchers.get(hash);
      listeners?.delete(invalidate);
      if (!listeners?.size) this.watchers.delete(hash);
    };
    const invalidate = () => {
      if (stopped) return;
      stop();
      try {
        onInvalid();
      } catch {
        /* All other transports must still close. */
      }
    };
    const check = async () => {
      if (stopped || checking) return;
      checking = true;
      try {
        if (!(await this.valid(token))) invalidate();
      } catch {
        invalidate();
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), 1000);
    timer.unref();
    const listeners = this.watchers.get(hash) || new Set<() => void>();
    listeners.add(invalidate);
    this.watchers.set(hash, listeners);
    void check();
    return stop;
  }
  close() {
    this.closed = true;
    for (const listeners of [...this.watchers.values()])
      for (const invalidate of [...listeners]) invalidate();
  }
}

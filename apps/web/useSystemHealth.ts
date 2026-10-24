import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export type SystemHealth = {
  app: boolean;
  checkedAt?: string;
  database?: { ok: boolean; version?: string; error?: string; engine?: string };
  execution?: {
    ok: boolean;
    reachable?: boolean;
    database?: { ok: boolean; error?: string };
    storage?: { ok: boolean; error?: string };
    error?: string;
    maxStudios?: number;
    activeRuns?: Array<{ id: string; projectId: string; sessionId: string }>;
    studios?: Array<{
      projectId: string;
      status: string;
      error?: string;
      blenderVersion?: string;
    }>;
  };
  storage?: { ok?: boolean; free?: number; total?: number; error?: string };
  model?: {
    ok?: boolean;
    model?: string;
    hasKey?: boolean;
    baseUrl?: string;
    error?: string;
  };
  versions?: Record<string, string>;
  versionSources?: Record<string, string>;
};

function isHealth(value: SystemHealth) {
  return (
    value?.app === true &&
    typeof value.database?.ok === "boolean" &&
    typeof value.execution?.ok === "boolean" &&
    !!value.storage &&
    !!value.model &&
    (value.execution.studios === undefined ||
      (Array.isArray(value.execution.studios) &&
        value.execution.studios.every(
          (studio) =>
            studio &&
            typeof studio.projectId === "string" &&
            typeof studio.status === "string",
        ))) &&
    (value.execution.activeRuns === undefined ||
      (Array.isArray(value.execution.activeRuns) &&
        value.execution.activeRuns.every(
          (run) =>
            run &&
            typeof run.id === "string" &&
            typeof run.projectId === "string" &&
            typeof run.sessionId === "string",
        )))
  );
}

/** Read-only polling, scoped to the current login. Old responses cannot repaint
 * a newer login or turn a failed/stale observation back into a live green state. */
export function useSystemHealth(enabled: boolean) {
  const [health, setHealth] = useState<SystemHealth>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [lastSuccessAt, setLastSuccessAt] = useState<number>();
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const current = useRef(enabled);
  current.current = enabled;
  const pending = useRef<
    | {
        controller: AbortController;
        promise: Promise<SystemHealth | undefined>;
      }
    | undefined
  >(undefined);
  const refresh = useCallback((): Promise<SystemHealth | undefined> => {
    if (!current.current) return Promise.resolve(undefined);
    if (pending.current) return pending.current.promise;
    const bound = generation.current;
    const controller = new AbortController();
    setLoading(true);
    const promise = api<SystemHealth>("/health", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
    })
      .then((value) => {
        if (bound !== generation.current || !current.current) return;
        if (!isHealth(value)) throw new Error("健康检查响应无效");
        setHealth(value);
        setError(undefined);
        setLastSuccessAt(Date.now());
        setNow(Date.now());
        return value;
      })
      .catch(() => {
        if (bound === generation.current && current.current) {
          setError("无法获取最新系统状态，请检查网络或服务后重试。");
          setNow(Date.now());
        }
        return undefined;
      })
      .finally(() => {
        if (pending.current?.controller === controller)
          pending.current = undefined;
        if (bound === generation.current) setLoading(false);
      });
    pending.current = { controller, promise };
    return promise;
  }, []);
  useEffect(() => {
    generation.current++;
    pending.current?.controller.abort();
    pending.current = undefined;
    setHealth(undefined);
    setLastSuccessAt(undefined);
    setError(undefined);
    setLoading(false);
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 10000);
    const onVisible = () => {
      setNow(Date.now());
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("online", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      generation.current++;
      pending.current?.controller.abort();
      pending.current = undefined;
      clearInterval(timer);
      window.removeEventListener("online", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, refresh]);
  return {
    health,
    loading,
    error,
    lastSuccessAt,
    stale: !!health && (!!error || now - (lastSuccessAt || 0) > 25000),
    refresh,
  };
}

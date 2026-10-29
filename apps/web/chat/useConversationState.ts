import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import type { PilotEvent, Run } from "../../../packages/contracts/index";

type Transcript = { runs: Run[]; events: Record<string, PilotEvent[]> };
const empty: Transcript = { runs: [], events: {} };
const MAX_SESSIONS = 6;
const MAX_CACHED_EVENTS = 5000;

/** Session-owned display cache. The server and resumed SSE remain authoritative.
 * Keep only a small working set in memory; never persist transcripts to storage.
 */
export function useConversationState(
  sessionId: string | undefined,
  authenticated: boolean,
) {
  const owner = useRef({ sessionId, authenticated });
  owner.current = { sessionId, authenticated };
  const [cache, setCache] = useState(() => new Map<string, Transcript>());
  useLayoutEffect(() => {
    setCache((previous) => {
      if (!authenticated) return previous.size ? new Map() : previous;
      if (!sessionId) return previous;
      const next = new Map(previous);
      const current = next.get(sessionId) || empty;
      next.delete(sessionId);
      // Very long histories are reloaded instead of occupying the working set.
      for (const [id, value] of next) {
        if (
          Object.values(value.events).reduce((n, list) => n + list.length, 0) >
          MAX_CACHED_EVENTS
        )
          next.delete(id);
      }
      next.set(sessionId, current);
      while (next.size > MAX_SESSIONS) next.delete(next.keys().next().value!);
      return next;
    });
  }, [sessionId, authenticated]);
  const setRuns = useCallback(
    (action: SetStateAction<Run[]>) => {
      if (!sessionId || !authenticated) return;
      setCache((previous) => {
        if (
          !owner.current.authenticated ||
          owner.current.sessionId !== sessionId
        )
          return previous;
        const current = previous.get(sessionId) || empty;
        const runs =
          typeof action === "function" ? action(current.runs) : action;
        if (runs === current.runs) return previous;
        return new Map(previous).set(sessionId, { ...current, runs });
      });
    },
    [sessionId, authenticated],
  );
  const setEvents = useCallback(
    (action: SetStateAction<Transcript["events"]>) => {
      if (!sessionId || !authenticated) return;
      setCache((previous) => {
        if (
          !owner.current.authenticated ||
          owner.current.sessionId !== sessionId
        )
          return previous;
        const current = previous.get(sessionId) || empty;
        const events =
          typeof action === "function" ? action(current.events) : action;
        if (events === current.events) return previous;
        return new Map(previous).set(sessionId, { ...current, events });
      });
    },
    [sessionId, authenticated],
  );
  return {
    ...(authenticated && sessionId ? cache.get(sessionId) || empty : empty),
    setRuns,
    setEvents,
  };
}

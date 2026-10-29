import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

const MIN = 340;
const MAX = 640;
const DEFAULT = 400;
const STORAGE_KEY = "pilot-panel-width";
const clamp = (width: number) => Math.max(MIN, Math.min(MAX, width));

/** Pointer capture keeps drag events local, including cancellation and unmount. */
export function usePanelWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      return Number.isFinite(saved) && saved > 0 ? clamp(saved) : DEFAULT;
    } catch {
      return DEFAULT;
    }
  });
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(width));
    } catch {
      // Storage can be disabled; resizing still works for this session.
    }
  }, [width]);
  const finish = () => {
    drag.current = null;
  };
  return {
    width,
    separatorProps: {
      "aria-valuemin": MIN,
      "aria-valuemax": MAX,
      "aria-valuenow": width,
      "aria-valuetext": `${width} 像素`,
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, width };
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        const start = drag.current;
        if (start?.id === event.pointerId)
          setWidth(clamp(start.width + start.x - event.clientX));
      },
      onPointerUp(event: PointerEvent<HTMLDivElement>) {
        finish();
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      },
      onPointerCancel: finish,
      onLostPointerCapture: finish,
      onDoubleClick: () => setWidth(DEFAULT),
      onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        if (event.key === "Home") setWidth(MIN);
        else if (event.key === "End") setWidth(MAX);
        else
          setWidth((value) =>
            clamp(value + (event.key === "ArrowLeft" ? 20 : -20)),
          );
      },
    },
  };
}

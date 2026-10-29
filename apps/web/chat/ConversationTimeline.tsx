import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowDown } from "lucide-react";

export function ConversationTimeline({
  sessionId,
  version,
  children,
}: {
  sessionId?: string;
  version: string | number;
  children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const follow = useRef(true),
    userScroll = useRef(false),
    direction = useRef<"up" | "down" | undefined>(undefined),
    lastTop = useRef(0);
  const [away, setAway] = useState(false);
  const goBottom = () => {
    const node = viewport.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
      lastTop.current = node.scrollTop;
    }
  };
  useLayoutEffect(() => {
    follow.current = true;
    direction.current = undefined;
    setAway(false);
    goBottom();
  }, [sessionId]);
  useLayoutEffect(() => {
    if (follow.current) goBottom();
  }, [version]);
  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const scroller = viewport.current;
      if (scroller && scroller.scrollHeight <= scroller.clientHeight + 1) {
        follow.current = true;
        userScroll.current = false;
        setAway(false);
      }
      if (follow.current) goBottom();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="chat-transcript-wrap">
      <div
        ref={viewport}
        className="chat-timeline"
        tabIndex={0}
        aria-label="对话消息"
        onWheel={(e) => {
          userScroll.current = true;
          if (e.deltaY < 0) {
            direction.current = "up";
            follow.current = false;
            setAway(true);
          } else if (e.deltaY > 0) {
            direction.current = "down";
            const node = viewport.current;
            if (
              node &&
              node.scrollHeight - node.clientHeight - node.scrollTop < 24
            ) {
              follow.current = true;
              setAway(false);
            }
          }
        }}
        onTouchStart={() => {
          userScroll.current = true;
          direction.current = undefined;
        }}
        onTouchMove={() => {
          userScroll.current = true;
          direction.current = undefined;
        }}
        onPointerDown={() => {
          userScroll.current = true;
          direction.current = undefined;
        }}
        onPointerMove={(e) => {
          if (e.buttons) {
            userScroll.current = true;
            direction.current = undefined;
          }
        }}
        onKeyDown={(e) => {
          if (["PageUp", "Home", "ArrowUp"].includes(e.key)) {
            userScroll.current = true;
            direction.current = "up";
            follow.current = false;
            setAway(true);
          } else if (["PageDown", "End", "ArrowDown"].includes(e.key)) {
            userScroll.current = true;
            direction.current = "down";
          }
        }}
        onScroll={() => {
          const node = viewport.current;
          if (!node) return;
          if (node.scrollHeight <= node.clientHeight + 1) {
            follow.current = true;
            userScroll.current = false;
            lastTop.current = node.scrollTop;
            setAway(false);
            return;
          }
          const bottom =
            node.scrollHeight - node.clientHeight - node.scrollTop < 24;
          const moved = node.scrollTop - lastTop.current;
          if (userScroll.current && moved < 0) follow.current = false;
          if (userScroll.current && !direction.current && moved !== 0)
            direction.current = moved > 0 ? "down" : "up";
          // A queued programmatic scroll can arrive after an upward wheel but
          // before its movement. Being at the old bottom is not new user intent.
          if (bottom && direction.current === "down" && moved >= 0)
            follow.current = true;
          lastTop.current = node.scrollTop;
          userScroll.current = false;
          setAway(!follow.current);
        }}
      >
        <div ref={content}>{children}</div>
      </div>
      {away && (
        <button
          type="button"
          className="chat-jump"
          aria-label="回到最新消息"
          onClick={() => {
            follow.current = true;
            direction.current = undefined;
            setAway(false);
            goBottom();
          }}
        >
          <ArrowDown size={13} />
          回到最新消息
        </button>
      )}
    </div>
  );
}

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
            follow.current = false;
            setAway(true);
          }
        }}
        onTouchStart={() => {
          userScroll.current = true;
        }}
        onPointerDown={() => {
          userScroll.current = true;
        }}
        onKeyDown={(e) => {
          if (["PageUp", "Home", "ArrowUp"].includes(e.key)) {
            userScroll.current = true;
            follow.current = false;
            setAway(true);
          }
        }}
        onScroll={() => {
          const node = viewport.current;
          if (!node) return;
          const bottom =
            node.scrollHeight - node.clientHeight - node.scrollTop < 24;
          if (userScroll.current && node.scrollTop < lastTop.current)
            follow.current = false;
          if (
            bottom &&
            !(userScroll.current && node.scrollTop < lastTop.current)
          )
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

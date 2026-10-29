import { copyText } from "./clipboard";
import {
  memo,
  Children,
  isValidElement,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? textOf(child.props.children)
          : "",
    )
    .join("");
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const child = Children.toArray(children).find(isValidElement) as
    React.ReactElement<{ className?: string }> | undefined;
  const language = child?.props.className?.replace(/^language-/, "") || "代码";
  return (
    <div className="chat-code">
      <div className="chat-code-head">
        <span>{language}</span>
        <button
          type="button"
          aria-label="复制代码"
          onClick={() => {
            void copyText(textOf(children))
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => setCopied(false));
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          img: ({ src, alt }) =>
            typeof src === "string" && src.startsWith("/api/files/") ? (
              <img src={src} alt={alt || "附件图片"} loading="lazy" />
            ) : (
              <a href={src} target="_blank" rel="noopener noreferrer">
                {alt || "查看图片"}
              </a>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

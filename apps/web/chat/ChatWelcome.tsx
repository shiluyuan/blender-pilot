import { ChevronRight, Grid2X2, Image } from "lucide-react";
import { Mark } from "../components/Mark";

const suggestions = [
  "创建一个有柔和灯光的产品展示台",
  "检查当前场景的构图和材质",
  "把选中的对象改成磨砂金属",
];

export function ChatWelcome({
  onSuggestion,
  onTemplates,
}: {
  onSuggestion: (text: string) => void;
  onTemplates: () => void;
}) {
  return (
    <div className="chat-welcome">
      <div className="assistant-emblem">
        <Mark />
      </div>
      <h2>一起，把场景做好。</h2>
      <p>
        描述你想创建或调整的内容。
        <br />
        我会观察场景，执行修改，再截图检查。
      </p>
      <div className="suggestions">
        {suggestions.map((text, index) => (
          <button key={text} onClick={() => onSuggestion(text)}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <span className="suggestion-text">{text}</span>
            <ChevronRight size={14} />
          </button>
        ))}
      </div>
      <div className="welcome-tip">
        <Image size={16} />
        <span>添加参考图，让空间、人物与风格更明确。</span>
      </div>
      <button className="chat-template-entry" onClick={onTemplates}>
        <Grid2X2 size={14} />
        从模板与素材组合开始
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

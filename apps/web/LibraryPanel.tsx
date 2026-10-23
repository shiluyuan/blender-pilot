import { useEffect, useRef, useState } from "react";
import {
  Box,
  Search,
  Star,
  Save,
  FolderOpen,
  Download,
  MoreHorizontal,
  X,
  RefreshCw,
  MessageSquare,
  Users,
  Layers3,
  Palette,
  Package,
} from "lucide-react";
import { api, post, bytes, date } from "./api";
import type { LibraryAsset } from "../../packages/blender-bridge/library";
const categories = [
  ["all", "全部素材", Layers3],
  ["character", "人物", Users],
  ["prop", "物品", Package],
  ["scene", "场景", Box],
  ["material", "材质", Palette],
  ["other", "其他", FolderOpen],
] as const;
export function LibraryPanel({
  projectId,
  busy,
  onUse,
  notify,
}: {
  projectId?: string;
  busy: boolean;
  onUse: (asset: LibraryAsset) => void;
  notify: (text: string) => void;
}) {
  const [items, setItems] = useState<LibraryAsset[]>([]),
    [total, setTotal] = useState(0),
    [page, setPage] = useState(0),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState("all"),
    [favorite, setFavorite] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [editing, setEditing] = useState<LibraryAsset | "new">(),
    [working, setWorking] = useState(false),
    [preview, setPreview] = useState<LibraryAsset>();
  const request = useRef(0),
    dialog = useRef<HTMLDialogElement>(null),
    previewDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (editing) dialog.current?.showModal();
  }, [editing]);
  useEffect(() => {
    if (preview) previewDialog.current?.showModal();
  }, [preview]);
  useEffect(() => {
    const seq = ++request.current;
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void api(
        `/library?search=${encodeURIComponent(search)}&category=${category}&favorite=${favorite}&page=${page}`,
      )
        .then((r) => {
          if (seq === request.current) {
            setItems(r.items);
            setTotal(r.total);
          }
        })
        .catch((e) => {
          if (seq === request.current) setError(String(e));
        })
        .finally(() => {
          if (seq === request.current) setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      request.current++;
    };
  }, [search, category, favorite, page, revision, busy]);
  const run = async (fn: () => Promise<unknown>, message?: string) => {
    setWorking(true);
    try {
      await fn();
      if (message) notify(message);
      setRevision((x) => x + 1);
    } catch (e) {
      notify(String(e));
    } finally {
      setWorking(false);
    }
  };
  const current = editing && editing !== "new" ? editing : undefined;
  return (
    <div className="page-content library-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR REUSABLE WORLD</div>
          <h1>素材库</h1>
          <p>人物、道具与场景，做一次，在每个项目里继续创作。</p>
        </div>
        <button
          className="primary"
          disabled={!projectId || busy || working}
          onClick={() => setEditing("new")}
        >
          <Save size={15} />从 Blender 保存
        </button>
      </div>
      <div className="library-intro">
        <Layers3 size={20} />
        <div>
          <strong>跨项目共享 · 独立副本导入</strong>
          <p>
            在 Blender 中选好对象，保存到这里。导入后自由修改，原素材仍然保留。
          </p>
        </div>
        <span>CREATE · COLLECT · REUSE</span>
      </div>
      <div className="library-layout">
        <aside className="library-categories" aria-label="素材分类">
          {categories.map(([id, label, Icon]) => (
            <button
              key={id}
              className={category === id && !favorite ? "active" : ""}
              onClick={() => {
                setCategory(id);
                setFavorite(false);
                setPage(0);
              }}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
          <hr />
          <button
            className={favorite ? "active" : ""}
            onClick={() => {
              setFavorite(!favorite);
              setCategory("all");
              setPage(0);
            }}
          >
            <Star size={16} />
            我的收藏
          </button>
          <small>项目上传文件可在「资源库」中加入此库。</small>
        </aside>
        <section className="library-results" aria-label="素材列表">
          <div className="filterbar">
            <div className="search">
              <Search size={15} />
              <input
                aria-label="搜索素材"
                placeholder="搜索名称、标签、描述"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
              />
            </div>
            <span className="count">{total} 项</span>
            <button
              className="icon"
              aria-label="刷新素材库"
              onClick={() => setRevision((x) => x + 1)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          {error ? (
            <div role="alert" className="library-empty">
              {error}
              <button onClick={() => setRevision((x) => x + 1)}>重试</button>
            </div>
          ) : loading ? (
            <div className="library-empty" role="status">
              正在读取素材…
            </div>
          ) : (
            <>
              <div className="asset-collection grid">
                {items.map((a) => (
                  <article className="asset-card library-card" key={a.id}>
                    <button
                      className="asset-preview"
                      aria-label={`预览 ${a.name}`}
                      disabled={!a.previewPath}
                      onClick={() => setPreview(a)}
                    >
                      {a.previewPath ? (
                        <img
                          src={`/api/library/${a.id}/file?preview=true`}
                          alt={a.name}
                        />
                      ) : (
                        <Box size={42} strokeWidth={1} />
                      )}
                      <span className="file-ext">
                        {categories.find((c) => c[0] === a.category)?.[1]}
                      </span>
                    </button>
                    <div className="asset-info">
                      <strong title={a.name}>{a.name}</strong>
                      <p className="library-description">
                        {a.description ||
                          (a.source === "blender"
                            ? `${a.objectNames.length} 个对象 · Blender 集合`
                            : "上传素材")}
                      </p>
                      <small>
                        {bytes(a.size)}
                        <span>·</span>
                        {date(a.createdAt)}
                      </small>
                      <div className="tags">
                        {a.tags.slice(0, 4).map((t) => (
                          <span key={t}>{t}</span>
                        ))}
                      </div>
                    </div>
                    <div className="asset-actions">
                      <button
                        disabled={!projectId || busy || working}
                        onClick={() =>
                          void run(
                            () =>
                              post(`/library/${a.id}/import`, { projectId }),
                            "已作为独立副本导入当前项目",
                          )
                        }
                      >
                        <Box size={13} />
                        导入
                      </button>
                      <button disabled={!projectId} onClick={() => onUse(a)}>
                        <MessageSquare size={13} />
                        对话引用
                      </button>
                      <button
                        className="icon"
                        aria-label={`${a.favorite ? "取消收藏" : "收藏"} ${a.name}`}
                        aria-pressed={a.favorite}
                        disabled={working}
                        onClick={() =>
                          void run(() =>
                            api(`/library/${a.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ favorite: !a.favorite }),
                            }),
                          )
                        }
                      >
                        <Star
                          size={14}
                          fill={a.favorite ? "currentColor" : "none"}
                        />
                      </button>
                      <button
                        className="icon"
                        aria-label={`编辑 ${a.name}`}
                        onClick={() => setEditing(a)}
                      >
                        <MoreHorizontal size={16} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {!items.length && (
                <div className="library-empty">
                  <Layers3 size={38} strokeWidth={1} />
                  <h2>
                    {search || favorite
                      ? "没有匹配的素材"
                      : "把创作留下来，下次直接用"}
                  </h2>
                  <p>
                    选中人物、物品或一组对象，点击「从 Blender 保存」。
                    <br />
                    也可以说：“把选中的椅子保存到物品素材库，标签是木质、客厅。”
                  </p>
                </div>
              )}
              <div className="pagination">
                <button
                  disabled={page === 0}
                  onClick={() => setPage((x) => x - 1)}
                >
                  上一页
                </button>
                <span>
                  {page + 1} / {Math.max(1, Math.ceil(total / 60))}
                </span>
                <button
                  disabled={(page + 1) * 60 >= total}
                  onClick={() => setPage((x) => x + 1)}
                >
                  下一页
                </button>
              </div>
            </>
          )}
        </section>
      </div>
      {editing && (
        <dialog
          ref={dialog}
          className="modal"
          onCancel={(e) => {
            e.preventDefault();
            if (!working) setEditing(undefined);
          }}
        >
          <div className="modal-head">
            <h2>{current ? "编辑素材" : "保存为可复用素材"}</h2>
            <button
              className="icon"
              aria-label="关闭"
              disabled={working}
              onClick={() => setEditing(undefined)}
            >
              <X size={18} />
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void run(
                async () => {
                  const input = {
                    name: form.get("name"),
                    category: form.get("category"),
                    description: form.get("description"),
                    tags: String(form.get("tags"))
                      .split(/[,，]/)
                      .map((x) => x.trim())
                      .filter(Boolean),
                  };
                  if (current)
                    await api(`/library/${current.id}`, {
                      method: "PATCH",
                      body: JSON.stringify(input),
                    });
                  else
                    await post(`/projects/${projectId}/library`, {
                      ...input,
                      scope: form.get("scope"),
                    });
                  setEditing(undefined);
                },
                current ? "素材信息已更新" : "素材已保存，所有项目均可复用",
              );
            }}
          >
            <label htmlFor="library-name">
              素材名称
              <input
                id="library-name"
                aria-label="素材名称"
                name="name"
                required
                maxLength={200}
                defaultValue={current?.name}
                placeholder="例如：木质餐椅"
              />
            </label>
            <label htmlFor="library-category">
              分类
              <select
                id="library-category"
                aria-label="分类"
                name="category"
                defaultValue={current?.category || "prop"}
              >
                {categories.slice(1).map(([id, label]) => (
                  <option value={id} key={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {!current && (
              <label htmlFor="library-scope">
                保存范围
                <select id="library-scope" aria-label="保存范围" name="scope">
                  <option value="selection">
                    当前选中对象（包含层级与常见依赖）
                  </option>
                  <option value="scene">当前场景全部对象</option>
                </select>
              </label>
            )}
            <label htmlFor="library-tags">
              标签（逗号分隔）
              <input
                id="library-tags"
                aria-label="标签（逗号分隔）"
                name="tags"
                defaultValue={current?.tags.join(", ")}
                placeholder="木质，客厅，低多边形"
              />
            </label>
            <label htmlFor="library-description">
              描述
              <textarea
                id="library-description"
                aria-label="描述"
                name="description"
                maxLength={2000}
                defaultValue={current?.description}
                placeholder="风格、用途、尺寸说明…"
                rows={3}
              />
            </label>
            <p className="muted">
              保存对象、材质与可打包贴图，预览采用保存时的视图。场景类别保存对象集合，不包含世界与渲染设置；材质类别用于保存带材质的样例对象。
            </p>
            <div className="modal-actions">
              {current && (
                <a className="button" href={`/api/library/${current.id}/file`}>
                  <Download size={14} />
                  下载文件
                </a>
              )}
              <button
                className="primary"
                disabled={working || (!current && busy)}
              >
                {working ? "正在保存…" : "保存素材"}
              </button>
            </div>
          </form>
        </dialog>
      )}
      {preview && (
        <dialog
          ref={previewDialog}
          className="modal wide"
          onCancel={() => setPreview(undefined)}
        >
          <div className="modal-head">
            <h2>{preview.name}</h2>
            <button
              className="icon"
              aria-label="关闭预览"
              onClick={() => setPreview(undefined)}
            >
              <X size={18} />
            </button>
          </div>
          <img
            className="lightbox-image"
            src={`/api/library/${preview.id}/file?preview=true`}
            alt={preview.name}
          />
          <p className="muted">
            {preview.source === "blender"
              ? "保存时的 Blender 视图"
              : "上传文件预览"}{" "}
            · {preview.description}
          </p>
        </dialog>
      )}
    </div>
  );
}

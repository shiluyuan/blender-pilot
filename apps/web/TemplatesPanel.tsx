import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  ArrowRight,
  BookOpen,
  Box,
  Check,
  Copy,
  Layers3,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import {
  TEMPLATE_CATEGORIES,
  renderTemplate,
  templateVariableError,
  templateInputSchema,
  type CreationTemplate,
  type TemplateInput,
} from "../../packages/contracts/templates";
import type { LibraryAsset } from "../../packages/contracts/library";
import { api, ApiError } from "./api";
import "./templates.css";

const labels: Record<string, string> = {
  all: "全部分类",
  prop: "道具",
  character: "角色",
  scene: "场景",
  material: "材质",
  composition: "素材组合",
};
type TemplateDetail = {
  template: CreationTemplate;
  libraryAssets: LibraryAsset[];
  missingLibraryAssetIds: string[];
};
type Editor = {
  id?: string;
  version?: number;
  key: string;
  input: TemplateInput;
};
type UseDraft = { values: Record<string, string>; libraryAssetIds: string[] };
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const draftKey = (template: CreationTemplate) =>
  `pilot-template-use:${template.id}:v${template.version}`;
const defaults = (template: CreationTemplate) =>
  Object.fromEntries(template.variables.map((v) => [v.key, v.defaultValue]));
const blankTemplate = (): TemplateInput => ({
  name: "",
  description: "",
  category: "prop",
  prompt: "",
  variables: [],
  libraryAssetIds: [],
});

function readUseDraft(template: CreationTemplate): UseDraft {
  const initial = {
    values: defaults(template),
    libraryAssetIds: template.libraryAssetIds,
  };
  try {
    const saved = JSON.parse(
      localStorage.getItem(draftKey(template)) || "null",
    );
    if (!saved || typeof saved !== "object") return initial;
    const values = { ...initial.values };
    for (const variable of template.variables)
      if (typeof saved.values?.[variable.key] === "string")
        values[variable.key] = saved.values[variable.key].slice(0, 2000);
    const ids = saved.libraryAssetIds;
    return {
      values,
      libraryAssetIds:
        Array.isArray(ids) &&
        ids.length <= 12 &&
        ids.every((id: unknown) => typeof id === "string")
          ? [...new Set<string>(ids)]
          : initial.libraryAssetIds,
    };
  } catch {
    return initial;
  }
}

function readEditorDraft(editor: Editor): Editor {
  try {
    const saved = JSON.parse(localStorage.getItem(editor.key) || "null");
    // Incomplete names/body are valid drafts, although they cannot be saved yet.
    const input = saved?.input;
    if (
      saved?.schema === 1 &&
      typeof input?.name === "string" &&
      typeof input?.description === "string" &&
      typeof input?.prompt === "string" &&
      TEMPLATE_CATEGORIES.includes(input.category) &&
      Array.isArray(input.variables) &&
      input.variables.length <= 12 &&
      input.variables.every(
        (v: any) =>
          typeof v?.key === "string" &&
          typeof v?.label === "string" &&
          typeof v?.defaultValue === "string" &&
          (v.type === undefined || v.type === "text" || v.type === "number") &&
          (v.unit === undefined || typeof v.unit === "string") &&
          [v.min, v.max, v.step].every(
            (n) =>
              n === undefined || (typeof n === "number" && Number.isFinite(n)),
          ),
      ) &&
      Array.isArray(input.libraryAssetIds) &&
      input.libraryAssetIds.length <= 12 &&
      input.libraryAssetIds.every((id: unknown) => typeof id === "string")
    )
      return { ...editor, input };
  } catch {}
  return editor;
}

function AssetPicker({
  ids,
  assets,
  onChange,
  onAssets,
  disabled,
}: {
  ids: string[];
  assets: Record<string, LibraryAsset>;
  onChange: (ids: string[]) => void;
  onAssets: (assets: LibraryAsset[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<LibraryAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void api<{ items: LibraryAsset[]; total: number }>(
        `/library?search=${encodeURIComponent(search)}&page=${page}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setItems(result.items);
          setTotal(result.total);
          onAssets(result.items);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(message(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // onAssets only updates the shared metadata cache and is deliberately stable.
  }, [open, search, page, revision, onAssets]);
  return (
    <div className="template-asset-picker">
      <div className="template-section-heading">
        <span>
          引用共享素材 <small>{ids.length}/12</small>
        </span>
        <button
          type="button"
          className="text-button"
          disabled={disabled}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Plus size={13} />
          {open ? "收起素材选择" : "选择素材"}
        </button>
      </div>
      {ids.length ? (
        <div className="template-ref-list">
          {ids.map((id) => (
            <span className="template-ref" key={id}>
              <Box size={13} />
              <span title={id}>
                {assets[id]?.name || `待校验素材 ${id.slice(0, 8)}`}
              </span>
              <button
                type="button"
                className="icon"
                disabled={disabled}
                aria-label={`移除模板素材：${assets[id]?.name || id}`}
                onClick={() => onChange(ids.filter((value) => value !== id))}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="template-help">
          可选择人物、物品或场景部件；使用时一并带入对话引用。
        </p>
      )}
      {open && (
        <div className="template-asset-browser">
          <div className="search">
            <Search size={14} />
            <input
              aria-label="搜索模板素材"
              placeholder="搜索共享素材"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
          </div>
          {error ? (
            <div className="template-inline-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => setRevision((r) => r + 1)}>
                重试素材查询
              </button>
            </div>
          ) : loading ? (
            <p className="template-help" role="status">
              正在加载素材…
            </p>
          ) : (
            <div className="template-asset-options">
              {items.map((asset) => (
                <label key={asset.id}>
                  <input
                    type="checkbox"
                    checked={ids.includes(asset.id)}
                    disabled={
                      disabled || (!ids.includes(asset.id) && ids.length >= 12)
                    }
                    onChange={(e) =>
                      onChange(
                        e.target.checked
                          ? [...ids, asset.id]
                          : ids.filter((id) => id !== asset.id),
                      )
                    }
                  />
                  <span>
                    {asset.name}
                    <small>{labels[asset.category] || "其他"}</small>
                  </span>
                  {ids.includes(asset.id) && <Check size={13} />}
                </label>
              ))}
              {!items.length && (
                <p className="template-help">
                  没有匹配素材。可先到素材库上传或保存作品。
                </p>
              )}
            </div>
          )}
          {total > 60 && (
            <div className="template-pagination">
              <button
                type="button"
                disabled={page === 0 || loading}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </button>
              <span>
                {page + 1} / {Math.ceil(total / 60)}
              </span>
              <button
                type="button"
                disabled={(page + 1) * 60 >= total || loading}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TemplatesPanel({
  projectId,
  sessionId,
  busy,
  blockedReason,
  onUse,
  notify,
}: {
  projectId?: string;
  sessionId?: string;
  busy: boolean;
  blockedReason?: string;
  onUse: (value: {
    prompt: string;
    libraryAssets: LibraryAsset[];
  }) => void | Promise<void>;
  notify: (text: string) => void;
}) {
  const [source, setSource] = useState("builtin");
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<CreationTemplate[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<TemplateDetail>();
  const [detailError, setDetailError] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [ids, setIds] = useState<string[]>([]);
  const [assetCache, setAssetCache] = useState<Record<string, LibraryAsset>>(
    {},
  );
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [editor, setEditor] = useState<Editor>();
  const [editorError, setEditorError] = useState("");
  const [saving, setSaving] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [deleting, setDeleting] = useState<CreationTemplate>();
  const [deleteError, setDeleteError] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const editorDialog = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const owner = useRef("");
  owner.current = `${projectId || ""}:${sessionId || ""}`;
  const detailId = useRef(selectedId);
  detailId.current = selectedId;
  const cacheAssets = useRef((assets: LibraryAsset[]) => {
    setAssetCache((cache) => ({
      ...cache,
      ...Object.fromEntries(assets.map((asset) => [asset.id, asset])),
    }));
  }).current;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (editor) editorDialog.current?.showModal();
  }, [!!editor]);
  useEffect(() => {
    if (deleting) deleteDialog.current?.showModal();
  }, [!!deleting]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void api<{ items: CreationTemplate[]; total: number }>(
        `/templates?source=${source}&category=${category}&search=${encodeURIComponent(search)}&page=${page}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setItems(result.items);
          setTotal(result.total);
          setSelectedId((current) =>
            result.items.some((item) => item.id === current)
              ? current
              : result.items[0]?.id,
          );
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(message(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [source, category, search, page, revision]);
  useEffect(() => {
    setDetail(undefined);
    setDetailError("");
    setApplyError("");
    if (!selectedId) return;
    const controller = new AbortController();
    void api<TemplateDetail>(`/templates/${encodeURIComponent(selectedId)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const draft = readUseDraft(result.template);
        cacheAssets(result.libraryAssets);
        setValues(draft.values);
        setIds(draft.libraryAssetIds);
        setDetail(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setDetailError(message(e));
      });
    return () => controller.abort();
  }, [selectedId, revision, cacheAssets]);
  useEffect(() => {
    if (!detail || detail.template.id !== selectedId) return;
    try {
      localStorage.setItem(
        draftKey(detail.template),
        JSON.stringify({ values, libraryAssetIds: ids }),
      );
    } catch {
      setStorageError(true);
    }
  }, [detail, selectedId, values, ids]);
  useEffect(() => {
    if (!editor) return;
    try {
      localStorage.setItem(
        editor.key,
        JSON.stringify({ schema: 1, input: editor.input }),
      );
    } catch {
      setStorageError(true);
    }
  }, [editor]);
  const current = detail?.template;
  const hasMissingReferences = !!detail?.missingLibraryAssetIds.some((id) =>
    ids.includes(id),
  );
  let prompt = "",
    promptError = "";
  if (current) {
    try {
      prompt = renderTemplate(current, values);
    } catch (e) {
      promptError = message(e);
    }
  }
  const openEditor = (template?: CreationTemplate, copy = false) => {
    const input = template
      ? {
          name: template.name + (copy ? " · 副本" : ""),
          description: template.description,
          category: template.category,
          prompt: template.prompt,
          variables: template.variables.map((v) => ({
            ...v,
            defaultValue: copy
              ? (values[v.key] ?? v.defaultValue)
              : v.defaultValue,
          })),
          libraryAssetIds: copy ? [...ids] : [...template.libraryAssetIds],
        }
      : blankTemplate();
    const editOriginal = template?.source === "custom" && !copy;
    const key = `pilot-template-editor:${editOriginal ? template.id : template ? "copy:" + template.id : "new"}:v${template?.version || 1}`;
    setEditorError("");
    setEditor(
      readEditorDraft({
        id: editOriginal ? template.id : undefined,
        version: editOriginal ? template.version : undefined,
        key,
        input,
      }),
    );
  };
  const changeEditor = (patch: Partial<TemplateInput>) => {
    setEditor(
      (current) =>
        current && { ...current, input: { ...current.input, ...patch } },
    );
    setEditorError("");
  };
  const saveEditor = async (asNew = false) => {
    if (!editor || saving) return;
    const captured = editor;
    const parsed = templateInputSchema.safeParse(captured.input);
    if (!parsed.success) {
      setEditorError(
        parsed.error.issues.map((issue) => issue.message).join("；"),
      );
      return;
    }
    setSaving(true);
    setEditorError("");
    try {
      const saved = await api<CreationTemplate>(
        captured.id && !asNew ? `/templates/${captured.id}` : "/templates",
        {
          method: captured.id && !asNew ? "PATCH" : "POST",
          body: JSON.stringify({
            ...parsed.data,
            ...(captured.id && !asNew
              ? { expectedVersion: captured.version }
              : {}),
          }),
        },
      );
      if (!mounted.current) return;
      try {
        localStorage.removeItem(captured.key);
      } catch {}
      setEditor(undefined);
      setSource("custom");
      setSearch("");
      setCategory("all");
      setPage(0);
      setSelectedId(saved.id);
      setRevision((r) => r + 1);
      notify("模板已保存，可在其他项目继续复用");
    } catch (e) {
      if (mounted.current)
        setEditorError(
          e instanceof ApiError && e.status === 409
            ? "模板已被其他页面更新。你的编辑草稿已保留，可关闭后刷新读取最新版，或另存为新模板。"
            : message(e),
        );
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const apply = async () => {
    if (!current || applying || busy || !projectId || !sessionId) return;
    if (hasMissingReferences) {
      setApplyError("引用素材已不存在，请移除对应引用或重新选择后使用模板。");
      return;
    }
    const capturedOwner = owner.current;
    const capturedId = current.id;
    const capturedPrompt = prompt;
    const capturedIds = [...ids];
    if (promptError) {
      setApplyError(promptError);
      return;
    }
    setApplying(true);
    setApplyError("");
    try {
      const assets = await Promise.all(
        capturedIds.map(async (id) => {
          try {
            return await api<LibraryAsset>(
              `/library/${encodeURIComponent(id)}`,
            );
          } catch (e) {
            throw new Error(
              e instanceof ApiError && e.status === 404
                ? `引用素材「${assetCache[id]?.name || id.slice(0, 8)}」已不存在，请移除或重新选择后使用模板。`
                : `无法确认引用素材：${message(e)}`,
            );
          }
        }),
      );
      if (!mounted.current) return;
      if (owner.current !== capturedOwner || detailId.current !== capturedId) {
        setApplyError(
          "项目、对话或模板已切换，本次未写入对话。请在当前项目重新使用模板。",
        );
        return;
      }
      await onUse({ prompt: capturedPrompt, libraryAssets: assets });
    } catch (e) {
      if (mounted.current) setApplyError(message(e));
    } finally {
      if (mounted.current) setApplying(false);
    }
  };
  return (
    <div className="page-content templates-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">CREATION RECIPES</div>
          <h1>模板中心</h1>
          <p>把创作要求、参数和素材引用保存成配方，在不同项目中复用。</p>
        </div>
        <button className="primary" onClick={() => openEditor()}>
          <Plus size={15} />
          新建模板
        </button>
      </div>
      <div className="template-context">
        <BookOpen size={15} />
        <span>填写参数 → 组合素材 → 带入对话</span>
        <small>发送后由助手执行，结果可保存回素材库</small>
      </div>
      {storageError && (
        <p className="template-inline-error" role="alert">
          浏览器暂时无法保存本地草稿，请保持当前页面，或先保存模板。
        </p>
      )}
      <div className="template-toolbar">
        <div className="template-tabs" role="tablist" aria-label="模板来源">
          {[
            ["builtin", "内置模板"],
            ["custom", "我的模板"],
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={source === id}
              onClick={() => {
                setSource(id);
                setPage(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="search">
          <Search size={15} />
          <input
            aria-label="搜索创作模板"
            placeholder="搜索模板名称、描述"
            maxLength={200}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </div>
        <select
          aria-label="筛选模板分类"
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setPage(0);
          }}
        >
          {["all", ...TEMPLATE_CATEGORIES].map((id) => (
            <option key={id} value={id}>
              {labels[id]}
            </option>
          ))}
        </select>
        <button
          className="icon"
          aria-label="刷新模板列表"
          onClick={() => setRevision((r) => r + 1)}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <div className="template-workspace">
        <section
          className="template-list"
          aria-label="创作模板列表"
          aria-busy={loading}
        >
          <div className="template-list-heading">
            <span>{source === "builtin" ? "创作起点" : "可复用配方"}</span>
            <small>{total} 个模板</small>
          </div>
          {error ? (
            <div className="template-empty" role="alert">
              <p>{error}</p>
              <button onClick={() => setRevision((r) => r + 1)}>
                重试模板查询
              </button>
            </div>
          ) : loading ? (
            <div className="template-empty" role="status">
              <LoaderCircle size={20} className="spin" />
              正在加载模板…
            </div>
          ) : items.length ? (
            items.map((template) => (
              <button
                className={
                  "template-card " +
                  (selectedId === template.id ? "selected" : "")
                }
                key={template.id}
                aria-label={`打开模板：${template.name}`}
                aria-pressed={selectedId === template.id}
                onClick={() => setSelectedId(template.id)}
              >
                <div className="template-card-top">
                  <span className="template-category-icon">
                    {template.category === "composition" ? (
                      <Layers3 size={18} />
                    ) : (
                      <Box size={18} />
                    )}
                  </span>
                  <span className="badge">{labels[template.category]}</span>
                </div>
                <strong>{template.name}</strong>
                <p>{template.description || "自定义创作配方"}</p>
                <div className="template-card-footer">
                  <span>
                    {template.variables.length} 个参数 ·{" "}
                    {template.libraryAssetIds.length} 项素材
                  </span>
                  <ArrowRight size={14} />
                </div>
              </button>
            ))
          ) : (
            <div className="template-empty">
              <BookOpen size={25} />
              <h3>{search ? "没有匹配模板" : "还没有自己的模板"}</h3>
              <p>
                {search
                  ? "试试其他关键词或分类。"
                  : "保存常用创作要求和素材组合，下次直接开始。"}
              </p>
              {!search && (
                <button onClick={() => openEditor()}>创建第一个模板</button>
              )}
            </div>
          )}
          {total > 60 && (
            <div className="template-pagination">
              <button
                disabled={!page || loading}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </button>
              <span>
                {page + 1} / {Math.ceil(total / 60)}
              </span>
              <button
                disabled={(page + 1) * 60 >= total || loading}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </section>
        <section
          className="template-detail"
          aria-label="模板详情"
          aria-busy={!!selectedId && !detail && !detailError}
        >
          {detailError ? (
            <div className="template-empty" role="alert">
              <p>{detailError}</p>
              <button onClick={() => setRevision((r) => r + 1)}>
                重试模板详情
              </button>
            </div>
          ) : current ? (
            <>
              <div className="template-detail-heading">
                <div>
                  <span className="eyebrow">
                    {current.source === "builtin"
                      ? "BUILT-IN RECIPE"
                      : `MY RECIPE · V${current.version}`}
                  </span>
                  <h2>{current.name}</h2>
                  <p>{current.description}</p>
                </div>
                <div className="template-detail-actions">
                  {current.source === "custom" ? (
                    <>
                      <button
                        title="编辑模板"
                        aria-label="编辑模板"
                        onClick={() => openEditor(current)}
                      >
                        <Pencil size={14} />
                        编辑
                      </button>
                      <button
                        className="icon"
                        aria-label="删除模板"
                        onClick={() => {
                          setDeleteError("");
                          setDeleting(current);
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </>
                  ) : (
                    <button onClick={() => openEditor(current, true)}>
                      <Copy size={14} />
                      另存为我的模板
                    </button>
                  )}
                </div>
              </div>
              <div className="template-detail-body">
                <div className="template-section-heading">
                  <span>
                    <SlidersHorizontal size={14} />
                    创作参数
                  </span>
                  <button
                    className="text-button"
                    disabled={applying}
                    onClick={() => {
                      setValues(defaults(current));
                      setIds(current.libraryAssetIds);
                      setApplyError("");
                    }}
                  >
                    重置参数与素材
                  </button>
                </div>
                {current.variables.length ? (
                  <div className="template-parameters">
                    {current.variables.map((variable) => {
                      const value =
                        values[variable.key] ?? variable.defaultValue;
                      const error = templateVariableError(variable, value);
                      const onChange = (
                        e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
                      ) => {
                        setValues((v) => ({
                          ...v,
                          [variable.key]: e.target.value,
                        }));
                        setApplyError("");
                      };
                      return (
                        <label key={variable.key}>
                          <span>
                            {variable.label}
                            {variable.unit ? `（${variable.unit}）` : ""}
                          </span>
                          {variable.type === "number" ? (
                            <>
                              <input
                                type="number"
                                inputMode="decimal"
                                aria-label={variable.label}
                                min={variable.min}
                                max={variable.max}
                                step={variable.step ?? "any"}
                                value={value}
                                disabled={applying}
                                onChange={onChange}
                                aria-invalid={!!error}
                                aria-describedby={`template-hint-${variable.key}`}
                              />
                              <small
                                id={`template-hint-${variable.key}`}
                                className={
                                  error
                                    ? "template-parameter-error"
                                    : "template-parameter-hint"
                                }
                              >
                                {error ||
                                  `${variable.min !== undefined ? `最小 ${variable.min}` : "无下限"} · ${variable.max !== undefined ? `最大 ${variable.max}` : "无上限"}${variable.step !== undefined ? ` · 步长 ${variable.step}` : ""}`}
                              </small>
                            </>
                          ) : (
                            <textarea
                              aria-label={variable.label}
                              rows={2}
                              maxLength={2000}
                              value={value}
                              disabled={applying}
                              onChange={onChange}
                            />
                          )}
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="template-help">
                    这个模板直接使用下方任务说明，也可以编辑为带参数的模板。
                  </p>
                )}
                <AssetPicker
                  ids={ids}
                  assets={assetCache}
                  onChange={(next) => {
                    setIds(next);
                    setApplyError("");
                  }}
                  onAssets={cacheAssets}
                  disabled={applying}
                />
                {hasMissingReferences && (
                  <p className="template-inline-error" role="alert">
                    模板中有素材已不存在；请移除对应引用或重新选择。使用前会再次校验。
                  </p>
                )}
                <div className="template-prompt-heading">
                  <span>任务预览</span>
                  <small>{prompt.length} 字符</small>
                </div>
                {promptError ? (
                  <p className="template-inline-error" role="alert">
                    {promptError}
                  </p>
                ) : (
                  <pre className="template-prompt">{prompt}</pre>
                )}
                <p className="template-help">
                  这是创作配方，包含任务说明与引用；模型生成的几何、材质和细节仍需在
                  Blender 中检查。
                </p>
              </div>
              <div className="template-use-footer">
                {applyError && (
                  <p className="template-inline-error" role="alert">
                    {applyError}
                  </p>
                )}
                <div>
                  <span>
                    {!projectId || !sessionId
                      ? "先打开一个项目和对话，即可使用模板"
                      : busy
                        ? blockedReason || "当前项目忙碌，请等待任务完成"
                        : "追加到当前对话草稿，确认后发送"}
                  </span>
                  <button
                    className="primary"
                    disabled={
                      !projectId ||
                      !sessionId ||
                      busy ||
                      applying ||
                      hasMissingReferences ||
                      !!promptError
                    }
                    onClick={() => void apply()}
                  >
                    {applying ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <ArrowRight size={15} />
                    )}
                    {applying ? "正在校验素材…" : "使用模板"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="template-empty">
              {selectedId
                ? "正在读取模板…"
                : "选择一个模板，预览参数和素材组合"}
            </div>
          )}
        </section>
      </div>
      {editor && (
        <dialog
          ref={editorDialog}
          className="template-editor-dialog"
          aria-label={editor.id ? "编辑模板" : "新建模板"}
          onCancel={(e) => {
            if (saving) e.preventDefault();
            else setEditor(undefined);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveEditor();
            }}
          >
            <div className="template-dialog-heading">
              <div>
                <h2>{editor.id ? "编辑模板" : "新建模板"}</h2>
                <small>
                  参数与素材一起保存，供所有项目复用。未保存编辑会保留在此浏览器。
                </small>
              </div>
              <button
                type="button"
                className="icon"
                aria-label="关闭模板编辑"
                disabled={saving}
                onClick={() => setEditor(undefined)}
              >
                <X size={17} />
              </button>
            </div>
            <fieldset disabled={saving}>
              <div className="template-editor-basics">
                <label>
                  模板名称
                  <input
                    aria-label="模板名称"
                    value={editor.input.name}
                    maxLength={100}
                    onChange={(e) => changeEditor({ name: e.target.value })}
                    required
                    autoFocus
                  />
                </label>
                <label>
                  模板分类
                  <select
                    aria-label="模板分类"
                    value={editor.input.category}
                    onChange={(e) =>
                      changeEditor({
                        category: e.target.value as TemplateInput["category"],
                      })
                    }
                  >
                    {TEMPLATE_CATEGORIES.map((id) => (
                      <option value={id} key={id}>
                        {labels[id]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                模板描述
                <input
                  aria-label="模板描述"
                  value={editor.input.description}
                  maxLength={1000}
                  placeholder="什么时候使用这个模板"
                  onChange={(e) =>
                    changeEditor({ description: e.target.value })
                  }
                />
              </label>
              <label>
                任务说明
                <textarea
                  aria-label="任务说明"
                  rows={7}
                  maxLength={12000}
                  value={editor.input.prompt}
                  placeholder="写下创作要求；使用 {{subject}} 插入下方定义的参数。"
                  required
                  onChange={(e) => changeEditor({ prompt: e.target.value })}
                />
                <small>
                  参数使用 <code>{"{{key}}"}</code>{" "}
                  标记；名称以字母开头，正文与参数表须一一对应。
                </small>
              </label>
              <div className="template-section-heading">
                <span>
                  模板参数 <small>{editor.input.variables.length}/12</small>
                </span>
                <button
                  type="button"
                  className="text-button"
                  disabled={editor.input.variables.length >= 12}
                  onClick={() =>
                    changeEditor({
                      variables: [
                        ...editor.input.variables,
                        { key: "", label: "", defaultValue: "" },
                      ],
                    })
                  }
                >
                  <Plus size={13} />
                  添加参数
                </button>
              </div>
              <div className="template-editor-variables">
                {editor.input.variables.map((variable, index) => (
                  <div className="template-variable-card" key={index}>
                    <div className="template-variable-row">
                      <label>
                        变量名称
                        <input
                          aria-label={`变量名称 ${index + 1}`}
                          maxLength={80}
                          value={variable.label}
                          placeholder="例如：道具名称"
                          onChange={(e) =>
                            changeEditor({
                              variables: editor.input.variables.map((v, i) =>
                                i === index
                                  ? { ...v, label: e.target.value }
                                  : v,
                              ),
                            })
                          }
                        />
                      </label>
                      <label>
                        变量标识
                        <input
                          aria-label={`变量标识 ${index + 1}`}
                          maxLength={40}
                          value={variable.key}
                          placeholder="subject"
                          onChange={(e) =>
                            changeEditor({
                              variables: editor.input.variables.map((v, i) =>
                                i === index ? { ...v, key: e.target.value } : v,
                              ),
                            })
                          }
                        />
                      </label>
                      <label>
                        默认值
                        <input
                          aria-label={`默认值 ${index + 1}`}
                          type={variable.type === "number" ? "number" : "text"}
                          min={
                            variable.type === "number"
                              ? variable.min
                              : undefined
                          }
                          max={
                            variable.type === "number"
                              ? variable.max
                              : undefined
                          }
                          step={
                            variable.type === "number"
                              ? (variable.step ?? "any")
                              : undefined
                          }
                          maxLength={2000}
                          value={variable.defaultValue}
                          onChange={(e) =>
                            changeEditor({
                              variables: editor.input.variables.map((v, i) =>
                                i === index
                                  ? { ...v, defaultValue: e.target.value }
                                  : v,
                              ),
                            })
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="icon"
                        aria-label={`移除参数 ${index + 1}`}
                        onClick={() =>
                          changeEditor({
                            variables: editor.input.variables.filter(
                              (_, i) => i !== index,
                            ),
                          })
                        }
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <div className="template-variable-options">
                      <label>
                        参数类型
                        <select
                          aria-label={`参数类型 ${index + 1}`}
                          value={variable.type ?? "text"}
                          onChange={(e) =>
                            changeEditor({
                              variables: editor.input.variables.map((v, i) => {
                                if (i !== index) return v;
                                if (e.target.value === "number")
                                  return { ...v, type: "number" as const };
                                const {
                                  min: _min,
                                  max: _max,
                                  step: _step,
                                  unit: _unit,
                                  ...text
                                } = v;
                                return { ...text, type: "text" as const };
                              }),
                            })
                          }
                        >
                          <option value="text">文本</option>
                          <option value="number">数值</option>
                        </select>
                      </label>
                      {variable.type === "number" && (
                        <>
                          <label>
                            单位
                            <input
                              aria-label={`参数单位 ${index + 1}`}
                              maxLength={16}
                              value={variable.unit ?? ""}
                              placeholder="米 / 层"
                              onChange={(e) =>
                                changeEditor({
                                  variables: editor.input.variables.map(
                                    (v, i) =>
                                      i === index
                                        ? { ...v, unit: e.target.value }
                                        : v,
                                  ),
                                })
                              }
                            />
                          </label>
                          {(
                            [
                              ["min", "最小值"],
                              ["max", "最大值"],
                              ["step", "步长"],
                            ] as const
                          ).map(([field, label]) => (
                            <label key={field}>
                              {label}
                              <input
                                aria-label={`${label} ${index + 1}`}
                                type="number"
                                step="any"
                                min={field === "step" ? 0.000001 : -1e9}
                                max={1e9}
                                value={variable[field] ?? ""}
                                placeholder="可选"
                                onChange={(e) =>
                                  changeEditor({
                                    variables: editor.input.variables.map(
                                      (v, i) =>
                                        i === index
                                          ? {
                                              ...v,
                                              [field]:
                                                e.target.value === ""
                                                  ? undefined
                                                  : Number(e.target.value),
                                            }
                                          : v,
                                    ),
                                  })
                                }
                              />
                            </label>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <AssetPicker
                ids={editor.input.libraryAssetIds}
                assets={assetCache}
                onChange={(libraryAssetIds) =>
                  changeEditor({ libraryAssetIds })
                }
                onAssets={cacheAssets}
                disabled={saving}
              />
            </fieldset>
            {editorError && (
              <p className="template-inline-error" role="alert">
                {editorError}
              </p>
            )}
            <div className="template-dialog-footer">
              <small>
                {editor.id
                  ? `正在编辑 v${editor.version} · 保存时校验版本`
                  : "保存后出现在「我的模板」"}
              </small>
              <div>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setEditor(undefined)}
                >
                  暂存并关闭
                </button>
                {editor.id && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveEditor(true)}
                  >
                    另存为新模板
                  </button>
                )}
                <button className="primary" disabled={saving}>
                  {saving ? "正在保存…" : "保存模板"}
                </button>
              </div>
            </div>
          </form>
        </dialog>
      )}
      {deleting && (
        <dialog
          ref={deleteDialog}
          className="template-delete-dialog"
          aria-label="删除创作模板"
          onCancel={(e) => {
            if (deleteBusy) e.preventDefault();
            else setDeleting(undefined);
          }}
        >
          <h2>删除模板「{deleting.name}」？</h2>
          <p>
            模板将从所有项目的模板中心移除。素材库文件、已有对话和 Blender
            场景会保留。
          </p>
          {deleteError && (
            <p className="template-inline-error" role="alert">
              {deleteError}
            </p>
          )}
          <div className="template-dialog-footer">
            <button
              disabled={deleteBusy}
              onClick={() => setDeleting(undefined)}
            >
              取消
            </button>
            <button
              className="danger"
              disabled={deleteBusy}
              onClick={() => {
                const captured = deleting;
                setDeleteBusy(true);
                void api(`/templates/${captured.id}`, {
                  method: "DELETE",
                  body: JSON.stringify({ expectedVersion: captured.version }),
                })
                  .then(() => {
                    if (!mounted.current) return;
                    setDeleting(undefined);
                    setRevision((r) => r + 1);
                    notify("模板已删除，引用的素材仍保留在素材库");
                  })
                  .catch((e) => {
                    if (mounted.current) setDeleteError(message(e));
                  })
                  .finally(() => {
                    if (mounted.current) setDeleteBusy(false);
                  });
              }}
            >
              {deleteBusy ? "正在删除…" : "确认删除模板"}
            </button>
          </div>
        </dialog>
      )}
    </div>
  );
}

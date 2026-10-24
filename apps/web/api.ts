export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    credentials: "same-origin",
    signal: options.signal || AbortSignal.timeout(180000),
  });
  const body = await response.text();
  let data: any;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    throw new Error("服务返回了无效响应");
  }
  if (!response.ok)
    throw new ApiError(
      data.error || `HTTP ${response.status}`,
      response.status,
    );
  return data;
}
export const post = <T = any>(path: string, data: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(data) });
export const fileUrl = (kind: string, id: string, preview = false) =>
  `/api/files/${kind}/${id}${preview ? "?preview=1" : ""}`;
export function bytes(n: number) {
  if (!n) return "0 B";
  const unit = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
  return (
    (n / 1024 ** unit).toFixed(unit ? 1 : 0) +
    " " +
    ["B", "KB", "MB", "GB"][unit]
  );
}
export const date = (s: string) =>
  new Date(s).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
export async function upload(
  file: File,
  projectId: string | undefined,
  progress: (n: number) => void,
  library?: {
    category: string;
    sourceUrl?: string;
    license?: string;
    author?: string;
  },
  options: { signal?: AbortSignal; scope?: string } = {},
) {
  const key = `pilot-upload:${library ? "library" : projectId}:${options.scope || "project"}:${file.name}:${file.size}:${file.lastModified}`;
  const signal = () =>
    options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000);
  let id = localStorage.getItem(key);
  let offset = 0;
  if (id) {
    try {
      const state = await api(`/uploads/${id}`, { signal: signal() });
      if (state.assetId) {
        // Replaying completion returns the authoritative metadata too, including
        // document truncation information; an ID-only receipt loses that context.
        offset = file.size;
      } else {
        offset = state.offset;
      }
    } catch (e) {
      if (options.signal?.aborted) throw e;
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
      id = null;
    }
  }
  if (!id) {
    const state = await api("/uploads", {
      method: "POST",
      signal: signal(),
      body: JSON.stringify({
        projectId,
        destination: library ? "library" : "project",
        library: library ? { name: file.name, ...library } : undefined,
        name: file.name,
        size: file.size,
      }),
    });
    id = state.id;
    localStorage.setItem(key, id!);
  }
  while (offset < file.size) {
    const chunk = file.slice(offset, offset + 4 * 1024 * 1024);
    const response = await fetch(`/api/uploads/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/octet-stream",
        "Upload-Offset": String(offset),
      },
      body: chunk,
      signal: signal(),
    });
    const result = await response.json();
    if (!response.ok)
      throw new ApiError(result.error || "上传失败", response.status);
    if (
      !Number.isSafeInteger(result.offset) ||
      result.offset <= offset ||
      result.offset > file.size
    )
      throw new Error("上传服务返回了无效分片位置，请重试");
    offset = result.offset;
    progress(Math.round((offset / file.size) * 100));
  }
  const asset = await api(`/uploads/${id}/complete`, {
    method: "POST",
    body: "{}",
    signal: signal(),
  });
  localStorage.removeItem(key);
  return asset;
}

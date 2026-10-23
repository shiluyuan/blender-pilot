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
  });
  const body = await response.text();
  let data: any;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    throw new Error("服务返回了无效响应");
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
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
) {
  const key = `pilot-upload:${library ? "library" : projectId}:${file.name}:${file.size}:${file.lastModified}`;
  let id = localStorage.getItem(key);
  let offset = 0;
  if (id) {
    try {
      const state = await api(`/uploads/${id}`);
      if (state.assetId) {
        localStorage.removeItem(key);
        return { id: state.assetId, name: file.name };
      }
      offset = state.offset;
    } catch {
      id = null;
    }
  }
  if (!id) {
    const state = await post("/uploads", {
      projectId,
      destination: library ? "library" : "project",
      library: library ? { name: file.name, ...library } : undefined,
      name: file.name,
      size: file.size,
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
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "上传失败");
    offset = result.offset;
    progress(Math.round((offset / file.size) * 100));
  }
  const asset = await post(`/uploads/${id}/complete`);
  localStorage.removeItem(key);
  return asset;
}

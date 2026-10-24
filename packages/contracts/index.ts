import { z } from "zod";
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const modelSettingsSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .max(500)
    .refine((s) => /^https?:\/\//.test(s), "使用 HTTP 或 HTTPS 地址"),
  model: z.string().trim().min(1).max(160),
  apiKey: z.string().max(2000).optional(),
  clearKey: z.boolean().optional(),
  effort: z.enum(["low", "medium", "high"]).default("medium"),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
export type RunStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface PilotEvent {
  schemaVersion: 1;
  runId: string;
  /** Present on new events. Legacy stored events remain replayable. */
  projectId?: string;
  sessionId?: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  time: string;
}
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
export interface Session {
  id: string;
  projectId: string;
  title: string;
  nativeThreadId?: string;
  createdAt: string;
}
export interface Asset {
  id: string;
  projectId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  kind: "reference" | "model" | "texture" | "capture" | "export" | "snapshot";
  path: string;
  previewPath?: string;
  documentInfo?: import("./attachments.js").DocumentInfo;
  tags: string[];
  folder: string;
  createdAt: string;
}
export interface Capture {
  id: string;
  projectId: string;
  runId?: string;
  path: string;
  mime: string;
  sceneRevision: string;
  generation: number;
  mode: string;
  phase: string;
  createdAt: string;
}
export interface Snapshot {
  id: string;
  projectId: string;
  name: string;
  path: string;
  createdAt: string;
  runId?: string;
}
export interface Run {
  id: string;
  skillRefs?: Array<{ id: string; name: string; sha256: string }>;
  qualityMode?: "multi-view";
  clientRequestId?: string;
  cancelRequestedAt?: string;
  attachmentRefs?: Array<{
    id: string;
    name: string;
    kind: "asset" | "capture" | "library";
    mime?: string;
  }>;
  sessionId: string;
  projectId: string;
  prompt: string;
  assetIds: string[];
  libraryAssetIds?: string[];
  status: RunStatus;
  verification: string;
  createdAt: string;
  updatedAt: string;
  nativeThreadId?: string;
  error?: string;
}
export interface SceneInfo {
  objects: Array<{
    name: string;
    type: string;
    location: number[];
    dimensions: number[];
    materials: string[];
  }>;
  active: string | null;
  selected: string[];
  mode: string;
  frame: number;
  version: string;
  filepath: string;
  revision: string;
}
export interface StartJob {
  runId: string;
  projectId: string;
  sessionId: string;
  prompt: string;
  assets: Array<Pick<Asset, "id" | "path" | "mime" | "name">>;
  libraryAssets?: Array<{ id: string; name: string }>;
  nativeThreadId?: string;
  settings: ModelSettings;
  skills?: Array<{ id: string; name: string; path: string; sha256: string }>;
  qualityMode?: "multi-view";
  workContext?: import("./workflow.js").WorkContext;
}
export const terminal = new Set<RunStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

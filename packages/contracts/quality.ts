import { z } from "zod";

export const qualityViewSchema = z.enum(["front", "right", "top", "isometric"]);
export type QualityView = z.infer<typeof qualityViewSchema>;
export const qualityViewsSchema = z
  .array(qualityViewSchema)
  .min(1)
  .max(3)
  .refine((views) => new Set(views).size === views.length, "检查视角不能重复");
export const inspectQualitySchema = z.object({
  groundZ: z.number().finite().min(-1_000_000).max(1_000_000).default(0),
  overlapCandidates: z.boolean().default(true),
});
export type QualityBounds = {
  min: [number, number, number];
  max: [number, number, number];
};
export interface QualityIssue {
  code:
    | "invalid-transform"
    | "empty-mesh"
    | "degenerate-bounds"
    | "negative-scale"
    | "missing-material"
    | "missing-texture"
    | "floating-candidate"
    | "overlap-candidate"
    | "no-light";
  severity: "error" | "warning" | "info";
  objects: string[];
  message: string;
  requiresVisualReview: boolean;
}
export interface SceneQualityInspection {
  schemaVersion: 1;
  id: string;
  projectId: string;
  createdAt: string;
  sceneRevision: string;
  generation: number;
  /** Machine checks are evidence for a visual review, never a beauty score. */
  status: "structural-errors" | "review-needed" | "no-structural-issues";
  summary: {
    objectsTotal: number;
    objectsInspected: number;
    meshObjects: number;
    vertices: number;
    polygons: number;
    lights: number;
    cameras: number;
    warningCount: number;
    errorCount: number;
  };
  bounds: QualityBounds | null;
  issues: QualityIssue[];
  limits: {
    maxObjects: number;
    objectsTruncated: boolean;
    issuesTruncated: boolean;
    overlapCandidatesTruncated: boolean;
    groundZ: number;
    limitations: string[];
  };
}

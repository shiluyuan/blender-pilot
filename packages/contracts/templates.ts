import { z } from "zod";
import { MAX_CHAT_PROMPT_CHARS } from "./chat-limits.js";

export const TEMPLATE_CATEGORIES = [
  "prop",
  "character",
  "scene",
  "material",
  "composition",
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const MAX_TEMPLATE_PROMPT = 12000;
export const MAX_RENDERED_TEMPLATE = MAX_CHAT_PROMPT_CHARS;
const variableSchema = z
  .object({
    key: z
      .string()
      .regex(
        /^[A-Za-z][A-Za-z0-9_]{0,39}$/,
        "参数名须以字母开头，只包含字母、数字和下划线",
      ),
    label: z.string().trim().min(1).max(80),
    defaultValue: z.string().max(2000).default(""),
    /** Absent in legacy recipes: text parameters remain fully compatible. */
    type: z.enum(["text", "number"]).optional(),
    unit: z.string().trim().max(16).optional(),
    min: z.number().min(-1e9).max(1e9).optional(),
    max: z.number().min(-1e9).max(1e9).optional(),
    step: z.number().positive().min(1e-6).max(1e9).optional(),
  })
  .strict()
  .superRefine((variable, ctx) => {
    if (variable.type !== "number") {
      if (
        [variable.unit, variable.min, variable.max, variable.step].some(
          (v) => v !== undefined,
        )
      )
        ctx.addIssue({ code: "custom", message: "单位和范围仅用于数值参数" });
      return;
    }
    if (
      variable.min !== undefined &&
      variable.max !== undefined &&
      variable.min > variable.max
    )
      ctx.addIssue({
        code: "custom",
        message: "最小值不能大于最大值",
        path: ["min"],
      });
    const error = templateVariableError(variable, variable.defaultValue);
    if (error)
      ctx.addIssue({ code: "custom", message: error, path: ["defaultValue"] });
  });

export type TemplateVariable = z.infer<typeof variableSchema>;

/** Shared by previews and the API, so browser constraints cannot be bypassed. */
export function templateVariableError(
  variable: {
    label: string;
    type?: "text" | "number";
    min?: number;
    max?: number;
    step?: number;
  },
  value: string,
): string | undefined {
  if (typeof value !== "string" || !value.trim())
    return `请填写参数：${variable.label}`;
  if (value.length > 2000) return `参数「${variable.label}」不能超过 2000 字符`;
  if (variable.type !== "number") return;
  const text = value.trim();
  const number = Number(text);
  if (
    !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) ||
    !Number.isFinite(number) ||
    Math.abs(number) > 1e9
  )
    return `参数「${variable.label}」须为有效数字（绝对值不超过 10 亿）`;
  if (variable.min !== undefined && number < variable.min)
    return `参数「${variable.label}」不能小于 ${variable.min}`;
  if (variable.max !== undefined && number > variable.max)
    return `参数「${variable.label}」不能大于 ${variable.max}`;
  if (variable.step !== undefined) {
    const steps = (number - (variable.min ?? 0)) / variable.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-7)
      return `参数「${variable.label}」须以 ${variable.min ?? 0} 为起点，按 ${variable.step} 递增`;
  }
}

export const templateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).default(""),
    category: z.enum(TEMPLATE_CATEGORIES),
    prompt: z.string().trim().min(1).max(MAX_TEMPLATE_PROMPT),
    variables: z.array(variableSchema).max(12).default([]),
    libraryAssetIds: z.array(z.string().uuid()).max(12).default([]),
  })
  .strict()
  .superRefine((input, ctx) => {
    const declared = new Set<string>();
    for (const variable of input.variables) {
      if (declared.has(variable.key))
        ctx.addIssue({
          code: "custom",
          message: "参数名不能重复",
          path: ["variables"],
        });
      declared.add(variable.key);
    }
    if (new Set(input.libraryAssetIds).size !== input.libraryAssetIds.length)
      ctx.addIssue({
        code: "custom",
        message: "引用素材不能重复",
        path: ["libraryAssetIds"],
      });
    const used = new Set<string>();
    const stripped = input.prompt.replace(
      /\{\{([A-Za-z][A-Za-z0-9_]{0,39})\}\}/g,
      (_match, key: string) => {
        used.add(key);
        if (!declared.has(key))
          ctx.addIssue({
            code: "custom",
            message: `未声明参数：${key}`,
            path: ["prompt"],
          });
        return "";
      },
    );
    if (stripped.includes("{{") || stripped.includes("}}"))
      ctx.addIssue({
        code: "custom",
        message: "参数使用 {{key}} 格式，不支持嵌套或不完整标记",
        path: ["prompt"],
      });
    for (const key of declared)
      if (!used.has(key))
        ctx.addIssue({
          code: "custom",
          message: `正文未使用参数：${key}`,
          path: ["variables"],
        });
  });
export type TemplateInput = z.infer<typeof templateInputSchema>;
export interface CreationTemplate extends TemplateInput {
  id: string;
  source: "builtin" | "custom";
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** A single replace pass preserves user text literally, including {{...}} and $&. */
export function renderTemplate(
  template: Pick<CreationTemplate, "prompt" | "variables">,
  values: Record<string, string> = {},
) {
  const known = new Set(template.variables.map((variable) => variable.key));
  for (const key of Object.keys(values))
    if (!known.has(key)) throw new Error(`未知参数：${key}`);
  const resolved = new Map<string, string>();
  for (const variable of template.variables) {
    const value = Object.hasOwn(values, variable.key)
      ? values[variable.key]
      : variable.defaultValue;
    const error = templateVariableError(variable, value);
    if (error) throw new Error(error);
    resolved.set(variable.key, value);
  }
  const prompt = template.prompt.replace(
    /\{\{([A-Za-z][A-Za-z0-9_]{0,39})\}\}/g,
    (_match, key: string) => {
      if (!resolved.has(key)) throw new Error(`未声明参数：${key}`);
      return resolved.get(key)!;
    },
  );
  if (prompt.length > MAX_RENDERED_TEMPLATE)
    throw new Error(
      `展开后的模板不能超过 ${MAX_RENDERED_TEMPLATE} 字符，请缩短参数`,
    );
  return prompt;
}

const verification =
  "\n保留当前场景与已有素材，新增内容放入单独命名的 Collection。完成后回读对象与尺寸，调整视图并截图检查，再说明完成情况；不要仅凭执行成功声称视觉验收通过。";
const builtins: Array<TemplateInput & { id: string }> = [
  {
    id: "builtin:prop",
    name: "可复用道具",
    description: "制作结构清楚、尺寸明确的单个道具，便于保存为物品素材。",
    category: "prop",
    prompt:
      "制作一个可复用的 {{subject}}。风格：{{style}}；目标尺寸（米）：{{dimensions}}。采用可编辑几何体，设置合理原点和材质，清楚命名零件。完成后说明哪些对象适合一起保存到物品素材库。" +
      verification,
    variables: [
      { key: "subject", label: "道具", defaultValue: "带扶手的木椅" },
      { key: "style", label: "风格", defaultValue: "简约低多边形" },
      {
        key: "dimensions",
        label: "尺寸",
        defaultValue: "宽 0.6、深 0.6、高 0.9",
      },
    ],
    libraryAssetIds: [],
  },
  {
    id: "builtin:character",
    name: "角色造型底稿",
    description: "从轮廓和比例开始制作可编辑角色底稿，适合后续细化。",
    category: "character",
    prompt:
      "制作 {{character}} 的角色造型底稿。造型风格：{{style}}；比例要求：{{proportions}}。先做清晰轮廓和主要部件，左右对称、名称可读，保留可编辑结构。明确说明底稿完成范围和仍需细化之处，不声称已经具备生产级拓扑、绑定或动画。" +
      verification,
    variables: [
      { key: "character", label: "角色", defaultValue: "友好的小型服务机器人" },
      { key: "style", label: "造型风格", defaultValue: "圆润的卡通风格" },
      {
        key: "proportions",
        label: "比例",
        defaultValue: "总高 1.2 米，头身比约 1:2",
      },
    ],
    libraryAssetIds: [],
  },
  {
    id: "builtin:scene",
    name: "完整场景搭建",
    description: "把空间、布局、材质、灯光和观察视角连成一次创作。",
    category: "scene",
    prompt:
      "搭建一个 {{scene}} 场景。空间尺寸（米）：{{dimensions}}；视觉风格与氛围：{{mood}}；核心内容：{{contents}}。先给出简短布局计划；优先复用我引用的素材，不足部分再新建。设置材质、灯光和适合观察整体的相机，避免物体明显穿插。" +
      verification,
    variables: [
      { key: "scene", label: "场景", defaultValue: "小型咖啡店室内" },
      {
        key: "dimensions",
        label: "空间尺寸",
        defaultValue: "长 8、宽 6、高 3",
      },
      {
        key: "mood",
        label: "风格与氛围",
        defaultValue: "温暖浅木色，柔和自然光",
      },
      {
        key: "contents",
        label: "核心内容",
        defaultValue: "吧台、三组桌椅、靠窗座位与植物",
      },
    ],
    libraryAssetIds: [],
  },
  {
    id: "builtin:material",
    name: "材质样例与灯光",
    description: "在新建样例对象上展示材质，保留已有对象的材质。",
    category: "material",
    prompt:
      "创建用于展示 {{material}} 的材质样例对象。表面细节与颜色：{{appearance}}；灯光氛围：{{lighting}}。优先使用可编辑的程序化节点，明确命名材质与样例对象，设置能展示粗糙度和高光的观察角度。除非我明确指定，不替换现有场景对象的材质；说明后续如何复用该样例。" +
      verification,
    variables: [
      { key: "material", label: "材质", defaultValue: "浅色拉丝金属" },
      {
        key: "appearance",
        label: "表面与颜色",
        defaultValue: "银白色、细密方向性纹理、适中粗糙度",
      },
      {
        key: "lighting",
        label: "灯光",
        defaultValue: "中性棚拍灯光，背景简洁",
      },
    ],
    libraryAssetIds: [],
  },
  {
    id: "builtin:composition",
    name: "素材组合与再创作",
    description: "引用共享库里的角色、道具或场景，组合成新的作品。",
    category: "composition",
    prompt:
      "使用我引用的共享素材，组合一个 {{goal}}。摆放与关系：{{layout}}；需要新增或改造的部分：{{changes}}。先读取引用素材的准确 ID、信息与预览，导入为独立副本，保留源素材。若没有引用素材，先向我询问所需素材，不自行假定已经存在。完成后列出组合对象与来源，并说明可以保存回素材库的范围，不自动覆盖已有条目。" +
      verification,
    variables: [
      {
        key: "goal",
        label: "组合目标",
        defaultValue: "有角色活动的办公室休息区",
      },
      {
        key: "layout",
        label: "摆放关系",
        defaultValue: "座椅围绕茶几，角色位于座椅旁，保留行走空间",
      },
      {
        key: "changes",
        label: "新增与改造",
        defaultValue: "补充地面、柔和灯光与绿植，统一整体配色",
      },
    ],
    libraryAssetIds: [],
  },
  {
    id: "builtin:reference",
    name: "参考图分解建模",
    description: "配合对话中的参考图，从可见形体开始搭建并逐步核对。",
    category: "prop",
    prompt:
      "根据我在本条消息附带的参考图，为 {{subject}} 建立可编辑的三维模型。目标风格：{{style}}；优先还原：{{priorities}}。先观察参考图并简述可见结构，再分解主要形体建模；不可见背面和遮挡细节须说明是推测。如果本条消息没有图片，请先要求补充参考图。" +
      verification,
    variables: [
      { key: "subject", label: "建模对象", defaultValue: "图片中的主要物体" },
      {
        key: "style",
        label: "目标风格",
        defaultValue: "保留轮廓与配色的简约低多边形",
      },
      {
        key: "priorities",
        label: "优先还原",
        defaultValue: "整体比例、轮廓、主要颜色和关键部件",
      },
    ],
    libraryAssetIds: [],
  },
  {
    id: "builtin:desk",
    name: "尺寸化书桌",
    description: "按米设置宽、深、高，制作独立零件组成的可复用书桌。",
    category: "prop",
    prompt:
      "制作一张可编辑书桌：外宽 {{width}} 米、外深 {{depth}} 米、总高 {{height}} 米；风格与材质：{{style}}。先检查场景单位比例，按实际米制尺寸建模。台面、桌腿分开命名并放入独立 Collection，原点位于桌子底部中心。尺寸指包含全部零件的外包围尺寸；回读世界坐标包围盒，逐项报告目标值、实际值和偏差（目标误差不超过 0.01 米）。记录轴向、材质和适合整组复用的对象。" +
      verification,
    variables: [
      {
        key: "width",
        label: "书桌宽度",
        type: "number",
        unit: "米",
        min: 0.6,
        max: 3,
        step: 0.05,
        defaultValue: "1.4",
      },
      {
        key: "depth",
        label: "书桌深度",
        type: "number",
        unit: "米",
        min: 0.3,
        max: 1.2,
        step: 0.05,
        defaultValue: "0.7",
      },
      {
        key: "height",
        label: "书桌总高",
        type: "number",
        unit: "米",
        min: 0.5,
        max: 1.2,
        step: 0.01,
        defaultValue: "0.75",
      },
      {
        key: "style",
        label: "书桌风格与材质",
        defaultValue: "浅色橡木台面，深灰金属桌腿",
      },
    ],
    libraryAssetIds: [],
  },
  {
    id: "builtin:shelf",
    name: "层数可调置物架",
    description: "设置层数与外形尺寸，生成便于替换材质和组合摆放的置物架。",
    category: "prop",
    prompt:
      "制作可编辑置物架：包含底板的承载搁板共 {{levels}} 层，外宽 {{width}} 米、外深 {{depth}} 米、总高 {{height}} 米。风格：{{style}}。底板计入层数，顶盖不计入层数，各层均匀分布；先说明层板厚度和净高，再建模。保持各搁板为独立命名对象，立柱和侧板避免重复，整组放入新 Collection。按实际米制单位校准，回读层板数量、世界包围尺寸、材质和原点位置；目标尺寸误差不超过 0.01 米。" +
      verification,
    variables: [
      {
        key: "levels",
        label: "搁板层数",
        type: "number",
        unit: "层",
        min: 2,
        max: 8,
        step: 1,
        defaultValue: "4",
      },
      {
        key: "width",
        label: "置物架宽度",
        type: "number",
        unit: "米",
        min: 0.4,
        max: 2.4,
        step: 0.05,
        defaultValue: "1.0",
      },
      {
        key: "depth",
        label: "置物架深度",
        type: "number",
        unit: "米",
        min: 0.2,
        max: 0.8,
        step: 0.05,
        defaultValue: "0.35",
      },
      {
        key: "height",
        label: "置物架总高",
        type: "number",
        unit: "米",
        min: 0.6,
        max: 2.8,
        step: 0.05,
        defaultValue: "1.8",
      },
      {
        key: "style",
        label: "置物架风格",
        defaultValue: "简约木质开放式置物架",
      },
    ],
    libraryAssetIds: [],
  },
  {
    id: "builtin:office-layout",
    name: "办公室布局",
    description: "设置空间尺寸、工位数量和通道宽度，复用素材分阶段搭建办公室。",
    category: "scene",
    prompt:
      "搭建办公室：室内净宽 {{width}} 米、净深 {{depth}} 米、层高 {{height}} 米，共 {{desks}} 个工位，主要行走通道净宽至少 {{aisle}} 米。视觉风格：{{style}}。先读取引用素材的尺寸、原点和材质，列出房间布局、需复用的素材、缺少的部件及制作阶段；如果工位放不下，先解释冲突，不能缩窄通道或偷偷缩小家具。按房间、工位、装饰、材质灯光、验收分阶段完成，各部分放入明确命名的 Collection。引用素材导入为独立副本；按实际米制尺寸回读空间、工位数量、通道和家具包围盒。最终从正面、侧面、俯视检查明显穿插、悬空和布局，并说明仍存在的视觉限制。" +
      verification,
    variables: [
      {
        key: "width",
        label: "办公室净宽",
        type: "number",
        unit: "米",
        min: 3,
        max: 20,
        step: 0.5,
        defaultValue: "8",
      },
      {
        key: "depth",
        label: "办公室净深",
        type: "number",
        unit: "米",
        min: 3,
        max: 20,
        step: 0.5,
        defaultValue: "6",
      },
      {
        key: "height",
        label: "办公室层高",
        type: "number",
        unit: "米",
        min: 2.4,
        max: 5,
        step: 0.1,
        defaultValue: "3",
      },
      {
        key: "desks",
        label: "工位数量",
        type: "number",
        unit: "个",
        min: 1,
        max: 24,
        step: 1,
        defaultValue: "6",
      },
      {
        key: "aisle",
        label: "通道净宽",
        type: "number",
        unit: "米",
        min: 0.8,
        max: 3,
        step: 0.1,
        defaultValue: "1.2",
      },
      {
        key: "style",
        label: "办公室风格",
        defaultValue: "温暖浅木色、自然光与少量绿植",
      },
    ],
    libraryAssetIds: [],
  },
];
const builtInTime = "2026-10-24T00:00:00.000Z";
export const BUILTIN_TEMPLATES: readonly CreationTemplate[] = builtins.map(
  ({ id, ...input }) => ({
    ...templateInputSchema.parse(input),
    id,
    source: "builtin",
    version: 1,
    createdAt: builtInTime,
    updatedAt: builtInTime,
  }),
);

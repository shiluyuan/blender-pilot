/** MCP discovery metadata, independent of run state and execution lifecycle. */
export const toolDefinitions = [
  {
    name: "update_work_plan",
    description:
      "Persist a bounded staged creation plan before a complex scene. Keep stable step IDs, update actual status and objectNames after readback. Newly completed stages create restorable checkpoints. This does not execute or automatically replay work.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              step: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "blocked"],
              },
              objectNames: { type: "array", items: { type: "string" } },
              note: { type: "string" },
            },
            required: ["id", "step", "status"],
          },
        },
      },
      required: ["title", "steps"],
    },
  },
  {
    name: "inspect_scene_quality",
    description:
      "Read bounded structure, dimensions, materials and missing textures. Overlap/floating findings are candidates requiring visual review, never a beauty score. Inspection is bound to current scene revision.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "capture_views",
    description:
      "Capture real front/right/top viewport images (or up to three specified distinct views), then restore the original view. Use a full three-view set for multi-view acceptance; images are not a final render or topology proof.",
    inputSchema: {
      type: "object",
      properties: {
        views: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: {
            type: "string",
            enum: ["front", "right", "top", "isometric"],
          },
        },
      },
    },
  },
  {
    name: "read_skill_resource",
    description:
      "Read a selected skill's bundled UTF-8 reference/script or image using skillId and relative path. Reading a script does not execute it. Follow Blender-only task scope and use MCP for explicit scene operations.",
    inputSchema: {
      type: "object",
      properties: { skillId: { type: "string" }, path: { type: "string" } },
      required: ["skillId", "path"],
    },
  },
  {
    name: "get_library_asset",
    description:
      "Inspect a library asset and its saved-view preview image. This is a reference image, NOT a current scene capture and cannot be used for report_verification.",
    inputSchema: {
      type: "object",
      properties: { assetId: { type: "string" } },
      required: ["assetId"],
    },
  },
  {
    name: "search_library",
    description:
      "Search the reusable global Blender asset library by name, description, tags and category. Search before creating assets when the user requests reuse. Results contain asset IDs for import_library_asset. Page size 60.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string" },
        category: {
          type: "string",
          enum: ["all", "character", "prop", "scene", "material", "other"],
        },
        page: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    name: "save_library_asset",
    description:
      "Save selected or named objects (with hierarchy, materials and packable textures), or all scene objects, as a reusable .blend collection in the global library. Only when the user requests saving a reusable asset. Includes a real saved-view preview. Does not save scene render/world settings.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        category: {
          type: "string",
          enum: ["character", "prop", "scene", "material", "other"],
        },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        scope: { type: "string", enum: ["selection", "scene"] },
        objectNames: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
    },
  },
  {
    name: "import_library_asset",
    description:
      "Append a reusable library asset to the current project as an independent copy. Use an ID from search_library or the user. Returns actual object names, a change receipt and screenshot. Use bpy to place those objects. Never replaces the scene.",
    inputSchema: {
      type: "object",
      properties: { assetId: { type: "string" } },
      required: ["assetId"],
    },
  },
  {
    name: "get_scene_info",
    description:
      "Read current live scene, selected objects, active object, mode and real dimensions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "execute_blender_code",
    description:
      "Execute a short Python bpy script in the live Blender. Automatically returns readback receipt and a new image. Inspect the image before continuing.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
  },
  {
    name: "capture",
    description:
      "Take a fresh viewport screenshot. Returns actual image content and captureId.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "query_blender_api",
    description:
      "Inspect actual Blender RNA types or operators. e.g. bpy.types.Mesh or bpy.ops.mesh.primitive_cube_add.",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
    },
  },
  {
    name: "import_asset",
    description:
      "Explicitly import a referenced asset by ID. Images are loaded as image datablocks; use bpy to apply them.",
    inputSchema: {
      type: "object",
      properties: { assetId: { type: "string" } },
      required: ["assetId"],
    },
  },
  {
    name: "save_scene",
    description: "Save current project scene.blend.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "export_scene",
    description: "Export current scene to a downloadable model.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["glb", "gltf", "blend"] },
      },
      required: ["format"],
    },
  },
  {
    name: "report_verification",
    description:
      "After inspecting the latest screenshot, record whether the scene meets the request. Must cite a current captureId with concrete visual observations.",
    inputSchema: {
      type: "object",
      properties: {
        captureId: { type: "string" },
        captureIds: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          uniqueItems: true,
          items: { type: "string" },
        },
        inspectionId: { type: "string" },
        passed: { type: "boolean" },
        observations: { type: "string" },
      },
      required: ["captureId", "passed", "observations"],
    },
  },
];

export const MODEL_EXTENSIONS = [
  ".blend",
  ".glb",
  ".gltf",
  ".fbx",
  ".obj",
  ".stl",
  ".ply",
  ".usd",
  ".usda",
  ".usdc",
  ".usdz",
  ".abc",
] as const;
export const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".exr",
  ".hdr",
] as const;
export const LIBRARY_ACCEPT = [
  ...MODEL_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ".zip",
].join(",");

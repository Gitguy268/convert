import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { FormatDefinition } from "../FormatHandler.ts";
import Formats, { Category } from "src/Formats.ts";
import type { ConvertContext } from "src/ui/ProgressStore.ts";
import { createCanvas } from "src/common/canvas.ts";
import { changeExt } from "src/common/index.ts";
import { edgeTable, triTable } from "three/addons/objects/MarchingCubes.js";

const model = (name: string, format: string, extension: string, mime: string) =>
  new FormatDefinition(name, format, extension, mime, Category.MODEL);

export const SPLATS_PLY = model(
  "3D from a picture: Gaussian splats (PLY)",
  "splats-3d",
  "ply",
  "model/x-ply",
);
export const MESH_GLB = model(
  "3D from a picture: mesh (GLB)",
  "mesh-3d-glb",
  "glb",
  "model/gltf-binary",
);
export const MESH_STL = model(
  "3D from a picture: mesh for printing (STL)",
  "mesh-3d-stl",
  "stl",
  "model/stl",
);
export const MESH_OBJ = model("3D from a picture: mesh (OBJ)", "mesh-3d-obj", "obj", "model/obj");

/** Side of the square picture the model looks at. */
export const INPUT_SIZE = 128;
/** The model's cells: a 16³ grid, one Gaussian each. */
export const CELLS = 16 ** 3;
/** Values per cell: occupancy logit, xyz, rgb, scale, rotation (w, x, y, z), opacity. */
const STRIDE = 15;
/** The occupancy the model card recommends (0.5 is the inherited CLI default). */
export const THRESHOLD = 0.6;

export interface Splat {
  xyz: [number, number, number];
  rgb: [number, number, number];
  scale: [number, number, number];
  quat: [number, number, number, number];
  opacity: number;
  score: number;
}

/**
 * The picture as the model was trained on it: composited on black, letterboxed into a black
 * square, as planar RGB from 0 to 1 (forma3d-tiny's `image_tensor`).
 */
export async function preprocess(bytes: Uint8Array): Promise<Float32Array> {
  const image = await createImageBitmap(new Blob([bytes as BlobPart]));
  const { ctx } = createCanvas(INPUT_SIZE, INPUT_SIZE);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  const scale = Math.min(INPUT_SIZE / image.width, INPUT_SIZE / image.height);
  const [w, h] = [image.width * scale, image.height * scale];
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, (INPUT_SIZE - w) / 2, (INPUT_SIZE - h) / 2, w, h);
  image.close();
  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  const out = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    for (let c = 0; c < 3; c++) out[c * plane + p] = data[p * 4 + c] / 255;
  }
  return out;
}

/** The cells the model calls occupied, most certain first. */
export function selectSplats(raw: ArrayLike<number>, threshold = THRESHOLD): Splat[] {
  const splats: Splat[] = [];
  for (let i = 0; i < CELLS; i++) {
    const v = (k: number) => raw[i * STRIDE + k];
    const score = 1 / (1 + Math.exp(-v(0)));
    if (score < threshold) continue;
    splats.push({
      xyz: [v(1), v(2), v(3)],
      rgb: [v(4), v(5), v(6)],
      scale: [v(7), v(8), v(9)],
      quat: [v(10), v(11), v(12), v(13)],
      opacity: v(14),
      score,
    });
  }
  return splats.toSorted((a, b) => b.score - a.score);
}

/** SH degree-zero constant of 3D Gaussian splatting, for colours. */
const C0 = 0.28209479177387814;

/** Splats as the standard 3DGS PLY that viewers such as SuperSplat and Polycam read. */
export function splatPly(splats: Splat[]): Uint8Array {
  const names = [
    "x",
    "y",
    "z",
    "nx",
    "ny",
    "nz",
    "f_dc_0",
    "f_dc_1",
    "f_dc_2",
    "opacity",
    "scale_0",
    "scale_1",
    "scale_2",
    "rot_0",
    "rot_1",
    "rot_2",
    "rot_3",
  ];
  const header =
    `ply\nformat binary_little_endian 1.0\nelement vertex ${splats.length}\n` +
    names.map((n) => `property float ${n}\n`).join("") +
    "end_header\n";
  const head = new TextEncoder().encode(header);
  const out = new Uint8Array(head.length + splats.length * names.length * 4);
  out.set(head);
  const view = new DataView(out.buffer, head.length);
  let o = 0;
  const put = (n: number) => {
    view.setFloat32(o, n, true);
    o += 4;
  };
  for (const s of splats) {
    const opacity = Math.min(1 - 1e-6, Math.max(1e-6, s.opacity));
    [
      ...s.xyz,
      0,
      0,
      0,
      ...s.rgb.map((c) => (c - 0.5) / C0),
      Math.log(opacity / (1 - opacity)),
      ...s.scale.map(Math.log),
      ...s.quat,
    ].forEach(put);
  }
  return out;
}

// ---------------------------------------------------------------------------- mesh

/** Cells a side of the density grid the mesh is made from. */
export const MESH_GRID = 56;
/** Half the side of the cube the grid covers: the model's objects sit inside ±0.5. */
const EXTENT = 0.56;
/**
 * The smallest a Gaussian counts as, for the mesh: about a model cell. The model's splats are
 * smaller than the gaps between them, so a surface through them alone would be beads.
 */
const MIN_SIGMA = 0.6 / 16;
/** The density the surface is drawn at. */
export const ISO = 0.5;

/** The splats' summed density and colour on a grid, for marching cubes. */
export function densityField(splats: Splat[], n = MESH_GRID) {
  const size = n + 1;
  const density = new Float32Array(size ** 3);
  const colour = new Float32Array(size ** 3 * 3);
  const step = (2 * EXTENT) / n;
  const at = (i: number) => -EXTENT + i * step;
  for (const s of splats) {
    const [w, x, y, z] = s.quat;
    const r = [
      1 - 2 * (y * y + z * z),
      2 * (x * y - z * w),
      2 * (x * z + y * w),
      2 * (x * y + z * w),
      1 - 2 * (x * x + z * z),
      2 * (y * z - x * w),
      2 * (x * z - y * w),
      2 * (y * z + x * w),
      1 - 2 * (x * x + y * y),
    ];
    const sig = s.scale.map((v) => Math.max(v, MIN_SIGMA));
    // the inverse covariance R S^-2 R^T
    const inv = Array.from({ length: 9 }, () => 0);
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += (r[a * 3 + k] * r[b * 3 + k]) / sig[k] ** 2;
        inv[a * 3 + b] = sum;
      }
    }
    const reach = 3 * Math.max(...sig);
    const lo = s.xyz.map((c) => Math.max(0, Math.floor((c - reach + EXTENT) / step)));
    const hi = s.xyz.map((c) => Math.min(n, Math.ceil((c + reach + EXTENT) / step)));
    for (let i = lo[0]; i <= hi[0]; i++) {
      const dx = at(i) - s.xyz[0];
      for (let j = lo[1]; j <= hi[1]; j++) {
        const dy = at(j) - s.xyz[1];
        for (let k = lo[2]; k <= hi[2]; k++) {
          const dz = at(k) - s.xyz[2];
          const e =
            dx * (inv[0] * dx + inv[1] * dy + inv[2] * dz) +
            dy * (inv[3] * dx + inv[4] * dy + inv[5] * dz) +
            dz * (inv[6] * dx + inv[7] * dy + inv[8] * dz);
          if (e > 9) continue;
          const g = s.opacity * Math.exp(-0.5 * e);
          const index = (i * size + j) * size + k;
          density[index] += g;
          for (let c = 0; c < 3; c++) colour[index * 3 + c] += g * s.rgb[c];
        }
      }
    }
  }
  for (let index = 0; index < density.length; index++) {
    const d = density[index];
    if (d > 0) for (let c = 0; c < 3; c++) colour[index * 3 + c] /= d;
  }
  return { density, colour, n, step, origin: -EXTENT };
}

/** Corner offsets of a cube, in the order of the classic marching cubes tables. */
const CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const EDGES = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/**
 * The surface where the density crosses `iso`, as triangles with a colour at each corner.
 * The grid's outer layer is empty, so the surface is closed, which 3D printing needs.
 */
export function marchingCubes(field: ReturnType<typeof densityField>, iso = ISO) {
  const { density, colour, n, step, origin } = field;
  const size = n + 1;
  const positions: number[] = [];
  const colours: number[] = [];
  const index = (i: number, j: number, k: number) => (i * size + j) * size + k;
  const values = new Float32Array(8);
  const edgeVertex = new Float32Array(12 * 6);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        let cube = 0;
        for (let c = 0; c < 8; c++) {
          const [a, b, d] = CORNERS[c];
          values[c] = density[index(i + a, j + b, k + d)];
          if (values[c] > iso) cube |= 1 << c;
        }
        const edges = edgeTable[cube];
        if (!edges) continue;
        for (let e = 0; e < 12; e++) {
          if (!(edges & (1 << e))) continue;
          const [p, q] = EDGES[e];
          const t = (iso - values[p]) / (values[q] - values[p] || 1e-9);
          const [pa, pb, pc] = CORNERS[p];
          const [qa, qb, qc] = CORNERS[q];
          const ip = index(i + pa, j + pb, k + pc);
          const iq = index(i + qa, j + qb, k + qc);
          edgeVertex[e * 6] = origin + (i + pa + t * (qa - pa)) * step;
          edgeVertex[e * 6 + 1] = origin + (j + pb + t * (qb - pb)) * step;
          edgeVertex[e * 6 + 2] = origin + (k + pc + t * (qc - pc)) * step;
          for (let c = 0; c < 3; c++) {
            edgeVertex[e * 6 + 3 + c] =
              colour[ip * 3 + c] + t * (colour[iq * 3 + c] - colour[ip * 3 + c]);
          }
        }
        for (let t = cube * 16; triTable[t] !== -1; t += 3) {
          // reversed, so that the faces point outward the way three.js and slicers expect
          for (const e of [triTable[t], triTable[t + 2], triTable[t + 1]]) {
            positions.push(edgeVertex[e * 6], edgeVertex[e * 6 + 1], edgeVertex[e * 6 + 2]);
            colours.push(edgeVertex[e * 6 + 3], edgeVertex[e * 6 + 4], edgeVertex[e * 6 + 5]);
          }
        }
      }
    }
  }
  return { positions: new Float32Array(positions), colours: new Float32Array(colours) };
}

async function meshObject(splats: Splat[]) {
  const THREE = await import("three");
  const { positions, colours } = marchingCubes(densityField(splats));
  if (!positions.length)
    throw new Error("The model found too little of an object to make a surface.");
  let geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  const { mergeVertices } = await import("three/addons/utils/BufferGeometryUtils.js");
  geometry = mergeVertices(geometry, 1e-6);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "forma3d";
  return mesh;
}

async function exportMesh(splats: Splat[], format: string): Promise<Uint8Array> {
  const mesh = await meshObject(splats);
  if (format === "mesh-3d-stl") {
    const { STLExporter } = await import("three/addons/exporters/STLExporter.js");
    // millimetres for a slicer: the object is about a unit across, so 100 mm
    mesh.scale.setScalar(100);
    mesh.updateMatrixWorld();
    const view = new STLExporter().parse(mesh, { binary: true }) as DataView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (format === "mesh-3d-obj") {
    const { OBJExporter } = await import("three/addons/exporters/OBJExporter.js");
    return new TextEncoder().encode(new OBJExporter().parse(mesh));
  }
  const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
  return new Uint8Array(
    (await new GLTFExporter().parseAsync(mesh, { binary: true })) as ArrayBuffer,
  );
}

/**
 * Image to 3D with forma3d-tiny-4 (Lucasgitguy-co, Apache-2.0): a 306k-parameter research model
 * that places up to 4,096 Gaussians in a 16³ grid from one picture of an object. It runs on
 * ONNX Runtime in the browser; the 1.7 MB model is part of this site.
 */
class imageTo3dHandler implements FormatHandler {
  public readonly name = "imageTo3d";
  public supportedFormats = [
    Formats.PNG.builder("png").from(),
    Formats.JPEG.builder("jpeg").from(),
    Formats.WEBP.builder("webp").from(),
    SPLATS_PLY.builder("ply").to(),
    MESH_GLB.builder("glb").to(),
    MESH_STL.builder("stl").to(),
    MESH_OBJ.builder("obj").to(),
  ];
  public ready = false;
  #session?: Promise<import("onnxruntime-web").InferenceSession>;

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    _inputFormat: FileFormat,
    outputFormat: FileFormat,
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    const ort = await import("onnxruntime-web/wasm");
    if (!this.#session) {
      ctx?.progress("Loading the 3D model...", 0);
      const [{ default: wasm }, { default: url }] = await Promise.all([
        import("onnxruntime-web/ort-wasm-simd-threaded.wasm?url"),
        import("./imageTo3d/forma3d-tiny-4.onnx?url"),
      ]);
      ort.env.wasm.wasmPaths = { wasm };
      this.#session = ort.InferenceSession.create(url, { executionProviders: ["wasm"] });
      this.#session.catch(() => (this.#session = undefined));
    }
    const session = await this.#session;
    const outputs: FileData[] = [];
    for (const [i, file] of inputFiles.entries()) {
      ctx?.throwIfAborted();
      ctx?.progress(`Guessing the shape in ${file.name}...`, i / inputFiles.length);
      const input = new ort.Tensor("float32", await preprocess(file.bytes), [
        1,
        3,
        INPUT_SIZE,
        INPUT_SIZE,
      ]);
      const result = await session.run({ image: input });
      const splats = selectSplats(result.gaussians.data as Float32Array);
      if (!splats.length) {
        throw new Error(
          `The model found no object in ${file.name}. It works best on one object on a plain background.`,
        );
      }
      ctx?.log(`${file.name}: ${splats.length} Gaussians.`);
      if (outputFormat.format === "splats-3d") {
        outputs.push({ name: changeExt(file.name, "ply", "-3d"), bytes: splatPly(splats) });
      } else {
        ctx?.progress(`Building a surface for ${file.name}...`, (i + 0.5) / inputFiles.length);
        outputs.push({
          name: changeExt(file.name, outputFormat.extension, "-3d"),
          bytes: await exportMesh(splats, outputFormat.format),
        });
      }
    }
    return outputs;
  }
}

export default imageTo3dHandler;

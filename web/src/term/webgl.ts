/*
 * WebGL terminal-grid renderer.
 *
 * One draw call per frame: four vertices, one fullscreen quad over the grid
 * area. The cell buffer goes up as a cols x rows RGBA8 texture whose channels
 * are (glyph, fg slot, bg slot, flags), and the fragment shader does the glyph
 * lookup and the palette lookup per pixel.
 *
 * Why this shape rather than one instanced quad per cell: it uploads a
 * comparable amount of data (19 KB at 120x40), needs no instancing extension so
 * plain WebGL1 works, and leaves a post-processing pass as a 20-line addition
 * rather than a redesign.
 *
 * The palette is a texture, not a uniform array, because GLSL ES 1.0 restricts
 * dynamic indexing of uniform arrays.
 *
 * Output is opaque with blending disabled, so CP_EMPTY (default fg on blue) and
 * CP_CURSOR (black on white) come out right with no premultiplied-alpha trap.
 */
import { ATLAS_COLS, ATLAS_ROWS, ATLAS_ROWS_PER_WEIGHT, type Atlas } from "./atlas";
import { PALETTE_SLOTS, paletteTexels, type Palette } from "./palette";
import type { Surface } from "./surface";

const VERT = `
attribute vec2 aPos;
uniform vec4 uRect;      // clip-space x, y, w, h of the grid area
varying vec2 vUV;        // 0..1 across the grid, y=0 at the TOP row
void main() {
  vUV = vec2(aPos.x, 1.0 - aPos.y);
  gl_Position = vec4(uRect.xy + aPos * uRect.zw, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
uniform sampler2D uCells;
uniform sampler2D uAtlas;
uniform sampler2D uPalette;
uniform vec2 uGrid;        // cols, rows
uniform vec2 uAtlasGrid;   // ATLAS_COLS, ATLAS_ROWS
uniform float uBoldRow;    // ATLAS_ROWS_PER_WEIGHT
uniform float uSlots;      // PALETTE_SLOTS
varying vec2 vUV;

vec3 slot(float idx) {
  return texture2D(uPalette, vec2((idx + 0.5) / uSlots, 0.5)).rgb;
}

void main() {
  vec2 cellF = vUV * uGrid;
  vec2 cellI = floor(cellF);
  vec2 inCell = cellF - cellI;

  vec4 c = texture2D(uCells, (cellI + 0.5) / uGrid);
  float glyph = floor(c.r * 255.0 + 0.5);
  float fgIdx = floor(c.g * 255.0 + 0.5);
  float bgIdx = floor(c.b * 255.0 + 0.5);
  float flags = floor(c.a * 255.0 + 0.5);
  float bold  = step(0.5, mod(flags, 2.0));

  float tile = max(glyph - 32.0, 0.0);
  float ax = mod(tile, uAtlasGrid.x);
  float ay = floor(tile / uAtlasGrid.x) + bold * uBoldRow;
  float cov = texture2D(uAtlas, (vec2(ax, ay) + inCell) / uAtlasGrid).a;

  gl_FragColor = vec4(mix(slot(bgIdx), slot(fgIdx), cov), 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(s)}`);
  }
  return s;
}

export interface GridMetrics {
  cellW: number; // device pixels
  cellH: number;
  originX: number; // device pixels from the left of the backing store
  originY: number;
}

export class GridRenderer {
  private gl!: WebGLRenderingContext;
  private prog!: WebGLProgram;
  private quad!: WebGLBuffer;
  private texCells!: WebGLTexture;
  private texAtlas!: WebGLTexture;
  private texPalette!: WebGLTexture;
  private loc!: Record<string, WebGLUniformLocation | null>;
  private uploadedVersion = -1;
  private uploadedCols = -1;
  private uploadedRows = -1;
  private lost = false;
  private atlas: Atlas | null = null;
  private palette: Palette | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.initContext();
    // A GPU reset otherwise kills the game silently. ~20 lines, not optional.
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.initContext();
      if (this.atlas) this.setAtlas(this.atlas);
      if (this.palette) this.setPalette(this.palette);
      this.uploadedVersion = -1;
      this.lost = false;
    });
  }

  get contextLost(): boolean {
    return this.lost;
  }

  private initContext(): void {
    const gl =
      this.canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false }) ??
      this.canvas.getContext("experimental-webgl", { alpha: false, antialias: false });
    if (!gl) throw new Error("WebGL is not available in this browser");
    this.gl = gl as WebGLRenderingContext;
    const g = this.gl;

    const prog = g.createProgram()!;
    g.attachShader(prog, compile(g, g.VERTEX_SHADER, VERT));
    g.attachShader(prog, compile(g, g.FRAGMENT_SHADER, FRAG));
    g.linkProgram(prog);
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
      throw new Error(`program link failed: ${g.getProgramInfoLog(prog)}`);
    }
    this.prog = prog;
    g.useProgram(prog);

    this.quad = g.createBuffer()!;
    g.bindBuffer(g.ARRAY_BUFFER, this.quad);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), g.STATIC_DRAW);
    const aPos = g.getAttribLocation(prog, "aPos");
    g.enableVertexAttribArray(aPos);
    g.vertexAttribPointer(aPos, 2, g.FLOAT, false, 0, 0);

    this.loc = {
      uRect: g.getUniformLocation(prog, "uRect"),
      uCells: g.getUniformLocation(prog, "uCells"),
      uAtlas: g.getUniformLocation(prog, "uAtlas"),
      uPalette: g.getUniformLocation(prog, "uPalette"),
      uGrid: g.getUniformLocation(prog, "uGrid"),
      uAtlasGrid: g.getUniformLocation(prog, "uAtlasGrid"),
      uBoldRow: g.getUniformLocation(prog, "uBoldRow"),
      uSlots: g.getUniformLocation(prog, "uSlots"),
    };

    this.texCells = this.makeTex();
    this.texAtlas = this.makeTex();
    this.texPalette = this.makeTex();

    g.disable(g.BLEND);
    g.disable(g.DEPTH_TEST);
    g.uniform1i(this.loc.uCells!, 0);
    g.uniform1i(this.loc.uAtlas!, 1);
    g.uniform1i(this.loc.uPalette!, 2);
    g.uniform2f(this.loc.uAtlasGrid!, ATLAS_COLS, ATLAS_ROWS);
    g.uniform1f(this.loc.uBoldRow!, ATLAS_ROWS_PER_WEIGHT);
    g.uniform1f(this.loc.uSlots!, PALETTE_SLOTS);
  }

  private makeTex(): WebGLTexture {
    const g = this.gl;
    const t = g.createTexture()!;
    g.bindTexture(g.TEXTURE_2D, t);
    // NEAREST throughout: no filtering anywhere means no softness anywhere.
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    return t;
  }

  setAtlas(atlas: Atlas): void {
    this.atlas = atlas;
    const g = this.gl;
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_2D, this.texAtlas);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, atlas.canvas as TexImageSource);
  }

  setPalette(p: Palette): void {
    this.palette = p;
    const g = this.gl;
    g.activeTexture(g.TEXTURE2);
    g.bindTexture(g.TEXTURE_2D, this.texPalette);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, PALETTE_SLOTS, 1, 0, g.RGBA, g.UNSIGNED_BYTE, paletteTexels(p));
  }

  draw(surface: Surface, m: GridMetrics): void {
    if (this.lost || surface.cols === 0 || surface.rows === 0) return;
    const g = this.gl;
    const bw = this.canvas.width;
    const bh = this.canvas.height;

    g.viewport(0, 0, bw, bh);
    const bg = this.palette ? this.palette.defaultBg : "#000000";
    const n = parseInt(bg.slice(1), 16);
    g.clearColor(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1);
    g.clear(g.COLOR_BUFFER_BIT);

    g.useProgram(this.prog);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, this.texCells);
    const sizeChanged = surface.cols !== this.uploadedCols || surface.rows !== this.uploadedRows;
    if (sizeChanged || surface.version !== this.uploadedVersion) {
      if (sizeChanged) {
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, surface.cols, surface.rows, 0, g.RGBA, g.UNSIGNED_BYTE, surface.cells);
        this.uploadedCols = surface.cols;
        this.uploadedRows = surface.rows;
      } else {
        g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, surface.cols, surface.rows, g.RGBA, g.UNSIGNED_BYTE, surface.cells);
      }
      this.uploadedVersion = surface.version;
    }

    const pxW = surface.cols * m.cellW;
    const pxH = surface.rows * m.cellH;
    // Device pixels -> clip space. Y is flipped: the grid's top edge is at the
    // larger clip-space y.
    const x0 = (m.originX / bw) * 2 - 1;
    const y1 = 1 - (m.originY / bh) * 2;
    const w = (pxW / bw) * 2;
    const h = (pxH / bh) * 2;
    g.uniform4f(this.loc.uRect!, x0, y1 - h, w, h);
    g.uniform2f(this.loc.uGrid!, surface.cols, surface.rows);
    g.bindBuffer(g.ARRAY_BUFFER, this.quad);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  }
}

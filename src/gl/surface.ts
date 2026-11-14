// One WebGL2 canvas and its program. Cards are drawn into it as quads, one draw each; their
// face images are uploaded on first use and kept until the context is lost or released.
//
// A per-card raster cache (content rendered into a texture per card, composited while its look
// held still) was tried and dropped: on the phone it lost to drawing every card directly in
// every scenario (Stack idle 108 -> 98 fps, scrub 103 -> 88), even caching settled cards only.

import type { FaceImages } from "./faces";
import { FRAGMENT, VERTEX } from "./shader";
import type { GlTokens, Rgba } from "./tokens";

/** Everything the shader needs to draw one card, in the surface's layout px. */
export interface CardDraw {
  readonly id: string;
  readonly cx: number;
  readonly cy: number;
  readonly halfW: number;
  readonly halfH: number;
  readonly margin: number;
  /** rotateX . rotateY . rotateZ . skewX . scale, column-major for uniformMatrix3fv. */
  readonly m: Float32Array;
  readonly persp: number;
  readonly r: number;
  readonly floats: Readonly<Partial<Record<UniformName, number | readonly number[]>>>;
  readonly fx: number;
}

export interface CardImages {
  /** A region of an atlas; undefined when the face is only an image (an empty texture). */
  readonly face: FaceImages["face"];
  readonly art: TexImageSource | undefined;
  /** The card back, a region of an atlas. */
  readonly back: FaceImages["face"];
}

const UNIFORMS = [
  "uView",
  "uCenter",
  "uHalf",
  "uMargin",
  "uM",
  "uPersp",
  "uR",
  "uTime",
  "uFace",
  "uFaceUv",
  "uBackTex",
  "uBackUv",
  "uBack",
  "uArt",
  "uGrain",
  "uHasArt",
  "uArtOnTop",
  "uArtRect",
  "uArtR",
  "uArtOffset",
  "uArtFit",
  "uArtScale",
  "uKb",
  "uEmber",
  "uFilter",
  "uGrainOp",
  "uGrainSize",
  "uFoil",
  "uFoilSize",
  "uGlare",
  "uLobe",
  "uSpot",
  "uHot",
  "uEdge",
  "uHairline",
  "uShadowA",
  "uShadowB",
  "uFx",
  "uSweep",
  "uRing",
  "uTracePad",
  "uPaper",
  "uGlint",
  "uShade",
  "uGold",
  "uTraceRun",
  "uTraceRunB",
  "uTraceBase",
] as const;


export type UniformName = (typeof UNIFORMS)[number];

/** Locations by name; WebGL's own type, which uses null for an unused uniform. */
type Uniforms = Readonly<Record<UniformName, ReturnType<WebGL2RenderingContext["getUniformLocation"]>>>;

function compile(gl: WebGL2RenderingContext, type: GLenum, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("gl: createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`gl: shader compile failed: ${gl.getShaderInfoLog(sh) ?? ""}`);
  }
  return sh;
}

export class Surface {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | undefined;
  private u: Uniforms | undefined;
  /** Uploaded images by source, so an atlas shared by many cards is uploaded once. */
  private readonly textures = new Map<TexImageSource, WebGLTexture>();
  private grain: WebGLTexture | undefined;
  private empty: WebGLTexture | undefined;
  private aniso: number | undefined;
  private lost = false;


  constructor(
    canvas: HTMLCanvasElement,
    private readonly tokens: GlTokens,
    private readonly grainImage: TexImageSource,
    private readonly images: (id: string) => CardImages | undefined,
  ) {
    this.canvas = canvas;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
      this.init();
    });
    this.init();
  }

  private init(): void {
    const gl = this.canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) throw new Error("gl: WebGL2 unavailable");
    this.gl = gl;
    this.textures.clear();
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(prog, 0, "aCorner");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`gl: link failed: ${gl.getProgramInfoLog(prog) ?? ""}`);
    }
    gl.useProgram(prog);
    const u = Object.fromEntries(
      UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)]),
    ) as Uniforms;
    this.u = u;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const ext = gl.getExtension("EXT_texture_filter_anisotropic");
    this.aniso = ext
      ? Math.min(4, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number)
      : undefined;
    this.grain = this.upload(this.grainImage, true);
    this.empty = this.upload(new ImageData(1, 1), false);
    const t = this.tokens;
    const set4 = (name: UniformName, v: Rgba): void => {
      gl.uniform4f(u[name], ...v);
    };
    set4("uPaper", t.paper);
    set4("uGlint", t.glint);
    set4("uShade", t.shade);
    set4("uGold", t.gold);
    set4("uTraceRun", t.traceRun);
    set4("uTraceRunB", t.traceRunB);
    set4("uTraceBase", t.traceBase);
    gl.uniform1f(u.uGrainSize, t.grainSize);
    gl.uniform1f(u.uHairline, t.hairline);
    gl.uniform1f(u.uFoilSize, t.foilSize);
    gl.uniform1f(u.uTracePad, t.tracePad);
    gl.uniform4f(u.uRing, t.ringPad, t.ringGlowPad, t.ringGlowBlur, t.ringSpan);
    gl.uniform1i(u.uFace, 0);
    gl.uniform1i(u.uArt, 1);
    gl.uniform1i(u.uGrain, 2);
    gl.uniform1i(u.uBackTex, 3);
  }

  private upload(src: TexImageSource, isRepeat: boolean): WebGLTexture {
    const gl = this.gl;
    if (!gl) throw new Error("gl: no context");
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wrap = isRepeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (this.aniso !== undefined) gl.texParameterf(gl.TEXTURE_2D, 0x84_FE, this.aniso);
    return tex;
  }

  /** Drops uploaded face images, after the faces were rasterized again. */
  forget(): void {
    const gl = this.gl;
    for (const t of this.textures.values()) gl?.deleteTexture(t);
    this.textures.clear();
  }

  /** Clears the canvas at `dpr` device px per layout px and returns false if it cannot draw. */
  begin(): boolean {
    const gl = this.gl;
    if (!gl || this.lost) return false;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return true;
  }

  /** Binds a card's images and sets its uniforms; false when its images are not loaded. */
  private setCard(d: CardDraw, view: readonly [number, number], time: number): boolean {
    const { gl, u, grain, empty } = this;
    if (!gl || !u || !grain || !empty) return false;
    const img = this.images(d.id);
    if (!img) return false;
    const texture = (src: TexImageSource | undefined): WebGLTexture => {
      if (!src) return empty;
      let tex = this.textures.get(src);
      if (!tex) {
        tex = this.upload(src, false);
        this.textures.set(src, tex);
      }
      return tex;
    };
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture(img.face?.source));
    gl.uniform4f(u.uFaceUv, ...(img.face?.uv ?? [0, 0, 1, 1]));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texture(img.art));
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, grain);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, texture(img.back?.source));
    gl.uniform4f(u.uBackUv, ...(img.back?.uv ?? [0, 0, 1, 1]));
    gl.uniform2f(u.uView, view[0], view[1]);
    gl.uniform1f(u.uTime, time);
    gl.uniform2f(u.uCenter, d.cx, d.cy);
    gl.uniform2f(u.uHalf, d.halfW, d.halfH);
    gl.uniform1f(u.uMargin, d.margin);
    gl.uniformMatrix3fv(u.uM, false, d.m);
    gl.uniform1f(u.uPersp, d.persp);
    gl.uniform1f(u.uR, d.r);
    gl.uniform1i(u.uFx, d.fx);
    for (const [name, v] of Object.entries(d.floats) as [UniformName, number | readonly number[]][]) {
      const loc = u[name];
      if (typeof v === "number") gl.uniform1f(loc, v);
      else if (v.length === 2) gl.uniform2f(loc, v[0] ?? 0, v[1] ?? 0);
      else if (v.length === 3) gl.uniform3f(loc, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
      else gl.uniform4f(loc, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0);
    }
    return true;
  }


  /** Draws one card; call between `begin` and the next `begin`. */
  draw(d: CardDraw, view: readonly [number, number], time: number): void {
    if (this.setCard(d, view, time)) this.gl?.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Uploads a changed rectangle of an image already in use (live text drawn into an atlas);
   * returns false when this canvas has not uploaded that image.
   */
  updateRegion(src: HTMLCanvasElement, x: number, y: number, w: number, h: number): boolean {
    const gl = this.gl;
    const tex = this.textures.get(src);
    const ctx = src.getContext("2d");
    if (!gl || !tex || !ctx) return false;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, ctx.getImageData(x, y, w, h));
    gl.generateMipmap(gl.TEXTURE_2D);
    return true;
  }

  /** Frees uploaded images whose source is no longer in use (a face snapshotted again). */
  retainSources(inUse: ReadonlySet<TexImageSource>): void {
    for (const [src, tex] of this.textures) {
      if (inUse.has(src)) continue;
      this.gl?.deleteTexture(tex);
      this.textures.delete(src);
    }
  }

  /**
   * Gives the context's memory back at once (canvas buffers, textures) instead of
   * when the page is collected; repeated reloads otherwise piled GPU memory up on a phone
   * until Android killed the tab.
   */
  release(): void {
    this.forget();
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = undefined;
  }
}

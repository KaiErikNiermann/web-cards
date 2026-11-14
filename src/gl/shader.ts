// GLSL for one card drawn as one quad: shadow, the border effects behind the face, the face
// (rasterized from the DOM) with parallax art, the material layers and the animated effects,
// clipped to the rounded card. It reproduces cards.css layer by layer; every colour and size
// comes from the tokens (read at start-up, tokens.ts), but the gradient stop positions and
// angles below repeat the ones in tokens.css and must change with them.
//
// Colours are premultiplied throughout. Blend modes follow the compositing spec for an opaque
// backdrop: $C = (1 - \alpha_s) C_b + \alpha_s B(C_b, C_s)$.

export const VERTEX = `#version 300 es
precision highp float;
// Unit quad corner in [-1, 1].
in vec2 aCorner;
uniform vec2 uView;     // surface size in layout px
uniform vec2 uCenter;   // card centre in surface layout px
uniform vec2 uHalf;     // half the card size
uniform float uMargin;  // quad margin beyond the card, for shadow and border effects
uniform mat3 uM;        // rotateX . rotateY . rotateZ . skewX . scale (CSS order)
uniform float uPersp;   // CSS perspective distance
out vec2 vLocal;        // position relative to the card centre, in card px (y down)

void main() {
  vec2 local = aCorner * (uHalf + uMargin);
  vec3 p = uM * vec3(local, 0.0);
  // CSS perspective(d): w = 1 - z / d, with z toward the viewer.
  float w = 1.0 - p.z / uPersp;
  vec2 screen = uCenter * w + p.xy;
  vec2 ndc = vec2(screen.x / uView.x * 2.0 - w, w - screen.y / uView.y * 2.0);
  gl_Position = vec4(ndc, 0.0, w);
  vLocal = local;
}
`;

export const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vLocal;
out vec4 outColor;

uniform vec2 uHalf;
uniform float uR;
uniform float uTime;

uniform sampler2D uFace;   // face text, plates and gradients (premultiplied), in an atlas
uniform vec4 uFaceUv;      // this face's region of the atlas
uniform sampler2D uBackTex; // the card back (an atlas)
uniform vec4 uBackUv;      // its region
uniform float uBack;       // 1 when the card is turned so its back faces the viewer
uniform sampler2D uArt;    // the face's image (the decoded <img>, downscaled)
uniform sampler2D uGrain;
uniform float uHasArt;
uniform float uArtOnTop;
uniform vec4 uArtRect;     // window x, y, w, h in card px from the top-left corner
uniform float uArtR;
uniform vec2 uArtOffset;   // parallax translation
uniform vec4 uArtFit;      // object-fit: cover offset x, y and drawn size in the art box
uniform float uArtScale;   // the parallax layer's scale (1.1), or 1 for a plain image
uniform vec3 uKb;          // Ken Burns scale and translation (fraction of the window)
uniform float uEmber;      // ember layer opacity, 0 when the face has none
uniform vec2 uFilter;      // face contrast, saturate

uniform float uGrainOp;
uniform float uGrainSize;
uniform vec3 uFoil;        // opacity, background-position x and y in %
uniform float uFoilSize;   // tile as a multiple of the card size
uniform vec4 uGlare;       // opacity, sheen alpha, is soft-light, spot side (x card width)
uniform vec4 uLobe;        // a1, a1 mid, r1 %, r2 %
uniform vec2 uSpot;        // lobe centre in card px from the top-left corner
uniform vec3 uHot;         // opacity, alpha, radius %
uniform vec2 uEdge;        // ring alpha, top alpha
uniform float uHairline;
uniform vec4 uShadowA;     // offset x, y, blur, alpha (on top)
uniform vec4 uShadowB;
uniform int uFx;           // 0 none, 1 orbit, 2 trace, 3 dual, 4 live
uniform float uSweep;      // sweep translation as a fraction of the sweep box width
uniform vec4 uRing;        // ring pad, glow pad, glow blur, spin square side (x card width)
uniform float uTracePad;

uniform vec4 uPaper;
uniform vec4 uGlint;
uniform vec4 uShade;
uniform vec4 uGold;
uniform vec4 uTraceRun;
uniform vec4 uTraceRunB;
uniform vec4 uTraceBase;

const float PI = 3.14159265;
const float TAU = 6.28318531;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Abramowitz-Stegun 7.1.26, |error| < 1.5e-7.
float erfApprox(float x) {
  float s = sign(x);
  x = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * x);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * exp(-x * x);
  return s * y;
}

// Coverage of a shape blurred by a Gaussian of deviation sigma, from its signed distance.
float blurredCover(float sd, float sigma) {
  return 0.5 - 0.5 * erfApprox(sd / (sigma * 1.41421356));
}

vec4 over(vec4 top, vec4 under) { return top + under * (1.0 - top.a); }

vec3 unpremul(vec4 c) { return c.a > 0.0 ? c.rgb / c.a : vec3(0.0); }

vec3 blendOverlay(vec3 b, vec3 s) {
  return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
}

vec3 blendSoftLight(vec3 b, vec3 s) {
  vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));
  return mix(b + (2.0 * s - 1.0) * (d - b), b - (1.0 - 2.0 * s) * b * (1.0 - b), step(s, vec3(0.5)));
}

vec3 blendScreen(vec3 b, vec3 s) { return b + s - b * s; }

vec3 blendDodge(vec3 b, vec3 s) {
  vec3 r = min(vec3(1.0), b / max(1.0 - s, 1e-4));
  r = mix(r, vec3(1.0), step(1.0, s));
  return mix(r, vec3(0.0), step(b, vec3(0.0)));
}

// Layer s (premultiplied, with opacity) blended onto the opaque backdrop b.
vec4 blendOnto(vec4 b, vec4 s, float op, int mode) {
  float a = s.a * op;
  if (a <= 0.0) return b;
  vec3 cs = unpremul(s);
  vec3 r;
  if (mode == 0) r = blendOverlay(b.rgb, cs);
  else if (mode == 1) r = blendSoftLight(b.rgb, cs);
  else if (mode == 2) r = blendScreen(b.rgb, cs);
  else r = blendDodge(b.rgb, cs);
  return vec4(b.rgb * (1.0 - a) + a * r, 1.0);
}

// Distance along a CSS linear-gradient line of angle deg over a box, as t in [0, 1].
float gradT(vec2 fromCentre, vec2 box, float deg) {
  float a = radians(deg);
  vec2 dir = vec2(sin(a), -cos(a));
  float len = abs(box.x * sin(a)) + abs(box.y * cos(a));
  return dot(fromCentre, dir) / len + 0.5;
}

// CSS angle of p about the centre: 0 at the top, growing clockwise (y down).
float cssAngle(vec2 p) {
  float a = atan(p.x, -p.y);
  return a < 0.0 ? a + TAU : a;
}

// Orbit sweep (tokens --ring-gold, --glint; stops 230, 318, 352, 360 deg), premultiplied.
vec4 orbitConic(float a) {
  float d = degrees(mod(a, TAU));
  vec4 gold = uGold * 0.85;
  if (d < 230.0) return vec4(0.0);
  if (d < 318.0) return gold * ((d - 230.0) / 88.0);
  if (d < 352.0) return mix(gold, uGlint, (d - 318.0) / 34.0);
  return uGlint * (1.0 - (d - 352.0) / 8.0);
}

float inSquare(vec2 p, float theta, float half_) {
  float c = cos(theta), s = sin(theta);
  vec2 r = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
  return step(max(abs(r.x), abs(r.y)), half_);
}

// Hard-stopped repeating conic dash, anti-aliased over one pixel of arc.
float dash(float a, float period, float on, float px) {
  float d = mod(a, period);
  float aa = max(px, 1e-4);
  return smoothstep(-aa, aa, d) * (1.0 - smoothstep(on - aa, on + aa, d));
}

vec4 behind(vec2 p, float pxSize) {
  vec4 col = vec4(0.0);
  float spinHalf = uRing.w * uHalf.x;
  if (uFx == 1) {
    float theta = TAU * uTime / 3.4;
    float a = cssAngle(p) - theta;
    // Glow: the sweep clipped to a box past the card, blurred. Blur is approximated as an
    // angular Gaussian of the sweep times the blurred coverage of the box.
    float sigma = uRing.z;
    float sa = sigma / max(length(p), 1.0);
    vec4 blurred = (orbitConic(a - 2.0 * sa) + 4.0 * orbitConic(a - sa) + 6.0 * orbitConic(a)
      + 4.0 * orbitConic(a + sa) + orbitConic(a + 2.0 * sa)) / 16.0;
    float gd = sdRoundBox(p, uHalf + uRing.y, uR + uRing.y);
    col = blurred * blurredCover(gd, sigma) * 0.9;
    float rd = sdRoundBox(p, uHalf + uRing.x, uR + uRing.x);
    float ring = clamp(0.5 - rd / pxSize, 0.0, 1.0) * inSquare(p, theta, spinHalf);
    col = over(orbitConic(a) * ring, col);
  } else if (uFx == 2 || uFx == 3) {
    float td = sdRoundBox(p, uHalf + uTracePad, uR + uTracePad);
    float cover = clamp(0.5 - td / pxSize, 0.0, 1.0);
    vec4 c = uTraceBase;
    float ang = cssAngle(p);
    float arcPx = pxSize / max(length(p), 1.0);
    float ta = TAU * uTime / 3.2;
    // Two dashes of 32 deg in 180 (token --trace-run).
    c = over(uTraceRun * dash(ang - ta, PI, radians(32.0), arcPx) * inSquare(p, ta, spinHalf), c);
    if (uFx == 3) {
      float tb = -TAU * uTime / 5.0;
      // Four dashes of 18 deg in 90, running the other way (token --trace-runb).
      c = over(uTraceRunB * dash(ang - tb, PI * 0.5, radians(18.0), arcPx) * inSquare(p, tb, spinHalf), c);
    }
    col = c * cover;
  }
  return col;
}

vec4 shadowOf(vec2 p, vec4 s) {
  float sd = sdRoundBox(p - s.xy, uHalf, uR);
  return uShade * s.w * blurredCover(sd, max(s.z * 0.5, 0.01));
}

vec4 artAt(vec2 q) {
  vec2 wq = q - uArtRect.xy;
  vec2 size = uArtRect.zw;
  vec2 c = size * 0.5;
  float inside = clamp(0.5 - sdRoundBox(wq - c, c, uArtR) / length(fwidth(q)), 0.0, 1.0);
  // .par: translate(art) scale(1.1) about the centre; .kb: scale(s) translate(t).
  vec2 p1 = (wq - c - uArtOffset) / uArtScale + c;
  vec2 p2 = (p1 - c) / uKb.x - uKb.yz * size + c;
  return texture(uArt, (p2 - uArtFit.xy) / uArtFit.zw) * inside;
}

// Ember glow (token --ember-glow): ellipse at 50% 62%, farthest-corner, 55% alpha to clear at 55%.
vec4 emberAt(vec2 q, vec2 size) {
  vec2 c = vec2(0.5, 0.62) * size;
  vec2 rad = 1.41421356 * max(c, size - c);
  float d = length((q - c) / rad);
  return vec4(1.0, 90.0 / 255.0, 60.0 / 255.0, 1.0) * 0.55 * max(0.0, 1.0 - d / 0.55);
}

vec3 filtered(vec3 c) {
  c = (c - 0.5) * uFilter.x + 0.5;
  float s = uFilter.y;
  mat3 sat = mat3(
    0.213 + 0.787 * s, 0.213 - 0.213 * s, 0.213 - 0.213 * s,
    0.715 - 0.715 * s, 0.715 + 0.285 * s, 0.715 - 0.715 * s,
    0.072 - 0.072 * s, 0.072 - 0.072 * s, 0.072 + 0.928 * s);
  return clamp(sat * c, 0.0, 1.0);
}

// Foil (token --foil-band): repeating 115 deg band of 36% with six hues.
vec3 foilBand(float t) {
  float u = mod(t, 0.36) / 0.06;
  vec3 h[7] = vec3[7](vec3(1.0, 0.502, 0.502), vec3(1.0, 0.827, 0.431), vec3(0.549, 1.0, 0.620),
    vec3(0.435, 0.902, 1.0), vec3(0.663, 0.545, 1.0), vec3(1.0, 0.502, 0.851), vec3(1.0, 0.502, 0.502));
  int i = int(floor(u));
  return mix(h[i], h[min(i + 1, 6)], fract(u));
}

vec4 clipContent(vec2 p, float pxSize) {
  vec2 size = uHalf * 2.0;
  vec2 q = p + uHalf;
  // Seen from behind, the card's x runs the other way across the screen.
  vec4 face = uBack > 0.5
    ? texture(uBackTex, uBackUv.xy + vec2(1.0 - q.x / size.x, q.y / size.y) * uBackUv.zw)
    : texture(uFace, uFaceUv.xy + q / size * uFaceUv.zw);
  if (uHasArt > 0.5 && uBack < 0.5) {
    vec4 art = artAt(q);
    if (uArtOnTop > 0.5) {
      face = over(art, face);
    } else {
      vec4 under = art;
      if (uEmber > 0.0) under = blendOnto(vec4(unpremul(under), 1.0), emberAt(q, size), uEmber, 2) * under.a;
      face = over(face, under);
    }
  }
  face = vec4(filtered(unpremul(face)) * face.a, face.a);
  vec4 col = over(face, uPaper);
  if (uGrainOp > 0.01) col = blendOnto(col, texture(uGrain, q / uGrainSize), uGrainOp, 0);
  if (uFoil.x > 0.01) {
    vec2 tile = size * uFoilSize;
    vec2 off = (size - tile) * uFoil.yz / 100.0;
    vec2 pt = mod(q - off, tile);
    col = blendOnto(col, vec4(foilBand(gradT(pt - tile * 0.5, tile, 115.0)), 1.0), uFoil.x, 3);
  }
  // Glare: the clearcoat sheen with the lobe over it, as one layer.
  float tLin = gradT(q - uHalf, size, 160.0);
  float aLin = uGlare.y * (1.0 - clamp(tLin / 0.42, 0.0, 1.0));
  float rr = 100.0 * length(q - uSpot) / (uGlare.w * size.x * 0.5);
  float aSpot = rr < uLobe.z ? mix(uLobe.x, uLobe.y, rr / uLobe.z)
    : max(0.0, mix(uLobe.y, 0.0, (rr - uLobe.z) / (uLobe.w - uLobe.z)));
  float aGl = aSpot + aLin * (1.0 - aSpot);
  col = blendOnto(col, uGlint * aGl, uGlare.x, uGlare.z > 0.5 ? 1 : 0);
  if (uHot.x > 0.01) {
    float aHot = uHot.y * max(0.0, 1.0 - rr / uHot.z);
    col = blendOnto(col, uGlint * aHot, uHot.x, 2);
  }
  if (uFx == 4) {
    // Sweep box: 220% x 120% of the card from (-60%, -10%), moved along x.
    vec2 box = size * vec2(2.2, 1.2);
    vec2 pb = q - vec2(-0.6 * size.x + uSweep * box.x, -0.1 * size.y);
    float t = gradT(pb - box * 0.5, box, 104.0);
    float a = 0.42 * max(0.0, 1.0 - abs(t - 0.5) / 0.08);
    col = blendOnto(col, uGlint * a, 1.0, 0);
  }
  // Edge: inset 1px top highlight, then the hairline ring over it.
  float sd = sdRoundBox(p, uHalf, uR);
  float top = clamp(sdRoundBox(p - vec2(0.0, uHairline), uHalf, uR) / pxSize + 0.5, 0.0, 1.0);
  col = over(uGlint * uEdge.y * top, col);
  float ring = clamp((sd + uHairline) / pxSize + 0.5, 0.0, 1.0);
  col = over(uGlint * uEdge.x * ring, col);
  return col;
}

void main() {
  vec2 p = vLocal;
  float pxSize = max(length(fwidth(p)) * 0.7071, 1e-3);
  float sd = sdRoundBox(p, uHalf, uR);
  vec4 col = over(shadowOf(p, uShadowA), shadowOf(p, uShadowB));
  col = over(behind(p, pxSize), col);
  float cover = clamp(0.5 - sd / pxSize, 0.0, 1.0);
  if (cover > 0.0) col = over(clipContent(p, pxSize) * cover, col);
  outColor = col;
}
`;

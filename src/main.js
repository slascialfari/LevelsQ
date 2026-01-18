// LevelQ Proto — layered levels + HOME in carousel
//
// Draw order (back -> front):
// 1) Background (REQUIRED)            [zoom+pan follow]
// 2) Layer 1 (optional)               [image or frames; align bg/screen]
// 3) Hero
// 4) Layer 2 (optional)               [overlay; image or frames; align bg/screen]
// 5) Layer 3 (optional)               [title; image or frames; align bg/screen]
// 6) Layer 4 (optional)               [arrows; image or frames; align bg/screen]
// 7) Foreground (optional; TRUE FG)   [zoom+pan follow; ONLY parallax layer]
//
// HOME behavior:
// - Level with `isHome:true` starts first
// - HOME is INCLUDED in carousel/loop
// - Until all non-home levels have been used, moving into new territory appends/prepends unused non-home levels
// - After all non-home levels are used, carousel loops across ALL items (including HOME)

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const W = canvas.width;
const H = canvas.height;

// Logical floor (never drawn)
const FLOOR_Y = 600;

// =========================
// SPRITES
// =========================
const SPRITES = {
  idle: { folder: "assets/sprites/hero_idle", fps: 6 },
  walk: { folder: "assets/sprites/hero_walk", fps: 12 },
};

// -------- TWEAKABLE VISUAL CONSTANTS --------
const SPRITE_SCALE = 0.34;
const FEET_FUDGE_PX = 0;
const WALK_BOB_PX = 0; // 0 disables
// -------------------------------------------

// -------- PAN-FOLLOW (non-tiling, no seams) --------
const BG_ZOOM = 1.05;
const FG_ZOOM = 1.02;

const BG_FOLLOW = 0.025;
const FG_FOLLOW = 0.55;

const MAX_PAN_PX = 55;
// -------------------------------------------

const DEFAULT_LAYER_FPS = 12;

let levelData = [];
let heroIdleFrames = [];
let heroWalkFrames = [];

// levelAssets.get(level.id) => { bgImg, fgImg|null, l1|null, l2|null, l3|null, l4|null }
const levelAssets = new Map();

const state = {
  levelIndex: 0,
  transitioning: false,
  transitionUntil: 0,
  lastEdge: null,

  // Carousel stores LEVEL INDICES (not ids)
  carousel: [],
  carouselPos: 0,

  // Home index in levelData (or -1)
  homeIndex: -1,
};

const player = {
  x: Math.floor(W / 2),
  speed: 90,
  visible: true,
  facing: 1,
  anim: "idle",
  frameIndex: 0,
  frameTimer: 0,
  renderW: 26,
  renderH: 56,
};

const input = { left: false, right: false };

window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") input.left = true;
  if (e.key === "ArrowRight") input.right = true;
});

window.addEventListener("keyup", (e) => {
  if (e.key === "ArrowLeft") input.left = false;
  if (e.key === "ArrowRight") input.right = false;
});

// ---------- Helpers ----------
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function randInt(min, maxInclusive) {
  return Math.floor(Math.random() * (maxInclusive - min + 1)) + min;
}

function warnOnce(key, msg) {
  if (!warnOnce._seen) warnOnce._seen = new Set();
  if (warnOnce._seen.has(key)) return;
  warnOnce._seen.add(key);
  console.warn(msg);
}

function isHomeIndex(i) {
  return state.homeIndex !== -1 && i === state.homeIndex;
}

// ---------- Carousel helpers ----------
function nonHomeIndices() {
  const out = [];
  for (let i = 0; i < levelData.length; i++) {
    if (!isHomeIndex(i)) out.push(i);
  }
  return out;
}

function usedNonHomeCount() {
  return state.carousel.filter((i) => !isHomeIndex(i)).length;
}

function pickUnusedNonHomeLevelIndex() {
  const used = new Set(state.carousel);
  const pool = nonHomeIndices().filter((i) => !used.has(i));
  if (pool.length === 0) {
    // fallback (shouldn't happen if called correctly)
    const nonHome = nonHomeIndices();
    return nonHome[0] ?? 0;
  }
  return pool[randInt(0, pool.length - 1)];
}

function initCarouselWithHomeOrFallback() {
  if (state.homeIndex !== -1) {
    state.carousel = [state.homeIndex];
    state.carouselPos = 0;
    state.levelIndex = state.homeIndex;
    return;
  }

  const startIdx = randInt(0, levelData.length - 1);
  state.carousel = [startIdx];
  state.carouselPos = 0;
  state.levelIndex = startIdx;
}

function carouselMoveRight() {
  if (levelData.length <= 1) return state.levelIndex;

  const nonHome = nonHomeIndices();
  const allUsed = usedNonHomeCount() >= nonHome.length;

  if (allUsed) {
    state.carouselPos = (state.carouselPos + 1) % state.carousel.length;
    return state.carousel[state.carouselPos];
  }

  // Not all used yet:
  // If we already have a next element in history, use it.
  if (state.carouselPos < state.carousel.length - 1) {
    state.carouselPos += 1;
    return state.carousel[state.carouselPos];
  }

  // We are at the end: append a new unused non-home
  const nextIdx = pickUnusedNonHomeLevelIndex();
  state.carousel.push(nextIdx);
  state.carouselPos = state.carousel.length - 1;
  return nextIdx;
}

function carouselMoveLeft() {
  if (levelData.length <= 1) return state.levelIndex;

  const nonHome = nonHomeIndices();
  const allUsed = usedNonHomeCount() >= nonHome.length;

  if (allUsed) {
    state.carouselPos =
      (state.carouselPos - 1 + state.carousel.length) % state.carousel.length;
    return state.carousel[state.carouselPos];
  }

  // Not all used yet:
  // If we can go back within history, do it
  if (state.carouselPos > 0) {
    state.carouselPos -= 1;
    return state.carousel[state.carouselPos];
  }

  // At the beginning: prepend a new unused non-home
  const prevIdx = pickUnusedNonHomeLevelIndex();
  state.carousel.unshift(prevIdx);
  state.carouselPos = 0;
  return prevIdx;
}

function setAnim(next) {
  if (player.anim === next) return;
  player.anim = next;
  player.frameIndex = 0;
  player.frameTimer = 0;
}

// Returns hero position normalized to [-1, +1]
function getHeroNormalizedX() {
  const range = Math.max(1, W - player.renderW);
  const t = clamp(player.x / range, 0, 1);
  return t * 2 - 1;
}

// Zoom+pan draw (used for BG + TRUE foreground + bg-aligned layers)
function drawZoomPanFollow(img, zoom, followStrength) {
  if (!img) return;

  const drawW = W * zoom;
  const drawH = H * zoom;

  const maxFromZoom = (drawW - W) / 2;
  const maxPan = Math.min(maxFromZoom, MAX_PAN_PX);

  const heroN = getHeroNormalizedX();
  const pan = clamp(
    heroN * maxPan * clamp(followStrength, 0, 1),
    -maxPan,
    maxPan
  );

  const x = -(drawW - W) / 2 + pan;
  const y = -(drawH - H) / 2;

  ctx.drawImage(img, x, y, drawW, drawH);
}

// ---------- Loaders ----------
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = src;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
  });
}

// Auto-detect hero frames: folder/frame_01.png, frame_02.png, ... until missing
async function loadFrameSequenceAuto(
  folder,
  { prefix = "frame_", start = 1, pad = 2 } = {}
) {
  const frames = [];
  let i = start;

  while (true) {
    const n = String(i).padStart(pad, "0");
    const src = `${folder}/${prefix}${n}.png`;
    try {
      const img = await loadImage(src);
      frames.push(img);
      i++;
    } catch {
      break;
    }
  }

  if (frames.length === 0) {
    throw new Error(
      `No frames found in "${folder}". Expected files like ${folder}/${prefix}${String(start).padStart(pad, "0")}.png`
    );
  }

  return frames;
}

// Count-based loader for level frame layers
function loadFrameSequenceCounted(folder, count) {
  const frames = [];
  const promises = [];

  for (let i = 1; i <= count; i++) {
    const n = String(i).padStart(2, "0");
    const img = new Image();
    img.src = `${folder}/frame_${n}.png`;
    frames.push(img);

    promises.push(
      new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error(`Failed to load ${img.src}`));
      })
    );
  }

  return Promise.all(promises).then(() => frames);
}

/**
 * Optional layer spec supports:
 * - { type:"frames", folder:"...", count: N, fps: 12, align:"bg"|"screen" }
 * - { type:"image",  src:"...", align:"bg"|"screen" }
 *
 * align:
 * - "bg"     => draw with same zoom+pan as background (perfect overlap)
 * - "screen" => draw raw at (0,0,W,H)
 */
async function loadOptionalLayer(levelId, layerSpec, layerName) {
  if (!layerSpec) return null;

  const type = String(layerSpec.type || "frames").toLowerCase();
  const align = String(layerSpec.align || "screen").toLowerCase();
  const safeAlign = align === "bg" ? "bg" : "screen";

  if (type === "image") {
    const src = layerSpec.src;
    if (!src) {
      warnOnce(
        `${levelId}:${layerName}:missingSrc`,
        `[${levelId}] ${layerName} type=image is missing "src". Skipping.`
      );
      return null;
    }

    try {
      const img = await loadImage(src);
      return { kind: "image", img, align: safeAlign };
    } catch (e) {
      warnOnce(
        `${levelId}:${layerName}:loadFail`,
        `[${levelId}] Failed to load ${layerName} image. Skipping. (${e.message})`
      );
      return null;
    }
  }

  if (type === "frames") {
    const count = Number(layerSpec.count || 0);
    if (!count) return null;

    const folder = layerSpec.folder;
    const fps = Number(layerSpec.fps || DEFAULT_LAYER_FPS);

    if (!folder) {
      warnOnce(
        `${levelId}:${layerName}:missingFolder`,
        `[${levelId}] ${layerName} type=frames is missing "folder". Skipping.`
      );
      return null;
    }

    try {
      const frames = await loadFrameSequenceCounted(folder, count);
      return { kind: "frames", frames, fps, timer: 0, frameIndex: 0, align: safeAlign };
    } catch (e) {
      warnOnce(
        `${levelId}:${layerName}:loadFail`,
        `[${levelId}] Failed to load ${layerName} frames. Skipping. (${e.message})`
      );
      return null;
    }
  }

  warnOnce(
    `${levelId}:${layerName}:unsupportedType`,
    `[${levelId}] ${layerName} has unsupported type="${layerSpec.type}". Skipping.`
  );
  return null;
}

async function loadLevels() {
  const res = await fetch("data/levels.json");
  if (!res.ok) throw new Error(`Failed to fetch data/levels.json (${res.status})`);

  const json = await res.json();
  if (!json.levels || !Array.isArray(json.levels) || json.levels.length === 0) {
    throw new Error("data/levels.json must contain { levels: [ ... ] } with at least 1 level");
  }

  const loadedLevels = [];

  for (const lvl of json.levels) {
    const id = lvl.id || "(missing id)";
    const bgSrc = lvl.background;

    if (!bgSrc) {
      console.warn(`[${id}] Missing required "background". Level excluded.`);
      continue;
    }

    try {
      const bgImg = await loadImage(bgSrc);

      // TRUE parallax foreground (optional)
      let fgImg = null;
      if (lvl.foreground) {
        try {
          fgImg = await loadImage(lvl.foreground);
        } catch (e) {
          warnOnce(
            `${id}:foreground:loadFail`,
            `[${id}] Foreground failed to load; continuing without it. (${e.message})`
          );
          fgImg = null;
        }
      }

      const l1 = await loadOptionalLayer(id, lvl.layer1, "layer1");
      const l2 = await loadOptionalLayer(id, lvl.layer2, "layer2");
      const l3 = await loadOptionalLayer(id, lvl.layer3, "layer3");
      const l4 = await loadOptionalLayer(id, lvl.layer4, "layer4");

      loadedLevels.push(lvl);
      levelAssets.set(id, { bgImg, fgImg, l1, l2, l3, l4 });
    } catch (e) {
      console.warn(`[${id}] Background failed to load. Level excluded. (${e.message})`);
    }
  }

  if (loadedLevels.length === 0) {
    throw new Error("No valid levels loaded. Check backgrounds.");
  }

  levelData = loadedLevels;

  // Detect HOME
  state.homeIndex = levelData.findIndex((l) => l && l.isHome === true);

  // Start with HOME in carousel if present
  initCarouselWithHomeOrFallback();
}

async function loadSprites() {
  [heroIdleFrames, heroWalkFrames] = await Promise.all([
    loadFrameSequenceAuto(SPRITES.idle.folder, { prefix: "frame_", start: 1, pad: 2 }),
    loadFrameSequenceAuto(SPRITES.walk.folder, { prefix: "frame_", start: 1, pad: 2 }),
  ]);

  const base = heroIdleFrames[0];
  player.renderW = Math.round(base.width * SPRITE_SCALE);
  player.renderH = Math.round(base.height * SPRITE_SCALE);
  player.x = clamp(player.x, 0, W - player.renderW);
}

// ---------- Rendering ----------
function currentLevel() {
  return levelData[state.levelIndex];
}

function currentLevelAssets() {
  const lvl = currentLevel();
  if (!lvl) return null;
  return levelAssets.get(lvl.id) || null;
}

function drawBackground() {
  const assets = currentLevelAssets();
  if (!assets?.bgImg) return;
  drawZoomPanFollow(assets.bgImg, BG_ZOOM, BG_FOLLOW);
}

function drawForeground() {
  const assets = currentLevelAssets();
  if (!assets?.fgImg) return;
  drawZoomPanFollow(assets.fgImg, FG_ZOOM, FG_FOLLOW);
}

function drawOptionalLayerAsset(layerAsset, dt) {
  if (!layerAsset) return;

  let img = null;

  if (layerAsset.kind === "image") {
    img = layerAsset.img;
  } else if (layerAsset.kind === "frames") {
    const frames = layerAsset.frames;
    if (!frames || frames.length === 0) return;

    layerAsset.timer += dt;
    const spf = 1 / Math.max(1, layerAsset.fps || DEFAULT_LAYER_FPS);
    while (layerAsset.timer >= spf) {
      layerAsset.timer -= spf;
      layerAsset.frameIndex = (layerAsset.frameIndex + 1) % frames.length;
    }

    img = frames[layerAsset.frameIndex];
  }

  if (!img) return;

  if (layerAsset.align === "bg") {
    drawZoomPanFollow(img, BG_ZOOM, BG_FOLLOW);
  } else {
    ctx.drawImage(img, 0, 0, W, H);
  }
}

function drawLayerN(key, dt) {
  const assets = currentLevelAssets();
  if (!assets) return;
  const layerAsset = assets[key];
  if (!layerAsset) return;
  drawOptionalLayerAsset(layerAsset, dt);
}

function drawLayer1(dt) { drawLayerN("l1", dt); }
function drawLayer2(dt) { drawLayerN("l2", dt); }
function drawLayer3(dt) { drawLayerN("l3", dt); }
function drawLayer4(dt) { drawLayerN("l4", dt); }

// ---------- Player ----------
function currentFrames() {
  return player.anim === "walk" ? heroWalkFrames : heroIdleFrames;
}

function currentFps() {
  return player.anim === "walk" ? SPRITES.walk.fps : SPRITES.idle.fps;
}

function drawPlayer() {
  if (!player.visible) return;

  const frames = currentFrames();
  if (!frames.length) return;

  player.frameIndex = player.frameIndex % frames.length;
  const img = frames[player.frameIndex];
  if (!img) return;

  const drawW = Math.round(img.width * SPRITE_SCALE);
  const drawH = Math.round(img.height * SPRITE_SCALE);

  let walkBob = 0;
  if (player.anim === "walk" && WALK_BOB_PX > 0 && heroWalkFrames.length) {
    const phase = (player.frameIndex / heroWalkFrames.length) * Math.PI * 2;
    walkBob = Math.sin(phase) * WALK_BOB_PX;
  }

  const x = Math.round(player.x);
  const y = Math.round(FLOOR_Y - drawH - FEET_FUDGE_PX + walkBob);

  ctx.save();
  if (player.facing === -1) {
    ctx.translate(x + drawW, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, y, drawW, drawH);
  } else {
    ctx.drawImage(img, x, y, drawW, drawH);
  }
  ctx.restore();
}

// ---------- Universe switching ----------
function triggerEdge(edge) {
  if (state.transitioning) return;
  state.transitioning = true;
  state.transitionUntil = performance.now() + 60;
  state.lastEdge = edge;
  player.visible = false;
}

function finishTransition() {
  state.levelIndex = state.lastEdge === "left" ? carouselMoveLeft() : carouselMoveRight();

  if (state.lastEdge === "left") {
    player.x = W - player.renderW - 2;
    player.facing = -1;
  } else {
    player.x = 2;
    player.facing = 1;
  }

  setAnim("idle");
  player.visible = true;
  state.transitioning = false;
}

// ---------- Loop ----------
let lastT = performance.now();

function loop(t) {
  const dt = Math.min(0.033, (t - lastT) / 1000);
  lastT = t;

  if (!state.transitioning) {
    let vx = 0;
    if (input.left) vx -= 1;
    if (input.right) vx += 1;

    if (vx !== 0) player.facing = vx > 0 ? 1 : -1;
    setAnim(vx === 0 ? "idle" : "walk");

    player.x += vx * player.speed * dt;

    if (player.x <= 0) {
      player.x = 0;
      triggerEdge("left");
    } else if (player.x >= W - player.renderW) {
      player.x = W - player.renderW;
      triggerEdge("right");
    }

    const fps = currentFps();
    player.frameTimer += dt;
    if (player.frameTimer >= 1 / fps) {
      player.frameTimer -= 1 / fps;
      const framesLen = currentFrames().length || 1;
      player.frameIndex = (player.frameIndex + 1) % framesLen;
    }
  } else if (performance.now() >= state.transitionUntil) {
    finishTransition();
  }

  ctx.clearRect(0, 0, W, H);

  drawBackground();
  drawLayer1(dt);

  drawPlayer();

  // In front of hero
  drawLayer2(dt);
  drawLayer3(dt);
  drawLayer4(dt);

  // True parallax FG last
  drawForeground();

  requestAnimationFrame(loop);
}

// ---------- Boot ----------
Promise.all([loadLevels(), loadSprites()])
  .then(() => requestAnimationFrame(loop))
  .catch((e) => {
    console.error(e);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#111";
    ctx.font = "18px ui-sans-serif, system-ui";
    ctx.fillText("Asset loading error. Check console.", 20, 30);
  });

// LevelQ Proto — layered levels (background + optional layer1 + hero + optional foreground + optional layer2)
//
// Draw order (back -> front):
// 1) Background (REQUIRED)
// 2) Layer 1 (optional; frames supported)
// 3) Hero
// 4) Foreground (optional; transparent PNG)
// 5) Layer 2 (optional; frames supported)
//
// IMPORTANT:
// - If a level background is missing/unloadable, the level is excluded from the pool (game still runs).
// - Adding new levels requires ONLY: add assets + add an entry in data/levels.json (no code changes).

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const W = canvas.width;
const H = canvas.height;

// Logical floor (never drawn)
const FLOOR_Y = 600;

// Sprite config (CUSTOM HERO)
const SPRITES = {
  idle: { folder: "assets/sprites/hero_idle_custom", count: 1, fps: 1 },
  walk: { folder: "assets/sprites/hero_walk_custom", count: 8, fps: 12 },
};

// -------- TWEAKABLE VISUAL CONSTANTS --------
const SPRITE_SCALE = 0.32;
const FEET_FUDGE_PX = 0;
const WALK_BOB_PX = 0; // 0 disables
// -------------------------------------------

// -------- PAN-FOLLOW (non-tiling, no seams) --------
// Zoom > 1 creates "extra image" to pan inside without revealing edges.
// *_FOLLOW is 0..1 follow strength (0=static, 1=full follow left/center/right)
// subtle preset (barely noticeable)
const BG_ZOOM = 1.05;
const FG_ZOOM = 1.02;

const BG_FOLLOW = 0.025;
const FG_FOLLOW = 0.55;

const MAX_PAN_PX = 55;



// -------------------------------------------

// -------- Level layer defaults (optional) ----
const DEFAULT_LAYER_FPS = 12;
// -------------------------------------------

let levelData = []; // filtered to only valid levels after loading
let heroIdleFrames = [];
let heroWalkFrames = [];

// Per-level loaded assets cache
// levelAssets.get(level.id) => { bgImg, fgImg|null, l1: layerAsset|null, l2: layerAsset|null }
const levelAssets = new Map();

const state = {
  levelIndex: 0,
  transitioning: false,
  transitionUntil: 0,
  lastEdge: null, // "left" | "right"
};

const player = {
  x: Math.floor(W / 2),
  speed: 90,
  visible: true,

  facing: 1,
  anim: "idle",
  frameIndex: 0,
  frameTimer: 0,

  // Render footprint (computed after sprites load)
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

function setAnim(next) {
  if (player.anim === next) return;
  player.anim = next;
  player.frameIndex = 0; // avoids idleFrames[out-of-range] flicker
  player.frameTimer = 0;
}

// Returns hero position normalized to [-1, +1] across walkable range.
// left edge => -1, center => 0, right edge => +1
function getHeroNormalizedX() {
  const range = Math.max(1, W - player.renderW);
  const t = clamp(player.x / range, 0, 1); // 0..1
  return t * 2 - 1; // -1..+1
}

// Draw zoomed image and pan inside its zoom margin.
// followStrength: 0..1 (0 = no movement, 1 = full follow)
function drawZoomPanFollow(img, zoom, followStrength) {
  if (!img) return;

  const drawW = W * zoom;
  const drawH = H * zoom;

  // Pan range allowed by zoom (per side)
  const maxFromZoom = (drawW - W) / 2;

  // Hard ceiling (for subtlety)
  const maxPan = Math.min(maxFromZoom, MAX_PAN_PX);

  // same direction as hero: left => negative, right => positive
  const heroN = getHeroNormalizedX();
  const pan = clamp(heroN * maxPan * clamp(followStrength, 0, 1), -maxPan, maxPan);

  // center zoomed image then apply pan
  const x = -(drawW - W) / 2 + pan;
  const y = -(drawH - H) / 2;

  ctx.drawImage(img, x, y, drawW, drawH);
}

// Debug: read ?debug=true&level=n (1-based) and return 0-based index, or null
function getDebugStartLevelIndex() {
  const params = new URLSearchParams(window.location.search);
  const debug = (params.get("debug") || "").toLowerCase() === "true";
  if (!debug) return null;

  const raw = params.get("level");
  if (!raw) return null;

  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return null;

  const idx = n - 1; // convert to 0-based index
  if (!levelData || idx >= levelData.length) return null;

  return idx;
}

function warnOnce(key, msg) {
  if (!warnOnce._seen) warnOnce._seen = new Set();
  if (warnOnce._seen.has(key)) return;
  warnOnce._seen.add(key);
  console.warn(msg);
}

// ---------- Generic image loader ----------
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = src;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
  });
}

// ---------- Frame sequence loader (pattern = folder/frame_01.png etc) ----------
function loadFrameSequence(folder, count) {
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

// ---------- Layer asset loader (optional) ----------
async function loadOptionalLayer(levelId, layerSpec, layerName) {
  if (!layerSpec) return null;

  const type = (layerSpec.type || "frames").toLowerCase();

  if (type === "frames") {
    const count = Number(layerSpec.count || 0);
    if (!count) return null;

    const folder = layerSpec.folder;
    const fps = Number(layerSpec.fps || DEFAULT_LAYER_FPS);

    if (!folder) {
      warnOnce(
        `${levelId}:${layerName}:missingFolder`,
        `[${levelId}] ${layerName} has type=frames but is missing "folder". Skipping.`
      );
      return null;
    }

    try {
      const frames = await loadFrameSequence(folder, count);
      return { kind: "frames", frames, fps, timer: 0, frameIndex: 0 };
    } catch (e) {
      warnOnce(
        `${levelId}:${layerName}:loadFail`,
        `[${levelId}] Failed to load ${layerName} frames. Skipping layer. (${e.message})`
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

// ---------- Loaders ----------
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
      console.warn(`[${id}] Missing required "background" field. Level excluded.`);
      continue;
    }

    try {
      const bgImg = await loadImage(bgSrc);

      // Optional foreground
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

      // Optional animated layers
      const l1 = await loadOptionalLayer(lvl.id, lvl.layer1, "layer1");
      const l2 = await loadOptionalLayer(lvl.id, lvl.layer2, "layer2");

      loadedLevels.push(lvl);
      levelAssets.set(lvl.id, { bgImg, fgImg, l1, l2 });
    } catch (e) {
      console.warn(`[${id}] Background failed to load. Level excluded. (${e.message})`);
    }
  }

  if (loadedLevels.length === 0) {
    throw new Error("No valid levels loaded. Check that each level has a valid background image.");
  }

  levelData = loadedLevels;

  const debugIdx = getDebugStartLevelIndex();
  state.levelIndex = debugIdx !== null ? debugIdx : randInt(0, levelData.length - 1);
}

async function loadSprites() {
  [heroIdleFrames, heroWalkFrames] = await Promise.all([
    loadFrameSequence(SPRITES.idle.folder, SPRITES.idle.count),
    loadFrameSequence(SPRITES.walk.folder, SPRITES.walk.count),
  ]);

  const base = heroIdleFrames[0];
  player.renderW = Math.round(base.width * SPRITE_SCALE);
  player.renderH = Math.round(base.height * SPRITE_SCALE);
  player.x = clamp(player.x, 0, W - player.renderW);
}

// ---------- Level rendering ----------
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

function tickAndDrawOptionalLayer(layerAsset, dt) {
  if (!layerAsset) return;

  if (layerAsset.kind === "frames") {
    const frames = layerAsset.frames;
    if (!frames || frames.length === 0) return;

    layerAsset.timer += dt;
    const spf = 1 / Math.max(1, layerAsset.fps || DEFAULT_LAYER_FPS);
    while (layerAsset.timer >= spf) {
      layerAsset.timer -= spf;
      layerAsset.frameIndex = (layerAsset.frameIndex + 1) % frames.length;
    }

    const img = frames[layerAsset.frameIndex];
    if (img) ctx.drawImage(img, 0, 0, W, H);
  }
}

function drawLayer1(dt) {
  const assets = currentLevelAssets();
  if (!assets?.l1) return;
  tickAndDrawOptionalLayer(assets.l1, dt);
}

function drawLayer2(dt) {
  const assets = currentLevelAssets();
  if (!assets?.l2) return;
  tickAndDrawOptionalLayer(assets.l2, dt);
}

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

// ---------- Universe switching (edge-based) ----------
function triggerEdge(edge) {
  if (state.transitioning) return;

  state.transitioning = true;
  state.transitionUntil = performance.now() + 60;
  state.lastEdge = edge;

  player.visible = false;
}

function finishTransition() {
  state.levelIndex = randInt(0, levelData.length - 1);

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
  drawForeground();
  drawLayer2(dt);

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

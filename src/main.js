// LevelQ Proto — static backgrounds + sprite hero + edge-based universe switching
// Flash / flicker REMOVED. Transition is a clean, instant cut.
//
// NEW: Debug URL params
// - ?debug=true&level=n  -> start on level n (1-based, so level=3 => third entry in levels.json)
//   Example: http://127.0.0.1:5500/?debug=true&level=7
//
// Run via Live Server / local HTTP server.

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const W = canvas.width;
const H = canvas.height;

// Logical floor (never drawn)
const FLOOR_Y = 600;

// Sprite config
const SPRITES = {
  idle: { folder: "assets/sprites/hero_idle_12f", count: 4, fps: 8 },
  walk: { folder: "assets/sprites/hero_walk_12f", count: 6, fps: 12 },
};

// -------- TWEAKABLE VISUAL CONSTANTS --------
const SPRITE_SCALE = 3.5;
const FEET_FUDGE_PX = 0;
const WALK_BOB_PX = 5; // 0 disables
// -------------------------------------------

let levelData = [];
const levelImages = new Map();

let heroIdleFrames = [];
let heroWalkFrames = [];

const state = {
  levelIndex: 0,
  transitioning: false,
  transitionUntil: 0,
  lastEdge: null, // "left" | "right"
};

const player = {
  x: Math.floor(W / 2),
  speed: 260,
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

// ---------- Loaders ----------
async function loadLevels() {
  const res = await fetch("data/levels.json");
  if (!res.ok) throw new Error(`Failed to fetch data/levels.json (${res.status})`);

  const json = await res.json();
  if (!json.levels || !Array.isArray(json.levels) || json.levels.length === 0) {
    throw new Error("data/levels.json must contain { levels: [ ... ] } with at least 1 level");
  }

  levelData = json.levels;

  await Promise.all(
    levelData.map(
      (lvl) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.src = lvl.image;
          img.onload = () => {
            levelImages.set(lvl.id, img);
            resolve();
          };
          img.onerror = () => reject(new Error(`Failed to load ${lvl.image}`));
        })
    )
  );

  // Start level: debug override if present, otherwise random
  const debugIdx = getDebugStartLevelIndex();
  state.levelIndex = debugIdx !== null ? debugIdx : randInt(0, levelData.length - 1);
}

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

async function loadSprites() {
  [heroIdleFrames, heroWalkFrames] = await Promise.all([
    loadFrameSequence(SPRITES.idle.folder, SPRITES.idle.count),
    loadFrameSequence(SPRITES.walk.folder, SPRITES.walk.count),
  ]);

  // Compute render footprint
  const base = heroIdleFrames[0];
  player.renderW = Math.round(base.width * SPRITE_SCALE);
  player.renderH = Math.round(base.height * SPRITE_SCALE);

  player.x = clamp(player.x, 0, W - player.renderW);
}

// ---------- Level ----------
function currentLevel() {
  return levelData[state.levelIndex];
}

function drawLevelBackground() {
  const lvl = currentLevel();
  if (!lvl) return;

  const img = levelImages.get(lvl.id);
  if (img) ctx.drawImage(img, 0, 0, W, H);
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
  const img = frames[player.frameIndex];
  if (!img) return;

  const drawW = Math.round(img.width * SPRITE_SCALE);
  const drawH = Math.round(img.height * SPRITE_SCALE);

  // Walk micro-bob
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
  state.transitionUntil = performance.now() + 60; // very short guard
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

  player.anim = "idle";
  player.frameIndex = 0;
  player.frameTimer = 0;

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
    player.anim = vx === 0 ? "idle" : "walk";

    player.x += vx * player.speed * dt;

    // Edge trigger
    if (player.x <= 0) {
      player.x = 0;
      triggerEdge("left");
    } else if (player.x >= W - player.renderW) {
      player.x = W - player.renderW;
      triggerEdge("right");
    }

    // Animate
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
  drawLevelBackground();
  drawPlayer();

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

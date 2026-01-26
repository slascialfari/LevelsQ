// LevelQ Proto — layered levels + HOME in carousel + HOME intro state machine
//
// Draw order (back -> front):
// 1) Background (REQUIRED)            [1:1, no zoom/pan]
// 2) Layer 1 (optional)               [image or frames; 1:1]
// 3) Hero (normal gameplay only)
// 4) Layer 2 (optional)
// 5) Layer 3 (optional)
// 6) Layer 4 (optional)
// 7) Foreground (optional; TRUE FG)   [zoom+pan follow; ONLY parallax layer]

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const W = canvas.width;
const H = canvas.height;

// Logical floor (never drawn)
const FLOOR_Y = 600;

// =========================
// SPRITES (normal gameplay hero)
// =========================
const SPRITES = {
  idle: { folder: "assets/sprites/hero_idle", count: 27, fps: 6 },
  walk: { folder: "assets/sprites/hero_walk", count: 8, fps: 12 },
};

// -------- TWEAKABLE VISUAL CONSTANTS --------
const SPRITE_SCALE = 0.34;
const FEET_FUDGE_PX = 0;
const WALK_BOB_PX = 0; // 0 disables

// 🔧 HOME HERO DROP OFFSET (THIS IS WHAT YOU TWEAK)
const HOME_DROP_OFFSET_X = 40; // px → + right, - left
// -------------------------------------------

// -------- FOREGROUND PARALLAX ONLY --------
const FG_ZOOM = 1.02;
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

  // Gameplay enabled only after HOME handoff
  gameplayEnabled: false,
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

const input = {
  left: false,
  right: false,
  enter: false,
  enterPressedThisFrame: false,
  arrowPressedThisFrame: false,
};

window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") input.left = true;
  if (e.key === "ArrowRight") input.right = true;

  if (e.key === "Enter") {
    if (!input.enter) input.enterPressedThisFrame = true;
    input.enter = true;
  }

  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    input.arrowPressedThisFrame = true;
  }
});

window.addEventListener("keyup", (e) => {
  if (e.key === "ArrowLeft") input.left = false;
  if (e.key === "ArrowRight") input.right = false;
  if (e.key === "Enter") input.enter = false;
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

  if (state.carouselPos < state.carousel.length - 1) {
    state.carouselPos += 1;
    return state.carousel[state.carouselPos];
  }

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

  if (state.carouselPos > 0) {
    state.carouselPos -= 1;
    return state.carousel[state.carouselPos];
  }

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

function getHeroNormalizedX() {
  const range = Math.max(1, W - player.renderW);
  const t = clamp(player.x / range, 0, 1);
  return t * 2 - 1;
}

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

  state.homeIndex = levelData.findIndex((l) => l && l.isHome === true);
  initCarouselWithHomeOrFallback();
}

async function loadSprites() {
  [heroIdleFrames, heroWalkFrames] = await Promise.all([
    loadFrameSequenceCounted(SPRITES.idle.folder, SPRITES.idle.count),
    loadFrameSequenceCounted(SPRITES.walk.folder, SPRITES.walk.count),
  ]);

  const base = heroIdleFrames[0];
  player.renderW = Math.round(base.width * SPRITE_SCALE);
  player.renderH = Math.round(base.height * SPRITE_SCALE);
  player.x = clamp(player.x, 0, W - player.renderW);
}

// ---------- Rendering helpers ----------
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
  ctx.drawImage(assets.bgImg, 0, 0, W, H);
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
  ctx.drawImage(img, 0, 0, W, H);
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
  if (!state.gameplayEnabled) return;

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

// =========================
// HOME INTRO STATE MACHINE
// =========================
const HOME = {
  active: false,
  phase: 0,
  phaseTimer: 0,

  preStart: null,
  start1: null,
  start2: null,
  idle: null,
  underlayImg: null,

  promptEnter: "Press Enter",
  promptArrows: "Use ← →",
  pauseMs: 1000,
};

function isHomeLevel() {
  return isHomeIndex(state.levelIndex);
}

function framePlayerUpdate(seq, dt) {
  if (!seq || !seq.frames?.length) return;

  seq.timer += dt;
  const spf = 1 / Math.max(1, seq.fps || 12);

  while (seq.timer >= spf) {
    seq.timer -= spf;
    const next = seq.idx + 1;
    if (next >= seq.frames.length) {
      seq.idx = seq.loop ? 0 : seq.frames.length - 1;
      seq.done = !seq.loop;
    } else {
      seq.idx = next;
    }
  }
}

function drawFrameSeq(seq) {
  if (!seq || !seq.frames?.length) return;
  const img = seq.frames[seq.idx] || null;
  if (!img) return;
  ctx.drawImage(img, 0, 0, W, H);
}

function drawHomeUnderlayIfAny() {
  if (!HOME.underlayImg) return;
  ctx.drawImage(HOME.underlayImg, 0, 0, W, H);
}

function drawHomePrompts() {
  ctx.save();
  ctx.font = "18px ui-sans-serif, system-ui";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.textAlign = "center";

  if (HOME.phase === 0) {
    ctx.fillText(HOME.promptEnter, W / 2, 640);
  } else if (HOME.phase >= 4) {
    ctx.fillText(HOME.promptArrows, W / 2, 640);
  }

  ctx.restore();
}

async function loadHomeIntroAssetsIfNeeded() {
  const lvl = currentLevel();
  const spec = lvl?.homeIntro;
  if (!spec) return;

  if (HOME.preStart && HOME.start1 && HOME.start2 && HOME.idle) return;

  HOME.promptEnter = spec.promptEnter || HOME.promptEnter;
  HOME.promptArrows = spec.promptArrows || HOME.promptArrows;
  HOME.pauseMs = Number(spec.pauseMs ?? HOME.pauseMs);

  const mkSeq = async (s) => {
    if (!s?.folder || !s?.count) return null;
    const frames = await loadFrameSequenceCounted(s.folder, Number(s.count));
    return {
      frames,
      fps: Number(s.fps || 12),
      loop: Boolean(s.loop),
      timer: 0,
      idx: 0,
      done: false,
    };
  };

  HOME.preStart = await mkSeq(spec.preStart);
  HOME.start1 = await mkSeq(spec.start1);
  HOME.start2 = await mkSeq(spec.start2);
  HOME.idle = await mkSeq(spec.idle);

  if (spec.start1?.underlay) {
    HOME.underlayImg = await loadImage(spec.start1.underlay);
  }
}

function enterHomeIntroMode() {
  HOME.active = true;
  HOME.phase = 0;
  HOME.phaseTimer = 0;

  state.gameplayEnabled = false;
  player.visible = false;

  for (const seq of [HOME.preStart, HOME.start1, HOME.start2, HOME.idle]) {
    if (!seq) continue;
    seq.timer = 0;
    seq.idx = 0;
    seq.done = false;
  }
}

function handoffHomeToGameplay() {
  // 🔧 Drop slightly right/left using HOME_DROP_OFFSET_X
  player.x = Math.floor(W / 2 - player.renderW / 2) + HOME_DROP_OFFSET_X;
  player.x = clamp(player.x, 0, W - player.renderW);

  if (input.left) player.facing = -1;
  if (input.right) player.facing = 1;

  state.gameplayEnabled = true;
  player.visible = true;

  const vx = (input.left ? -1 : 0) + (input.right ? 1 : 0);
  setAnim(vx === 0 ? "idle" : "walk");

  HOME.active = false;
}

function updateAndDrawHome(dt) {
  if (!HOME.active) return;

  const drawTopUI = () => {
    drawLayer3(dt);      // title.png
    drawHomePrompts();   // optional text
  };

  // Phase 0: preStart BEHIND background
  if (HOME.phase === 0) {
    framePlayerUpdate(HOME.preStart, dt);
    drawFrameSeq(HOME.preStart); // behind
    drawBackground();            // on top
    drawTopUI();

    if (input.enterPressedThisFrame) {
      HOME.phase = 1;
      HOME.start1.timer = 0;
      HOME.start1.idx = 0;
      HOME.start1.done = false;
    }
    return;
  }

  // Phase 1: start1 BEHIND background
  if (HOME.phase === 1) {
    framePlayerUpdate(HOME.start1, dt);
    drawFrameSeq(HOME.start1); // behind
    drawBackground();          // on top
    drawTopUI();

    if (HOME.start1?.done) {
      HOME.phase = 2;
      HOME.phaseTimer = 0;
    }
    return;
  }

  // Phase 2: underlay BEHIND background (pause)
  if (HOME.phase === 2) {
    drawHomeUnderlayIfAny(); // behind
    drawBackground();        // on top
    drawTopUI();

    HOME.phaseTimer += dt * 1000;
    if (HOME.phaseTimer >= HOME.pauseMs) {
      HOME.phase = 3;
      HOME.start2.timer = 0;
      HOME.start2.idx = 0;
      HOME.start2.done = false;
    }
    return;
  }

  // Phase 3: start2 IN FRONT; underlay ALWAYS behind background
  if (HOME.phase === 3) {
    drawHomeUnderlayIfAny(); // behind
    drawBackground();        // on top

    framePlayerUpdate(HOME.start2, dt);
    drawFrameSeq(HOME.start2); // front
    drawTopUI();

    if (HOME.start2?.done) {
      HOME.phase = 4;
      HOME.idle.timer = 0;
      HOME.idle.idx = 0;
      HOME.idle.done = false;
    }
    return;
  }

  // Phase 4: immediately move to waiting state 5 (idle loop)
  if (HOME.phase === 4) HOME.phase = 5;

  // Phase 5: idle IN FRONT; underlay ALWAYS behind background
  if (HOME.phase === 5) {
    drawHomeUnderlayIfAny(); // behind
    drawBackground();        // on top

    framePlayerUpdate(HOME.idle, dt);
    drawFrameSeq(HOME.idle); // front
    drawTopUI();

    if (input.arrowPressedThisFrame) {
      handoffHomeToGameplay();
    }
    return;
  }
}

// ---------- Loop ----------
let lastT = performance.now();

function loop(t) {
  const dt = Math.min(0.033, (t - lastT) / 1000);
  lastT = t;

  ctx.clearRect(0, 0, W, H);

  // HOME intro pipeline
  if (isHomeLevel() && !state.gameplayEnabled) {
    if (!HOME.preStart || !HOME.start1 || !HOME.start2 || !HOME.idle) {
      drawBackground();
      drawLayer3(dt);

      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = "18px ui-sans-serif, system-ui";
      ctx.fillText("Loading...", 20, 30);
      ctx.restore();

      if (!HOME._loading) {
        HOME._loading = true;
        loadHomeIntroAssetsIfNeeded()
          .then(() => {
            HOME._loading = false;
            enterHomeIntroMode();
          })
          .catch((e) => {
            HOME._loading = false;
            console.error(e);
          });
      }

      // consume one-frame flags (AFTER processing this frame)
      input.enterPressedThisFrame = false;
      input.arrowPressedThisFrame = false;

      requestAnimationFrame(loop);
      return;
    }

    if (!HOME.active) enterHomeIntroMode();
    updateAndDrawHome(dt);

    // consume one-frame flags (AFTER processing this frame)
    input.enterPressedThisFrame = false;
    input.arrowPressedThisFrame = false;

    requestAnimationFrame(loop);
    return;
  }

  // ============ Normal gameplay ============
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

  // Draw normal level
  // HOME underlay (layer1) must ALWAYS be behind background
  if (isHomeLevel()) {
    drawLayer1(dt);   // underlay first
    drawBackground(); // then background on top
  } else {
    drawBackground();
    drawLayer1(dt);
  }

  drawPlayer();

  drawLayer2(dt);
  drawLayer3(dt);
  drawLayer4(dt);

  drawForeground();

  // consume one-frame flags (AFTER processing this frame)
  input.enterPressedThisFrame = false;
  input.arrowPressedThisFrame = false;

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

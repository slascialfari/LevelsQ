const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;

// Root of the game project (one level up from levelUploader/)
const PROJECT_ROOT = path.resolve(__dirname, "..");
const LEVELS_DIR = path.join(PROJECT_ROOT, "assets", "levels");
const LEVELS_JSON = path.join(PROJECT_ROOT, "data", "levels.json");

// Multer stores uploads in a temp dir; we move them manually
const upload = multer({ dest: path.join(__dirname, "tmp") });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readLevelsJson() {
  const raw = fs.readFileSync(LEVELS_JSON, "utf-8");
  return JSON.parse(raw);
}

function writeLevelsJson(data) {
  fs.writeFileSync(LEVELS_JSON, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/** Return the next available 3-digit level ID (e.g. "004"). */
function getNextLevelId() {
  const entries = fs.readdirSync(LEVELS_DIR);
  let max = 0;
  for (const e of entries) {
    const n = parseInt(e, 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return String(max + 1).padStart(3, "0");
}

/**
 * Extract a numeric index from a filename like:
 *   frame-01.png, frame_02.png, frame03.png, frame (3).png, etc.
 * Returns the number or null.
 */
function extractIndex(filename) {
  const base = path.basename(filename, path.extname(filename));
  // Try pattern: name (N)
  let m = base.match(/\((\d+)\)\s*$/);
  if (m) return parseInt(m[1], 10);
  // Try pattern: name-N, name_N, nameN (grab last numeric run)
  m = base.match(/(\d+)\s*$/);
  if (m) return parseInt(m[1], 10);
  return null;
}

/**
 * Sort uploaded files by their detected index and rename them
 * sequentially as frame_01.png, frame_02.png, ...
 */
function sortAndRenameFrames(files, destDir) {
  // Attach detected index
  const withIndex = files.map((f) => ({
    file: f,
    index: extractIndex(f.originalname),
  }));

  // Sort: by detected index if available, otherwise by original name
  withIndex.sort((a, b) => {
    if (a.index !== null && b.index !== null) return a.index - b.index;
    if (a.index !== null) return -1;
    if (b.index !== null) return 1;
    return a.file.originalname.localeCompare(b.file.originalname);
  });

  fs.mkdirSync(destDir, { recursive: true });

  for (let i = 0; i < withIndex.length; i++) {
    const seq = String(i + 1).padStart(2, "0");
    const dest = path.join(destDir, `frame_${seq}.png`);
    fs.renameSync(withIndex[i].file.path, dest);
  }

  return withIndex.length;
}

/** Remove a directory recursively. */
function rmDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Clean up leftover temp files (e.g. on error). */
function cleanupFiles(files) {
  if (!files) return;
  for (const f of Object.values(files).flat()) {
    if (f && f.path && fs.existsSync(f.path)) {
      fs.unlinkSync(f.path);
    }
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// GET /api/levels — return current levels + next ID
app.get("/api/levels", (_req, res) => {
  try {
    const data = readLevelsJson();
    const nextId = getNextLevelId();
    // Only return gameplay levels (not HOME)
    const gameplay = data.levels.filter((l) => !l.isHome);
    res.json({ levels: gameplay, nextId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload/:id? — upload/overwrite a level
// We accept a dynamic field set via multer.any()
app.post("/api/upload/:id?", upload.any(), (req, res) => {
  let levelId = null;
  try {
    const files = req.files || [];
    const config = JSON.parse(req.body.config || "{}");

    // Determine level ID
    const overwriteId = req.params.id;
    if (overwriteId) {
      levelId = overwriteId;
    } else {
      levelId = getNextLevelId();
    }

    const levelDir = path.join(LEVELS_DIR, levelId);

    // If overwriting, remove existing folder
    if (overwriteId) {
      rmDir(levelDir);
    }

    fs.mkdirSync(levelDir, { recursive: true });

    // ---- Background ----
    const bgFile = files.find((f) => f.fieldname === "background");
    if (!bgFile) {
      cleanupFiles({ files });
      return res.status(400).json({ error: "Background image is required." });
    }
    fs.renameSync(bgFile.path, path.join(levelDir, "background.png"));

    // ---- Underlays ----
    const underlayConfigs = config.underlays || [];
    const underlaysJson = [];

    for (let i = 0; i < underlayConfigs.length; i++) {
      const uc = underlayConfigs[i];
      const folderName = `underlay${String(i + 1).padStart(2, "0")}`;
      const folderPath = path.join(levelDir, folderName);
      const layerFiles = files.filter(
        (f) => f.fieldname === `underlay_${i}`
      );

      if (uc.type === "static") {
        fs.mkdirSync(folderPath, { recursive: true });
        if (layerFiles.length > 0) {
          fs.renameSync(
            layerFiles[0].path,
            path.join(folderPath, "underlay.png")
          );
        }
        const entry = { folder: folderName, type: "static" };
        if (uc.rendering && uc.rendering !== "loop")
          entry.rendering = uc.rendering;
        if (uc.startMs) entry.startMs = Number(uc.startMs);
        underlaysJson.push(entry);
      } else {
        // frames
        const count = sortAndRenameFrames(layerFiles, folderPath);
        const entry = {
          folder: folderName,
          type: "frames",
          rendering: uc.rendering || "loop",
          fps: Number(uc.fps) || 12,
          count,
        };
        if (uc.startMs) entry.startMs = Number(uc.startMs);
        if (uc.intervalMs) entry.intervalMs = Number(uc.intervalMs);
        if (uc.randomInterval) {
          entry.randomInterval = true;
          if (uc.minIntervalMs) entry.minIntervalMs = Number(uc.minIntervalMs);
          if (uc.maxIntervalMs) entry.maxIntervalMs = Number(uc.maxIntervalMs);
        }
        if (uc.repeatCount !== undefined && Number(uc.repeatCount) !== -1) {
          entry.repeatCount = Number(uc.repeatCount);
        }
        underlaysJson.push(entry);
      }
    }

    // ---- Overlays ----
    const overlayConfigs = config.overlays || [];
    const overlaysJson = [];

    for (let i = 0; i < overlayConfigs.length; i++) {
      const oc = overlayConfigs[i];
      const folderName = `overlay${String(i + 1).padStart(2, "0")}`;
      const folderPath = path.join(levelDir, folderName);
      const layerFiles = files.filter((f) => f.fieldname === `overlay_${i}`);

      if (oc.type === "static") {
        fs.mkdirSync(folderPath, { recursive: true });
        if (layerFiles.length > 0) {
          fs.renameSync(
            layerFiles[0].path,
            path.join(folderPath, "overlay.png")
          );
        }
        const entry = { folder: folderName, type: "static" };
        if (oc.parallax) entry.parallax = true;
        if (oc.rendering && oc.rendering !== "loop")
          entry.rendering = oc.rendering;
        if (oc.startMs) entry.startMs = Number(oc.startMs);
        overlaysJson.push(entry);
      } else {
        // frames
        const count = sortAndRenameFrames(layerFiles, folderPath);
        const entry = {
          folder: folderName,
          type: "frames",
          rendering: oc.rendering || "loop",
          fps: Number(oc.fps) || 12,
          count,
        };
        if (oc.parallax) entry.parallax = true;
        if (oc.startMs) entry.startMs = Number(oc.startMs);
        if (oc.intervalMs) entry.intervalMs = Number(oc.intervalMs);
        if (oc.randomInterval) {
          entry.randomInterval = true;
          if (oc.minIntervalMs) entry.minIntervalMs = Number(oc.minIntervalMs);
          if (oc.maxIntervalMs) entry.maxIntervalMs = Number(oc.maxIntervalMs);
        }
        if (oc.repeatCount !== undefined && Number(oc.repeatCount) !== -1) {
          entry.repeatCount = Number(oc.repeatCount);
        }
        overlaysJson.push(entry);
      }
    }

    // ---- Update levels.json ----
    const levelsData = readLevelsJson();

    const levelEntry = {
      id: levelId,
      name: `Level ${levelId}`,
    };
    if (underlaysJson.length > 0) levelEntry.underlays = underlaysJson;
    if (overlaysJson.length > 0) levelEntry.overlays = overlaysJson;

    if (overwriteId) {
      // Replace existing entry
      const idx = levelsData.levels.findIndex((l) => l.id === overwriteId);
      if (idx !== -1) {
        levelsData.levels[idx] = levelEntry;
      } else {
        levelsData.levels.push(levelEntry);
      }
    } else {
      levelsData.levels.push(levelEntry);
    }

    writeLevelsJson(levelsData);

    // Cleanup any remaining temp files
    for (const f of files) {
      if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
    }

    res.json({ success: true, levelId, levelEntry });
  } catch (err) {
    // Attempt cleanup on error
    if (req.files) {
      for (const f of req.files) {
        if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      }
    }
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Level Uploader running at http://localhost:${PORT}`);
  console.log(`Project root: ${PROJECT_ROOT}`);
});

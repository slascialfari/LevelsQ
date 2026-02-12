# Level Uploader

Local web tool for uploading new levels to the game. Handles file renaming, folder structure creation, and `levels.json` updates automatically.

## First-time setup

Requires [Node.js](https://nodejs.org/) (v18+).

```bash
cd levelUploader
npm install
```

## Start the server

```bash
cd levelUploader
node server.js
```

Then open **http://localhost:3000** in your browser.

## How to use

1. The tool auto-detects the next level number (e.g. if levels 001-003 exist, it will create 004).
2. Drop a **background image** into the background zone.
3. Add **underlays** and/or **overlays** using the "+ Add" buttons.
4. For each layer, configure:
   - **Type**: Static (single image) or Frames (animation sequence)
   - **Rendering**: Loop, Once, or Intermittent (frames only)
   - **FPS** (frames only, default 12)
   - **Parallax** (overlays only)
   - Additional timing options for Once/Intermittent rendering
5. Drop files into each layer's drop zone. The tool shows a rename preview:
   - Static layers: file is renamed to `overlay.png` / `underlay.png`
   - Frame layers: files are sorted by detected index and renamed to `frame_01.png`, `frame_02.png`, etc.
6. Press **Upload Level**.

## Overwriting an existing level

Use the dropdown at the top to select an existing level instead of "New level". This will completely replace the level's folder and its entry in `levels.json`.

## What gets created

For a level with ID `004`:

```
assets/levels/004/
  background.png
  underlay01/
    frame_01.png
    frame_02.png
    ...
  overlay01/
    overlay.png
```

And a new entry is appended to `data/levels.json`.

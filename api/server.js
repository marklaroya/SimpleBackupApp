const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(cors());

const UPLOAD_DIR =
  process.env.UPLOAD_DIR || "/home/server/Backup";

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// mapped disk folder → HTTP route
app.use("/files", express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "");
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
});

// Upload endpoint: saves files into UPLOAD_DIR
// so the upload flow ( Client → POST /upload → Server → Save file → Return link )
app.post("/upload", upload.array("files", 3), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No file inserted" });
    }

    const files = req.files.map((f) => ({
      filename: f.filename,
      originalname: f.originalname,
      size: f.size,
      url: `/files/${f.filename}`,
    }));

    res.status(200).json({
      message: "Files uploaded successfully",
      count: files.length,
      files,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// for list files
app.get("/api/files", (req, res) => {
  try {
    const names = fs.readdirSync(UPLOAD_DIR);

    const files = names.map((name) => {
      const fullPath = path.join(UPLOAD_DIR, name);
      const stat = fs.statSync(fullPath);

      return {
        filename: name,
        size: stat.size,
        modified: stat.mtime,
        url: `/files/${name}`,
      };
    });

    res.json({ count: files.length, files });
  } catch (err) {
    res.status(500).json({ message: "Failed to list files" });
  }
});



// port binding
app.listen(4000, "100.126.179.32", () => {
  console.log("Server running on port 4000");
});


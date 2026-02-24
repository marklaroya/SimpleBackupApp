const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(cors());

const MAX_FILE_SIZE_GB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_GB * 1024 * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 20;

const UPLOAD_DIR = process.env.UPLOAD_DIR || "Backup";
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Mapped disk folder to HTTP route
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
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES_PER_UPLOAD,
  },
});

// Upload endpoint: saves files into UPLOAD_DIR
app.post("/upload", (req, res) => {
  upload.array("files", MAX_FILES_PER_UPLOAD)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          message: `File too large. Max allowed size is ${MAX_FILE_SIZE_GB} GB per file.`,
        });
      }

      if (err.code === "LIMIT_FILE_COUNT") {
        return res.status(413).json({
          message: `Too many files. Max allowed is ${MAX_FILES_PER_UPLOAD} files per upload.`,
        });
      }

      return res.status(400).json({ message: err.message });
    }

    if (err) {
      return res.status(500).json({ message: "Upload failed due to a server error." });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No file inserted" });
    }

    const files = req.files.map((f) => ({
      filename: f.filename,
      originalname: f.originalname,
      size: f.size,
      url: `/files/${f.filename}`,
    }));

    return res.status(200).json({
      message: "Files uploaded successfully",
      count: files.length,
      files,
    });
  });
});

// List files
app.get("/backup/files", (_req, res) => {
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
  } catch (_err) {
    res.status(500).json({ message: "Failed to list files" });
  }
});

const PORT = process.env.PORT;
const HOST = process.env.HOST;

// Port binding
app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});

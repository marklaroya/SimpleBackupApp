const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const MAX_FILE_SIZE_GB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_GB * 1024 * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 20;
const MAX_BASE_NAME_LENGTH = 120;
const MAX_EXT_LENGTH = 20;

const UPLOAD_DIR = process.env.UPLOAD_DIR || "Backup";
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Mapped disk folder to HTTP route
app.use("/files", express.static(UPLOAD_DIR));

const sanitizeUploadedName = (originalName) => {
  const parsed = path.parse((originalName || "file").normalize("NFKC"));

  let baseName = parsed.name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!baseName) baseName = "file";
  baseName = baseName.slice(0, MAX_BASE_NAME_LENGTH);

  let ext = (parsed.ext || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, "");
  ext = ext.slice(0, MAX_EXT_LENGTH);

  return `${baseName}${ext}`;
};

const ensureUniqueName = (directory, initialName) => {
  const parsed = path.parse(initialName);
  let nextName = initialName;
  let suffix = 1;

  while (fs.existsSync(path.join(directory, nextName))) {
    nextName = `${parsed.name} (${suffix})${parsed.ext}`;
    suffix += 1;
  }

  return nextName;
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const cleanName = sanitizeUploadedName(file.originalname);
    const uniqueName = ensureUniqueName(UPLOAD_DIR, cleanName);
    cb(null, uniqueName);
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

const deleteSingleFile = (filename, res) => {
  try {
    const normalized = (filename || "").trim();
    if (!normalized) {
      return res.status(400).json({ message: "Filename is required." });
    }

    // Disallow path traversal/subdirectory deletion.
    if (path.basename(normalized) !== normalized) {
      return res.status(400).json({ message: "Invalid filename." });
    }

    const uploadRoot = path.resolve(UPLOAD_DIR);
    const filePath = path.resolve(uploadRoot, normalized);
    if (!filePath.startsWith(`${uploadRoot}${path.sep}`)) {
      return res.status(400).json({ message: "Invalid file path." });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "File not found." });
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return res.status(400).json({ message: "Target is not a file." });
    }

    fs.unlinkSync(filePath);
    return res.status(200).json({ message: "File deleted.", filename: normalized });
  } catch (_err) {
    return res.status(500).json({ message: "Failed to delete file." });
  }
};

// Delete a file by exact filename
app.delete("/backup/files/:filename", (req, res) => {
  return deleteSingleFile(req.params.filename, res);
});

// Fallback delete endpoint for clients/proxies that block DELETE verbs.
app.post("/backup/files/delete", (req, res) => {
  return deleteSingleFile(req.body?.filename, res);
});

const PORT = process.env.PORT;
const HOST = process.env.HOST;

// Port binding
app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});

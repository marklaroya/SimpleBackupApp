const express = require("express");
const multer = require("multer");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const MAX_FILE_SIZE_GB = 30;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_GB * 1024 * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 20;
const MAX_BASE_NAME_LENGTH = 120;
const MAX_EXT_LENGTH = 20;
const STATIC_CACHE_MAX_AGE = process.env.STATIC_CACHE_MAX_AGE || "1h";
const PARTIAL_UPLOAD_SUFFIX = ".part";
const CHUNK_UPLOAD_DIR_NAME = ".chunks";
const MAX_CHUNK_SIZE_BYTES = 32 * 1024 * 1024;

const UPLOAD_DIR = process.env.UPLOAD_DIR || "Backup";
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
const CHUNK_UPLOAD_DIR = path.join(UPLOAD_DIR, CHUNK_UPLOAD_DIR_NAME);
if (!fs.existsSync(CHUNK_UPLOAD_DIR)) {
  fs.mkdirSync(CHUNK_UPLOAD_DIR, { recursive: true });
}

// Mapped disk folder to HTTP route
app.use(
  "/files",
  express.static(UPLOAD_DIR, {
    maxAge: STATIC_CACHE_MAX_AGE,
    etag: true,
    lastModified: true,
    acceptRanges: true,
  })
);

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

// unique name file when uploaded
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

const createTempUploadName = (finalName) => {
  return `${Date.now()}-${crypto.randomUUID()}-${finalName}${PARTIAL_UPLOAD_SUFFIX}`;
};

const rememberTempUploadPath = (req, tempPath) => {
  if (!req.tempUploadPaths) req.tempUploadPaths = new Set();
  req.tempUploadPaths.add(tempPath);
};

const forgetTempUploadPath = (req, tempPath) => {
  req.tempUploadPaths?.delete(tempPath);
};

const cleanupTempUploadPaths = async (req) => {
  const tempPaths = Array.from(req.tempUploadPaths || []);
  await Promise.all(
    tempPaths.map(async (tempPath) => {
      try {
        await fs.promises.unlink(tempPath);
      } catch (err) {
        if (err.code !== "ENOENT") {
          console.error("Failed to remove partial upload:", tempPath, err);
        }
      } finally {
        forgetTempUploadPath(req, tempPath);
      }
    })
  );
};

const getChunkUploadDir = (uploadId) => path.join(CHUNK_UPLOAD_DIR, uploadId);
const getChunkMetaPath = (uploadId) => path.join(getChunkUploadDir(uploadId), "meta.json");
const getChunkPath = (uploadId, chunkIndex) =>
  path.join(getChunkUploadDir(uploadId), `${chunkIndex}.chunk`);

const getChunkByteSize = (totalSize, chunkSize, chunkIndex) => {
  const offset = chunkIndex * chunkSize;
  return Math.max(0, Math.min(chunkSize, totalSize - offset));
};

const writeChunkMeta = async (uploadId, metadata) => {
  await fsp.writeFile(getChunkMetaPath(uploadId), JSON.stringify(metadata, null, 2), "utf8");
};

const readChunkMeta = async (uploadId) => {
  const raw = await fsp.readFile(getChunkMetaPath(uploadId), "utf8");
  return JSON.parse(raw);
};

const listUploadedChunkIndexes = async (uploadId) => {
  const names = await fsp.readdir(getChunkUploadDir(uploadId));
  return names
    .filter((name) => name.endsWith(".chunk"))
    .map((name) => Number.parseInt(name, 10))
    .filter((value) => Number.isInteger(value) && value >= 0)
    .sort((a, b) => a - b);
};

const removeChunkUploadDir = async (uploadId) => {
  await fsp.rm(getChunkUploadDir(uploadId), { recursive: true, force: true });
};

const mergeChunkUpload = async (uploadId, targetPath, totalChunks) => {
  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(targetPath, { flags: "wx" });

    const pipeChunk = (chunkIndex) => {
      if (chunkIndex >= totalChunks) {
        writeStream.end();
        return;
      }

      const readStream = fs.createReadStream(getChunkPath(uploadId, chunkIndex));
      readStream.on("error", (err) => writeStream.destroy(err));
      readStream.on("end", () => pipeChunk(chunkIndex + 1));
      readStream.pipe(writeStream, { end: false });
    };

    writeStream.on("error", reject);
    writeStream.on("finish", resolve);

    pipeChunk(0);
  });
};


const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const cleanName = sanitizeUploadedName(file.originalname);
    const finalName = ensureUniqueName(UPLOAD_DIR, cleanName);
    const tempName = createTempUploadName(finalName);
    const tempPath = path.join(UPLOAD_DIR, tempName);

    file.finalFilename = finalName;
    rememberTempUploadPath(req, tempPath);

    cb(null, tempName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES_PER_UPLOAD,
  },
});

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_CHUNK_SIZE_BYTES,
    files: 1,
  },
});

app.post("/upload/init", async (req, res) => {
  try {
    const requestedName = `${req.body?.filename || ""}`;
    const totalSize = Number(req.body?.size);
    const chunkSize = Number(req.body?.chunkSize);
    const totalChunks = Number(req.body?.totalChunks);
    const lastModified = Number(req.body?.lastModified || 0);

    if (!requestedName.trim()) {
      return res.status(400).json({ message: "Filename is required." });
    }

    if (!Number.isFinite(totalSize) || totalSize <= 0) {
      return res.status(400).json({ message: "Valid file size is required." });
    }

    if (!Number.isFinite(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK_SIZE_BYTES) {
      return res.status(400).json({ message: "Invalid chunk size." });
    }

    const expectedChunks = Math.ceil(totalSize / chunkSize);
    if (!Number.isInteger(totalChunks) || totalChunks !== expectedChunks) {
      return res.status(400).json({ message: "Invalid total chunk count." });
    }

    const uploadId = crypto.randomUUID();
    const metadata = {
      uploadId,
      originalFilename: requestedName,
      cleanedFilename: sanitizeUploadedName(requestedName),
      size: totalSize,
      chunkSize,
      totalChunks,
      lastModified,
      createdAt: new Date().toISOString(),
    };

    await fsp.mkdir(getChunkUploadDir(uploadId), { recursive: true });
    await writeChunkMeta(uploadId, metadata);

    return res.status(201).json({
      uploadId,
      chunkSize,
      totalChunks,
      filename: metadata.cleanedFilename,
    });
  } catch (err) {
    console.error("Failed to initialize chunked upload:", err);
    return res.status(500).json({ message: "Failed to initialize upload." });
  }
});

app.get("/upload/status/:uploadId", async (req, res) => {
  try {
    const metadata = await readChunkMeta(req.params.uploadId);
    const uploadedChunks = await listUploadedChunkIndexes(req.params.uploadId);
    const uploadedBytes = uploadedChunks.reduce(
      (sum, chunkIndex) => sum + getChunkByteSize(metadata.size, metadata.chunkSize, chunkIndex),
      0
    );

    return res.json({
      uploadId: metadata.uploadId,
      filename: metadata.cleanedFilename,
      totalChunks: metadata.totalChunks,
      chunkSize: metadata.chunkSize,
      uploadedChunks,
      uploadedBytes,
    });
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.status(404).json({ message: "Upload session not found." });
    }

    console.error("Failed to read upload status:", err);
    return res.status(500).json({ message: "Failed to read upload status." });
  }
});

app.post("/upload/chunk", (req, res) => {
  chunkUpload.single("chunk")(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ message: "Chunk exceeds the maximum allowed size." });
      }

      return res.status(400).json({ message: err.message });
    }

    if (err) {
      return res.status(500).json({ message: "Failed to receive chunk." });
    }

    try {
      const uploadId = `${req.body?.uploadId || ""}`.trim();
      const chunkIndex = Number(req.body?.chunkIndex);
      const chunk = req.file;

      if (!uploadId) {
        return res.status(400).json({ message: "Upload ID is required." });
      }

      if (!chunk) {
        return res.status(400).json({ message: "Chunk data is required." });
      }

      if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
        return res.status(400).json({ message: "Invalid chunk index." });
      }

      const metadata = await readChunkMeta(uploadId);
      if (chunkIndex >= metadata.totalChunks) {
        return res.status(400).json({ message: "Chunk index is out of range." });
      }

      const expectedSize = getChunkByteSize(metadata.size, metadata.chunkSize, chunkIndex);
      if (chunk.size !== expectedSize) {
        return res.status(400).json({ message: "Chunk size does not match the upload session." });
      }

      const chunkPath = getChunkPath(uploadId, chunkIndex);
      const tempChunkPath = `${chunkPath}.tmp`;

      await fsp.writeFile(tempChunkPath, chunk.buffer);
      await fsp.rename(tempChunkPath, chunkPath);

      return res.status(200).json({ chunkIndex });
    } catch (chunkErr) {
      if (chunkErr.code === "ENOENT") {
        return res.status(404).json({ message: "Upload session not found." });
      }

      console.error("Failed to store chunk:", chunkErr);
      return res.status(500).json({ message: "Failed to store upload chunk." });
    }
  });
});

app.post("/upload/complete", async (req, res) => {
  try {
    const uploadId = `${req.body?.uploadId || ""}`.trim();
    if (!uploadId) {
      return res.status(400).json({ message: "Upload ID is required." });
    }

    const metadata = await readChunkMeta(uploadId);
    const uploadedChunks = await listUploadedChunkIndexes(uploadId);

    if (uploadedChunks.length !== metadata.totalChunks) {
      const uploadedChunkSet = new Set(uploadedChunks);
      const missingChunks = Array.from({ length: metadata.totalChunks }, (_, index) => index).filter(
        (index) => !uploadedChunkSet.has(index)
      );

      return res.status(409).json({
        message: "Upload is incomplete.",
        missingChunks,
      });
    }

    const finalName = ensureUniqueName(UPLOAD_DIR, metadata.cleanedFilename);
    const finalPath = path.join(UPLOAD_DIR, finalName);
    const finalTempPath = path.join(UPLOAD_DIR, createTempUploadName(finalName));

    await mergeChunkUpload(uploadId, finalTempPath, metadata.totalChunks);
    await fsp.rename(finalTempPath, finalPath);
    await removeChunkUploadDir(uploadId);

    const stat = await fsp.stat(finalPath);
    return res.status(200).json({
      message: "Files uploaded successfully",
      count: 1,
      files: [
        {
          filename: finalName,
          originalname: metadata.originalFilename,
          size: stat.size,
          url: `/files/${finalName}`,
        },
      ],
    });
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.status(404).json({ message: "Upload session not found." });
    }

    console.error("Failed to finalize chunked upload:", err);
    return res.status(500).json({ message: "Failed to finalize upload." });
  }
});

app.delete("/upload/:uploadId", async (req, res) => {
  try {
    await removeChunkUploadDir(req.params.uploadId);
    return res.status(200).json({ message: "Upload canceled." });
  } catch (err) {
    console.error("Failed to cancel chunked upload:", err);
    return res.status(500).json({ message: "Failed to cancel upload." });
  }
});

// Upload endpoint: saves files into UPLOAD_DIR
app.post("/upload", (req, res) => {
  let requestAborted = false;
  req.on("aborted", () => {
    requestAborted = true;
    cleanupTempUploadPaths(req).catch((cleanupErr) => {
      console.error("Failed to clean aborted upload:", cleanupErr);
    });
  });

  upload.array("files", MAX_FILES_PER_UPLOAD)(req, res, async (err) => {
    if (requestAborted) {
      await cleanupTempUploadPaths(req);
      return;
    }

    if (err instanceof multer.MulterError) {
      await cleanupTempUploadPaths(req);
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
      await cleanupTempUploadPaths(req);
      return res.status(500).json({ message: "Upload failed due to a server error." });
    }

    if (!req.files || req.files.length === 0) {
      await cleanupTempUploadPaths(req);
      return res.status(400).json({ message: "No file inserted" });
    }

    try {
      const files = [];

      for (const file of req.files) {
        const tempPath = path.join(UPLOAD_DIR, file.filename);
        const finalName = file.finalFilename || sanitizeUploadedName(file.originalname);
        const finalPath = path.join(UPLOAD_DIR, finalName);

        await fs.promises.rename(tempPath, finalPath);
        forgetTempUploadPath(req, tempPath);

        files.push({
          filename: finalName,
          originalname: file.originalname,
          size: file.size,
          url: `/files/${finalName}`,
        });
      }

      return res.status(200).json({
        message: "Files uploaded successfully",
        count: files.length,
        files,
      });
    } catch (renameErr) {
      console.error("Failed to finalize upload:", renameErr);
      await cleanupTempUploadPaths(req);
      return res.status(500).json({ message: "Upload failed while finalizing the file." });
    }
  });
});

// List files
app.get("/backup/files", (_req, res) => {
  try {
    const names = fs
      .readdirSync(UPLOAD_DIR)
      .filter((name) => !name.endsWith(PARTIAL_UPLOAD_SUFFIX));

    const files = names
      .map((name) => {
        const fullPath = path.join(UPLOAD_DIR, name);
        const stat = fs.statSync(fullPath);

        if (!stat.isFile()) return null;

        return {
          filename: name,
          size: stat.size,
          modified: stat.mtime,
          url: `/files/${name}`,
        };
      })
      .filter(Boolean);

    res.json({ count: files.length, files });
  } catch (_err) {
    res.status(500).json({ message: "Failed to list files" });
  }
});


// Deleting a File
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

const startServer = ({ port = PORT, host = HOST } = {}) => {
  return app.listen(port, host, () => {
    console.log(`Server running at http://${host}:${port}`);
  });
};

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
};

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

const sanitizeFolderSegment = (segment) => {
  return `${segment || ""}`
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BASE_NAME_LENGTH);
};

const sanitizeRelativeFolder = (folderPath) => {
  const normalized = `${folderPath || ""}`.replace(/\\/g, "/").trim();
  if (!normalized) return "";

  return normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => segment !== "." && segment !== "..")
    .map(sanitizeFolderSegment)
    .filter(Boolean)
    .join("/");
};

const resolveTargetDirectory = (folderPath = "") => {
  const cleanFolder = sanitizeRelativeFolder(folderPath);
  const targetDirectory = cleanFolder
    ? path.join(UPLOAD_DIR, ...cleanFolder.split("/"))
    : UPLOAD_DIR;

  return { cleanFolder, targetDirectory };
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

const createTempUploadName = (finalName) => {
  return `${Date.now()}-${crypto.randomUUID()}-${finalName}${PARTIAL_UPLOAD_SUFFIX}`;
};

const buildFileUrl = (relativePath) => {
  return `/files/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
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
        await fsp.unlink(tempPath);
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

const resolveUploadFilePath = (filename) => {
  const raw = `${filename || ""}`.replace(/\\/g, "/").trim();
  if (!raw) {
    return { error: "Filename is required." };
  }

  const normalizedPath = path.posix.normalize(raw);
  if (
    !normalizedPath ||
    normalizedPath === "." ||
    normalizedPath.startsWith("../") ||
    normalizedPath.includes("/../") ||
    path.posix.isAbsolute(normalizedPath)
  ) {
    return { error: "Invalid file path." };
  }

  const normalized = normalizedPath.split("/").filter(Boolean).join("/");
  if (!normalized) {
    return { error: "Filename is required." };
  }

  const uploadRoot = path.resolve(UPLOAD_DIR);
  const filePath = path.resolve(uploadRoot, ...normalized.split("/"));
  if (filePath !== uploadRoot && !filePath.startsWith(`${uploadRoot}${path.sep}`)) {
    return { error: "Invalid file path." };
  }

  return { normalized, filePath };
};

const listStoredFiles = (directoryPath = UPLOAD_DIR, relativeDir = "") => {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === CHUNK_UPLOAD_DIR_NAME) continue;

    const entryPath = path.join(directoryPath, entry.name);
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...listStoredFiles(entryPath, relativePath));
      continue;
    }

    if (!entry.isFile() || entry.name.endsWith(PARTIAL_UPLOAD_SUFFIX)) {
      continue;
    }

    const stat = fs.statSync(entryPath);
    files.push({
      filename: relativePath,
      basename: entry.name,
      folder: relativeDir,
      size: stat.size,
      modified: stat.mtime,
      url: buildFileUrl(relativePath),
    });
  }

  return files;
};

const listStoredFolders = (directoryPath = UPLOAD_DIR, relativeDir = "") => {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  const folders = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === CHUNK_UPLOAD_DIR_NAME) continue;

    const folderPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const absolutePath = path.join(directoryPath, entry.name);
    const childEntries = fs
      .readdirSync(absolutePath, { withFileTypes: true })
      .filter((child) => child.name !== CHUNK_UPLOAD_DIR_NAME);

    folders.push({
      path: folderPath,
      name: entry.name,
      parentPath: relativeDir,
      isEmpty: childEntries.length === 0,
    });
    folders.push(...listStoredFolders(absolutePath, folderPath));
  }

  return folders.sort((a, b) => a.path.localeCompare(b.path));
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
    const tempName = createTempUploadName(cleanName);
    const tempPath = path.join(UPLOAD_DIR, tempName);

    file.cleanedFilename = cleanName;
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
    const targetFolder = sanitizeRelativeFolder(req.body?.folder);
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
      folder: targetFolder,
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
      folder: metadata.folder,
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
      folder: metadata.folder,
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

    const { cleanFolder, targetDirectory } = resolveTargetDirectory(metadata.folder);
    await fsp.mkdir(targetDirectory, { recursive: true });

    const finalName = ensureUniqueName(targetDirectory, metadata.cleanedFilename);
    const finalRelativePath = cleanFolder ? `${cleanFolder}/${finalName}` : finalName;
    const finalPath = path.join(targetDirectory, finalName);
    const finalTempPath = path.join(targetDirectory, createTempUploadName(finalName));

    await mergeChunkUpload(uploadId, finalTempPath, metadata.totalChunks);
    await fsp.rename(finalTempPath, finalPath);
    await removeChunkUploadDir(uploadId);

    const stat = await fsp.stat(finalPath);
    return res.status(200).json({
      message: "Files uploaded successfully",
      count: 1,
      files: [
        {
          filename: finalRelativePath,
          basename: finalName,
          folder: cleanFolder,
          originalname: metadata.originalFilename,
          size: stat.size,
          url: buildFileUrl(finalRelativePath),
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
      const { cleanFolder, targetDirectory } = resolveTargetDirectory(req.body?.folder);
      await fsp.mkdir(targetDirectory, { recursive: true });
      const files = [];

      for (const file of req.files) {
        const tempPath = path.join(UPLOAD_DIR, file.filename);
        const finalName = ensureUniqueName(
          targetDirectory,
          file.cleanedFilename || sanitizeUploadedName(file.originalname)
        );
        const finalRelativePath = cleanFolder ? `${cleanFolder}/${finalName}` : finalName;
        const finalPath = path.join(targetDirectory, finalName);

        await fsp.rename(tempPath, finalPath);
        forgetTempUploadPath(req, tempPath);

        files.push({
          filename: finalRelativePath,
          basename: finalName,
          folder: cleanFolder,
          originalname: file.originalname,
          size: file.size,
          url: buildFileUrl(finalRelativePath),
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

app.get("/backup/files", (_req, res) => {
  try {
    const files = listStoredFiles();
    res.json({ count: files.length, files });
  } catch (_err) {
    res.status(500).json({ message: "Failed to list files" });
  }
});

app.get("/backup/folders", (_req, res) => {
  try {
    const folders = listStoredFolders();
    res.json({ count: folders.length, folders });
  } catch (_err) {
    res.status(500).json({ message: "Failed to list folders" });
  }
});

const deleteSingleFile = (filename, res) => {
  try {
    const { normalized, filePath, error } = resolveUploadFilePath(filename);
    if (error) {
      return res.status(400).json({ message: error });
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

app.post("/backup/files/move", async (req, res) => {
  try {
    const { normalized: currentName, filePath: currentPath, error } = resolveUploadFilePath(
      req.body?.filename
    );
    if (error) {
      return res.status(400).json({ message: error });
    }

    if (!fs.existsSync(currentPath)) {
      return res.status(404).json({ message: "File not found." });
    }

    const currentStat = await fsp.stat(currentPath);
    if (!currentStat.isFile()) {
      return res.status(400).json({ message: "Target is not a file." });
    }

    const currentParsed = path.posix.parse(currentName);
    const targetFolder = sanitizeRelativeFolder(req.body?.targetFolder);

    if (currentParsed.dir === targetFolder) {
      return res.status(200).json({
        message: "File already in that folder.",
        filename: currentName,
      });
    }

    const { cleanFolder, targetDirectory } = resolveTargetDirectory(targetFolder);
    await fsp.mkdir(targetDirectory, { recursive: true });

    const finalName = ensureUniqueName(targetDirectory, currentParsed.base);
    const finalRelativePath = cleanFolder ? `${cleanFolder}/${finalName}` : finalName;
    const finalPath = path.join(targetDirectory, finalName);

    await fsp.rename(currentPath, finalPath);

    return res.status(200).json({
      message: "File moved.",
      filename: finalRelativePath,
      basename: finalName,
      folder: cleanFolder,
      previousFilename: currentName,
      url: buildFileUrl(finalRelativePath),
    });
  } catch (err) {
    console.error("Failed to move file:", err);
    return res.status(500).json({ message: "Failed to move file." });
  }
});

app.post("/backup/files/rename", async (req, res) => {
  try {
    const { normalized: currentName, filePath: currentPath, error } = resolveUploadFilePath(
      req.body?.filename
    );
    if (error) {
      return res.status(400).json({ message: error });
    }

    if (!fs.existsSync(currentPath)) {
      return res.status(404).json({ message: "File not found." });
    }

    const currentStat = await fsp.stat(currentPath);
    if (!currentStat.isFile()) {
      return res.status(400).json({ message: "Target is not a file." });
    }

    const requestedName = `${req.body?.nextFilename || ""}`.trim();
    if (!requestedName) {
      return res.status(400).json({ message: "New filename is required." });
    }

    if (requestedName.includes("/") || requestedName.includes("\\")) {
      return res.status(400).json({ message: "New filename cannot include folders." });
    }

    const currentParsed = path.posix.parse(currentName);
    const currentFolder = currentParsed.dir || "";
    const requestedParsed = path.parse(requestedName);
    const requestedHasExtension = Boolean(requestedParsed.ext);
    const cleanedRequestedName = sanitizeUploadedName(
      requestedHasExtension ? requestedName : `${requestedName}${currentParsed.ext}`
    );

    if (!cleanedRequestedName.trim()) {
      return res.status(400).json({ message: "New filename is invalid." });
    }

    const nextRelativePath = currentFolder
      ? `${currentFolder}/${cleanedRequestedName}`
      : cleanedRequestedName;
    if (nextRelativePath === currentName) {
      return res.status(200).json({
        message: "Filename unchanged.",
        filename: currentName,
      });
    }

    const {
      normalized: normalizedNextPath,
      filePath: nextPath,
      error: nextPathError,
    } = resolveUploadFilePath(nextRelativePath);
    if (nextPathError) {
      return res.status(400).json({ message: nextPathError });
    }

    if (fs.existsSync(nextPath)) {
      return res.status(409).json({ message: "A file with that name already exists." });
    }

    await fsp.rename(currentPath, nextPath);

    return res.status(200).json({
      message: "File renamed.",
      filename: normalizedNextPath,
      basename: cleanedRequestedName,
      folder: currentFolder,
      previousFilename: currentName,
      url: buildFileUrl(normalizedNextPath),
    });
  } catch (err) {
    console.error("Failed to rename file:", err);
    return res.status(500).json({ message: "Failed to rename file." });
  }
});

app.post("/backup/folders", async (req, res) => {
  try {
    const providedPath = `${req.body?.folderPath || ""}`.trim();
    const parentPath = sanitizeRelativeFolder(req.body?.parentPath);
    const requestedFolder =
      providedPath.includes("/") || providedPath.includes("\\")
        ? sanitizeRelativeFolder(providedPath)
        : sanitizeRelativeFolder(parentPath ? `${parentPath}/${providedPath}` : providedPath);

    if (!requestedFolder) {
      return res.status(400).json({ message: "Folder path is required." });
    }

    const { cleanFolder, targetDirectory } = resolveTargetDirectory(requestedFolder);
    if (fs.existsSync(targetDirectory)) {
      return res.status(409).json({ message: "Folder already exists." });
    }

    await fsp.mkdir(targetDirectory, { recursive: true });
    return res.status(201).json({
      message: "Folder created.",
      folder: {
        path: cleanFolder,
        name: path.posix.basename(cleanFolder),
        parentPath: path.posix.dirname(cleanFolder) === "." ? "" : path.posix.dirname(cleanFolder),
        isEmpty: true,
      },
    });
  } catch (err) {
    console.error("Failed to create folder:", err);
    return res.status(500).json({ message: "Failed to create folder." });
  }
});

app.post("/backup/folders/delete", async (req, res) => {
  try {
    const folderPath = sanitizeRelativeFolder(req.body?.folderPath);
    if (!folderPath) {
      return res.status(400).json({ message: "Folder path is required." });
    }

    const { targetDirectory } = resolveTargetDirectory(folderPath);
    if (!fs.existsSync(targetDirectory)) {
      return res.status(404).json({ message: "Folder not found." });
    }

    const stat = await fsp.stat(targetDirectory);
    if (!stat.isDirectory()) {
      return res.status(400).json({ message: "Target is not a folder." });
    }

    const childEntries = (await fsp.readdir(targetDirectory)).filter(
      (entry) => entry !== CHUNK_UPLOAD_DIR_NAME
    );
    if (childEntries.length > 0) {
      return res.status(409).json({ message: "Folder is not empty." });
    }

    await fsp.rmdir(targetDirectory);
    return res.status(200).json({ message: "Folder deleted.", folderPath });
  } catch (err) {
    console.error("Failed to delete folder:", err);
    return res.status(500).json({ message: "Failed to delete folder." });
  }
});

app.delete("/backup/files/:filename", (req, res) => {
  return deleteSingleFile(req.params.filename, res);
});

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

import axios from "axios";
import { useEffect, useMemo, useRef, useState } from "react";
import UploadProgress from "./UploadProgress.jsx";

const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
const UPLOAD_SESSION_STORAGE_KEY = "simplebackup.uploadSessions.v1";
const MAX_CHUNK_RETRIES = 3;
const CHUNK_RETRY_DELAY_MS = 800;

const formatSize = (bytes) => {
  if (!bytes) return "0 B";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
};

const normalizeFolderInput = (folder) =>
  `${folder || ""}`
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");

const fileKey = (file, folder = "") =>
  `${normalizeFolderInput(folder)}::${file.name}-${file.size}-${file.lastModified}`;

const readStoredUploadSessions = () => {
  try {
    const raw = window.localStorage.getItem(UPLOAD_SESSION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeStoredUploadSessions = (sessions) => {
  window.localStorage.setItem(UPLOAD_SESSION_STORAGE_KEY, JSON.stringify(sessions));
};

const getStoredUploadSession = (file, folder = "") => {
  const normalizedFolder = normalizeFolderInput(folder);
  const sessions = readStoredUploadSessions();
  const session = sessions[fileKey(file, normalizedFolder)];
  if (!session) return null;

  if (
    session.name !== file.name ||
    session.size !== file.size ||
    session.lastModified !== file.lastModified ||
    normalizeFolderInput(session.folder) !== normalizedFolder
  ) {
    delete sessions[fileKey(file, normalizedFolder)];
    writeStoredUploadSessions(sessions);
    return null;
  }

  return session;
};

const saveStoredUploadSession = (file, folder, session) => {
  const normalizedFolder = normalizeFolderInput(folder);
  const sessions = readStoredUploadSessions();
  sessions[fileKey(file, normalizedFolder)] = {
    ...session,
    folder: normalizedFolder,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
  };
  writeStoredUploadSessions(sessions);
};

const removeStoredUploadSession = (file, folder = "") => {
  const normalizedFolder = normalizeFolderInput(folder);
  const sessions = readStoredUploadSessions();
  delete sessions[fileKey(file, normalizedFolder)];
  writeStoredUploadSessions(sessions);
};

const getChunkByteSize = (fileSize, chunkIndex, chunkSize) => {
  const offset = chunkIndex * chunkSize;
  return Math.max(0, Math.min(chunkSize, fileSize - offset));
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableChunkError = (error) => {
  if (!error) return false;
  if (error.code === "ERR_CANCELED" || error.name === "CanceledError") return false;
  if (!error.response) return true;
  return error.response.status >= 500 || error.response.status === 429;
};

export default function UploadBox({
  apiBase,
  currentFolder = "",
  onUploaded,
  onStatus,
  compact = false,
  embedded = false,
}) {
  const [selected, setSelected] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState({
    active: false,
    phase: "uploading",
    percent: 0,
    loadedBytes: 0,
    totalBytes: 0,
  });
  const inputRef = useRef(null);
  const uploadAbortRef = useRef(null);
  const activeChunkSessionRef = useRef(null);
  const normalizedCurrentFolder = useMemo(
    () => normalizeFolderInput(currentFolder),
    [currentFolder]
  );

  const totalBytes = useMemo(
    () => selected.reduce((sum, file) => sum + (file?.size || 0), 0),
    [selected]
  );

  const mergeUnique = (base, incoming) => {
    const map = new Map();
    [...base, ...incoming].forEach((file) => {
      if (!file) return;
      map.set(fileKey(file, normalizedCurrentFolder), file);
    });
    return Array.from(map.values());
  };

  const setFiles = (filesArr, append = false) => {
    const clean = (filesArr || []).filter(Boolean);
    setSelected((prev) => (append ? mergeUnique(prev, clean) : mergeUnique([], clean)));
    onStatus?.("");
  };

  const onPick = (event) => {
    const list = Array.from(event.target.files || []);
    setFiles(list, true);
    if (inputRef.current) inputRef.current.value = "";
  };

  const onDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  };

  const onDragLeave = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  };

  const onDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    const list = Array.from(event.dataTransfer.files || []);
    setFiles(list, true);
  };

  const removeSelected = (targetFile) => {
    setSelected((prev) =>
      prev.filter(
        (file) => fileKey(file, normalizedCurrentFolder) !== fileKey(targetFile, normalizedCurrentFolder)
      )
    );
  };

  const clearSelection = () => {
    setSelected([]);
    if (inputRef.current) inputRef.current.value = "";
  };

  const cancelUpload = async () => {
    const controller = uploadAbortRef.current;
    if (!controller || controller.signal.aborted) return;

    controller.abort();

    const activeSession = activeChunkSessionRef.current;
    if (activeSession?.uploadId) {
      try {
        await axios.delete(`${apiBase}/upload/${activeSession.uploadId}`);
      } catch {
        // Cleanup can be retried later.
      }
      if (activeSession.file) {
        removeStoredUploadSession(activeSession.file, activeSession.folder);
      }
      activeChunkSessionRef.current = null;
    }

    onStatus?.("Upload canceled.");
  };

  useEffect(() => {
    return () => {
      const controller = uploadAbortRef.current;
      if (controller && !controller.signal.aborted) {
        controller.abort();
      }
    };
  }, []);

  useEffect(() => {
    setSelected([]);
    if (inputRef.current) inputRef.current.value = "";
  }, [normalizedCurrentFolder]);

  const upload = async () => {
    if (selected.length === 0) {
      onStatus?.("Please select at least one file first.");
      return;
    }

    const expectedTotalBytes = selected.reduce((sum, file) => sum + (file?.size || 0), 0);
    const abortController = new AbortController();
    uploadAbortRef.current = abortController;

    const updateProgress = (loadedBytes) => {
      const safeLoadedBytes = Math.max(0, Math.min(expectedTotalBytes, loadedBytes));
      const percent =
        expectedTotalBytes > 0
          ? Math.round((safeLoadedBytes / expectedTotalBytes) * 100)
          : 0;

      setProgress({
        active: true,
        phase: "uploading",
        percent,
        loadedBytes: safeLoadedBytes,
        totalBytes: expectedTotalBytes,
      });
    };

    const createUploadSession = async (file) => {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE_BYTES);
      const { data } = await axios.post(
        `${apiBase}/upload/init`,
        {
          filename: file.name,
          folder: normalizedCurrentFolder,
          size: file.size,
          lastModified: file.lastModified,
          chunkSize: CHUNK_SIZE_BYTES,
          totalChunks,
        },
        { signal: abortController.signal }
      );

      const session = {
        uploadId: data.uploadId,
        chunkSize: data.chunkSize,
        totalChunks: data.totalChunks,
        folder: data.folder || normalizedCurrentFolder,
      };

      saveStoredUploadSession(file, normalizedCurrentFolder, session);
      return session;
    };

    const loadUploadStatus = async (uploadId) => {
      const { data } = await axios.get(`${apiBase}/upload/status/${uploadId}`, {
        signal: abortController.signal,
      });
      return data;
    };

    const resolveUploadSession = async (file) => {
      const existingSession = getStoredUploadSession(file, normalizedCurrentFolder);
      if (!existingSession?.uploadId) {
        const freshSession = await createUploadSession(file);
        return {
          session: freshSession,
          uploadedChunkSet: new Set(),
        };
      }

      try {
        const status = await loadUploadStatus(existingSession.uploadId);
        return {
          session: {
            uploadId: existingSession.uploadId,
            chunkSize: status.chunkSize,
            totalChunks: status.totalChunks,
            folder: status.folder || normalizedCurrentFolder,
          },
          uploadedChunkSet: new Set(status.uploadedChunks || []),
        };
      } catch (error) {
        if (error?.response?.status !== 404) throw error;
        removeStoredUploadSession(file, normalizedCurrentFolder);

        const freshSession = await createUploadSession(file);
        return {
          session: freshSession,
          uploadedChunkSet: new Set(),
        };
      }
    };

    setUploading(true);
    updateProgress(0);
    onStatus?.(
      normalizedCurrentFolder
        ? `Uploading files to ${normalizedCurrentFolder}...`
        : "Uploading files to Root..."
    );

    try {
      let completedBatchBytes = 0;

      const uploadChunkWithRetry = async ({
        file,
        session,
        chunkIndex,
        chunkBlob,
        currentFileLoaded,
      }) => {
        for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt += 1) {
          const form = new FormData();
          form.append("uploadId", session.uploadId);
          form.append("chunkIndex", `${chunkIndex}`);
          form.append("chunk", chunkBlob, file.name);

          let inFlightChunkLoaded = 0;

          try {
            await axios.post(`${apiBase}/upload/chunk`, form, {
              signal: abortController.signal,
              onUploadProgress: (event) => {
                inFlightChunkLoaded = Math.min(event.loaded || 0, chunkBlob.size);
                updateProgress(completedBatchBytes + currentFileLoaded + inFlightChunkLoaded);
              },
            });
            return;
          } catch (error) {
            if (
              abortController.signal.aborted ||
              attempt === MAX_CHUNK_RETRIES ||
              !isRetryableChunkError(error)
            ) {
              throw error;
            }

            const retryDelay = CHUNK_RETRY_DELAY_MS * attempt;
            onStatus?.(
              `Connection dipped while uploading ${file.name}. Retrying chunk ${
                chunkIndex + 1
              }/${session.totalChunks} (${attempt + 1}/${MAX_CHUNK_RETRIES})...`
            );
            await wait(retryDelay);
          }
        }
      };

      for (const file of selected) {
        if (abortController.signal.aborted) break;

        const { session, uploadedChunkSet } = await resolveUploadSession(file);
        activeChunkSessionRef.current = {
          uploadId: session.uploadId,
          file,
          folder: normalizedCurrentFolder,
        };

        let currentFileLoaded = 0;
        uploadedChunkSet.forEach((chunkIndex) => {
          currentFileLoaded += getChunkByteSize(file.size, chunkIndex, session.chunkSize);
        });
        updateProgress(completedBatchBytes + currentFileLoaded);

        for (let chunkIndex = 0; chunkIndex < session.totalChunks; chunkIndex += 1) {
          if (uploadedChunkSet.has(chunkIndex)) continue;
          if (abortController.signal.aborted) break;

          const chunkStart = chunkIndex * session.chunkSize;
          const chunkEnd = Math.min(chunkStart + session.chunkSize, file.size);
          const chunkBlob = file.slice(chunkStart, chunkEnd);
          await uploadChunkWithRetry({
            file,
            session,
            chunkIndex,
            chunkBlob,
            currentFileLoaded,
          });

          uploadedChunkSet.add(chunkIndex);
          currentFileLoaded += chunkBlob.size;
          updateProgress(completedBatchBytes + currentFileLoaded);
        }

        if (abortController.signal.aborted) break;

        setProgress((prev) => ({
          ...prev,
          active: true,
          phase: "finalizing",
        }));
        onStatus?.(`Finalizing ${file.name} on the server...`);

        await axios.post(
          `${apiBase}/upload/complete`,
          { uploadId: session.uploadId },
          { signal: abortController.signal }
        );

        removeStoredUploadSession(file, normalizedCurrentFolder);
        activeChunkSessionRef.current = null;
        completedBatchBytes += file.size;
        updateProgress(completedBatchBytes);
      }

      if (!abortController.signal.aborted) {
        clearSelection();
        onUploaded?.();
        onStatus?.("Upload complete");
      }
    } catch (error) {
      const isCanceled = error?.code === "ERR_CANCELED" || error?.name === "CanceledError";
      const isIncomplete = error?.response?.status === 409;
      const message = isCanceled
        ? "Upload canceled."
        : isIncomplete
          ? "Upload interrupted. Retry to resume from the last completed chunk."
          : error?.response?.data?.message || error?.message || "Upload error";
      onStatus?.(message);
    } finally {
      if (uploadAbortRef.current === abortController) {
        uploadAbortRef.current = null;
      }
      activeChunkSessionRef.current = null;
      setUploading(false);
      setProgress((prev) => ({ ...prev, active: false }));
    }
  };

  return (
    <section
      className={`dashboardPanel uploadSection ${compact ? "uploadSectionCompact" : ""} ${
        embedded ? "uploadSectionEmbedded" : ""
      }`}
    >
      <div className="sectionHead uploadSectionHead">
        <div>
          <h2 className="sectionTitle">{compact ? "Upload" : "Quick Upload"}</h2>
          <p className="sectionText">
            {compact
              ? `Send files straight to ${normalizedCurrentFolder || "Root"}.`
              : `Add files to ${normalizedCurrentFolder || "Root"} with resumable transfer and progress tracking.`}
          </p>
        </div>
        <div className="sectionMeta">
          {selected.length} file(s) / {formatSize(totalBytes)}
        </div>
      </div>

      <div className="uploadDestinationMeta">
        <span className="storageMetaPill">Destination</span>
        <span className="uploadDestinationPath">{normalizedCurrentFolder || "Root"}</span>
      </div>

      <div
        className={`dropZone ${isDragging ? "dropZoneActive" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="dropZoneTitle">
          {selected.length > 0 ? "Drop more files to add them" : "Drop files here"}
        </div>
        <div className="dropZoneHint">or browse directly from this device</div>
      </div>

      <div className="uploadRow">
        <label className="btn btnPrimary">
          Select Files
          <input ref={inputRef} type="file" multiple onChange={onPick} hidden />
        </label>

        <button
          className="btn btnAccent"
          onClick={upload}
          disabled={selected.length === 0 || uploading}
        >
          {uploading ? "Uploading" : "Upload"}
        </button>

        <button
          className="btn btnGhost"
          onClick={clearSelection}
          disabled={selected.length === 0 || uploading}
        >
          Clear
        </button>

        <button className="btn btnGhost" onClick={cancelUpload} disabled={!uploading}>
          Cancel
        </button>
      </div>

      <UploadProgress
        active={progress.active}
        phase={progress.phase}
        percent={progress.percent}
        loadedBytes={progress.loadedBytes}
        totalBytes={progress.totalBytes || totalBytes}
      />

      {selected.length > 0 && (
        <div className="selectedList">
          {selected.slice(0, 6).map((file) => (
            <div className="selectedItem" key={fileKey(file, normalizedCurrentFolder)}>
              <span className="selectedName" title={file.name}>
                {file.name}
              </span>
              <span className="selectedSize">{formatSize(file.size)}</span>
              <button
                type="button"
                className="pillButton"
                onClick={() => removeSelected(file)}
                disabled={uploading}
              >
                Remove
              </button>
            </div>
          ))}

          {selected.length > 6 && (
            <div className="selectedMore">+{selected.length - 6} more file(s) selected</div>
          )}
        </div>
      )}
    </section>
  );
}

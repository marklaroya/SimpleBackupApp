import axios from "axios";
import { useEffect, useMemo, useRef, useState } from "react";
import UploadProgress from "./UploadProgress.jsx";

const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
const UPLOAD_SESSION_STORAGE_KEY = "simplebackup.uploadSessions.v1";

const formatSize = (bytes) => {
  if (!bytes) return "0 B";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
};

const fileKey = (file) => `${file.name}-${file.size}-${file.lastModified}`;

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

const getStoredUploadSession = (file) => {
  const sessions = readStoredUploadSessions();
  const session = sessions[fileKey(file)];
  if (!session) return null;

  if (
    session.name !== file.name ||
    session.size !== file.size ||
    session.lastModified !== file.lastModified
  ) {
    delete sessions[fileKey(file)];
    writeStoredUploadSessions(sessions);
    return null;
  }

  return session;
};

const saveStoredUploadSession = (file, session) => {
  const sessions = readStoredUploadSessions();
  sessions[fileKey(file)] = {
    ...session,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
  };
  writeStoredUploadSessions(sessions);
};

const removeStoredUploadSession = (file) => {
  const sessions = readStoredUploadSessions();
  delete sessions[fileKey(file)];
  writeStoredUploadSessions(sessions);
};

const getChunkByteSize = (fileSize, chunkIndex, chunkSize) => {
  const offset = chunkIndex * chunkSize;
  return Math.max(0, Math.min(chunkSize, fileSize - offset));
};

export default function UploadBox({ apiBase, onUploaded, onStatus }) {
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

  const totalBytes = useMemo(
    () => selected.reduce((sum, file) => sum + (file?.size || 0), 0),
    [selected]
  );

  const mergeUnique = (base, incoming) => {
    const map = new Map();
    [...base, ...incoming].forEach((file) => {
      if (!file) return;
      map.set(fileKey(file), file);
    });
    return Array.from(map.values());
  };

  const setFiles = (filesArr, append = false) => {
    const clean = (filesArr || []).filter(Boolean);
    setSelected((prev) => (append ? mergeUnique(prev, clean) : mergeUnique([], clean)));
    onStatus?.("");
  };

  const onPick = (e) => {
    const list = Array.from(e.target.files || []);
    setFiles(list, true);
    if (inputRef.current) inputRef.current.value = "";
  };

  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const onDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const list = Array.from(e.dataTransfer.files || []);
    setFiles(list, true);
  };

  const removeSelected = (targetFile) => {
    setSelected((prev) => prev.filter((file) => fileKey(file) !== fileKey(targetFile)));
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
        // Ignore cleanup failures on cancel; the session can still be retried or cleaned up later.
      }
      if (activeSession.file) {
        removeStoredUploadSession(activeSession.file);
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
      const percent = expectedTotalBytes > 0 ? Math.round((safeLoadedBytes / expectedTotalBytes) * 100) : 0;
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
      };

      saveStoredUploadSession(file, session);
      return session;
    };

    const loadUploadStatus = async (uploadId) => {
      const { data } = await axios.get(`${apiBase}/upload/status/${uploadId}`, {
        signal: abortController.signal,
      });
      return data;
    };

    const resolveUploadSession = async (file) => {
      const existingSession = getStoredUploadSession(file);
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
          },
          uploadedChunkSet: new Set(status.uploadedChunks || []),
        };
      } catch (err) {
        if (err?.response?.status !== 404) throw err;
        removeStoredUploadSession(file);

        const freshSession = await createUploadSession(file);
        return {
          session: freshSession,
          uploadedChunkSet: new Set(),
        };
      }
    };

    setUploading(true);
    updateProgress(0);
    onStatus?.("Uploading files...");

    try {
      let completedBatchBytes = 0;

      for (const file of selected) {
        if (abortController.signal.aborted) break;

        const { session, uploadedChunkSet } = await resolveUploadSession(file);
        activeChunkSessionRef.current = {
          uploadId: session.uploadId,
          file,
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
          const form = new FormData();
          form.append("uploadId", session.uploadId);
          form.append("chunkIndex", `${chunkIndex}`);
          form.append("chunk", chunkBlob, file.name);

          let inFlightChunkLoaded = 0;
          await axios.post(`${apiBase}/upload/chunk`, form, {
            signal: abortController.signal,
            onUploadProgress: (event) => {
              inFlightChunkLoaded = Math.min(event.loaded || 0, chunkBlob.size);
              updateProgress(completedBatchBytes + currentFileLoaded + inFlightChunkLoaded);
            },
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

        removeStoredUploadSession(file);
        activeChunkSessionRef.current = null;
        completedBatchBytes += file.size;
        updateProgress(completedBatchBytes);
      }

      if (!abortController.signal.aborted) {
        clearSelection();
        onUploaded?.();
        onStatus?.("Upload complete");
      }
    } catch (e) {
      const isCanceled = e?.code === "ERR_CANCELED" || e?.name === "CanceledError";
      const isIncomplete = e?.response?.status === 409;
      const message = isCanceled
        ? "Upload canceled."
        : isIncomplete
          ? "Upload interrupted. Retry to resume from the last completed chunk."
          : e?.response?.data?.message || e?.message || "Upload error";
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
    <div className="uploadBox">
      <div className="sectionHead">
        <div className="sectionTitle">Upload Files</div>
        <div className="sectionMeta">
          {selected.length} file(s) - {formatSize(totalBytes)}
        </div>
      </div>

      <div
        className={`dropZone ${isDragging ? "dropZoneActive" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="dropZoneTitle">
          {selected.length > 0 ? "Drop more files to add them" : "Drag and drop files here"}
        </div>
        <div className="dropZoneHint">or use the Select File button</div>
      </div>

      <div className="uploadRow">
        <label className="btn btnPrimary">
          Select File(s)
          <input ref={inputRef} type="file" multiple onChange={onPick} hidden />
        </label>

        <button className="btn btnAccent" onClick={upload} disabled={selected.length === 0 || uploading}>
          {uploading ? "Uploading..." : "Upload"}
        </button>

        <button className="btn btnGhost" onClick={clearSelection} disabled={selected.length === 0 || uploading}>
          Clear
        </button>

        <button className="btn btnGhost" onClick={cancelUpload} disabled={!uploading}>
          Cancel Upload
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
          {selected.slice(0, 8).map((file) => (
            <div className="selectedItem" key={fileKey(file)}>
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
          {selected.length > 8 && (
            <div className="selectedMore">+{selected.length - 8} more file(s) selected</div>
          )}
        </div>
      )}
    </div>
  );
}

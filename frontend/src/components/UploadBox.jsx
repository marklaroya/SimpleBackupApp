import axios from "axios";
import { useEffect, useMemo, useRef, useState } from "react";
import UploadProgress from "./UploadProgress.jsx";

const MAX_PARALLEL_UPLOADS = 3;

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

export default function UploadBox({ apiBase, onUploaded, onStatus }) {
  const [selected, setSelected] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState({
    active: false,
    percent: 0,
    loadedBytes: 0,
    totalBytes: 0,
  });
  const inputRef = useRef(null);
  const uploadAbortRef = useRef(null);

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

  const cancelUpload = () => {
    const controller = uploadAbortRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
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
    const loadedByFile = new Map();
    const totalByFile = new Map(selected.map((file) => [fileKey(file), file.size || 0]));
    const updateAggregateProgress = () => {
      let loaded = 0;
      let total = 0;

      totalByFile.forEach((fileTotal, key) => {
        const safeTotal = Math.max(0, Number(fileTotal) || 0);
        total += safeTotal;
        loaded += Math.min(Math.max(0, Number(loadedByFile.get(key)) || 0), safeTotal || Infinity);
      });

      if (total <= 0) total = expectedTotalBytes;
      if (loaded > total && total > 0) loaded = total;

      const nextPercent = total > 0 ? Math.round((loaded / total) * 100) : 0;
      setProgress({
        active: true,
        percent: nextPercent,
        loadedBytes: loaded,
        totalBytes: total,
      });
    };

    setUploading(true);
    setProgress({
      active: true,
      percent: 0,
      loadedBytes: 0,
      totalBytes: expectedTotalBytes,
    });
    onStatus?.("Uploading files...");

    try {
      const uploadSingleFile = async (file) => {
        const key = fileKey(file);
        const form = new FormData();
        form.append("files", file);

        await axios.post(`${apiBase}/upload`, form, {
          signal: abortController.signal,
          onUploadProgress: (event) => {
            loadedByFile.set(key, event.loaded || 0);
            if (event.total && event.total > 0) {
              totalByFile.set(key, event.total);
            }
            updateAggregateProgress();
          },
        });

        loadedByFile.set(key, totalByFile.get(key) || file.size || 0);
        updateAggregateProgress();
      };

      const workerCount = Math.min(MAX_PARALLEL_UPLOADS, selected.length);
      const queue = [...selected];
      const workers = Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
          if (abortController.signal.aborted) return;
          const nextFile = queue.shift();
          if (!nextFile) return;
          await uploadSingleFile(nextFile);
        }
      });

      await Promise.all(workers);

      setProgress((prev) => ({
        ...prev,
        active: true,
        percent: 100,
        loadedBytes: prev.totalBytes || prev.loadedBytes,
      }));

      clearSelection();
      onUploaded?.();
      onStatus?.("Upload complete");
    } catch (e) {
      const isCanceled = e?.code === "ERR_CANCELED" || e?.name === "CanceledError";
      const message = isCanceled
        ? "Upload canceled."
        : e?.response?.data?.message || e?.message || "Upload error";
      onStatus?.(message);
    } finally {
      if (uploadAbortRef.current === abortController) {
        uploadAbortRef.current = null;
      }
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

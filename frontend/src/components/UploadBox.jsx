import { useMemo, useRef, useState } from "react";

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
  const inputRef = useRef(null);

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

  const upload = async () => {
    if (selected.length === 0) {
      onStatus?.("Please select at least one file first.");
      return;
    }

    setUploading(true);
    onStatus?.("Uploading files...");

    try {
      const form = new FormData();
      selected.forEach((file) => form.append("files", file));

      const res = await fetch(`${apiBase}/upload`, {
        method: "POST",
        body: form,
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Upload failed (${res.status})`);

      clearSelection();
      onUploaded?.();
      onStatus?.("Upload complete");
    } catch (e) {
      onStatus?.(e.message || "Upload error");
    } finally {
      setUploading(false);
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
      </div>

      {selected.length > 0 && (
        <div className="selectedList">
          {selected.slice(0, 8).map((file) => (
            <div className="selectedItem" key={fileKey(file)}>
              <span className="selectedName" title={file.name}>
                {file.name}
              </span>
              <span className="selectedSize">{formatSize(file.size)}</span>
              <button type="button" className="pillButton" onClick={() => removeSelected(file)}>
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

import { useMemo, useState } from "react";

export default function UploadBox({ apiBase, onUploaded, onStatus }) {
  const [selected, setSelected] = useState([]); // multiple files
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const totalBytes = useMemo(
    () => selected.reduce((sum, f) => sum + (f?.size || 0), 0),
    [selected]
  );

  const formatSize = (bytes) => {
    if (!bytes) return "0 B";
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
  };

  const setFiles = (filesArr) => {
    // remove empty/null
    const clean = (filesArr || []).filter(Boolean);
    setSelected(clean);
    onStatus?.("");
  };

  // File picker
  const onPick = (e) => {
    const list = Array.from(e.target.files || []);
    setFiles(list);
  };

  // Drag & drop handlers
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
    setFiles(list);
  };

  const clearSelection = () => {
    setSelected([]);
    const input = document.getElementById("file-input");
    if (input) input.value = "";
  };

  const upload = async () => {
    if (selected.length === 0) {
      onStatus?.("Please select at least one file first.");
      return;
    }

    setUploading(true);
    onStatus?.("Uploading...");

    try {
      const form = new FormData();
      // IMPORTANT: backend uses upload.array("files", X)
      selected.forEach((file) => form.append("files", file));

      const res = await fetch(`${apiBase}/upload`, {
        method: "POST",
        body: form,
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Upload failed (${res.status})`);

      clearSelection();
      onUploaded?.();
      onStatus?.("Upload complete ✅");
    } catch (e) {
      onStatus?.(e.message || "Upload error");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="uploadBox">
      <div className="uploadLabel">FILE UPLOAD HERE:</div>

      {/* Drag & Drop Zone */}
      <div
        className={`dropZone ${isDragging ? "dropZoneActive" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {selected.length > 0 ? (
          <div>
            <div className="metaStrong">{selected.length} file(s) selected</div>
            <div className="metaDim">{formatSize(totalBytes)}</div>
          </div>
        ) : (
          <div>
            <div className="metaStrong">Drag & drop files here</div>
            <div className="metaDim">or click Select File</div>
          </div>
        )}
      </div>

      <div className="uploadRow">
        <label className="btn">
          Select File(s)
          <input id="file-input" type="file" multiple onChange={onPick} hidden />
        </label>

        <button className="btn" onClick={upload} disabled={selected.length === 0 || uploading}>
          {uploading ? "Uploading..." : "Upload"}
        </button>

        <button className="btn" onClick={clearSelection} disabled={selected.length === 0 || uploading}>
          Clear
        </button>
      </div>
    </div>
  );
}

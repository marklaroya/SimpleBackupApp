const formatSize = (bytes) => {
  if (!bytes) return "0 B";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
};

export default function UploadProgress({ active, percent, loadedBytes, totalBytes }) {
  if (!active) return null;

  const clampedPercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const hasTotal = Number.isFinite(totalBytes) && totalBytes > 0;

  return (
    <div className="uploadProgress" role="status" aria-live="polite">
      <div className="uploadProgressTop">
        <span className="uploadProgressLabel">Uploading</span>
        <span className="uploadProgressPercent">{clampedPercent}%</span>
      </div>

      <div className="uploadProgressTrack" aria-hidden="true">
        <div className="uploadProgressFill" style={{ width: `${clampedPercent}%` }} />
      </div>

      <div className="uploadProgressMeta">
        {formatSize(loadedBytes)}
        {hasTotal ? ` / ${formatSize(totalBytes)}` : ""}
      </div>
    </div>
  );
}

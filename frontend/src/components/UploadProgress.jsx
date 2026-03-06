const formatSize = (bytes) => {
  if (!bytes) return "0 B";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
};

export default function UploadProgress({
  active,
  percent,
  loadedBytes,
  totalBytes,
  phase = "uploading",
}) {
  if (!active) return null;

  const clampedPercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const displayPercent =
    phase === "finalizing" && clampedPercent >= 100 ? 99 : clampedPercent;
  const hasTotal = Number.isFinite(totalBytes) && totalBytes > 0;
  const label = phase === "finalizing" ? "Finalizing on server" : "Uploading";
  const metaText =
    phase === "finalizing"
      ? "All chunks uploaded. Server is assembling the final file."
      : `${formatSize(loadedBytes)}${hasTotal ? ` / ${formatSize(totalBytes)}` : ""}`;

  return (
    <div className="uploadProgress" role="status" aria-live="polite">
      <div className="uploadProgressTop">
        <span className="uploadProgressLabel">{label}</span>
        <span className="uploadProgressPercent">{displayPercent}%</span>
      </div>

      <div className="uploadProgressTrack" aria-hidden="true">
        <div className="uploadProgressFill" style={{ width: `${displayPercent}%` }} />
      </div>

      <div className="uploadProgressMeta">{metaText}</div>
    </div>
  );
}

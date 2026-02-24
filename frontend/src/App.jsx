import { useEffect, useMemo, useState } from "react";
import UploadBox from "./components/UploadBox.jsx";
import FileTable from "./components/FileTable.jsx";

const formatSize = (bytes) => {
  if (!bytes) return "0 B";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
};

export default function App() {
  const API = import.meta.env.VITE_API_BASE || "Netbird IP:4000";

  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  const totalBytes = useMemo(
    () => files.reduce((sum, file) => sum + (file?.size || 0), 0),
    [files]
  );

  const loadFiles = async () => {
    setLoading(true);
    setStatus((prev) => (prev.includes("Upload complete") ? prev : ""));
    try {
      const res = await fetch(`${API}/backup/files`);
      if (!res.ok) throw new Error(`List failed (${res.status})`);
      const data = await res.json();
      setFiles(data.files || []);
    } catch (e) {
      setStatus(e.message || "Failed to load files");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusTone = /error|failed/i.test(status)
    ? "statusError"
    : /complete|success/i.test(status)
      ? "statusSuccess"
      : "statusInfo";

  return (
    <div className="page">
      <div className="ambientBlob ambientBlobA" />
      <div className="ambientBlob ambientBlobB" />

      <main className="shell">
        <header className="hero">
          <div className="heroBadge">Self-hosted backup</div>
          <h1>Backup Vault</h1>
          <p>Upload, track, and download files from backup directory.</p>

          <div className="heroStats">
            <div className="statCard">
              <span className="statValue">{files.length}</span>
              <span className="statLabel">Stored Files</span>
            </div>
            <div className="statCard">
              <span className="statValue">{formatSize(totalBytes)}</span>
              <span className="statLabel">Total Size</span>
            </div>
            <div className="statCard">
              <span className="statValue">{loading ? "..." : "Ready"}</span>
              <span className="statLabel">Server State</span>
            </div>
          </div>
        </header>

        <section className="panelGrid">
          <UploadBox
            apiBase={API}
            onUploaded={() => {
              setStatus("Upload complete");
              loadFiles();
            }}
            onStatus={(msg) => setStatus(msg)}
          />

          <FileTable
            files={files}
            loading={loading}
            apiBase={API}
            onRefresh={loadFiles}
          />
        </section>

        {status && <div className={`statusLine ${statusTone}`}>{status}</div>}
      </main>
    </div>
  );
}

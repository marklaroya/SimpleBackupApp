import { useEffect, useMemo, useRef, useState } from "react";
import UploadBox from "./components/UploadBox.jsx";
import FileTable from "./components/FileTable.jsx";

const LOAD_TIMEOUT_MS = 15000;

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
  const API =
    import.meta.env.VITE_API_BASE ||
    `${window.location.protocol}//${window.location.hostname}:4000`;

  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const activeLoadController = useRef(null);

  const totalBytes = useMemo(
    () => files.reduce((sum, file) => sum + (file?.size || 0), 0),
    [files]
  );

  const loadFiles = async () => {
    if (activeLoadController.current) {
      activeLoadController.current.abort();
    }

    const controller = new AbortController();
    activeLoadController.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);

    setLoading(true);
    setStatus((prev) => (prev.includes("Upload complete") ? prev : ""));
    try {
      const res = await fetch(`${API}/backup/files`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`List failed (${res.status})`);
      const data = await res.json();
      setFiles(data.files || []);
    } catch (e) {
      if (activeLoadController.current !== controller) return;

      if (e?.name === "AbortError") {
        setStatus("Server request timed out. Please try Refresh.");
      } else {
        setStatus(e.message || "Failed to load files");
      }
    } finally {
      clearTimeout(timeoutId);
      if (activeLoadController.current === controller) {
        activeLoadController.current = null;
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    loadFiles();
    return () => {
      if (activeLoadController.current) {
        activeLoadController.current.abort();
      }
    };
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

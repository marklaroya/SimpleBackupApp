import { useEffect, useState } from "react";
import UploadBox from "./components/UploadBox.jsx";
import FileTable from "./components/FileTable.jsx";


export default function App() {
  const API = import.meta.env.VITE_API_BASE || "Netbird IP:4000";

  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  const loadFiles = async () => {
    setLoading(true);
    setStatus("");
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

  return (
    <div className="page">
      <div className="title"></div>

      <div className="card">
        <div className="cardTop">
          <div className="cardTopLeft">BackUp Files</div>
          <div className="cardTopCenter">WELCOME!</div>
          <div />
        </div>

        <div className="content">
          <UploadBox
            apiBase={API}
            onUploaded={() => {
              setStatus("Upload complete ✅");
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

          {status && <div className="statusLine">{status}</div>}
        </div>
      </div>
    </div>
  );
}

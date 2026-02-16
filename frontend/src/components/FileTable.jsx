export default function FileTable({ files, loading, apiBase, onRefresh }) {
  return (
    <div className="tableBox">
      <div className="tableHeader">
        <span>File</span>
        <span style={{ textAlign: "right" }}>Download</span>
      </div>

      {loading ? (
        <div className="tableEmpty">Loading...</div>
      ) : files.length === 0 ? (
        <div className="tableEmpty">No files yet.</div>
      ) : (
        <div className="rows">
          {files.map((f) => (
            <div className="row" key={f.filename}>
              <div className="rowFile">{f.filename}</div>

              <a
                className="downloadLink"
                href={`${apiBase}${f.url}`}
                target="_blank"
                rel="noreferrer"
              >
                Download
              </a>
            </div>
          ))}
        </div>
      )}

      <div className="tableFooter">
        <button className="btn" onClick={onRefresh} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
        <span className="metaDim">{files.length} file(s)</span>
      </div>
    </div>
  );
}

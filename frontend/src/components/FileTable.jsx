import { useMemo, useState } from "react";

const CATEGORY_GROUPS = [
  {
    label: "Documents",
    exts: ["pdf", "doc", "docx", "txt", "rtf", "odt", "md", "ppt", "pptx", "xls", "xlsx", "csv"],
  },
  {
    label: "Images",
    exts: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "avif"],
  },
  {
    label: "Video",
    exts: ["mp4", "mov", "avi", "mkv", "wmv", "webm", "m4v"],
  },
  {
    label: "Audio",
    exts: ["mp3", "wav", "m4a", "aac", "flac", "ogg"],
  },
  {
    label: "Archives",
    exts: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"],
  },
  {
    label: "Code",
    exts: ["js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "cs", "go", "rs", "php", "html", "css", "json", "yml", "yaml"],
  },
];

const CATEGORY_ORDER = [
  "All",
  "Documents",
  "Images",
  "Video",
  "Audio",
  "Archives",
  "Code",
  "Other",
];

const formatSize = (bytes) => {
  if (!bytes) return "0 B";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
};

const formatDate = (value) => {
  if (!value) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

const getExtension = (filename) => {
  if (!filename || !filename.includes(".")) return "FILE";
  const ext = filename.split(".").pop();
  return (ext || "FILE").slice(0, 4).toUpperCase();
};

const inferCategory = (filename) => {
  if (!filename || !filename.includes(".")) return "Other";
  const ext = (filename.split(".").pop() || "").toLowerCase();

  for (const group of CATEGORY_GROUPS) {
    if (group.exts.includes(ext)) return group.label;
  }

  return "Other";
};

export default function FileTable({ files, loading, apiBase, onRefresh }) {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("newest");
  const [copyMessage, setCopyMessage] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");

  const categoryCounts = useMemo(() => {
    const counts = Object.fromEntries(CATEGORY_ORDER.map((name) => [name, 0]));
    counts.All = files.length;

    files.forEach((file) => {
      const category = inferCategory(file.filename);
      counts[category] = (counts[category] || 0) + 1;
    });

    return counts;
  }, [files]);

  const visibleFiles = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    const filtered = files.filter((file) => {
      const matchesQuery = !normalized || (file.filename || "").toLowerCase().includes(normalized);
      const matchesCategory =
        activeCategory === "All" || inferCategory(file.filename) === activeCategory;
      return matchesQuery && matchesCategory;
    });

    filtered.sort((a, b) => {
      switch (sortBy) {
        case "oldest":
          return new Date(a.modified || 0) - new Date(b.modified || 0);
        case "largest":
          return (b.size || 0) - (a.size || 0);
        case "smallest":
          return (a.size || 0) - (b.size || 0);
        case "name-asc":
          return (a.filename || "").localeCompare(b.filename || "");
        case "name-desc":
          return (b.filename || "").localeCompare(a.filename || "");
        case "newest":
        default:
          return new Date(b.modified || 0) - new Date(a.modified || 0);
      }
    });

    return filtered;
  }, [files, query, sortBy, activeCategory]);

  const copyLink = async (url) => {
    if (!navigator?.clipboard) {
      setCopyMessage("Clipboard is not available in this browser.");
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      setCopyMessage("Link copied.");
    } catch {
      setCopyMessage("Copy failed.");
    }
  };

  return (
    <div className="tableBox">
      <div className="tableTop">
        <div className="sectionHead">
          <div className="sectionTitle">Stored Files</div>
          <div className="sectionMeta">{files.length} total</div>
        </div>

        <div className="tableTools">
          <input
            className="fieldInput"
            type="search"
            placeholder="Search file names"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="fieldSelect"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="largest">Largest</option>
            <option value="smallest">Smallest</option>
            <option value="name-asc">Name A-Z</option>
            <option value="name-desc">Name Z-A</option>
          </select>
        </div>

        <div className="categoryRow">
          {CATEGORY_ORDER.map((category) => (
            <button
              key={category}
              type="button"
              className={`categoryChip ${activeCategory === category ? "isActive" : ""}`}
              onClick={() => setActiveCategory(category)}
            >
              <span>{category}</span>
              <span className="chipCount">{categoryCounts[category] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="tableHeader">
        <span>File</span>
        <span>Size</span>
        <span>Actions</span>
      </div>

      {loading ? (
        <div className="tableEmpty">Loading files...</div>
      ) : visibleFiles.length === 0 ? (
        <div className="tableEmpty">No matching files found.</div>
      ) : (
        <div className="rows">
          {visibleFiles.map((file) => {
            const absoluteUrl = `${apiBase}${file.url}`;
            const category = inferCategory(file.filename);

            return (
              <div className="row" key={file.filename}>
                <div className="rowFile">
                  <span className="fileBadge">{getExtension(file.filename)}</span>
                  <div className="fileMeta">
                    <div className="fileName" title={file.filename}>
                      {file.filename}
                    </div>
                    <div className="fileSubRow">
                      <span className="fileCategory">{category}</span>
                      <span className="fileSub">{formatDate(file.modified)}</span>
                    </div>
                  </div>
                </div>

                <div className="rowSize">{formatSize(file.size)}</div>

                <div className="rowActions">
                  <button type="button" className="miniBtn" onClick={() => copyLink(absoluteUrl)}>
                    Copy Link
                  </button>
                  <a className="miniBtn miniBtnStrong" href={absoluteUrl} target="_blank" rel="noreferrer">
                    Download
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="tableFooter">
        <button className="btn btnGhost" onClick={onRefresh} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
        <span className="metaDim">{copyMessage || `${visibleFiles.length} shown`}</span>
      </div>
    </div>
  );
}

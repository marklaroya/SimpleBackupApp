import { useEffect, useMemo, useState } from "react";

const PAGE_SIZES = [8, 16, 32];

const CATEGORY_GROUPS = [
  {
    label: "All",
    exts: [],
  },
  {
    label: "Documents",
    exts: [
      "pdf",
      "doc",
      "docx",
      "txt",
      "rtf",
      "odt",
      "md",
      "ppt",
      "pptx",
      "xls",
      "xlsx",
      "csv",
    ],
  },
  {
    label: "Images",
    exts: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "avif"],
  },
  {
    label: "Audio",
    exts: ["mp3", "wav", "m4a", "aac", "flac", "ogg"],
  },
  {
    label: "Videos",
    exts: ["mp4", "mov", "avi", "mkv", "wmv", "webm", "m4v"],
  },
  {
    label: "Others",
    exts: [],
  },
];

const LEGACY_PREFIX_RE = /^(\d{12,})-(.+)$/;

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
  return ((filename.split(".").pop() || "FILE").slice(0, 4)).toUpperCase();
};

const inferCategory = (filename) => {
  if (!filename || !filename.includes(".")) return "Others";
  const ext = (filename.split(".").pop() || "").toLowerCase();

  const group = CATEGORY_GROUPS.find(
    (item) => item.label !== "All" && item.label !== "Others" && item.exts.includes(ext)
  );
  return group ? group.label : "Others";
};

const parseLegacyName = (filename) => {
  if (!filename) {
    return { cleaned: "Unnamed file", legacyId: "", isLegacy: false };
  }

  const match = filename.match(LEGACY_PREFIX_RE);
  if (!match) {
    return { cleaned: filename, legacyId: "", isLegacy: false };
  }

  return {
    cleaned: match[2] || filename,
    legacyId: match[1].slice(-4),
    isLegacy: true,
  };
};

const addDuplicateIndex = (name, index) => {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return `${name} (${index})`;
  const base = name.slice(0, dotIndex);
  const ext = name.slice(dotIndex);
  return `${base} (${index})${ext}`;
};

export default function FileTable({
  files,
  loading,
  apiBase,
  onRefresh,
  onDelete,
  searchQuery = "",
}) {
  const [sortBy, setSortBy] = useState("newest");
  const [activeCategory, setActiveCategory] = useState("All");
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [page, setPage] = useState(1);
  const [copyMessage, setCopyMessage] = useState("");
  const [deletingFilename, setDeletingFilename] = useState("");

  const displayNameByFilename = useMemo(() => {
    const groups = new Map();

    files.forEach((file) => {
      const parsed = parseLegacyName(file.filename);
      if (!groups.has(parsed.cleaned)) groups.set(parsed.cleaned, []);
      groups.get(parsed.cleaned).push(file);
    });

    const labels = new Map();

    groups.forEach((groupFiles, cleaned) => {
      if (groupFiles.length === 1) {
        labels.set(groupFiles[0].filename, cleaned);
        return;
      }

      const sortedGroup = [...groupFiles].sort((a, b) => {
        const timeA = new Date(a.modified || 0).getTime();
        const timeB = new Date(b.modified || 0).getTime();
        if (timeA !== timeB) return timeA - timeB;
        return (a.filename || "").localeCompare(b.filename || "");
      });

      sortedGroup.forEach((file, index) => {
        labels.set(file.filename, addDuplicateIndex(cleaned, index + 1));
      });
    });

    return labels;
  }, [files]);

  const filteredFiles = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();

    const filtered = files.filter((file) => {
      const matchesQuery =
        !normalized || (file.filename || "").toLowerCase().includes(normalized);
      const category = inferCategory(file.filename);
      const matchesCategory =
        activeCategory === "All" || category === activeCategory;
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
  }, [activeCategory, files, searchQuery, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filteredFiles.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const visibleFiles = filteredFiles.slice(startIndex, startIndex + pageSize);
  const rangeStart = filteredFiles.length === 0 ? 0 : startIndex + 1;
  const rangeEnd = Math.min(filteredFiles.length, startIndex + visibleFiles.length);
  const hasActiveFilters = searchQuery.trim().length > 0 || activeCategory !== "All";

  useEffect(() => {
    if (!copyMessage) return;
    const timeout = setTimeout(() => setCopyMessage(""), 2200);
    return () => clearTimeout(timeout);
  }, [copyMessage]);

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

  const deleteFile = async (file, uiName) => {
    const ok = window.confirm(`Delete "${uiName}"? This cannot be undone.`);
    if (!ok) return;

    setDeletingFilename(file.filename);
    try {
      let res = await fetch(
        `${apiBase}/backup/files/${encodeURIComponent(file.filename)}`,
        { method: "DELETE" }
      );

      if (res.status === 404 || res.status === 405) {
        res = await fetch(`${apiBase}/backup/files/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.filename }),
        });
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || `Delete failed (${res.status})`);
      }

      setCopyMessage("File deleted.");
      await onDelete?.(file.filename, data.message);
    } catch (error) {
      setCopyMessage(error.message || "Delete failed.");
    } finally {
      setDeletingFilename("");
    }
  };

  return (
    <section className="dashboardPanel recentFilesSection">
      <div className="filesHead">
        <div>
          <h2 className="sectionTitle">Recent Files</h2>
          <p className="sectionText">
            {filteredFiles.length} file(s) in view
            {searchQuery.trim() ? ` for "${searchQuery.trim()}"` : ""}.
          </p>
        </div>

        <div className="filesHeadControls">
          <select
            className="fieldSelect"
            value={activeCategory}
            onChange={(event) => {
              setActiveCategory(event.target.value);
              setPage(1);
            }}
          >
            {CATEGORY_GROUPS.map((group) => (
              <option key={group.label} value={group.label}>
                {group.label}
              </option>
            ))}
          </select>

          <select
            className="fieldSelect"
            value={sortBy}
            onChange={(event) => {
              setSortBy(event.target.value);
              setPage(1);
            }}
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="largest">Largest</option>
            <option value="smallest">Smallest</option>
            <option value="name-asc">Name A-Z</option>
            <option value="name-desc">Name Z-A</option>
          </select>

          <select
            className="fieldSelect"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} / page
              </option>
            ))}
          </select>

          <button
            type="button"
            className="controlButton controlButtonQuiet"
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="tableEmpty">Loading files...</div>
      ) : visibleFiles.length === 0 ? (
        <div className="tableEmpty">
          {hasActiveFilters ? "No matching files found." : "No files uploaded yet."}
        </div>
      ) : (
        <div className="recentTable">
          <div className="recentTableHead recentTableGrid">
            <span>File</span>
            <span>Type</span>
            <span>Size</span>
            <span>Date Modified</span>
            <span>Actions</span>
          </div>

          <div className="recentTableBody">
            {visibleFiles.map((file) => {
              const absoluteUrl = `${apiBase}${file.url}`;
              const category = inferCategory(file.filename);
              const parsedName = parseLegacyName(file.filename);
              const uiName =
                displayNameByFilename.get(file.filename) || parsedName.cleaned;
              const isDeleting = deletingFilename === file.filename;

              return (
                <div className="recentTableRow recentTableGrid" key={file.filename}>
                  <div className="recentFileCell">
                    <span className="fileBadge">{getExtension(file.filename)}</span>
                    <div className="recentMeta">
                      <span className="recentName" title={file.filename}>
                        {uiName}
                      </span>
                      <span className="recentSecondary">
                        {parsedName.isLegacy
                          ? `Imported version ${parsedName.legacyId}`
                          : "Stored in backup vault"}
                      </span>
                    </div>
                  </div>

                  <div className="recentCell">
                    <span className="mobileLabel">Type</span>
                    <span className="fileCategoryPill">{category}</span>
                  </div>

                  <div className="recentCell">
                    <span className="mobileLabel">Size</span>
                    <span className="tableCellMeta">{formatSize(file.size)}</span>
                  </div>

                  <div className="recentCell">
                    <span className="mobileLabel">Date Modified</span>
                    <span className="tableCellMeta">{formatDate(file.modified)}</span>
                  </div>

                  <div className="recentActions">
                    <a
                      className="miniBtn miniBtnStrong"
                      href={absoluteUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Download
                    </a>
                    <button
                      type="button"
                      className="miniBtn"
                      onClick={() => copyLink(absoluteUrl)}
                    >
                      Copy Link
                    </button>
                    <button
                      type="button"
                      className="miniBtn miniBtnDanger"
                      onClick={() => deleteFile(file, uiName)}
                      disabled={isDeleting}
                    >
                      {isDeleting ? "Deleting" : "Delete"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="filesFooter">
        <div className="pager">
          <button
            className="btn btnGhost"
            type="button"
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            disabled={currentPage <= 1}
          >
            Prev
          </button>
          <span className="metaDim">
            Page {currentPage} / {totalPages}
          </span>
          <button
            className="btn btnGhost"
            type="button"
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
            disabled={currentPage >= totalPages}
          >
            Next
          </button>
        </div>

        <span className="metaDim">
          {copyMessage || `${rangeStart}-${rangeEnd} of ${filteredFiles.length} shown`}
        </span>
      </div>
    </section>
  );
}

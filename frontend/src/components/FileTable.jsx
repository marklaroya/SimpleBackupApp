import { useEffect, useMemo, useState } from "react";

const PAGE_SIZES = [8, 16, 32];
const ALL_FILES_FOLDER = "__all_files__";

const CATEGORY_GROUPS = [
  { label: "All", exts: [] },
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
  { label: "Audio", exts: ["mp3", "wav", "m4a", "aac", "flac", "ogg"] },
  { label: "Videos", exts: ["mp4", "mov", "avi", "mkv", "wmv", "webm", "m4v"] },
  { label: "Others", exts: [] },
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

const getBaseFilename = (filename) => {
  const normalized = `${filename || ""}`.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
};

const getFolderPath = (file) => {
  if (typeof file?.folder === "string") return file.folder;
  const normalized = `${file?.filename || ""}`.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
};

const getExtension = (filename) => {
  const basename = getBaseFilename(filename);
  if (!basename || !basename.includes(".")) return "FILE";
  return ((basename.split(".").pop() || "FILE").slice(0, 4)).toUpperCase();
};

const inferCategory = (filename) => {
  const basename = getBaseFilename(filename);
  if (!basename || !basename.includes(".")) return "Others";
  const ext = (basename.split(".").pop() || "").toLowerCase();
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
  currentFolder = ALL_FILES_FOLDER,
  onRefresh,
  onDelete,
  onRename,
  onRequestMove,
  searchQuery = "",
}) {
  const [sortBy, setSortBy] = useState("newest");
  const [activeCategory, setActiveCategory] = useState("All");
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [page, setPage] = useState(1);
  const [copyMessage, setCopyMessage] = useState("");
  const [deletingFilename, setDeletingFilename] = useState("");
  const [renamingFilename, setRenamingFilename] = useState("");

  const displayNameByFilename = useMemo(() => {
    const groups = new Map();

    files.forEach((file) => {
      const basename = file.basename || getBaseFilename(file.filename);
      const parsed = parseLegacyName(basename);
      const groupKey = `${getFolderPath(file)}::${parsed.cleaned}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(file);
    });

    const labels = new Map();

    groups.forEach((groupFiles) => {
      const cleaned =
        parseLegacyName(groupFiles[0]?.basename || getBaseFilename(groupFiles[0]?.filename)).cleaned ||
        "Unnamed file";

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
      const folderPath = getFolderPath(file);
      const basename = file.basename || getBaseFilename(file.filename);
      const matchesFolder =
        currentFolder === ALL_FILES_FOLDER ? true : folderPath === currentFolder;
      const matchesQuery =
        !normalized ||
        basename.toLowerCase().includes(normalized) ||
        folderPath.toLowerCase().includes(normalized);
      const category = inferCategory(file.filename);
      const matchesCategory =
        activeCategory === "All" || category === activeCategory;

      return matchesFolder && matchesQuery && matchesCategory;
    });

    filtered.sort((a, b) => {
      const aBase = a.basename || getBaseFilename(a.filename);
      const bBase = b.basename || getBaseFilename(b.filename);

      switch (sortBy) {
        case "oldest":
          return new Date(a.modified || 0) - new Date(b.modified || 0);
        case "largest":
          return (b.size || 0) - (a.size || 0);
        case "smallest":
          return (a.size || 0) - (b.size || 0);
        case "name-asc":
          return aBase.localeCompare(bBase);
        case "name-desc":
          return bBase.localeCompare(aBase);
        case "newest":
        default:
          return new Date(b.modified || 0) - new Date(a.modified || 0);
      }
    });

    return filtered;
  }, [activeCategory, currentFolder, files, searchQuery, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filteredFiles.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const visibleFiles = filteredFiles.slice(startIndex, startIndex + pageSize);
  const rangeStart = filteredFiles.length === 0 ? 0 : startIndex + 1;
  const rangeEnd = Math.min(filteredFiles.length, startIndex + visibleFiles.length);
  const hasActiveFilters =
    searchQuery.trim().length > 0 || activeCategory !== "All";

  useEffect(() => {
    setPage(1);
  }, [searchQuery, activeCategory, currentFolder, pageSize, sortBy]);

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
      const res = await fetch(`${apiBase}/backup/files/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.filename }),
      });

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

  const renameFile = async (file, uiName) => {
    const requestedName = window.prompt("Rename file", uiName);
    if (requestedName === null) return;

    const trimmedName = requestedName.trim();
    if (!trimmedName || trimmedName === uiName) return;

    setRenamingFilename(file.filename);
    try {
      const res = await fetch(`${apiBase}/backup/files/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.filename,
          nextFilename: trimmedName,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || `Rename failed (${res.status})`);
      }

      setCopyMessage("File renamed.");
      await onRename?.(file.filename, data.filename, data.message);
    } catch (error) {
      setCopyMessage(error.message || "Rename failed.");
    } finally {
      setRenamingFilename("");
    }
  };

  return (
    <section className="dashboardPanel recentFilesSection">
      <div className="filesHead">
        <div className="filesHeadMain">
          <h2 className="sectionTitle">Recent Files</h2>
          <p className="sectionText">
            {filteredFiles.length} file(s) in view
            {currentFolder !== ALL_FILES_FOLDER ? " for this folder" : ""}
            {searchQuery.trim() ? ` matching "${searchQuery.trim()}"` : ""}.
          </p>
        </div>

        <div className="filesHeadControls">
          <select
            className="fieldSelect"
            value={activeCategory}
            onChange={(event) => setActiveCategory(event.target.value)}
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
            onChange={(event) => setSortBy(event.target.value)}
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
            onChange={(event) => setPageSize(Number(event.target.value))}
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
          <div className="recentTableToolbar">
            <div className="recentTableScope">
              <span className="recentTableLabel">Workspace</span>
              <strong className="recentTableValue">
                {currentFolder === ALL_FILES_FOLDER ? "All Files" : currentFolder || "Root"}
              </strong>
            </div>
            <div className="recentTableSummary">
              <span>{filteredFiles.length} items</span>
              <span>{rangeStart}-{rangeEnd} visible</span>
            </div>
          </div>

          <div className="recentTableHead recentTableGrid">
            <span>Name</span>
            <span>Folder</span>
            <span>Modified</span>
            <span>Size</span>
            <span>Actions</span>
          </div>

          <div className="recentTableBody">
            {visibleFiles.map((file) => {
              const absoluteUrl = `${apiBase}${file.url}`;
              const category = inferCategory(file.filename);
              const basename = file.basename || getBaseFilename(file.filename);
              const folderPath = getFolderPath(file);
              const parsedName = parseLegacyName(basename);
              const uiName =
                displayNameByFilename.get(file.filename) || parsedName.cleaned;
              const isDeleting = deletingFilename === file.filename;
              const isRenaming = renamingFilename === file.filename;

              let secondaryMeta = folderPath || "Root";
              if (currentFolder !== ALL_FILES_FOLDER && parsedName.isLegacy) {
                secondaryMeta = `Imported version ${parsedName.legacyId}`;
              }

              return (
                <div className="recentTableRow recentTableGrid" key={file.filename}>
                  <div className="recentFileCell">
                    <span className="fileBadge">{getExtension(basename)}</span>
                    <div className="recentMeta">
                      <span className="recentName" title={basename}>
                        {uiName}
                      </span>
                      <div className="recentMetaLine">
                        <span className="fileTypeTag">{category}</span>
                        <span className="recentSecondary">{secondaryMeta}</span>
                      </div>
                    </div>
                  </div>

                  <div className="recentCell">
                    <span className="mobileLabel">Folder</span>
                    <span className="tableCellMeta" title={folderPath || "Root"}>
                      {folderPath || "Root"}
                    </span>
                  </div>

                  <div className="recentCell">
                    <span className="mobileLabel">Modified</span>
                    <span className="tableCellMeta">{formatDate(file.modified)}</span>
                  </div>

                  <div className="recentCell">
                    <span className="mobileLabel">Size</span>
                    <span className="tableCellValue">{formatSize(file.size)}</span>
                  </div>

                  <div className="recentActions">
                    <a
                      className="recentActionPrimary"
                      href={absoluteUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Download
                    </a>
                    <div className="recentActionGroup">
                      <button
                        type="button"
                        className="recentActionSecondary"
                        onClick={() => onRequestMove?.(file)}
                        disabled={isDeleting || isRenaming}
                      >
                        Move
                      </button>
                      <button
                        type="button"
                        className="recentActionSecondary"
                        onClick={() => renameFile(file, uiName)}
                        disabled={isDeleting || isRenaming}
                      >
                        {isRenaming ? "Renaming" : "Rename"}
                      </button>
                      <button
                        type="button"
                        className="recentActionSecondary"
                        onClick={() => copyLink(absoluteUrl)}
                        disabled={isDeleting || isRenaming}
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        className="recentActionSecondary recentActionDanger"
                        onClick={() => deleteFile(file, uiName)}
                        disabled={isDeleting || isRenaming}
                      >
                        {isDeleting ? "Deleting" : "Delete"}
                      </button>
                    </div>
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import UploadBox from "./components/UploadBox.jsx";
import FileTable from "./components/FileTable.jsx";

const LOAD_TIMEOUT_MS = 30000;
const THEME_STORAGE_KEY = "simplebackup.theme";
const STORAGE_CAPACITY_GB = Number(import.meta.env.VITE_STORAGE_CAPACITY_GB || 100);
const STORAGE_CAPACITY_BYTES =
  Number.isFinite(STORAGE_CAPACITY_GB) && STORAGE_CAPACITY_GB > 0
    ? STORAGE_CAPACITY_GB * 1024 * 1024 * 1024
    : 100 * 1024 * 1024 * 1024;
const ALL_FILES_FOLDER = "__all_files__";

const STORAGE_GROUPS = [
  {
    key: "Documents",
    label: "Documents",
    shortLabel: "DOC",
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
    color: "var(--chart-documents)",
  },
  {
    key: "Images",
    label: "Images",
    shortLabel: "IMG",
    exts: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "avif"],
    color: "var(--chart-images)",
  },
  {
    key: "Audio",
    label: "Audio",
    shortLabel: "AUD",
    exts: ["mp3", "wav", "m4a", "aac", "flac", "ogg"],
    color: "var(--chart-audio)",
  },
  {
    key: "Videos",
    label: "Videos",
    shortLabel: "VID",
    exts: ["mp4", "mov", "avi", "mkv", "wmv", "webm", "m4v"],
    color: "var(--chart-videos)",
  },
  {
    key: "Others",
    label: "Others",
    shortLabel: "ETC",
    exts: [],
    color: "var(--chart-others)",
  },
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
  if (!value) return "Unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
};

const getBaseFilename = (filename) => {
  const normalized = `${filename || ""}`.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
};

const getFileFolder = (file) => {
  if (typeof file?.folder === "string") return file.folder;

  const normalized = `${file?.filename || ""}`.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
};

const getFolderName = (folderPath) => {
  if (!folderPath) return "Root";
  const parts = folderPath.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "Root";
};

const getParentFolder = (folderPath) => {
  if (!folderPath) return "";
  const parts = folderPath.split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
};

const buildFolderTree = (folders) => {
  const nodeMap = new Map();
  folders.forEach((folder) => {
    nodeMap.set(folder.path, {
      ...folder,
      children: [],
    });
  });

  const roots = [];
  nodeMap.forEach((node) => {
    if (node.parentPath && nodeMap.has(node.parentPath)) {
      nodeMap.get(node.parentPath).children.push(node);
      return;
    }
    roots.push(node);
  });

  const sortNodes = (nodes) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((node) => sortNodes(node.children));
    return nodes;
  };

  return sortNodes(roots);
};

const resolveStorageGroup = (filename) => {
  const baseName = getBaseFilename(filename);
  if (!baseName || !baseName.includes(".")) return "Others";
  const ext = (baseName.split(".").pop() || "").toLowerCase();
  const match = STORAGE_GROUPS.find(
    (group) => group.key !== "Others" && group.exts.includes(ext)
  );
  return match ? match.key : "Others";
};

const buildDonutGradient = (segments, totalBytes) => {
  if (!totalBytes) return "conic-gradient(var(--chart-empty) 0deg 360deg)";

  let current = 0;
  const stops = [];

  segments.forEach((segment) => {
    if (!segment.bytes) return;
    const portion = (segment.bytes / totalBytes) * 360;
    const start = current;
    const end = current + portion;
    stops.push(`${segment.color} ${start}deg ${end}deg`);
    current = end;
  });

  if (current < 360) {
    stops.push(`var(--chart-empty) ${current}deg 360deg`);
  }

  return `conic-gradient(${stops.join(", ")})`;
};

export default function App() {
  const API =
    import.meta.env.VITE_API_BASE ||
    `${window.location.protocol}//${window.location.hostname}:4000`;

  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentFolder, setCurrentFolder] = useState(ALL_FILES_FOLDER);
  const [theme, setTheme] = useState(() => {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === "light" || storedTheme === "dark") return storedTheme;
    return "light";
  });
  const [moveDialog, setMoveDialog] = useState({
    open: false,
    file: null,
    targetFolder: "",
    submitting: false,
  });

  const activeLoadController = useRef(null);

  const loadLibrary = useCallback(async () => {
    if (activeLoadController.current) {
      activeLoadController.current.abort();
    }

    const controller = new AbortController();
    activeLoadController.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);

    setLoading(true);
    setStatus((prev) =>
      /Upload complete|File deleted|File renamed|File moved|Folder created|Folder deleted/i.test(prev)
        ? prev
        : ""
    );

    try {
      const [filesRes, foldersRes] = await Promise.all([
        fetch(`${API}/backup/files`, {
          signal: controller.signal,
          cache: "no-store",
        }),
        fetch(`${API}/backup/folders`, {
          signal: controller.signal,
          cache: "no-store",
        }),
      ]);

      if (!filesRes.ok) throw new Error(`Files failed (${filesRes.status})`);
      if (!foldersRes.ok) throw new Error(`Folders failed (${foldersRes.status})`);

      const filesData = await filesRes.json();
      const foldersData = await foldersRes.json();

      setFiles(filesData.files || []);
      setFolders(foldersData.folders || []);
    } catch (error) {
      if (activeLoadController.current !== controller) return;
      if (error?.name === "AbortError") {
        setStatus("Server request timed out. Please try again.");
      } else {
        setStatus(error.message || "Failed to load library");
      }
    } finally {
      clearTimeout(timeoutId);
      if (activeLoadController.current === controller) {
        activeLoadController.current = null;
        setLoading(false);
      }
    }
  }, [API]);

  useEffect(() => {
    loadLibrary();
    return () => {
      if (activeLoadController.current) {
        activeLoadController.current.abort();
      }
    };
  }, [loadLibrary]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (currentFolder === ALL_FILES_FOLDER || currentFolder === "") return;
    if (folders.some((folder) => folder.path === currentFolder)) return;
    setCurrentFolder("");
  }, [currentFolder, folders]);

  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);

  const scopedFiles = useMemo(() => {
    if (currentFolder === ALL_FILES_FOLDER) return files;
    return files.filter((file) => getFileFolder(file) === currentFolder);
  }, [currentFolder, files]);

  const totalBytes = useMemo(
    () => files.reduce((sum, file) => sum + (file?.size || 0), 0),
    [files]
  );

  const scopedBytes = useMemo(
    () => scopedFiles.reduce((sum, file) => sum + (file?.size || 0), 0),
    [scopedFiles]
  );

  const filesByRecent = useMemo(() => {
    return [...files].sort(
      (a, b) => new Date(b.modified || 0) - new Date(a.modified || 0)
    );
  }, [files]);

  const remainingBytes = Math.max(0, STORAGE_CAPACITY_BYTES - totalBytes);

  const storageCards = useMemo(() => {
    const initial = Object.fromEntries(
      STORAGE_GROUPS.map((group) => [group.key, { ...group, count: 0, bytes: 0 }])
    );

    scopedFiles.forEach((file) => {
      const key = resolveStorageGroup(file.filename);
      initial[key].count += 1;
      initial[key].bytes += file?.size || 0;
    });

    return STORAGE_GROUPS.map((group) => initial[group.key]);
  }, [scopedFiles]);

  const donutGradient = useMemo(
    () => buildDonutGradient(storageCards, scopedBytes),
    [storageCards, scopedBytes]
  );

  const currentFolderBreadcrumb = useMemo(() => {
    if (currentFolder === ALL_FILES_FOLDER) {
      return [{ label: "All Files", value: ALL_FILES_FOLDER }];
    }

    const parts = currentFolder.split("/").filter(Boolean);
    const segments = [{ label: "Root", value: "" }];
    parts.forEach((part, index) => {
      segments.push({
        label: part,
        value: parts.slice(0, index + 1).join("/"),
      });
    });
    return segments;
  }, [currentFolder]);

  const statusTone = /error|failed/i.test(status)
    ? "statusError"
    : /complete|success|deleted|canceled|renamed|moved|created/i.test(status)
      ? "statusSuccess"
      : "statusInfo";

  const createFolder = async () => {
    const baseFolder = currentFolder === ALL_FILES_FOLDER ? "" : currentFolder;
    const requested = window.prompt(
      "Create folder",
      baseFolder ? `${baseFolder}/New Folder` : "New Folder"
    );
    if (requested === null) return;

    const trimmed = requested.trim();
    if (!trimmed) return;

    try {
      const res = await fetch(`${API}/backup/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folderPath: trimmed,
          parentPath: baseFolder,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || `Create folder failed (${res.status})`);
      }

      setStatus(data.message || "Folder created.");
      setCurrentFolder(data.folder?.path || baseFolder || "");
      await loadLibrary();
    } catch (error) {
      setStatus(error.message || "Failed to create folder.");
    }
  };

  const deleteFolder = async () => {
    if (!currentFolder || currentFolder === ALL_FILES_FOLDER) return;

    const confirmed = window.confirm(`Delete empty folder "${currentFolder}"?`);
    if (!confirmed) return;

    try {
      const res = await fetch(`${API}/backup/folders/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath: currentFolder }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || `Delete folder failed (${res.status})`);
      }

      setStatus(data.message || "Folder deleted.");
      setCurrentFolder(getParentFolder(currentFolder));
      await loadLibrary();
    } catch (error) {
      setStatus(error.message || "Failed to delete folder.");
    }
  };

  const openMoveDialog = (file) => {
    setMoveDialog({
      open: true,
      file,
      targetFolder: getFileFolder(file),
      submitting: false,
    });
  };

  const closeMoveDialog = () => {
    setMoveDialog({
      open: false,
      file: null,
      targetFolder: "",
      submitting: false,
    });
  };

  const submitMoveDialog = async () => {
    if (!moveDialog.file) return;

    setMoveDialog((prev) => ({ ...prev, submitting: true }));
    try {
      const res = await fetch(`${API}/backup/files/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: moveDialog.file.filename,
          targetFolder: moveDialog.targetFolder,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || `Move failed (${res.status})`);
      }

      setStatus(data.message || "File moved.");
      closeMoveDialog();
      await loadLibrary();
    } catch (error) {
      setStatus(error.message || "Failed to move file.");
      setMoveDialog((prev) => ({ ...prev, submitting: false }));
    }
  };

  const renderFolderNodes = (nodes, depth = 0) => {
    return nodes.map((node) => (
      <div key={node.path} className="folderTreeNode">
        <button
          type="button"
          className={`folderTreeButton ${currentFolder === node.path ? "isActive" : ""}`}
          style={{ paddingLeft: `${14 + depth * 16}px` }}
          onClick={() => setCurrentFolder(node.path)}
        >
          <span className="folderTreeGlyph" aria-hidden="true">
            FD
          </span>
          <span className="folderTreeLabel">{node.name}</span>
        </button>
        {node.children.length > 0 ? renderFolderNodes(node.children, depth + 1) : null}
      </div>
    ));
  };

  return (
    <div className="page">
      <main className="vaultApp">
        <aside className="sidebarPanel">
          <div className="brandBlock">
            <span className="brandMark" aria-hidden="true">
              BV
            </span>
            <div className="brandMeta">
              <span className="brandEyebrow">Personal Cloud</span>
              <span className="brandTitle">Backup Vault</span>
            </div>
          </div>

          <div className="folderSection">
            <div className="folderSectionHead">
              <span className="sidebarFootLabel">Folders</span>
              <button type="button" className="folderActionLink" onClick={createFolder}>
                New
              </button>
            </div>

            <div className="folderQuickLinks">
              <button
                type="button"
                className={`folderTreeButton ${currentFolder === ALL_FILES_FOLDER ? "isActive" : ""}`}
                onClick={() => setCurrentFolder(ALL_FILES_FOLDER)}
              >
                <span className="folderTreeGlyph" aria-hidden="true">
                  AL
                </span>
                <span className="folderTreeLabel">All Files</span>
              </button>

              <button
                type="button"
                className={`folderTreeButton ${currentFolder === "" ? "isActive" : ""}`}
                onClick={() => setCurrentFolder("")}
              >
                <span className="folderTreeGlyph" aria-hidden="true">
                  RT
                </span>
                <span className="folderTreeLabel">Root</span>
              </button>
            </div>

            <div className="folderTree">{renderFolderNodes(folderTree)}</div>
          </div>

          <div className="sidebarFoot">
            <span className="sidebarFootLabel">Current scope</span>
            <strong className="sidebarFootValue">
              {currentFolder === ALL_FILES_FOLDER ? "All Files" : getFolderName(currentFolder)}
            </strong>
            <span className="sidebarFootHint">
              {currentFolder === ALL_FILES_FOLDER
                ? `${files.length} files across all folders`
                : `${scopedFiles.length} files in ${currentFolder || "Root"}`}
            </span>
            {currentFolder !== ALL_FILES_FOLDER && currentFolder !== "" ? (
              <button type="button" className="btn btnGhost" onClick={deleteFolder}>
                Delete Empty Folder
              </button>
            ) : null}
          </div>
        </aside>

        <section className="workspacePanel">
          <header className="topBar">
            <label className="searchField">
              <span className="searchFieldIcon" aria-hidden="true" />
              <input
                className="searchInput"
                type="search"
                placeholder="Search files..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </label>

            <div className="topBarActions">
              <button
                type="button"
                className="controlButton controlButtonQuiet"
                onClick={loadLibrary}
                disabled={loading}
              >
                {loading ? "Syncing" : "Refresh"}
              </button>
              <button
                type="button"
                className="controlButton controlButtonQuiet"
                onClick={() =>
                  setTheme((prev) => (prev === "dark" ? "light" : "dark"))
                }
              >
                {theme === "dark" ? "Light" : "Dark"}
              </button>
              <div className="profileChip">
                <span className="profileAvatar">ML</span>
                <div className="profileMeta">
                  <span className="profileName">My Storage</span>
                  <span className="profileHint">Private server</span>
                </div>
              </div>
            </div>
          </header>

          <div className="workspaceGrid">
            <div className="workspaceMain">
              <section className="dashboardPanel storageSection">
                <div className="sectionHead storageSectionHead">
                  <div>
                    <h1 className="sectionTitle">Storage</h1>
                    <p className="sectionText">
                      Overview for {currentFolder === ALL_FILES_FOLDER ? "all files" : currentFolder || "Root"}.
                    </p>
                  </div>
                  <div className="storageSectionMeta">
                    <span className="storageMetaPill">{scopedFiles.length} files</span>
                    <span className="storageMetaPill">{formatSize(scopedBytes)} in scope</span>
                    <span className="storageMetaPill">{formatSize(remainingBytes)} free</span>
                  </div>
                </div>

                <div className="storageCardsGrid">
                  {storageCards.map((group) => (
                    <article className="storageCard" key={group.key}>
                      <span className="storageCardGlyph">{group.shortLabel}</span>
                      <div className="storageCardBody">
                        <strong className="storageCardValue">
                          {group.count} {group.label}
                        </strong>
                        <span className="storageCardMeta">{formatSize(group.bytes)}</span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <UploadBox
                apiBase={API}
                currentFolder={currentFolder === ALL_FILES_FOLDER ? "" : currentFolder}
                onUploaded={() => {
                  setStatus("Upload complete");
                  loadLibrary();
                }}
                onStatus={(message) => setStatus(message)}
              />

              <section className="dashboardPanel folderBreadcrumbPanel">
                <div className="folderBreadcrumb">
                  {currentFolderBreadcrumb.map((item, index) => (
                    <div key={item.value || "root"} className="folderBreadcrumbItem">
                      <button
                        type="button"
                        className={`folderBreadcrumbButton ${
                          item.value === currentFolder ? "isActive" : ""
                        }`}
                        onClick={() => setCurrentFolder(item.value)}
                      >
                        {item.label}
                      </button>
                      {index < currentFolderBreadcrumb.length - 1 ? (
                        <span className="folderBreadcrumbDivider">/</span>
                      ) : null}
                    </div>
                  ))}
                </div>

                <div className="folderBreadcrumbMeta">
                  <span>{currentFolder === ALL_FILES_FOLDER ? "All folders" : currentFolder || "Root"}</span>
                  <span>{scopedFiles.length} visible</span>
                </div>
              </section>

              <FileTable
                files={files}
                loading={loading}
                apiBase={API}
                currentFolder={currentFolder}
                onRefresh={loadLibrary}
                searchQuery={searchQuery}
                onRequestMove={openMoveDialog}
                onRename={async (_previousFilename, _nextFilename, message) => {
                  setStatus(message || "File renamed");
                  await loadLibrary();
                }}
                onDelete={async (_filename, message) => {
                  setStatus(message || "File deleted");
                  await loadLibrary();
                }}
              />

              {status && <div className={`statusLine ${statusTone}`}>{status}</div>}
            </div>

            <aside className="statsPanel">
              <div className="sectionHead statsPanelHead">
                <div>
                  <h2 className="sectionTitle">Storage Stats</h2>
                  <p className="sectionText">
                    Scope-aware summary for your current folder view.
                  </p>
                </div>
              </div>

              <div className="donutCard">
                <div
                  className="donutChart"
                  style={{ background: donutGradient }}
                  aria-hidden="true"
                >
                  <div className="donutChartInner">
                    <strong>{scopedFiles.length}</strong>
                    <span>files</span>
                  </div>
                </div>

                <div className="donutSummary">
                  <strong>{formatSize(scopedBytes)}</strong>
                  <span>{currentFolder === ALL_FILES_FOLDER ? "in all folders" : "in current scope"}</span>
                </div>
              </div>

              <div className="statsLegend">
                {storageCards.map((group) => (
                  <div className="statsLegendRow" key={group.key}>
                    <div className="statsLegendMain">
                      <span
                        className="statsLegendDot"
                        style={{ background: group.color }}
                        aria-hidden="true"
                      />
                      <span>{group.label}</span>
                    </div>
                    <span className="statsLegendValue">{formatSize(group.bytes)}</span>
                  </div>
                ))}
              </div>

              <div className="statsMetaCard">
                <div className="statsMetaRow">
                  <span className="statsMetaLabel">Free space</span>
                  <strong>{formatSize(remainingBytes)}</strong>
                </div>
                <div className="statsMetaRow">
                  <span className="statsMetaLabel">Latest update</span>
                  <strong>
                    {filesByRecent[0] ? formatDate(filesByRecent[0].modified) : "No files yet"}
                  </strong>
                </div>
                <div className="statsMetaRow">
                  <span className="statsMetaLabel">Current folder</span>
                  <strong>{currentFolder === ALL_FILES_FOLDER ? "All Files" : currentFolder || "Root"}</strong>
                </div>
              </div>
            </aside>
          </div>
        </section>
      </main>

      {moveDialog.open && moveDialog.file ? (
        <div className="dialogBackdrop" role="presentation" onClick={closeMoveDialog}>
          <div
            className="dialogPanel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="move-file-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialogHead">
              <div>
                <h2 className="sectionTitle dialogTitle" id="move-file-title">
                  Move File
                </h2>
                <p className="sectionText">
                  Move {moveDialog.file.basename || getBaseFilename(moveDialog.file.filename)} to another folder.
                </p>
              </div>
            </div>

            <label className="inputGroup">
              <span className="inputLabel">Destination</span>
              <select
                className="fieldSelect dialogSelect"
                value={moveDialog.targetFolder}
                onChange={(event) =>
                  setMoveDialog((prev) => ({ ...prev, targetFolder: event.target.value }))
                }
                disabled={moveDialog.submitting}
              >
                <option value="">Root</option>
                {folders.map((folder) => (
                  <option key={folder.path} value={folder.path}>
                    {folder.path}
                  </option>
                ))}
              </select>
            </label>

            <div className="dialogActions">
              <button
                type="button"
                className="btn btnGhost"
                onClick={closeMoveDialog}
                disabled={moveDialog.submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btnAccent"
                onClick={submitMoveDialog}
                disabled={moveDialog.submitting}
              >
                {moveDialog.submitting ? "Moving" : "Move File"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

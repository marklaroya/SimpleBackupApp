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

const NAV_ITEMS = [
  { label: "Home", shortLabel: "HM", active: true },
  { label: "My Files", shortLabel: "FL" },
  { label: "Documents", shortLabel: "DC" },
  { label: "Images", shortLabel: "IM" },
  { label: "Audio", shortLabel: "AU" },
  { label: "Videos", shortLabel: "VD" },
  { label: "Recent", shortLabel: "RC" },
  { label: "Shared", shortLabel: "SH" },
  { label: "Trash", shortLabel: "TR" },
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

const resolveStorageGroup = (filename) => {
  if (!filename || !filename.includes(".")) return "Others";
  const ext = (filename.split(".").pop() || "").toLowerCase();
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

  if (stops.length === 0) {
    return "conic-gradient(var(--chart-empty) 0deg 360deg)";
  }

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
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [theme, setTheme] = useState(() => {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === "light" || storedTheme === "dark") return storedTheme;
    return "light";
  });

  const activeLoadController = useRef(null);

  const totalBytes = useMemo(
    () => files.reduce((sum, file) => sum + (file?.size || 0), 0),
    [files]
  );

  const filesByRecent = useMemo(() => {
    return [...files].sort(
      (a, b) => new Date(b.modified || 0) - new Date(a.modified || 0)
    );
  }, [files]);

  const usedPercent = Math.max(
    0,
    Math.min(100, Math.round((totalBytes / STORAGE_CAPACITY_BYTES) * 100))
  );
  const remainingBytes = Math.max(0, STORAGE_CAPACITY_BYTES - totalBytes);

  const searchMatchCount = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) return files.length;
    return files.filter((file) =>
      (file.filename || "").toLowerCase().includes(normalized)
    ).length;
  }, [files, searchQuery]);

  const storageCards = useMemo(() => {
    const initial = Object.fromEntries(
      STORAGE_GROUPS.map((group) => [
        group.key,
        { ...group, count: 0, bytes: 0 },
      ])
    );

    files.forEach((file) => {
      const key = resolveStorageGroup(file.filename);
      initial[key].count += 1;
      initial[key].bytes += file?.size || 0;
    });

    return STORAGE_GROUPS.map((group) => initial[group.key]);
  }, [files]);

  const donutGradient = useMemo(
    () => buildDonutGradient(storageCards, totalBytes),
    [storageCards, totalBytes]
  );

  const loadFiles = useCallback(async () => {
    if (activeLoadController.current) {
      activeLoadController.current.abort();
    }

    const controller = new AbortController();
    activeLoadController.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);

    setLoading(true);
    setStatus((prev) => (/Upload complete|File deleted/i.test(prev) ? prev : ""));
    try {
      const res = await fetch(`${API}/backup/files`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`List failed (${res.status})`);
      const data = await res.json();
      setFiles(data.files || []);
    } catch (error) {
      if (activeLoadController.current !== controller) return;
      if (error?.name === "AbortError") {
        setStatus("Server request timed out. Please try again.");
      } else {
        setStatus(error.message || "Failed to load files");
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
    loadFiles();
    return () => {
      if (activeLoadController.current) {
        activeLoadController.current.abort();
      }
    };
  }, [loadFiles]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const statusTone = /error|failed/i.test(status)
    ? "statusError"
    : /complete|success|deleted|canceled/i.test(status)
      ? "statusSuccess"
      : "statusInfo";

  return (
    <div className="page">
      <main className="vaultApp">
        <aside className="sidebarPanel">
          <div className="brandBlock">
            <span className="brandMark" aria-hidden="true">
              BV
            </span>
            <div className="brandMeta">
              <span className="brandEyebrow">Personal</span>
              <span className="brandTitle">File Storage</span>
            </div>
          </div>

          <nav className="sidebarNavList" aria-label="Primary navigation">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.label}
                type="button"
                className={`sidebarNavItem ${item.active ? "isActive" : ""}`}
              >
                <span className="sidebarNavGlyph" aria-hidden="true">
                  {item.shortLabel}
                </span>
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebarFoot">
            <span className="sidebarFootLabel">Current n</span>
            <strong className="sidebarFootValue">{STORAGE_CAPACITY_GB} GB</strong>
            <span className="sidebarFootHint">
              {formatSize(remainingBytes)} free, {usedPercent}% in use.
            </span>
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
                onClick={loadFiles}
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
                      A quick view of how your library is distributed across file
                      types.
                    </p>
                  </div>
                  <div className="storageSectionMeta">
                    <span className="storageMetaPill">{files.length} files</span>
                    <span className="storageMetaPill">{formatSize(totalBytes)} used</span>
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
                onUploaded={() => {
                  setStatus("Upload complete");
                  loadFiles();
                }}
                onStatus={(message) => setStatus(message)}
              />

              <FileTable
                files={files}
                loading={loading}
                apiBase={API}
                onRefresh={loadFiles}
                searchQuery={searchQuery}
                onRename={async (_previousFilename, _nextFilename, message) => {
                  setStatus(message || "File renamed");
                  await loadFiles();
                }}
                onDelete={async (_filename, message) => {
                  setStatus(message || "File deleted");
                  await loadFiles();
                }}
              />

              {status && <div className={`statusLine ${statusTone}`}>{status}</div>}
            </div>

            <aside className="statsPanel">
              <div className="sectionHead statsPanelHead">
                <div>
                  <h2 className="sectionTitle">Storage Stats</h2>
                  <p className="sectionText">
                    A clear summary of your current storage usage.
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
                    <strong>{usedPercent}%</strong>
                    <span>Used</span>
                  </div>
                </div>

                <div className="donutSummary">
                  <strong>{formatSize(totalBytes)}</strong>
                  <span>of {STORAGE_CAPACITY_GB} GB</span>
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
                  <span className="statsMetaLabel">Visible now</span>
                  <strong>{searchMatchCount}</strong>
                </div>
                <div className="statsMetaRow">
                  <span className="statsMetaLabel">Latest update</span>
                  <strong>
                    {filesByRecent[0] ? formatDate(filesByRecent[0].modified) : "No files yet"}
                  </strong>
                </div>
                <div className="statsMetaRow">
                  <span className="statsMetaLabel">Server state</span>
                  <strong>{loading ? "Syncing" : "Ready"}</strong>
                </div>
              </div>
            </aside>
          </div>
        </section>
      </main>
    </div>
  );
}

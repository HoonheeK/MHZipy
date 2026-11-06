import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openPowerShellRunnerWindow } from './openPowerShellManagerWindow';

export interface PowerShellFolder {
  id: string;
  name: string;
  parentId: string | null;
  order?: number;
}

export interface PowerShellSnippet {
  id: string;
  title: string;
  category: string;
  parentId?: string | null;
  description: string;
  code: string;
  updatedAt: number;
}

export interface PowerShellRunRecord {
  id: string;
  scriptId: string;
  scriptTitle: string;
  code: string;
  workingDir: string;
  selectedFiles: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  shellUsed: string;
  timestamp: number;
}

interface PowerShellRunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  shell_used: string;
}

interface VisibleTreeItem {
  id: string;
  kind: 'folder' | 'script';
  name: string;
  parentId: string | null;
  depth: number;
  folder?: PowerShellFolder;
  snippet?: PowerShellSnippet;
}

const DEFAULT_FOLDERS: PowerShellFolder[] = [
  { id: 'folder_files', name: 'Files', parentId: null },
  { id: 'folder_security', name: 'Security', parentId: null },
  { id: 'folder_analytics', name: 'Analytics', parentId: null },
  { id: 'folder_dev_git', name: 'Dev & Git', parentId: null },
  { id: 'folder_system', name: 'System', parentId: null },
];

const DEFAULT_SNIPPETS: PowerShellSnippet[] = [
  {
    id: 'ps_default_files_summary',
    title: 'Selected Files / Folder Summary',
    category: 'Files',
    parentId: 'folder_files',
    description: 'Lists file size, last modified time, and full path for selected files (or current folder).',
    code: `# Uses $SelectedFiles (from MHZipy FileList) or lists $CurrentDir
if ($SelectedFiles.Count -gt 0) {
    $SelectedFiles | ForEach-Object { Get-Item -LiteralPath $_ } |
        Select-Object Name, @{N='Size(KB)';E={[math]::Round($_.Length/1KB, 2)}}, LastWriteTime, FullName |
        Format-Table -AutoSize | Out-String -Width 4096
} else {
    Get-ChildItem -LiteralPath $CurrentDir -Force |
        Select-Object Mode, Name, @{N='Size(KB)';E={if ($_.PSIsContainer) {'<DIR>'} else {[math]::Round($_.Length/1KB, 2)}}}, LastWriteTime |
        Format-Table -AutoSize | Out-String -Width 4096
}`,
    updatedAt: Date.now(),
  },
  {
    id: 'ps_default_sha256',
    title: 'SHA-256 Checksum Calculator',
    category: 'Security',
    parentId: 'folder_security',
    description: 'Calculates SHA-256 hashes for selected files (or all files in current folder) for easy copying.',
    code: `$targets = if ($SelectedFiles.Count -gt 0) {
    $SelectedFiles | ForEach-Object { Get-Item -LiteralPath $_ } | Where-Object { -not $_.PSIsContainer }
} else {
    Get-ChildItem -LiteralPath $CurrentDir -File
}

if (-not $targets) {
    Write-Output "No files found to hash."
} else {
    $targets | ForEach-Object {
        $h = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
        [PSCustomObject]@{
            FileName = $_.Name
            SHA256   = $h.Hash
            SizeKB   = [math]::Round($_.Length / 1KB, 2)
        }
    } | Format-Table -AutoSize | Out-String -Width 4096
}`,
    updatedAt: Date.now(),
  },
  {
    id: 'ps_default_ext_stats',
    title: 'Directory Extension & Size Breakdown',
    category: 'Analytics',
    parentId: 'folder_analytics',
    description: 'Groups all files in $CurrentDir (recursively) by extension and calculates count and total MB.',
    code: `Write-Output "Scanning directory: $CurrentDir ..."
Get-ChildItem -LiteralPath $CurrentDir -File -Recurse -ErrorAction SilentlyContinue |
    Group-Object Extension |
    Select-Object @{N='Extension';E={if ($_.Name) {$_.Name} else {'(no ext)'}}},
                  Count,
                  @{N='Total(MB)';E={[math]::Round(($_.Group | Measure-Object Length -Sum).Sum / 1MB, 2)}} |
    Sort-Object 'Total(MB)' -Descending |
    Format-Table -AutoSize | Out-String -Width 4096`,
    updatedAt: Date.now(),
  },
  {
    id: 'ps_default_git_status',
    title: 'Git Status & Recent 10 Commits',
    category: 'Dev & Git',
    parentId: 'folder_dev_git',
    description: 'Shows git branch, status, and the last 10 commits in the current working directory.',
    code: `Write-Output "=== Working Directory: $CurrentDir ==="
git status -sb
Write-Output "\`n=== Recent 10 Commits ==="
git log -n 10 --oneline --decorate`,
    updatedAt: Date.now(),
  },
  {
    id: 'ps_default_sys_network',
    title: 'System & Active Listening Ports',
    category: 'System',
    parentId: 'folder_system',
    description: 'Displays OS version, IPv4 addresses, and top memory-consuming processes.',
    code: `Write-Output "=== IPv4 Addresses ==="
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -ne '127.0.0.1' } |
    Select-Object InterfaceAlias, IPAddress | Format-Table -AutoSize | Out-String -Width 4096

Write-Output "=== Top 10 Processes by Memory (MB) ==="
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 \`
    Name, Id, @{N='Memory(MB)';E={[math]::Round($_.WorkingSet64 / 1MB, 1)}} |
    Format-Table -AutoSize | Out-String -Width 4096`,
    updatedAt: Date.now(),
  },
];

interface PowerShellManagerProps {
  initialWorkingDir?: string;
  initialScriptFilePath?: string;
  runnerMode?: boolean;
  runId?: string;
}

const PowerShellManager: React.FC<PowerShellManagerProps> = ({
  initialWorkingDir = '',
  initialScriptFilePath = '',
  runnerMode = false,
  runId = '',
}) => {
  const [folders, setFolders] = useState<PowerShellFolder[]>(DEFAULT_FOLDERS);
  const [snippets, setSnippets] = useState<PowerShellSnippet[]>(DEFAULT_SNIPPETS);
  const [history, setHistory] = useState<PowerShellRunRecord[]>([]);

  // Tree expansion & selection state
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(
    () => new Set(DEFAULT_FOLDERS.map((f) => f.id))
  );
  const [selectedSnippetId, setSelectedSnippetId] = useState<string>(DEFAULT_SNIPPETS[0].id);
  const [selectedScriptIds, setSelectedScriptIds] = useState<Set<string>>(
    () => new Set([DEFAULT_SNIPPETS[0].id])
  );
  const [activeFolderId, setActiveFolderId] = useState<string | null>('folder_files');
  const [anchorItemId, setAnchorItemId] = useState<string | null>(DEFAULT_SNIPPETS[0].id);
  const [focusedItemId, setFocusedItemId] = useState<string | null>(DEFAULT_SNIPPETS[0].id);

  // Tree Clipboard (Ctrl+C / Ctrl+X / Ctrl+V)
  const [treeClipboard, setTreeClipboard] = useState<{
    scriptIds: string[];
    op: 'copy' | 'cut';
  } | null>(null);

  // Tree Drag & Drop state
  const [dragOverFolderId, setDragOverFolderId] = useState<string | 'ROOT' | null>(null);

  // Tree Context Menu state
  const [treeContextMenu, setTreeContextMenu] = useState<{
    x: number;
    y: number;
    targetKind: 'folder' | 'script' | 'root';
    targetId: string | null;
  } | null>(null);

  // Inline Rename in Tree
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  const [renamingText, setRenamingText] = useState<string>('');

  // Marquee (Rubber-band) Range Selection state in Tree
  const [marquee, setMarquee] = useState<{
    startX: number;
    startY: number;
    curX: number;
    curY: number;
  } | null>(null);

  // Active editor fields
  const [title, setTitle] = useState<string>(DEFAULT_SNIPPETS[0].title);
  const [description, setDescription] = useState<string>(DEFAULT_SNIPPETS[0].description);
  const [code, setCode] = useState<string>(DEFAULT_SNIPPETS[0].code);
  const [isDirty, setIsDirty] = useState<boolean>(false);

  // Explorer context
  const [workingDir, setWorkingDir] = useState<string>(initialWorkingDir || 'C:\\');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [showSelectedFilesModal, setShowSelectedFilesModal] = useState<boolean>(false);

  // Filter in sidebar
  const [searchTerm, setSearchTerm] = useState<string>('');

  // Resizable Splitters (Left/Right and Top/Bottom)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('mhz_ps_sidebar_width'));
    return !Number.isNaN(saved) && saved >= 180 && saved <= 600 ? saved : 295;
  });
  const [prevSidebarWidth, setPrevSidebarWidth] = useState<number>(295);
  const [topPaneRatio, setTopPaneRatio] = useState<number>(() => {
    const saved = Number(localStorage.getItem('mhz_ps_top_ratio'));
    return !Number.isNaN(saved) && saved >= 18 && saved <= 82 ? saved : runnerMode ? 42 : 52;
  });
  const [isResizingHorizontal, setIsResizingHorizontal] = useState<boolean>(false);
  const [isResizingVertical, setIsResizingVertical] = useState<boolean>(false);

  // Selectable Run Mode ('inline' = run in current window, 'window' = open standalone runner window)
  const [runMode, setRunMode] = useState<'inline' | 'window'>(() => {
    return localStorage.getItem('mhz_ps_run_mode') === 'window' ? 'window' : 'inline';
  });
  const [runMenuOpen, setRunMenuOpen] = useState<boolean>(false);

  // Execution & Output state
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [activeBottomTab, setActiveBottomTab] = useState<'output' | 'history'>('output');
  const [currentResult, setCurrentResult] = useState<PowerShellRunRecord | null>(null);
  const [resultDialogOpen, setResultDialogOpen] = useState<boolean>(false);
  const [resultFilterQuery, setResultFilterQuery] = useState<string>('');
  const [copyFeedback, setCopyFeedback] = useState<string>('');
  const [saveFeedback, setSaveFeedback] = useState<string>('');
  const [isMaximized, setIsMaximized] = useState<boolean>(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rightPaneRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const nodeElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const runMenuRef = useRef<HTMLDivElement>(null);
  const storageLoadedRef = useRef<boolean>(false);

  const foldersRef = useRef<PowerShellFolder[]>(folders);
  const snippetsRef = useRef<PowerShellSnippet[]>(snippets);
  const historyRef = useRef<PowerShellRunRecord[]>(history);

  useEffect(() => {
    foldersRef.current = folders;
  }, [folders]);
  useEffect(() => {
    snippetsRef.current = snippets;
  }, [snippets]);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  // Close menus on outside click
  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (runMenuRef.current && !runMenuRef.current.contains(e.target as Node)) {
        setRunMenuOpen(false);
      }
      setTreeContextMenu(null);
    };
    window.addEventListener('mousedown', onDocDown);
    return () => window.removeEventListener('mousedown', onDocDown);
  }, []);

  // Handle Left/Right (Horizontal) & Top/Bottom (Vertical) Splitter Dragging
  useEffect(() => {
    if (!isResizingHorizontal && !isResizingVertical) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingHorizontal && workspaceRef.current) {
        const rect = workspaceRef.current.getBoundingClientRect();
        const nextWidth = Math.min(Math.max(e.clientX - rect.left, 180), Math.min(620, rect.width - 360));
        setSidebarWidth(nextWidth);
        try {
          localStorage.setItem('mhz_ps_sidebar_width', String(Math.round(nextWidth)));
        } catch {}
      } else if (isResizingVertical && rightPaneRef.current) {
        const rect = rightPaneRef.current.getBoundingClientRect();
        if (rect.height > 100) {
          const pct = ((e.clientY - rect.top) / rect.height) * 100;
          const clamped = Math.min(Math.max(pct, 18), 82);
          setTopPaneRatio(clamped);
          try {
            localStorage.setItem('mhz_ps_top_ratio', String(Math.round(clamped)));
          } catch {}
        }
      }
    };

    const handleMouseUp = () => {
      setIsResizingHorizontal(false);
      setIsResizingVertical(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingHorizontal, isResizingVertical]);

  const persistData = useCallback(
    async (
      nextFolders: PowerShellFolder[],
      nextSnippets: PowerShellSnippet[],
      nextHistory: PowerShellRunRecord[]
    ) => {
      if (!storageLoadedRef.current || runnerMode) return;
      try {
        const dir = await appConfigDir();
        if (!(await exists(dir))) {
          await mkdir(dir, { recursive: true });
        }
        const filePath = await join(dir, 'ps_manager.json');
        await writeTextFile(
          filePath,
          JSON.stringify(
            {
              folders: nextFolders,
              snippets: nextSnippets,
              history: nextHistory.slice(0, 50),
            },
            null,
            2
          )
        );
      } catch (err) {
        console.warn('Failed to save ps_manager.json:', err);
      }
    },
    [runnerMode]
  );

  // Build Flattened Visible Tree Items for Rendering, Shift+Click, and Shift+Arrow Navigation
  const visibleTreeItems = useMemo<VisibleTreeItem[]>(() => {
    const q = searchTerm.trim().toLowerCase();
    const result: VisibleTreeItem[] = [];

    if (q) {
      // When searching, show matching scripts flat with their folder context
      for (const s of snippets) {
        if (
          s.title.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.code.toLowerCase().includes(q)
        ) {
          result.push({
            id: s.id,
            kind: 'script',
            name: s.title,
            parentId: s.parentId ?? null,
            depth: 0,
            snippet: s,
          });
        }
      }
      return result;
    }

    const traverse = (parentId: string | null, depth: number) => {
      const childFolders = folders
        .filter((f) => (f.parentId ?? null) === parentId)
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const folder of childFolders) {
        result.push({
          id: folder.id,
          kind: 'folder',
          name: folder.name,
          parentId,
          depth,
          folder,
        });
        if (expandedFolderIds.has(folder.id)) {
          traverse(folder.id, depth + 1);
        }
      }

      const childScripts = snippets.filter((s) => (s.parentId ?? null) === parentId);
      for (const script of childScripts) {
        result.push({
          id: script.id,
          kind: 'script',
          name: script.title,
          parentId,
          depth,
          snippet: script,
        });
      }
    };

    traverse(null, 0);
    return result;
  }, [folders, snippets, expandedFolderIds, searchTerm]);

  // Marquee Selection Mouse Move / Up
  useEffect(() => {
    if (!marquee) return;

    const handleMouseMove = (e: MouseEvent) => {
      const nextMarquee = { ...marquee, curX: e.clientX, curY: e.clientY };
      setMarquee(nextMarquee);

      const minX = Math.min(nextMarquee.startX, nextMarquee.curX);
      const maxX = Math.max(nextMarquee.startX, nextMarquee.curX);
      const minY = Math.min(nextMarquee.startY, nextMarquee.curY);
      const maxY = Math.max(nextMarquee.startY, nextMarquee.curY);

      const hitScripts = new Set<string>();
      for (const item of visibleTreeItems) {
        if (item.kind !== 'script') continue;
        const el = nodeElementsRef.current.get(item.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const intersects = r.left <= maxX && r.right >= minX && r.top <= maxY && r.bottom >= minY;
        if (intersects) {
          hitScripts.add(item.id);
        }
      }

      if (hitScripts.size > 0) {
        setSelectedScriptIds(hitScripts);
        const firstId = Array.from(hitScripts)[0];
        const found = snippetsRef.current.find((s) => s.id === firstId);
        if (found) {
          setSelectedSnippetId(found.id);
          setTitle(found.title);
          setDescription(found.description || '');
          setCode(found.code);
          setIsDirty(false);
        }
      }
    };

    const handleMouseUp = () => {
      setMarquee(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [marquee, visibleTreeItems]);

  const executePowerShellCode = useCallback(
    async (execTitle: string, execCode: string, execWorkingDir: string, execSelectedFiles: string[]) => {
      if (!execCode.trim()) return;
      setIsRunning(true);
      setActiveBottomTab('output');

      try {
        const res = await invoke<PowerShellRunResult>('run_powershell_script', {
          code: execCode,
          workingDir: execWorkingDir,
          selectedFiles: execSelectedFiles,
        });

        const record: PowerShellRunRecord = {
          id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
          scriptId: selectedSnippetId,
          scriptTitle: execTitle.trim() || 'Untitled Script',
          code: execCode,
          workingDir: execWorkingDir,
          selectedFiles: [...execSelectedFiles],
          stdout: res.stdout || '',
          stderr: res.stderr || '',
          exitCode: res.exit_code,
          durationMs: res.duration_ms,
          shellUsed: res.shell_used,
          timestamp: Date.now(),
        };

        setCurrentResult(record);
        if (runnerMode) {
          emit('mhz-ps-runner-finished', record).catch(() => {});
        } else {
          const nextHistory = [record, ...historyRef.current].slice(0, 50);
          setHistory(nextHistory);
          persistData(foldersRef.current, snippetsRef.current, nextHistory);
        }
      } catch (err) {
        const record: PowerShellRunRecord = {
          id: `run_${Date.now()}`,
          scriptId: selectedSnippetId,
          scriptTitle: execTitle.trim() || 'Untitled Script',
          code: execCode,
          workingDir: execWorkingDir,
          selectedFiles: [...execSelectedFiles],
          stdout: '',
          stderr: String(err),
          exitCode: -1,
          durationMs: 0,
          shellUsed: 'Error',
          timestamp: Date.now(),
        };
        setCurrentResult(record);
      } finally {
        setIsRunning(false);
      }
    },
    [runnerMode, selectedSnippetId, persistData]
  );

  // Runner Mode Initialization
  useEffect(() => {
    if (!runnerMode || !runId) return;
    try {
      const storageKey = `mhz_ps_runner_${runId}`;
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        const rTitle = parsed.title || 'PowerShell Script';
        const rCode = parsed.code || '';
        const rWd = parsed.workingDir || 'C:\\';
        const rFiles = Array.isArray(parsed.selectedFiles) ? parsed.selectedFiles : [];

        setTitle(rTitle);
        setCode(rCode);
        setWorkingDir(rWd);
        setSelectedFiles(rFiles);
        localStorage.removeItem(storageKey);

        executePowerShellCode(rTitle, rCode, rWd, rFiles);
      }
    } catch (e) {
      console.error('Failed to initialize Runner window:', e);
    }
  }, [runnerMode, runId, executePowerShellCode]);

  // Studio Mode Initialization
  useEffect(() => {
    if (runnerMode) return;
    try {
      const raw = localStorage.getItem('mhz_ps_initial_context');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.workingDir && parsed.workingDir !== 'My PC') {
          setWorkingDir(parsed.workingDir);
        }
        if (Array.isArray(parsed.selectedFiles)) {
          setSelectedFiles(parsed.selectedFiles);
        }
        if (parsed.scriptFilePath) {
          loadExternalPs1File(parsed.scriptFilePath);
        }
      } else if (initialScriptFilePath) {
        loadExternalPs1File(initialScriptFilePath);
      }
    } catch {}
  }, [runnerMode, initialScriptFilePath]);

  // Listen for live context updates & runner window completions in Studio mode
  useEffect(() => {
    if (runnerMode) return;
    let unlistenCtx: (() => void) | null = null;
    let unlistenRunner: (() => void) | null = null;

    listen<{
      workingDir?: string;
      selectedFiles?: string[];
      scriptFilePath?: string;
    }>('mhz-ps-manager-context', (ev) => {
      const p = ev.payload;
      if (!p) return;
      if (p.workingDir && p.workingDir !== 'My PC') {
        setWorkingDir(p.workingDir);
      }
      if (Array.isArray(p.selectedFiles)) {
        setSelectedFiles(p.selectedFiles);
      }
      if (p.scriptFilePath) {
        loadExternalPs1File(p.scriptFilePath);
      }
    }).then((fn) => {
      unlistenCtx = fn;
    });

    listen<PowerShellRunRecord>('mhz-ps-runner-finished', (ev) => {
      const rec = ev.payload;
      if (!rec || !rec.id) return;
      setCurrentResult(rec);
      const nextHistory = [rec, ...historyRef.current].slice(0, 50);
      setHistory(nextHistory);
      persistData(foldersRef.current, snippetsRef.current, nextHistory);
    }).then((fn) => {
      unlistenRunner = fn;
    });

    return () => {
      if (unlistenCtx) unlistenCtx();
      if (unlistenRunner) unlistenRunner();
    };
  }, [runnerMode, persistData]);

  // Load saved folders, snippets & run history from appConfigDir/ps_manager.json
  useEffect(() => {
    if (runnerMode) return;
    const loadData = async () => {
      try {
        const dir = await appConfigDir();
        const filePath = await join(dir, 'ps_manager.json');
        if (await exists(filePath)) {
          const text = await readTextFile(filePath);
          const data = JSON.parse(text);

          let loadedFolders: PowerShellFolder[] = Array.isArray(data.folders)
            ? data.folders
            : [...DEFAULT_FOLDERS];

          let loadedSnippets: PowerShellSnippet[] =
            Array.isArray(data.snippets) && data.snippets.length > 0
              ? data.snippets
              : [...DEFAULT_SNIPPETS];

          // Migrate legacy category-based snippets to folder parentId if needed
          const folderByName = new Map<string, string>();
          for (const f of loadedFolders) {
            folderByName.set(f.name.toLowerCase(), f.id);
          }

          loadedSnippets = loadedSnippets.map((s) => {
            if (s.parentId !== undefined) return s;
            const cat = (s.category || '').trim();
            if (!cat) return { ...s, parentId: null };
            const existingFolderId = folderByName.get(cat.toLowerCase());
            if (existingFolderId) {
              return { ...s, parentId: existingFolderId };
            }
            const newFolderId = `folder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            loadedFolders.push({ id: newFolderId, name: cat, parentId: null });
            folderByName.set(cat.toLowerCase(), newFolderId);
            return { ...s, parentId: newFolderId };
          });

          setFolders(loadedFolders);
          setExpandedFolderIds(new Set(loadedFolders.map((f) => f.id)));
          setSnippets(loadedSnippets);

          if (loadedSnippets.length > 0) {
            const first = loadedSnippets[0];
            setSelectedSnippetId(first.id);
            setSelectedScriptIds(new Set([first.id]));
            setAnchorItemId(first.id);
            setFocusedItemId(first.id);
            setActiveFolderId(first.parentId ?? null);
            setTitle(first.title);
            setDescription(first.description || '');
            setCode(first.code || '');
          }

          if (Array.isArray(data.history)) {
            setHistory(data.history);
            if (data.history.length > 0) {
              setCurrentResult(data.history[0]);
            }
          }
        }
      } catch (err) {
        console.warn('Failed to load ps_manager.json:', err);
      } finally {
        storageLoadedRef.current = true;
      }
    };
    loadData();
  }, [runnerMode]);

  const activateSnippetInEditor = (item: PowerShellSnippet) => {
    setSelectedSnippetId(item.id);
    setActiveFolderId(item.parentId ?? null);
    setTitle(item.title);
    setDescription(item.description || '');
    setCode(item.code);
    setIsDirty(false);
  };

  const loadExternalPs1File = async (filePath: string) => {
    try {
      const content = await invoke<string>('read_text_file_content', { path: filePath });
      const fileName = filePath.split(/[\\/]/).pop() || 'Script.ps1';
      const parentDir = filePath.replace(/[\\/][^\\/]+$/, '');
      if (parentDir) setWorkingDir(parentDir);

      const newSnippet: PowerShellSnippet = {
        id: `ps_${Date.now()}`,
        title: fileName.replace(/\.ps1$/i, ''),
        category: 'Imported',
        parentId: activeFolderId,
        description: `Imported from ${filePath}`,
        code: content,
        updatedAt: Date.now(),
      };
      setSnippets((prev) => {
        const next = [newSnippet, ...prev];
        persistData(foldersRef.current, next, historyRef.current);
        return next;
      });
      setSelectedScriptIds(new Set([newSnippet.id]));
      setAnchorItemId(newSnippet.id);
      setFocusedItemId(newSnippet.id);
      activateSnippetInEditor(newSnippet);
    } catch (err) {
      console.error('Failed to read external .ps1 file:', err);
    }
  };

  const handleSaveCurrentSnippet = () => {
    const cleanTitle = title.trim() || 'Untitled PowerShell Script';
    const currentObj = snippets.find((s) => s.id === selectedSnippetId);
    const updatedItem: PowerShellSnippet = {
      id: selectedSnippetId || `ps_${Date.now()}`,
      title: cleanTitle,
      category: currentObj?.category || 'General',
      parentId: currentObj ? (currentObj.parentId ?? null) : activeFolderId,
      description: description.trim(),
      code,
      updatedAt: Date.now(),
    };

    const existsIdx = snippets.findIndex((s) => s.id === updatedItem.id);
    let nextSnippets: PowerShellSnippet[];
    if (existsIdx >= 0) {
      nextSnippets = [...snippets];
      nextSnippets[existsIdx] = updatedItem;
    } else {
      nextSnippets = [updatedItem, ...snippets];
    }

    setSnippets(nextSnippets);
    setSelectedSnippetId(updatedItem.id);
    setIsDirty(false);
    persistData(folders, nextSnippets, history);
    setSaveFeedback('💾 Saved!');
    setTimeout(() => setSaveFeedback(''), 1800);
  };

  const handleCreateNewSnippet = (targetParentId: string | null = activeFolderId) => {
    const newItem: PowerShellSnippet = {
      id: `ps_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: 'New PowerShell Script',
      category: 'Custom',
      parentId: targetParentId,
      description: '',
      code: `# Available variables from MHZipy:\n# $CurrentDir    -> Current Working Directory\n# $SelectedFiles -> Array of selected file/folder paths\n\nWrite-Output "Working Dir: $CurrentDir"\n`,
      updatedAt: Date.now(),
    };
    if (targetParentId) {
      setExpandedFolderIds((prev) => new Set([...prev, targetParentId]));
    }
    const next = [newItem, ...snippets];
    setSnippets(next);
    setSelectedScriptIds(new Set([newItem.id]));
    setAnchorItemId(newItem.id);
    setFocusedItemId(newItem.id);
    activateSnippetInEditor(newItem);
    persistData(folders, next, history);
  };

  const handleCreateNewFolder = (parentFolderId: string | null = null) => {
    const newFolder: PowerShellFolder = {
      id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: 'New Folder',
      parentId: parentFolderId,
    };
    const nextFolders = [...folders, newFolder];
    setFolders(nextFolders);
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      next.add(newFolder.id);
      if (parentFolderId) next.add(parentFolderId);
      return next;
    });
    setActiveFolderId(newFolder.id);
    setFocusedItemId(newFolder.id);
    setRenamingNodeId(newFolder.id);
    setRenamingText(newFolder.name);
    persistData(nextFolders, snippets, history);
  };

  // Tree Copy / Cut / Paste / Delete / Rename Operations
  const handleCopySelectedScripts = useCallback(() => {
    const ids = Array.from(selectedScriptIds);
    if (ids.length === 0) return;
    setTreeClipboard({ scriptIds: ids, op: 'copy' });
    setSaveFeedback(`📋 Copied ${ids.length} script(s)`);
    setTimeout(() => setSaveFeedback(''), 1500);
  }, [selectedScriptIds]);

  const handleCutSelectedScripts = useCallback(() => {
    const ids = Array.from(selectedScriptIds);
    if (ids.length === 0) return;
    setTreeClipboard({ scriptIds: ids, op: 'cut' });
    setSaveFeedback(`✂️ Cut ${ids.length} script(s)`);
    setTimeout(() => setSaveFeedback(''), 1500);
  }, [selectedScriptIds]);

  const handlePasteScriptsToFolder = useCallback(
    (targetFolderId: string | null) => {
      if (!treeClipboard || treeClipboard.scriptIds.length === 0) return;

      if (treeClipboard.op === 'cut') {
        const cutSet = new Set(treeClipboard.scriptIds);
        const nextSnippets = snippets.map((s) =>
          cutSet.has(s.id) ? { ...s, parentId: targetFolderId, updatedAt: Date.now() } : s
        );
        setSnippets(nextSnippets);
        setTreeClipboard(null);
        if (targetFolderId) {
          setExpandedFolderIds((prev) => new Set([...prev, targetFolderId]));
        }
        persistData(folders, nextSnippets, history);
        setSaveFeedback(`📁 Moved ${cutSet.size} script(s)`);
        setTimeout(() => setSaveFeedback(''), 1500);
      } else {
        // Copy (duplicate)
        const sourceItems = snippets.filter((s) => treeClipboard.scriptIds.includes(s.id));
        if (sourceItems.length === 0) return;
        const now = Date.now();
        const clonedItems: PowerShellSnippet[] = sourceItems.map((src, idx) => ({
          ...src,
          id: `ps_${now}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
          title:
            (src.parentId ?? null) === targetFolderId ? `${src.title} (Copy)` : src.title,
          parentId: targetFolderId,
          updatedAt: now + idx,
        }));
        const nextSnippets = [...clonedItems, ...snippets];
        setSnippets(nextSnippets);
        const newIds = new Set(clonedItems.map((c) => c.id));
        setSelectedScriptIds(newIds);
        activateSnippetInEditor(clonedItems[0]);
        if (targetFolderId) {
          setExpandedFolderIds((prev) => new Set([...prev, targetFolderId]));
        }
        persistData(folders, nextSnippets, history);
        setSaveFeedback(`📄 Pasted ${clonedItems.length} script(s)`);
        setTimeout(() => setSaveFeedback(''), 1500);
      }
    },
    [treeClipboard, snippets, folders, history, persistData]
  );

  const handleDeleteTreeItems = useCallback(
    (targetKind?: 'folder' | 'script', explicitId?: string) => {
      if (targetKind === 'folder' && explicitId) {
        // Collect folder and its descendant folders
        const toDeleteFolders = new Set<string>([explicitId]);
        let added = true;
        while (added) {
          added = false;
          for (const f of folders) {
            if (f.parentId && toDeleteFolders.has(f.parentId) && !toDeleteFolders.has(f.id)) {
              toDeleteFolders.add(f.id);
              added = true;
            }
          }
        }
        const nextFolders = folders.filter((f) => !toDeleteFolders.has(f.id));
        // Move scripts inside deleted folder to root (or delete? Wait: let's delete scripts or move to root? Moving scripts inside or deleting: let's delete scripts inside if user deletes folder, or keep at least 1 default)
        const nextSnippets = snippets.filter((s) => !s.parentId || !toDeleteFolders.has(s.parentId));
        const finalSnippets = nextSnippets.length > 0 ? nextSnippets : DEFAULT_SNIPPETS;
        setFolders(nextFolders);
        setSnippets(finalSnippets);
        if (!finalSnippets.some((s) => s.id === selectedSnippetId)) {
          activateSnippetInEditor(finalSnippets[0]);
          setSelectedScriptIds(new Set([finalSnippets[0].id]));
        }
        persistData(nextFolders, finalSnippets, history);
        return;
      }

      const idsToRemove =
        explicitId && !selectedScriptIds.has(explicitId)
          ? new Set([explicitId])
          : new Set(selectedScriptIds);

      if (idsToRemove.size === 0) return;

      const next = snippets.filter((s) => !idsToRemove.has(s.id));
      const finalSnippets = next.length > 0 ? next : DEFAULT_SNIPPETS;
      setSnippets(finalSnippets);
      if (idsToRemove.has(selectedSnippetId)) {
        activateSnippetInEditor(finalSnippets[0]);
      }
      setSelectedScriptIds(new Set([finalSnippets[0].id]));
      persistData(folders, finalSnippets, history);
    },
    [folders, snippets, selectedScriptIds, selectedSnippetId, history, persistData]
  );

  const handleStartRenameNode = (nodeId: string, currentName: string) => {
    setRenamingNodeId(nodeId);
    setRenamingText(currentName);
  };

  const handleFinishRenameNode = () => {
    if (!renamingNodeId) return;
    const clean = renamingText.trim();
    if (!clean) {
      setRenamingNodeId(null);
      return;
    }

    const isFolder = folders.some((f) => f.id === renamingNodeId);
    if (isFolder) {
      const nextFolders = folders.map((f) => (f.id === renamingNodeId ? { ...f, name: clean } : f));
      setFolders(nextFolders);
      persistData(nextFolders, snippets, history);
    } else {
      const nextSnippets = snippets.map((s) =>
        s.id === renamingNodeId ? { ...s, title: clean, updatedAt: Date.now() } : s
      );
      setSnippets(nextSnippets);
      if (selectedSnippetId === renamingNodeId) {
        setTitle(clean);
      }
      persistData(folders, nextSnippets, history);
    }
    setRenamingNodeId(null);
  };

  // Click / Shift+Click / Ctrl+Click selection on tree items
  const handleTreeItemClick = (e: React.MouseEvent, item: VisibleTreeItem) => {
    e.stopPropagation();
    treeContainerRef.current?.focus();

    if (item.kind === 'folder') {
      setActiveFolderId(item.id);
      setFocusedItemId(item.id);
      setExpandedFolderIds((prev) => {
        const next = new Set(prev);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
      return;
    }

    const script = item.snippet!;
    setActiveFolderId(script.parentId ?? null);
    setFocusedItemId(script.id);

    if (e.shiftKey && anchorItemId) {
      const scriptItems = visibleTreeItems.filter((v) => v.kind === 'script');
      const anchorIdx = scriptItems.findIndex((v) => v.id === anchorItemId);
      const targetIdx = scriptItems.findIndex((v) => v.id === script.id);
      if (anchorIdx !== -1 && targetIdx !== -1) {
        const start = Math.min(anchorIdx, targetIdx);
        const end = Math.max(anchorIdx, targetIdx);
        const rangeIds = new Set<string>();
        for (let i = start; i <= end; i++) {
          rangeIds.add(scriptItems[i].id);
        }
        setSelectedScriptIds(rangeIds);
        activateSnippetInEditor(script);
        return;
      }
    }

    if (e.ctrlKey || e.metaKey) {
      setSelectedScriptIds((prev) => {
        const next = new Set(prev);
        if (next.has(script.id)) {
          if (next.size > 1) next.delete(script.id);
        } else {
          next.add(script.id);
        }
        return next;
      });
      setAnchorItemId(script.id);
      activateSnippetInEditor(script);
      return;
    }

    setSelectedScriptIds(new Set([script.id]));
    setAnchorItemId(script.id);
    activateSnippetInEditor(script);
  };

  // Keyboard Navigation (Shift+Up/Down, Ctrl+C/X/V, Delete, F2) inside Tree
  const handleTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (renamingNodeId) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      handleCopySelectedScripts();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      handleCutSelectedScripts();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      handlePasteScriptsToFolder(activeFolderId);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      handleCreateNewFolder(activeFolderId);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      handleCreateNewSnippet(activeFolderId);
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      const focusedItem = visibleTreeItems.find((v) => v.id === focusedItemId);
      if (focusedItem?.kind === 'folder') {
        handleDeleteTreeItems('folder', focusedItem.id);
      } else {
        handleDeleteTreeItems('script');
      }
      return;
    }
    if (e.key === 'F2' && focusedItemId) {
      e.preventDefault();
      const focusedItem = visibleTreeItems.find((v) => v.id === focusedItemId);
      if (focusedItem) {
        handleStartRenameNode(focusedItem.id, focusedItem.name);
      }
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const scriptItems = visibleTreeItems.filter((v) => v.kind === 'script');
      if (scriptItems.length === 0) return;

      const curIdx = scriptItems.findIndex((v) => v.id === (focusedItemId || selectedSnippetId));
      const nextIdx =
        e.key === 'ArrowDown'
          ? Math.min(scriptItems.length - 1, curIdx + 1)
          : Math.max(0, curIdx - 1);

      const nextItem = scriptItems[nextIdx];
      if (!nextItem || !nextItem.snippet) return;

      setFocusedItemId(nextItem.id);
      activateSnippetInEditor(nextItem.snippet);

      const el = nodeElementsRef.current.get(nextItem.id);
      el?.scrollIntoView({ block: 'nearest' });

      if (e.shiftKey) {
        const effAnchor = anchorItemId || scriptItems[Math.max(0, curIdx)]?.id || nextItem.id;
        if (!anchorItemId) setAnchorItemId(effAnchor);
        const anchorIdx = scriptItems.findIndex((v) => v.id === effAnchor);
        if (anchorIdx !== -1) {
          const start = Math.min(anchorIdx, nextIdx);
          const end = Math.max(anchorIdx, nextIdx);
          const rangeIds = new Set<string>();
          for (let i = start; i <= end; i++) {
            rangeIds.add(scriptItems[i].id);
          }
          setSelectedScriptIds(rangeIds);
        }
      } else {
        setSelectedScriptIds(new Set([nextItem.id]));
        setAnchorItemId(nextItem.id);
      }
    }
  };

  // Drag & Drop Handlers for placing .ps1 scripts into Tree Folders
  const handleScriptDragStart = (e: React.DragEvent, script: PowerShellSnippet) => {
    let dragIds = Array.from(selectedScriptIds);
    if (!selectedScriptIds.has(script.id)) {
      dragIds = [script.id];
      setSelectedScriptIds(new Set([script.id]));
      setAnchorItemId(script.id);
      activateSnippetInEditor(script);
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-mhz-ps-scripts', JSON.stringify(dragIds));
  };

  const handleDropOnFolder = (e: React.DragEvent, targetFolderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolderId(null);

    const raw = e.dataTransfer.getData('application/x-mhz-ps-scripts');
    if (!raw) return;
    try {
      const dragIds: string[] = JSON.parse(raw);
      if (!Array.isArray(dragIds) || dragIds.length === 0) return;
      const dragSet = new Set(dragIds);
      const nextSnippets = snippets.map((s) =>
        dragSet.has(s.id) ? { ...s, parentId: targetFolderId, updatedAt: Date.now() } : s
      );
      setSnippets(nextSnippets);
      if (targetFolderId) {
        setExpandedFolderIds((prev) => new Set([...prev, targetFolderId]));
      }
      setActiveFolderId(targetFolderId);
      persistData(folders, nextSnippets, history);
      setSaveFeedback(`📁 Moved ${dragSet.size} script(s)`);
      setTimeout(() => setSaveFeedback(''), 1500);
    } catch {}
  };

  const handleImportPs1 = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: 'PowerShell Script', extensions: ['ps1', 'txt'] }],
    });
    if (picked && typeof picked === 'string') {
      await loadExternalPs1File(picked);
    }
  };

  const handleExportPs1 = async () => {
    const target = await save({
      defaultPath: `${title.replace(/[^a-zA-Z0-9_-]/g, '_') || 'script'}.ps1`,
      filters: [{ name: 'PowerShell Script', extensions: ['ps1'] }],
    });
    if (target && typeof target === 'string') {
      await invoke('save_text_file_content', { path: target, content: code });
      setSaveFeedback('📤 Exported .ps1');
      setTimeout(() => setSaveFeedback(''), 1800);
    }
  };

  const handleBrowseWorkingDir = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: workingDir || undefined,
    });
    if (picked && typeof picked === 'string') {
      setWorkingDir(picked);
    }
  };

  const handleRunInCurrentWindow = () => {
    if (isRunning || !code.trim()) return;
    executePowerShellCode(title, code, workingDir, selectedFiles);
  };

  const handleRunInSeparateWindow = () => {
    if (!code.trim()) return;
    openPowerShellRunnerWindow({
      title: title.trim() || 'PowerShell Script',
      code,
      workingDir,
      selectedFiles,
    });
  };

  const handlePrimaryRunAction = () => {
    if (runnerMode || runMode === 'inline') {
      handleRunInCurrentWindow();
    } else {
      handleRunInSeparateWindow();
    }
  };

  const selectRunModeOption = (mode: 'inline' | 'window') => {
    setRunMode(mode);
    try {
      localStorage.setItem('mhz_ps_run_mode', mode);
    } catch {}
    setRunMenuOpen(false);
  };

  const copyTextToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(`✅ ${label}`);
      setTimeout(() => setCopyFeedback(''), 1800);
    } catch {}
  };

  const handleSaveOutputToFile = async () => {
    if (!currentResult) return;
    const combined = [
      currentResult.stdout,
      currentResult.stderr ? `\n--- STDERR ---\n${currentResult.stderr}` : '',
    ]
      .join('')
      .trim();

    const target = await save({
      defaultPath: `${currentResult.scriptTitle.replace(/[^a-zA-Z0-9_-]/g, '_')}_output.txt`,
      filters: [
        { name: 'Text File', extensions: ['txt'] },
        { name: 'Markdown File', extensions: ['md'] },
      ],
    });
    if (target && typeof target === 'string') {
      await invoke('save_text_file_content', { path: target, content: combined });
      setCopyFeedback('💾 Output Saved!');
      setTimeout(() => setCopyFeedback(''), 1800);
    }
  };

  const insertVariableAtCursor = (varText: string) => {
    const el = textareaRef.current;
    if (!el) {
      setCode((prev) => `${prev}\n${varText}`);
      setIsDirty(true);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const nextCode = code.slice(0, start) + varText + code.slice(end);
    setCode(nextCode);
    setIsDirty(true);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + varText.length, start + varText.length);
    }, 10);
  };

  const combinedOutputText = useMemo(() => {
    if (!currentResult) return '';
    const out = currentResult.stdout || '';
    const err = currentResult.stderr ? `${out ? '\n' : ''}[STDERR]\n${currentResult.stderr}` : '';
    return `${out}${err}`;
  }, [currentResult]);

  const filteredResultLines = useMemo(() => {
    const lines = combinedOutputText.split(/\r?\n/);
    if (!resultFilterQuery.trim()) return lines;
    const q = resultFilterQuery.toLowerCase();
    return lines.filter((line) => line.toLowerCase().includes(q));
  }, [combinedOutputText, resultFilterQuery]);

  const handleToggleMaximize = async () => {
    try {
      const win = getCurrentWindow();
      await win.toggleMaximize();
      const max = await win.isMaximized();
      setIsMaximized(max);
    } catch {}
  };

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#0b1120',
        color: '#e2e8f0',
        fontFamily: 'Segoe UI, system-ui, sans-serif',
        overflow: 'hidden',
        userSelect: 'none',
        cursor: isResizingHorizontal
          ? 'col-resize'
          : isResizingVertical
            ? 'row-resize'
            : 'default',
      }}
    >
      {/* 1. Custom Window Titlebar */}
      <header
        data-tauri-drag-region
        onDoubleClick={handleToggleMaximize}
        style={{
          height: '38px',
          backgroundColor: '#0f172a',
          borderBottom: '1px solid rgba(148, 163, 184, 0.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 10px 0 14px',
          flexShrink: 0,
        }}
      >
        <div
          data-tauri-drag-region
          style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, fontSize: '0.88rem' }}
        >
          <span style={{ fontSize: '1.05rem' }}>{runnerMode ? '🚀' : '⚡'}</span>
          <span style={{ color: '#38bdf8' }}>
            {runnerMode ? `PowerShell Runner — ${title}` : 'MHZipy PowerShell Studio'}
          </span>
          <span style={{ color: '#64748b', fontWeight: 400, fontSize: '0.78rem' }}>
            {runnerMode ? '(Code & Result View)' : '— Script Tree & Output Manager'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <button
            type="button"
            onClick={() => getCurrentWindow().minimize()}
            title="Minimize"
            style={{
              width: '30px',
              height: '26px',
              border: 'none',
              borderRadius: '4px',
              background: 'transparent',
              color: '#94a3b8',
              cursor: 'pointer',
            }}
          >
            ─
          </button>
          <button
            type="button"
            onClick={handleToggleMaximize}
            title={isMaximized ? 'Restore' : 'Maximize'}
            style={{
              width: '30px',
              height: '26px',
              border: 'none',
              borderRadius: '4px',
              background: 'transparent',
              color: '#94a3b8',
              cursor: 'pointer',
            }}
          >
            {isMaximized ? '❐' : '□'}
          </button>
          <button
            type="button"
            onClick={() => getCurrentWindow().close()}
            title="Close Window"
            style={{
              width: '30px',
              height: '26px',
              border: 'none',
              borderRadius: '4px',
              background: 'transparent',
              color: '#f87171',
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            ✕
          </button>
        </div>
      </header>

      {/* 2. Main Workspace */}
      <div ref={workspaceRef} style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Left Sidebar: Script Tree Library (Hidden in Standalone Runner Mode) */}
        {!runnerMode && sidebarWidth > 0 && (
          <aside
            style={{
              width: `${sidebarWidth}px`,
              backgroundColor: '#0f172a',
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0,
              minWidth: 0,
            }}
          >
            {/* Top Action Buttons & Search */}
            <div
              style={{
                padding: '9px 10px',
                borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
                display: 'flex',
                flexDirection: 'column',
                gap: '7px',
              }}
            >
              <div style={{ display: 'flex', gap: '5px' }}>
                <button
                  type="button"
                  onClick={() => handleCreateNewSnippet(activeFolderId)}
                  title="New PowerShell Script in active folder (Ctrl+N)"
                  style={{
                    flex: 1,
                    padding: '5px 8px',
                    borderRadius: '6px',
                    border: '1px solid #0284c7',
                    backgroundColor: '#0369a1',
                    color: '#f8fafc',
                    fontWeight: 700,
                    fontSize: '0.76rem',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  + Script
                </button>
                <button
                  type="button"
                  onClick={() => handleCreateNewFolder(null)}
                  title="Create New Folder in Tree (Ctrl+Shift+N)"
                  style={{
                    padding: '5px 8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(56, 189, 248, 0.35)',
                    backgroundColor: 'rgba(30, 41, 59, 0.9)',
                    color: '#7dd3fc',
                    fontWeight: 600,
                    fontSize: '0.76rem',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  + Folder
                </button>
                <button
                  type="button"
                  onClick={handleImportPs1}
                  title="Import .ps1 file into active folder"
                  style={{
                    padding: '5px 7px',
                    borderRadius: '6px',
                    border: '1px solid rgba(148, 163, 184, 0.25)',
                    backgroundColor: '#1e293b',
                    color: '#cbd5e1',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                  }}
                >
                  📂
                </button>
                <button
                  type="button"
                  onClick={handleExportPs1}
                  title="Export active script as .ps1"
                  style={{
                    padding: '5px 7px',
                    borderRadius: '6px',
                    border: '1px solid rgba(148, 163, 184, 0.25)',
                    backgroundColor: '#1e293b',
                    color: '#cbd5e1',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                  }}
                >
                  💾
                </button>
              </div>

              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="🔍 Filter scripts in tree..."
                style={{
                  padding: '5px 9px',
                  borderRadius: '6px',
                  border: '1px solid rgba(148, 163, 184, 0.22)',
                  backgroundColor: '#1e293b',
                  color: '#f8fafc',
                  fontSize: '0.78rem',
                  outline: 'none',
                }}
              />

              {/* Multi-Selection & Clipboard Status Strip */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: '0.69rem',
                  color: '#64748b',
                }}
              >
                <span>
                  {selectedScriptIds.size > 1
                    ? `${selectedScriptIds.size} scripts selected`
                    : 'Drag to move or range-select'}
                </span>
                {treeClipboard && (
                  <span style={{ color: '#38bdf8', fontWeight: 600 }}>
                    {treeClipboard.op === 'cut' ? '✂️' : '📋'} {treeClipboard.scriptIds.length} in clipboard
                  </span>
                )}
              </div>
            </div>

            {/* Hierarchical Script Tree Container */}
            <div
              ref={treeContainerRef}
              tabIndex={0}
              onKeyDown={handleTreeKeyDown}
              onMouseDown={(e) => {
                // Start marquee range selection when dragging from background / empty space
                if (e.button !== 0) return;
                const target = e.target as HTMLElement;
                if (target.closest('[data-tree-node="true"]')) return;
                treeContainerRef.current?.focus();
                setMarquee({
                  startX: e.clientX,
                  startY: e.clientY,
                  curX: e.clientX,
                  curY: e.clientY,
                });
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverFolderId('ROOT');
              }}
              onDragLeave={(e) => {
                if (e.currentTarget === e.target) {
                  setDragOverFolderId(null);
                }
              }}
              onDrop={(e) => handleDropOnFolder(e, null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setTreeContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  targetKind: 'root',
                  targetId: null,
                });
              }}
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '6px 8px 28px 8px',
                outline: 'none',
                position: 'relative',
                backgroundColor:
                  dragOverFolderId === 'ROOT' ? 'rgba(56, 189, 248, 0.06)' : 'transparent',
              }}
            >
              {visibleTreeItems.map((item) => {
                const isFolder = item.kind === 'folder';
                const isExpanded = isFolder && expandedFolderIds.has(item.id);
                const isSelectedScript = !isFolder && selectedScriptIds.has(item.id);
                const isActiveFolder = isFolder && activeFolderId === item.id;
                const isCut =
                  !isFolder &&
                  treeClipboard?.op === 'cut' &&
                  treeClipboard.scriptIds.includes(item.id);
                const isDragOver = isFolder && dragOverFolderId === item.id;

                return (
                  <div
                    key={item.id}
                    data-tree-node="true"
                    ref={(el) => {
                      if (el) nodeElementsRef.current.set(item.id, el);
                      else nodeElementsRef.current.delete(item.id);
                    }}
                    draggable={!isFolder && renamingNodeId !== item.id}
                    onDragStart={(e) => {
                      if (!isFolder && item.snippet) {
                        handleScriptDragStart(e, item.snippet);
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const dropFolder = isFolder ? item.id : item.parentId;
                      setDragOverFolderId(dropFolder ?? 'ROOT');
                    }}
                    onDrop={(e) => {
                      const dropFolder = isFolder ? item.id : item.parentId;
                      handleDropOnFolder(e, dropFolder ?? null);
                    }}
                    onClick={(e) => handleTreeItemClick(e, item)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      treeContainerRef.current?.focus();
                      if (!isFolder && item.snippet) {
                        if (!selectedScriptIds.has(item.id)) {
                          setSelectedScriptIds(new Set([item.id]));
                          setAnchorItemId(item.id);
                          activateSnippetInEditor(item.snippet);
                        }
                        setActiveFolderId(item.parentId);
                        setFocusedItemId(item.id);
                        setTreeContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          targetKind: 'script',
                          targetId: item.id,
                        });
                      } else {
                        setActiveFolderId(item.id);
                        setFocusedItemId(item.id);
                        setTreeContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          targetKind: 'folder',
                          targetId: item.id,
                        });
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: `5px 8px 5px ${item.depth * 16 + 8}px`,
                      marginBottom: '2px',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      opacity: isCut ? 0.45 : 1,
                      backgroundColor: isDragOver
                        ? 'rgba(56, 189, 248, 0.28)'
                        : isSelectedScript
                          ? 'rgba(2, 132, 199, 0.34)'
                          : isActiveFolder
                            ? 'rgba(30, 41, 59, 0.85)'
                            : 'transparent',
                      border: isDragOver
                        ? '1px dashed #38bdf8'
                        : isSelectedScript
                          ? '1px solid rgba(56, 189, 248, 0.6)'
                          : isActiveFolder
                            ? '1px solid rgba(148, 163, 184, 0.25)'
                            : '1px solid transparent',
                    }}
                  >
                    <span style={{ fontSize: '0.82rem', flexShrink: 0 }}>
                      {isFolder ? (isExpanded ? '📂' : '📁') : '📜'}
                    </span>

                    {renamingNodeId === item.id ? (
                      <input
                        type="text"
                        value={renamingText}
                        onChange={(e) => setRenamingText(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') handleFinishRenameNode();
                          else if (e.key === 'Escape') setRenamingNodeId(null);
                        }}
                        onBlur={handleFinishRenameNode}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                        style={{
                          flex: 1,
                          padding: '1px 5px',
                          borderRadius: '4px',
                          border: '1px solid #38bdf8',
                          backgroundColor: '#020617',
                          color: '#f8fafc',
                          fontSize: '0.78rem',
                          outline: 'none',
                        }}
                      />
                    ) : (
                      <span
                        style={{
                          flex: 1,
                          fontSize: '0.79rem',
                          fontWeight: isFolder || isSelectedScript ? 700 : 500,
                          color: isFolder
                            ? '#fcd34d'
                            : isSelectedScript
                              ? '#7dd3fc'
                              : '#e2e8f0',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.name}
                      </span>
                    )}

                    {!isFolder && (
                      <span
                        style={{
                          fontSize: '0.64rem',
                          color: '#64748b',
                          fontFamily: 'Consolas, monospace',
                          flexShrink: 0,
                        }}
                      >
                        .ps1
                      </span>
                    )}
                  </div>
                );
              })}

              {/* Marquee Selection Overlay Box */}
              {marquee && (
                <div
                  style={{
                    position: 'fixed',
                    left: Math.min(marquee.startX, marquee.curX),
                    top: Math.min(marquee.startY, marquee.curY),
                    width: Math.abs(marquee.curX - marquee.startX),
                    height: Math.abs(marquee.curY - marquee.startY),
                    backgroundColor: 'rgba(56, 189, 248, 0.18)',
                    border: '1px solid #38bdf8',
                    pointerEvents: 'none',
                    zIndex: 2600,
                  }}
                />
              )}
            </div>
          </aside>
        )}

        {/* Draggable Left/Right Vertical Splitter Bar */}
        {!runnerMode && (
          <div
            onMouseDown={(e) => {
              e.preventDefault();
              setIsResizingHorizontal(true);
            }}
            onDoubleClick={() => {
              if (sidebarWidth > 0) {
                setPrevSidebarWidth(sidebarWidth);
                setSidebarWidth(0);
              } else {
                setSidebarWidth(prevSidebarWidth || 295);
              }
            }}
            title="Drag to resize Script Tree width (Double-click to collapse/expand)"
            style={{
              width: '5px',
              cursor: 'col-resize',
              backgroundColor: isResizingHorizontal ? '#38bdf8' : 'rgba(148, 163, 184, 0.18)',
              transition: 'background-color 0.15s',
              flexShrink: 0,
            }}
          />
        )}

        {/* Right Area: Top Code Editor + Draggable Splitter + Bottom Result & History */}
        <main
          ref={rightPaneRef}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}
        >
          {/* Top Pane: Script Metadata + Context Bar + Code Editor */}
          <section
            style={{
              height: `${topPaneRatio}%`,
              display: 'flex',
              flexDirection: 'column',
              padding: '10px 12px',
              gap: '8px',
              minHeight: '110px',
              boxSizing: 'border-box',
            }}
          >
            {/* Title, Description, Save & Selectable Run Row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="text"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setIsDirty(true);
                }}
                placeholder="Script Title..."
                style={{
                  flex: 2,
                  padding: '6px 10px',
                  borderRadius: '6px',
                  border: '1px solid rgba(148, 163, 184, 0.25)',
                  backgroundColor: '#1e293b',
                  color: '#f8fafc',
                  fontWeight: 700,
                  fontSize: '0.86rem',
                  outline: 'none',
                }}
              />
              {!runnerMode && (
                <>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => {
                      setDescription(e.target.value);
                      setIsDirty(true);
                    }}
                    placeholder="Short description..."
                    style={{
                      flex: 2,
                      padding: '6px 10px',
                      borderRadius: '6px',
                      border: '1px solid rgba(148, 163, 184, 0.25)',
                      backgroundColor: '#1e293b',
                      color: '#cbd5e1',
                      fontSize: '0.8rem',
                      outline: 'none',
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleSaveCurrentSnippet}
                    style={{
                      padding: '6px 12px',
                      borderRadius: '6px',
                      border: isDirty ? '1px solid #38bdf8' : '1px solid rgba(148, 163, 184, 0.25)',
                      backgroundColor: isDirty ? 'rgba(2, 132, 199, 0.35)' : '#1e293b',
                      color: '#f8fafc',
                      fontWeight: 600,
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {saveFeedback || (isDirty ? '💾 Save *' : '💾 Save')}
                  </button>
                </>
              )}

              {/* Selectable Run Split Button */}
              {runnerMode ? (
                <button
                  type="button"
                  disabled={isRunning}
                  onClick={handleRunInCurrentWindow}
                  title="Re-run PowerShell Script (Ctrl+Enter or F5)"
                  style={{
                    padding: '6px 16px',
                    borderRadius: '6px',
                    border: '1px solid #22c55e',
                    backgroundColor: isRunning ? '#15803d' : '#16a34a',
                    color: '#ffffff',
                    fontWeight: 700,
                    fontSize: '0.84rem',
                    cursor: isRunning ? 'wait' : 'pointer',
                    whiteSpace: 'nowrap',
                    boxShadow: '0 2px 10px rgba(22, 163, 74, 0.35)',
                  }}
                >
                  {isRunning ? '⏳ Running...' : '▶ Re-run (Ctrl+Enter)'}
                </button>
              ) : (
                <div ref={runMenuRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                  <button
                    type="button"
                    disabled={isRunning && runMode === 'inline'}
                    onClick={handlePrimaryRunAction}
                    title={
                      runMode === 'inline'
                        ? 'Run in Current Studio Window (Ctrl+Enter or F5)'
                        : 'Open Separate Runner Window & Execute (Ctrl+Enter or F5)'
                    }
                    style={{
                      padding: '6px 13px',
                      borderTopLeftRadius: '6px',
                      borderBottomLeftRadius: '6px',
                      borderTopRightRadius: 0,
                      borderBottomRightRadius: 0,
                      border: runMode === 'inline' ? '1px solid #22c55e' : '1px solid #38bdf8',
                      borderRight: 'none',
                      backgroundColor:
                        runMode === 'inline'
                          ? isRunning
                            ? '#15803d'
                            : '#16a34a'
                          : '#0284c7',
                      color: '#ffffff',
                      fontWeight: 700,
                      fontSize: '0.82rem',
                      cursor: isRunning && runMode === 'inline' ? 'wait' : 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {runMode === 'inline'
                      ? isRunning
                        ? '⏳ Running...'
                        : '▶ Run Here'
                      : '🚀 Run in Window'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRunMenuOpen((prev) => !prev)}
                    title="Select Run Mode (Run Here vs. Run in Separate Window)"
                    style={{
                      padding: '6px 8px',
                      borderTopRightRadius: '6px',
                      borderBottomRightRadius: '6px',
                      borderTopLeftRadius: 0,
                      borderBottomLeftRadius: 0,
                      border: runMode === 'inline' ? '1px solid #22c55e' : '1px solid #38bdf8',
                      backgroundColor: runMode === 'inline' ? '#15803d' : '#0369a1',
                      color: '#ffffff',
                      fontWeight: 700,
                      fontSize: '0.78rem',
                      cursor: 'pointer',
                    }}
                  >
                    ▾
                  </button>

                  {runMenuOpen && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 5px)',
                        right: 0,
                        width: '285px',
                        backgroundColor: '#0f172a',
                        border: '1px solid rgba(56, 189, 248, 0.45)',
                        borderRadius: '8px',
                        boxShadow: '0 12px 28px rgba(0, 0, 0, 0.65)',
                        padding: '5px',
                        zIndex: 2500,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                      }}
                    >
                      <div
                        onClick={() => {
                          selectRunModeOption('inline');
                          handleRunInCurrentWindow();
                        }}
                        style={{
                          padding: '7px 10px',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          backgroundColor:
                            runMode === 'inline' ? 'rgba(22, 163, 74, 0.22)' : 'transparent',
                          border:
                            runMode === 'inline'
                              ? '1px solid rgba(34, 197, 94, 0.45)'
                              : '1px solid transparent',
                        }}
                      >
                        <div style={{ fontWeight: 700, fontSize: '0.8rem', color: '#4ade80' }}>
                          ▶ Run Here (Current Studio)
                        </div>
                        <div style={{ fontSize: '0.71rem', color: '#94a3b8' }}>
                          Executes script and shows output in the bottom console.
                        </div>
                      </div>

                      <div
                        onClick={() => {
                          selectRunModeOption('window');
                          handleRunInSeparateWindow();
                        }}
                        style={{
                          padding: '7px 10px',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          backgroundColor:
                            runMode === 'window' ? 'rgba(2, 132, 199, 0.24)' : 'transparent',
                          border:
                            runMode === 'window'
                              ? '1px solid rgba(56, 189, 248, 0.45)'
                              : '1px solid transparent',
                        }}
                      >
                        <div style={{ fontWeight: 700, fontSize: '0.8rem', color: '#38bdf8' }}>
                          🚀 Run in Separate Window
                        </div>
                        <div style={{ fontSize: '0.71rem', color: '#94a3b8' }}>
                          Opens a clean Code (Top) + Result (Bottom) window without the left script list.
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Explorer Context Bar ($CurrentDir & $SelectedFiles) */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '5px 8px',
                borderRadius: '6px',
                backgroundColor: 'rgba(15, 23, 42, 0.9)',
                border: '1px solid rgba(148, 163, 184, 0.16)',
                fontSize: '0.76rem',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ color: '#94a3b8', fontWeight: 600 }}>📁 Working Dir ($CurrentDir):</span>
              <input
                type="text"
                value={workingDir}
                onChange={(e) => setWorkingDir(e.target.value)}
                style={{
                  flex: 1,
                  minWidth: '180px',
                  padding: '3px 8px',
                  borderRadius: '4px',
                  border: '1px solid rgba(148, 163, 184, 0.22)',
                  backgroundColor: '#1e293b',
                  color: '#7dd3fc',
                  fontSize: '0.76rem',
                  outline: 'none',
                }}
              />
              <button
                type="button"
                onClick={handleBrowseWorkingDir}
                style={{
                  padding: '3px 8px',
                  borderRadius: '4px',
                  border: '1px solid rgba(148, 163, 184, 0.25)',
                  backgroundColor: '#334155',
                  color: '#f8fafc',
                  fontSize: '0.73rem',
                  cursor: 'pointer',
                }}
              >
                Browse...
              </button>

              <button
                type="button"
                onClick={() => setShowSelectedFilesModal(true)}
                style={{
                  padding: '3px 8px',
                  borderRadius: '4px',
                  border:
                    selectedFiles.length > 0
                      ? '1px solid rgba(56, 189, 248, 0.5)'
                      : '1px solid rgba(148, 163, 184, 0.22)',
                  backgroundColor:
                    selectedFiles.length > 0 ? 'rgba(56, 189, 248, 0.16)' : 'rgba(30, 41, 59, 0.8)',
                  color: selectedFiles.length > 0 ? '#7dd3fc' : '#94a3b8',
                  fontSize: '0.73rem',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
                title="View or edit $SelectedFiles passed from FileExplorer"
              >
                📄 $SelectedFiles ({selectedFiles.length})
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: 'auto' }}>
                <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Insert:</span>
                <button
                  type="button"
                  onClick={() => insertVariableAtCursor('$CurrentDir')}
                  style={{
                    padding: '2px 6px',
                    borderRadius: '4px',
                    border: '1px solid rgba(148, 163, 184, 0.25)',
                    backgroundColor: '#1e293b',
                    color: '#38bdf8',
                    fontSize: '0.72rem',
                    fontFamily: 'Consolas, monospace',
                    cursor: 'pointer',
                  }}
                >
                  $CurrentDir
                </button>
                <button
                  type="button"
                  onClick={() => insertVariableAtCursor('$SelectedFiles')}
                  style={{
                    padding: '2px 6px',
                    borderRadius: '4px',
                    border: '1px solid rgba(148, 163, 184, 0.25)',
                    backgroundColor: '#1e293b',
                    color: '#38bdf8',
                    fontSize: '0.72rem',
                    fontFamily: 'Consolas, monospace',
                    cursor: 'pointer',
                  }}
                >
                  $SelectedFiles
                </button>
              </div>
            </div>

            {/* PowerShell Code Textarea */}
            <textarea
              ref={textareaRef}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setIsDirty(true);
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey && e.key === 'Enter') || e.key === 'F5') {
                  e.preventDefault();
                  handlePrimaryRunAction();
                } else if (!runnerMode && e.ctrlKey && e.key.toLowerCase() === 's') {
                  e.preventDefault();
                  handleSaveCurrentSnippet();
                } else if (e.key === 'Tab') {
                  e.preventDefault();
                  insertVariableAtCursor('    ');
                }
              }}
              spellCheck={false}
              placeholder="Write or paste your PowerShell script here..."
              style={{
                flex: 1,
                width: '100%',
                resize: 'none',
                padding: '10px 12px',
                borderRadius: '7px',
                border: '1px solid rgba(148, 163, 184, 0.24)',
                backgroundColor: '#020617',
                color: '#e2e8f0',
                fontFamily: 'Consolas, "Cascadia Code", monospace',
                fontSize: '0.85rem',
                lineHeight: 1.5,
                outline: 'none',
                boxSizing: 'border-box',
                userSelect: 'text',
              }}
            />
          </section>

          {/* Draggable Top/Bottom Horizontal Splitter Bar */}
          <div
            onMouseDown={(e) => {
              e.preventDefault();
              setIsResizingVertical(true);
            }}
            onDoubleClick={() => setTopPaneRatio(50)}
            title="Drag to resize Top (Code) / Bottom (Result) height (Double-click to reset 50/50)"
            style={{
              height: '5px',
              cursor: 'row-resize',
              backgroundColor: isResizingVertical ? '#38bdf8' : 'rgba(148, 163, 184, 0.2)',
              transition: 'background-color 0.15s',
              flexShrink: 0,
            }}
          />

          {/* Bottom Pane: Output Console & Run History */}
          <section
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: '#090d16',
              minHeight: '110px',
            }}
          >
            {/* Output Action Bar */}
            <div
              style={{
                padding: '6px 12px',
                backgroundColor: '#0f172a',
                borderBottom: '1px solid rgba(148, 163, 184, 0.16)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  onClick={() => setActiveBottomTab('output')}
                  style={{
                    padding: '4px 10px',
                    borderRadius: '5px',
                    border: 'none',
                    backgroundColor: activeBottomTab === 'output' ? '#0284c7' : 'transparent',
                    color: activeBottomTab === 'output' ? '#ffffff' : '#94a3b8',
                    fontWeight: 700,
                    fontSize: '0.78rem',
                    cursor: 'pointer',
                  }}
                >
                  📟 Output Console
                </button>
                {!runnerMode && (
                  <button
                    type="button"
                    onClick={() => setActiveBottomTab('history')}
                    style={{
                      padding: '4px 10px',
                      borderRadius: '5px',
                      border: 'none',
                      backgroundColor: activeBottomTab === 'history' ? '#0284c7' : 'transparent',
                      color: activeBottomTab === 'history' ? '#ffffff' : '#94a3b8',
                      fontWeight: 700,
                      fontSize: '0.78rem',
                      cursor: 'pointer',
                    }}
                  >
                    📜 Run History ({history.length})
                  </button>
                )}

                {currentResult && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '8px', fontSize: '0.74rem' }}>
                    <span
                      style={{
                        padding: '1px 6px',
                        borderRadius: '4px',
                        fontWeight: 700,
                        backgroundColor:
                          currentResult.exitCode === 0
                            ? 'rgba(34, 197, 94, 0.18)'
                            : 'rgba(239, 68, 68, 0.2)',
                        color: currentResult.exitCode === 0 ? '#4ade80' : '#f87171',
                      }}
                    >
                      {currentResult.exitCode === 0 ? '✅ Exit 0' : `❌ Exit ${currentResult.exitCode}`}
                    </span>
                    <span style={{ color: '#94a3b8' }}>⏱️ {currentResult.durationMs} ms</span>
                    <span style={{ color: '#64748b' }}>({currentResult.shellUsed})</span>
                  </div>
                )}
              </div>

              {/* Copy & Dialog Controls */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {copyFeedback && (
                  <span style={{ color: '#4ade80', fontSize: '0.76rem', fontWeight: 700 }}>{copyFeedback}</span>
                )}
                <button
                  type="button"
                  disabled={!combinedOutputText}
                  onClick={() => copyTextToClipboard(combinedOutputText, 'Copied Full Output!')}
                  style={{
                    padding: '4px 10px',
                    borderRadius: '5px',
                    border: '1px solid rgba(56, 189, 248, 0.45)',
                    backgroundColor: 'rgba(2, 132, 199, 0.25)',
                    color: '#7dd3fc',
                    fontWeight: 700,
                    fontSize: '0.76rem',
                    cursor: combinedOutputText ? 'pointer' : 'not-allowed',
                    opacity: combinedOutputText ? 1 : 0.45,
                  }}
                >
                  📋 Copy Output
                </button>
                <button
                  type="button"
                  disabled={!combinedOutputText}
                  onClick={() => copyTextToClipboard(combinedOutputText.trim(), 'Copied Trimmed!')}
                  style={{
                    padding: '4px 9px',
                    borderRadius: '5px',
                    border: '1px solid rgba(148, 163, 184, 0.28)',
                    backgroundColor: '#1e293b',
                    color: '#cbd5e1',
                    fontSize: '0.75rem',
                    cursor: combinedOutputText ? 'pointer' : 'not-allowed',
                    opacity: combinedOutputText ? 1 : 0.45,
                  }}
                >
                  📋 Copy Trimmed
                </button>
                <button
                  type="button"
                  disabled={!currentResult}
                  onClick={() => {
                    setResultFilterQuery('');
                    setResultDialogOpen(true);
                  }}
                  style={{
                    padding: '4px 10px',
                    borderRadius: '5px',
                    border: '1px solid rgba(168, 85, 247, 0.45)',
                    backgroundColor: 'rgba(147, 51, 234, 0.22)',
                    color: '#d8b4fe',
                    fontWeight: 700,
                    fontSize: '0.75rem',
                    cursor: currentResult ? 'pointer' : 'not-allowed',
                    opacity: currentResult ? '1' : 0.45,
                  }}
                >
                  🔍 Result Dialog
                </button>
                <button
                  type="button"
                  disabled={!currentResult}
                  onClick={handleSaveOutputToFile}
                  style={{
                    padding: '4px 9px',
                    borderRadius: '5px',
                    border: '1px solid rgba(148, 163, 184, 0.28)',
                    backgroundColor: '#1e293b',
                    color: '#cbd5e1',
                    fontSize: '0.75rem',
                    cursor: currentResult ? 'pointer' : 'not-allowed',
                    opacity: currentResult ? 1 : 0.45,
                  }}
                >
                  💾 Save Output
                </button>
                <button
                  type="button"
                  onClick={() => setCurrentResult(null)}
                  style={{
                    padding: '4px 8px',
                    borderRadius: '5px',
                    border: '1px solid rgba(148, 163, 184, 0.2)',
                    backgroundColor: 'transparent',
                    color: '#94a3b8',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                  }}
                >
                  🧹 Clear
                </button>
              </div>
            </div>

            {/* Tab Content */}
            {activeBottomTab === 'output' || runnerMode ? (
              <div
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  overflow: 'auto',
                  fontFamily: 'Consolas, "Cascadia Code", monospace',
                  fontSize: '0.82rem',
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  userSelect: 'text',
                  color: '#e2e8f0',
                }}
              >
                {isRunning ? (
                  <div style={{ color: '#38bdf8' }}>⏳ Executing PowerShell script in {workingDir}...</div>
                ) : !currentResult ? (
                  <div style={{ color: '#64748b' }}>
                    Press &quot;▶ Run (Ctrl+Enter)&quot; to execute the PowerShell script and inspect/copy its output here.
                  </div>
                ) : (
                  <>
                    {currentResult.stdout ? (
                      <span>{currentResult.stdout}</span>
                    ) : (
                      !currentResult.stderr && (
                        <span style={{ color: '#64748b' }}>(Command completed with no stdout output)</span>
                      )
                    )}
                    {currentResult.stderr && (
                      <div
                        style={{
                          marginTop: currentResult.stdout ? '10px' : 0,
                          padding: '8px 10px',
                          borderRadius: '6px',
                          backgroundColor: 'rgba(127, 29, 29, 0.28)',
                          border: '1px solid rgba(248, 113, 113, 0.35)',
                          color: '#fca5a5',
                        }}
                      >
                        {currentResult.stderr}
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {history.length === 0 ? (
                  <div style={{ color: '#64748b', fontSize: '0.8rem', padding: '12px' }}>No execution history yet.</div>
                ) : (
                  history.map((rec) => {
                    const isSelectedRec = currentResult?.id === rec.id;
                    return (
                      <div
                        key={rec.id}
                        onClick={() => {
                          setCurrentResult(rec);
                          setActiveBottomTab('output');
                        }}
                        style={{
                          padding: '8px 10px',
                          borderRadius: '6px',
                          backgroundColor: isSelectedRec ? 'rgba(2, 132, 199, 0.22)' : 'rgba(15, 23, 42, 0.85)',
                          border: isSelectedRec
                            ? '1px solid rgba(56, 189, 248, 0.5)'
                            : '1px solid rgba(148, 163, 184, 0.14)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '10px',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'hidden', flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ color: rec.exitCode === 0 ? '#4ade80' : '#f87171', fontWeight: 700, fontSize: '0.76rem' }}>
                              {rec.exitCode === 0 ? '✅' : `❌ (${rec.exitCode})`}
                            </span>
                            <span style={{ fontWeight: 700, fontSize: '0.82rem', color: '#f1f5f9' }}>{rec.scriptTitle}</span>
                            <span style={{ color: '#64748b', fontSize: '0.72rem' }}>
                              {new Date(rec.timestamp).toLocaleString()} • {rec.durationMs} ms
                            </span>
                          </div>
                          <div style={{ fontSize: '0.73rem', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            📁 {rec.workingDir} — {(rec.stdout || rec.stderr || '(no output)').replace(/\s+/g, ' ').slice(0, 120)}
                          </div>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0 }}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              copyTextToClipboard((rec.stdout || rec.stderr || '').trim(), 'Copied History Output!');
                            }}
                            style={{
                              padding: '3px 8px',
                              borderRadius: '4px',
                              border: '1px solid rgba(56, 189, 248, 0.4)',
                              backgroundColor: 'rgba(2, 132, 199, 0.2)',
                              color: '#7dd3fc',
                              fontSize: '0.72rem',
                              cursor: 'pointer',
                            }}
                          >
                            📋 Copy
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCurrentResult(rec);
                              setResultFilterQuery('');
                              setResultDialogOpen(true);
                            }}
                            style={{
                              padding: '3px 8px',
                              borderRadius: '4px',
                              border: '1px solid rgba(148, 163, 184, 0.25)',
                              backgroundColor: '#1e293b',
                              color: '#cbd5e1',
                              fontSize: '0.72rem',
                              cursor: 'pointer',
                            }}
                          >
                            🔍 Dialog
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </section>
        </main>
      </div>

      {/* 3. Tree Right-Click Context Menu (English + Right-Aligned Shortcuts) */}
      {treeContextMenu && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: Math.min(treeContextMenu.x, window.innerWidth - 235),
            top: Math.min(treeContextMenu.y, window.innerHeight - 280),
            width: '225px',
            backgroundColor: '#0f172a',
            border: '1px solid rgba(56, 189, 248, 0.4)',
            borderRadius: '8px',
            boxShadow: '0 14px 32px rgba(0, 0, 0, 0.72)',
            padding: '5px',
            zIndex: 3500,
            fontSize: '0.79rem',
            color: '#f1f5f9',
          }}
        >
          {/* New Script / New Folder */}
          <div
            onClick={() => {
              const folderTarget =
                treeContextMenu.targetKind === 'folder'
                  ? treeContextMenu.targetId
                  : activeFolderId;
              setTreeContextMenu(null);
              handleCreateNewSnippet(folderTarget);
            }}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '6px 10px',
              borderRadius: '5px',
              cursor: 'pointer',
            }}
          >
            <span>📜 New Script</span>
            <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Ctrl+N</span>
          </div>

          <div
            onClick={() => {
              const parentFolder =
                treeContextMenu.targetKind === 'folder' ? treeContextMenu.targetId : null;
              setTreeContextMenu(null);
              handleCreateNewFolder(parentFolder);
            }}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '6px 10px',
              borderRadius: '5px',
              cursor: 'pointer',
            }}
          >
            <span>📁 New Folder</span>
            <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Ctrl+Shift+N</span>
          </div>

          <div style={{ height: '1px', backgroundColor: 'rgba(148, 163, 184, 0.16)', margin: '4px 0' }} />

          {/* Cut / Copy / Paste */}
          <div
            onClick={() => {
              if (selectedScriptIds.size === 0) return;
              setTreeContextMenu(null);
              handleCutSelectedScripts();
            }}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '6px 10px',
              borderRadius: '5px',
              cursor: selectedScriptIds.size > 0 ? 'pointer' : 'not-allowed',
              opacity: selectedScriptIds.size > 0 ? 1 : 0.4,
            }}
          >
            <span>✂️ Cut (Move)</span>
            <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Ctrl+X</span>
          </div>

          <div
            onClick={() => {
              if (selectedScriptIds.size === 0) return;
              setTreeContextMenu(null);
              handleCopySelectedScripts();
            }}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '6px 10px',
              borderRadius: '5px',
              cursor: selectedScriptIds.size > 0 ? 'pointer' : 'not-allowed',
              opacity: selectedScriptIds.size > 0 ? 1 : 0.4,
            }}
          >
            <span>📋 Copy</span>
            <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Ctrl+C</span>
          </div>

          <div
            onClick={() => {
              if (!treeClipboard) return;
              const destFolder =
                treeContextMenu.targetKind === 'folder'
                  ? treeContextMenu.targetId
                  : treeContextMenu.targetKind === 'root'
                    ? null
                    : activeFolderId;
              setTreeContextMenu(null);
              handlePasteScriptsToFolder(destFolder);
            }}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '6px 10px',
              borderRadius: '5px',
              cursor: treeClipboard ? 'pointer' : 'not-allowed',
              opacity: treeClipboard ? 1 : 0.4,
            }}
          >
            <span>📥 Paste</span>
            <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Ctrl+V</span>
          </div>

          <div style={{ height: '1px', backgroundColor: 'rgba(148, 163, 184, 0.16)', margin: '4px 0' }} />

          {/* Rename & Delete */}
          {treeContextMenu.targetId && (
            <div
              onClick={() => {
                const targetId = treeContextMenu.targetId!;
                const item = visibleTreeItems.find((v) => v.id === targetId);
                setTreeContextMenu(null);
                if (item) {
                  handleStartRenameNode(item.id, item.name);
                }
              }}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '6px 10px',
                borderRadius: '5px',
                cursor: 'pointer',
              }}
            >
              <span>✏️ Rename</span>
              <span style={{ color: '#64748b', fontSize: '0.72rem' }}>F2</span>
            </div>
          )}

          <div
            onClick={() => {
              const kind = treeContextMenu.targetKind;
              const targetId = treeContextMenu.targetId;
              setTreeContextMenu(null);
              if (kind === 'folder' && targetId) {
                handleDeleteTreeItems('folder', targetId);
              } else {
                handleDeleteTreeItems('script', targetId || undefined);
              }
            }}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '6px 10px',
              borderRadius: '5px',
              cursor: 'pointer',
              color: '#f87171',
              fontWeight: 600,
            }}
          >
            <span>🗑️ Delete</span>
            <span style={{ color: '#fca5a5', fontSize: '0.72rem', fontWeight: 400 }}>Del</span>
          </div>
        </div>
      )}

      {/* 4. Dedicated Result Inspector & Line-by-Line Copy Dialog */}
      {resultDialogOpen && currentResult && (
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setResultDialogOpen(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(2, 6, 23, 0.78)',
            backdropFilter: 'blur(3px)',
            zIndex: 3000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '920px',
              height: '82vh',
              backgroundColor: '#0f172a',
              border: '1px solid rgba(56, 189, 248, 0.4)',
              borderRadius: '10px',
              boxShadow: '0 24px 50px rgba(0, 0, 0, 0.75)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '12px 16px',
                backgroundColor: '#1e293b',
                borderBottom: '1px solid rgba(148, 163, 184, 0.16)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700 }}>
                <span>🔍</span>
                <span>PowerShell Execution Result — {currentResult.scriptTitle}</span>
                <span style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 400 }}>
                  ({filteredResultLines.length} lines)
                </span>
              </div>
              <button
                type="button"
                onClick={() => setResultDialogOpen(false)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '1.1rem' }}
              >
                ✕
              </button>
            </div>

            {/* Filter & Quick Copy Bar inside Dialog */}
            <div
              style={{
                padding: '10px 16px',
                borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <input
                type="text"
                value={resultFilterQuery}
                onChange={(e) => setResultFilterQuery(e.target.value)}
                placeholder="🔎 Filter output lines (e.g. .pdf, SHA256, IPv4)..."
                autoFocus
                style={{
                  flex: 1,
                  padding: '7px 10px',
                  borderRadius: '6px',
                  border: '1px solid rgba(148, 163, 184, 0.28)',
                  backgroundColor: '#020617',
                  color: '#f8fafc',
                  fontSize: '0.82rem',
                  outline: 'none',
                }}
              />
              <button
                type="button"
                onClick={() => copyTextToClipboard(filteredResultLines.join('\n'), 'Copied Filtered Lines!')}
                style={{
                  padding: '7px 14px',
                  borderRadius: '6px',
                  border: '1px solid #38bdf8',
                  backgroundColor: '#0284c7',
                  color: '#ffffff',
                  fontWeight: 700,
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                📋 Copy All Shown ({filteredResultLines.length} lines)
              </button>
              <button
                type="button"
                onClick={() => copyTextToClipboard(filteredResultLines.join('\n').trim(), 'Copied Trimmed!')}
                style={{
                  padding: '7px 12px',
                  borderRadius: '6px',
                  border: '1px solid rgba(148, 163, 184, 0.3)',
                  backgroundColor: '#1e293b',
                  color: '#e2e8f0',
                  fontWeight: 600,
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                📋 Copy Trimmed
              </button>
            </div>

            {/* Line-by-line interactive viewer */}
            <div
              style={{
                flex: 1,
                overflow: 'auto',
                padding: '10px 14px',
                backgroundColor: '#020617',
                fontFamily: 'Consolas, "Cascadia Code", monospace',
                fontSize: '0.82rem',
                userSelect: 'text',
              }}
            >
              {filteredResultLines.map((line, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    borderBottom: '1px solid rgba(30, 41, 59, 0.45)',
                  }}
                >
                  <span style={{ width: '36px', color: '#475569', fontSize: '0.72rem', textAlign: 'right', userSelect: 'none', flexShrink: 0 }}>
                    {idx + 1}
                  </span>
                  <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#e2e8f0' }}>
                    {line || ' '}
                  </span>
                  {line.trim() && (
                    <button
                      type="button"
                      onClick={() => copyTextToClipboard(line.trim(), `Copied Line ${idx + 1}!`)}
                      title="Copy this line"
                      style={{
                        padding: '1px 6px',
                        borderRadius: '4px',
                        border: '1px solid rgba(148, 163, 184, 0.2)',
                        backgroundColor: 'rgba(30, 41, 59, 0.7)',
                        color: '#94a3b8',
                        fontSize: '0.68rem',
                        cursor: 'pointer',
                        flexShrink: 0,
                        userSelect: 'none',
                      }}
                    >
                      Copy
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 5. $SelectedFiles Context Modal */}
      {showSelectedFilesModal && (
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowSelectedFilesModal(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(2, 6, 23, 0.72)',
            zIndex: 3000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '600px',
              backgroundColor: '#0f172a',
              border: '1px solid rgba(148, 163, 184, 0.3)',
              borderRadius: '10px',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 700 }}>
              <span>📄 $SelectedFiles Array ({selectedFiles.length} items)</span>
              <button
                type="button"
                onClick={() => setShowSelectedFilesModal(false)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>
            <div style={{ fontSize: '0.78rem', color: '#94a3b8' }}>
              These file/folder paths are passed from MHZipy FileExplorer into the PowerShell variable <code>$SelectedFiles</code> (one path per line):
            </div>
            <textarea
              value={selectedFiles.join('\n')}
              onChange={(e) =>
                setSelectedFiles(
                  e.target.value
                    .split(/\r?\n/)
                    .map((s) => s.trim())
                    .filter(Boolean)
                )
              }
              rows={8}
              style={{
                width: '100%',
                padding: '8px',
                borderRadius: '6px',
                border: '1px solid rgba(148, 163, 184, 0.25)',
                backgroundColor: '#020617',
                color: '#7dd3fc',
                fontFamily: 'Consolas, monospace',
                fontSize: '0.8rem',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                type="button"
                onClick={() => setSelectedFiles([])}
                style={{
                  padding: '5px 12px',
                  borderRadius: '5px',
                  border: '1px solid rgba(248, 113, 113, 0.35)',
                  backgroundColor: 'rgba(127, 29, 29, 0.25)',
                  color: '#fca5a5',
                  cursor: 'pointer',
                }}
              >
                Clear All
              </button>
              <button
                type="button"
                onClick={() => setShowSelectedFilesModal(false)}
                style={{
                  padding: '5px 14px',
                  borderRadius: '5px',
                  border: '1px solid #38bdf8',
                  backgroundColor: '#0284c7',
                  color: '#ffffff',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PowerShellManager;

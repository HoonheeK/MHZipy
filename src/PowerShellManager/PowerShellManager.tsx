import React, { useState, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { open, save } from '@tauri-apps/plugin-dialog';

export interface PowerShellSnippet {
  id: string;
  title: string;
  category: string;
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

const DEFAULT_SNIPPETS: PowerShellSnippet[] = [
  {
    id: 'ps_default_files_summary',
    title: 'Selected Files / Folder Summary',
    category: 'Files',
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
    category: 'Dev / Git',
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
}

const PowerShellManager: React.FC<PowerShellManagerProps> = ({
  initialWorkingDir = '',
  initialScriptFilePath = '',
}) => {
  const [snippets, setSnippets] = useState<PowerShellSnippet[]>(DEFAULT_SNIPPETS);
  const [history, setHistory] = useState<PowerShellRunRecord[]>([]);
  const [selectedSnippetId, setSelectedSnippetId] = useState<string>(DEFAULT_SNIPPETS[0].id);

  // Active editor fields
  const [title, setTitle] = useState<string>(DEFAULT_SNIPPETS[0].title);
  const [category, setCategory] = useState<string>(DEFAULT_SNIPPETS[0].category);
  const [description, setDescription] = useState<string>(DEFAULT_SNIPPETS[0].description);
  const [code, setCode] = useState<string>(DEFAULT_SNIPPETS[0].code);
  const [isDirty, setIsDirty] = useState<boolean>(false);

  // Explorer context
  const [workingDir, setWorkingDir] = useState<string>(initialWorkingDir || 'C:\\');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [showSelectedFilesModal, setShowSelectedFilesModal] = useState<boolean>(false);

  // Filter in sidebar
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');

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
  const storageLoadedRef = useRef<boolean>(false);

  // Load initial context from localStorage + URL params
  useEffect(() => {
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
  }, [initialScriptFilePath]);

  // Listen for live context updates from main FileExplorer window
  useEffect(() => {
    let unlisten: (() => void) | null = null;
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
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Load saved snippets & run history from appConfigDir/ps_manager.json
  useEffect(() => {
    const loadData = async () => {
      try {
        const dir = await appConfigDir();
        const filePath = await join(dir, 'ps_manager.json');
        if (await exists(filePath)) {
          const text = await readTextFile(filePath);
          const data = JSON.parse(text);
          if (Array.isArray(data.snippets) && data.snippets.length > 0) {
            setSnippets(data.snippets);
            const first = data.snippets[0];
            setSelectedSnippetId(first.id);
            setTitle(first.title);
            setCategory(first.category || 'General');
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
  }, []);

  const persistData = async (nextSnippets: PowerShellSnippet[], nextHistory: PowerShellRunRecord[]) => {
    if (!storageLoadedRef.current) return;
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
        description: `Imported from ${filePath}`,
        code: content,
        updatedAt: Date.now(),
      };
      setSnippets((prev) => {
        const next = [newSnippet, ...prev];
        persistData(next, history);
        return next;
      });
      setSelectedSnippetId(newSnippet.id);
      setTitle(newSnippet.title);
      setCategory(newSnippet.category);
      setDescription(newSnippet.description);
      setCode(newSnippet.code);
      setIsDirty(false);
    } catch (err) {
      console.error('Failed to read external .ps1 file:', err);
    }
  };

  const selectSnippet = (item: PowerShellSnippet) => {
    setSelectedSnippetId(item.id);
    setTitle(item.title);
    setCategory(item.category || 'General');
    setDescription(item.description || '');
    setCode(item.code);
    setIsDirty(false);
  };

  const handleSaveCurrentSnippet = () => {
    const cleanTitle = title.trim() || 'Untitled PowerShell Script';
    const cleanCat = category.trim() || 'General';
    const updatedItem: PowerShellSnippet = {
      id: selectedSnippetId || `ps_${Date.now()}`,
      title: cleanTitle,
      category: cleanCat,
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
    persistData(nextSnippets, history);
    setSaveFeedback('💾 Saved!');
    setTimeout(() => setSaveFeedback(''), 1800);
  };

  const handleCreateNewSnippet = () => {
    const newItem: PowerShellSnippet = {
      id: `ps_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: 'New PowerShell Script',
      category: 'Custom',
      description: '',
      code: `# Available variables from MHZipy:\n# $CurrentDir    -> Current Working Directory\n# $SelectedFiles -> Array of selected file/folder paths\n\nWrite-Output "Working Dir: $CurrentDir"\n`,
      updatedAt: Date.now(),
    };
    const next = [newItem, ...snippets];
    setSnippets(next);
    selectSnippet(newItem);
    persistData(next, history);
  };

  const handleDeleteSnippet = (id: string) => {
    const next = snippets.filter((s) => s.id !== id);
    const finalSnippets = next.length > 0 ? next : DEFAULT_SNIPPETS;
    setSnippets(finalSnippets);
    if (selectedSnippetId === id) {
      selectSnippet(finalSnippets[0]);
    }
    persistData(finalSnippets, history);
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

  const handleRunScript = async () => {
    if (isRunning || !code.trim()) return;
    setIsRunning(true);
    setActiveBottomTab('output');

    try {
      const res = await invoke<PowerShellRunResult>('run_powershell_script', {
        code,
        workingDir,
        selectedFiles,
      });

      const record: PowerShellRunRecord = {
        id: `run_${Date.now()}`,
        scriptId: selectedSnippetId,
        scriptTitle: title.trim() || 'Untitled Script',
        code,
        workingDir,
        selectedFiles: [...selectedFiles],
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        exitCode: res.exit_code,
        durationMs: res.duration_ms,
        shellUsed: res.shell_used,
        timestamp: Date.now(),
      };

      setCurrentResult(record);
      const nextHistory = [record, ...history].slice(0, 50);
      setHistory(nextHistory);
      persistData(snippets, nextHistory);
    } catch (err) {
      const record: PowerShellRunRecord = {
        id: `run_${Date.now()}`,
        scriptId: selectedSnippetId,
        scriptTitle: title.trim() || 'Untitled Script',
        code,
        workingDir,
        selectedFiles: [...selectedFiles],
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

  const categories = useMemo(() => {
    const set = new Set<string>(['All']);
    for (const s of snippets) {
      if (s.category) set.add(s.category);
    }
    return Array.from(set);
  }, [snippets]);

  const filteredSnippets = useMemo(() => {
    return snippets.filter((s) => {
      if (selectedCategory !== 'All' && s.category !== selectedCategory) return false;
      if (!searchTerm.trim()) return true;
      const q = searchTerm.toLowerCase();
      return (
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.code.toLowerCase().includes(q)
      );
    });
  }, [snippets, selectedCategory, searchTerm]);

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
          <span style={{ fontSize: '1.05rem' }}>⚡</span>
          <span style={{ color: '#38bdf8' }}>MHZipy PowerShell Studio</span>
          <span style={{ color: '#64748b', fontWeight: 400, fontSize: '0.78rem' }}>
            — Script Library &amp; Output Manager
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

      {/* 2. Main 3-Pane Workspace */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Left Sidebar: Script Library */}
        <aside
          style={{
            width: '285px',
            backgroundColor: '#0f172a',
            borderRight: '1px solid rgba(148, 163, 184, 0.16)',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
          }}
        >
          {/* Action Buttons */}
          <div
            style={{
              padding: '10px',
              borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                onClick={handleCreateNewSnippet}
                style={{
                  flex: 1,
                  padding: '6px 10px',
                  borderRadius: '6px',
                  border: '1px solid #0284c7',
                  backgroundColor: '#0369a1',
                  color: '#f8fafc',
                  fontWeight: 700,
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                + New Script
              </button>
              <button
                type="button"
                onClick={handleImportPs1}
                title="Import .ps1 file into Library"
                style={{
                  padding: '6px 9px',
                  borderRadius: '6px',
                  border: '1px solid rgba(148, 163, 184, 0.28)',
                  backgroundColor: '#1e293b',
                  color: '#cbd5e1',
                  fontSize: '0.78rem',
                  cursor: 'pointer',
                }}
              >
                📂 Import
              </button>
              <button
                type="button"
                onClick={handleExportPs1}
                title="Export current script as .ps1"
                style={{
                  padding: '6px 9px',
                  borderRadius: '6px',
                  border: '1px solid rgba(148, 163, 184, 0.28)',
                  backgroundColor: '#1e293b',
                  color: '#cbd5e1',
                  fontSize: '0.78rem',
                  cursor: 'pointer',
                }}
              >
                💾 .ps1
              </button>
            </div>

            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="🔍 Search scripts..."
              style={{
                padding: '6px 9px',
                borderRadius: '6px',
                border: '1px solid rgba(148, 163, 184, 0.22)',
                backgroundColor: '#1e293b',
                color: '#f8fafc',
                fontSize: '0.8rem',
                outline: 'none',
              }}
            />

            {/* Category Pills */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  style={{
                    padding: '2px 7px',
                    borderRadius: '999px',
                    fontSize: '0.7rem',
                    border:
                      selectedCategory === cat
                        ? '1px solid #38bdf8'
                        : '1px solid rgba(148, 163, 184, 0.2)',
                    backgroundColor:
                      selectedCategory === cat ? 'rgba(56, 189, 248, 0.2)' : 'rgba(30, 41, 59, 0.7)',
                    color: selectedCategory === cat ? '#7dd3fc' : '#94a3b8',
                    cursor: 'pointer',
                  }}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* Script List */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px' }}>
            {filteredSnippets.map((item) => {
              const active = item.id === selectedSnippetId;
              return (
                <div
                  key={item.id}
                  onClick={() => selectSnippet(item)}
                  style={{
                    padding: '8px 10px',
                    marginBottom: '5px',
                    borderRadius: '7px',
                    cursor: 'pointer',
                    backgroundColor: active ? 'rgba(3, 105, 161, 0.28)' : 'rgba(30, 41, 59, 0.45)',
                    border: active
                      ? '1px solid rgba(56, 189, 248, 0.55)'
                      : '1px solid rgba(148, 163, 184, 0.12)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: '0.82rem',
                        color: active ? '#38bdf8' : '#f1f5f9',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.title}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                      <span
                        style={{
                          fontSize: '0.66rem',
                          padding: '1px 5px',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(15, 23, 42, 0.75)',
                          color: '#94a3b8',
                        }}
                      >
                        {item.category}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteSnippet(item.id);
                        }}
                        title="Delete Script"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#64748b',
                          cursor: 'pointer',
                          fontSize: '0.75rem',
                          padding: '0 2px',
                        }}
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                  {item.description && (
                    <div
                      style={{
                        fontSize: '0.72rem',
                        color: '#94a3b8',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.description}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        {/* Right Area: Top Code Editor + Bottom Result & History */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          {/* Top Pane: Script Metadata + Context Bar + Code Editor */}
          <section
            style={{
              flex: '1 1 52%',
              display: 'flex',
              flexDirection: 'column',
              padding: '10px 12px',
              gap: '8px',
              borderBottom: '1px solid rgba(148, 163, 184, 0.2)',
              minHeight: 0,
            }}
          >
            {/* Title, Category, Save & Run Row */}
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
              <input
                type="text"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setIsDirty(true);
                }}
                placeholder="Category (e.g. Files)"
                style={{
                  width: '130px',
                  padding: '6px 10px',
                  borderRadius: '6px',
                  border: '1px solid rgba(148, 163, 184, 0.25)',
                  backgroundColor: '#1e293b',
                  color: '#38bdf8',
                  fontSize: '0.8rem',
                  outline: 'none',
                }}
              />
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
              <button
                type="button"
                disabled={isRunning}
                onClick={handleRunScript}
                title="Execute PowerShell Script (Ctrl+Enter or F5)"
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
                {isRunning ? '⏳ Running...' : '▶ Run (Ctrl+Enter)'}
              </button>
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
                  handleRunScript();
                } else if (e.ctrlKey && e.key.toLowerCase() === 's') {
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

          {/* Bottom Pane: Output Console & Run History */}
          <section
            style={{
              flex: '1 1 48%',
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: '#090d16',
              minHeight: 0,
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
                    opacity: currentResult ? 1 : 0.45,
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
            {activeBottomTab === 'output' ? (
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

      {/* 3. Dedicated Result Inspector & Line-by-Line Copy Dialog */}
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

      {/* 4. $SelectedFiles Context Modal */}
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


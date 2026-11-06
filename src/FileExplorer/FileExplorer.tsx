import { useState, useEffect, useLayoutEffect, useRef, useMemo, forwardRef, useImperativeHandle } from "react";
import { useTranslation } from "react-i18next";
import { dirname, join } from '@tauri-apps/api/path';
import { mkdir, rename } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import FolderTree, { WebFolderBadgeInfo } from "./FolderTree";
import QuickAccessTree from "./QuickAccessTree";
import FileList from "./FileList";
import SearchView from "../SearchView/SearchView";
import { deleteFiles, pasteFiles, checkPathPermission } from '../command/fileOperations';
import MessageDialog from "../common/MessageDialog";
import ConfirmDialog from "../common/ConfirmDialog";
import { WebFolderItem, WebFolderEditModal } from "../WebFolder/WebFolderModals";
import { openPowerShellManagerWindow } from "../PowerShellManager/openPowerShellManagerWindow";
import "./FileExplorer.css";
import { SearchConfig } from "../App";

export interface SelectionStatus {
  hasSelectedFiles: boolean;
  isZipSelected: boolean;
  canPaste: boolean;
  canGoUp: boolean;
  currentPath: string;
}

export interface FileExplorerRef {
  compress: () => void;
  extract: () => void;
  newFolder: () => void;
  newMdFile: () => void;
  copy: () => void;
  paste: () => void;
  deleteSelected: () => void;
  refresh: () => void;
  goUp: () => void;
  navigate: (path: string) => void;
  openPowerShellManager: () => void;
}

interface FileExplorerProps {
  config: { defaultPath: string; quickAccess: string[]; sidebarWidth?: number; expandedPaths?: string[]; quickAccessHeight?: number; view?: 'folder' | 'search'; editableFolders?: string[]; readonlyFolders?: string[]; search?: SearchConfig; columnSettings?: { key: string; visible: boolean }[]; usePdfWorker?: boolean; useImageViewer?: boolean; useVideoPlayer?: boolean; recentOpenedFolders?: string[]; pdfExportPath?: string; webFolders?: WebFolderItem[] };
  onSaveConfig: (updates: Partial<{ defaultPath: string; quickAccess: string[]; sidebarWidth?: number; expandedPaths?: string[]; quickAccessHeight?: number; view?: 'folder' | 'search'; editableFolders?: string[]; readonlyFolders?: string[]; search?: SearchConfig; columnSettings?: { key: string; visible: boolean }[]; usePdfWorker?: boolean; useImageViewer?: boolean; useVideoPlayer?: boolean; recentOpenedFolders?: string[]; pdfExportPath?: string; webFolders?: WebFolderItem[] }>) => void;
  currentView: 'folder' | 'search';
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  externalPath?: string;
  externalSelect?: string;
  pdfExportPath?: string;
  onNavigate?: (path: string) => void;
  onSelectionStatusChange?: (status: SelectionStatus) => void;
}

const FileExplorer = forwardRef<FileExplorerRef, FileExplorerProps>(function FileExplorer({
  config,
  onSaveConfig,
  currentView,
  searchQuery,
  onSearchChange,
  externalPath,
  externalSelect,
  pdfExportPath,
  onNavigate,
  onSelectionStatusChange
}, ref) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string>(externalPath || config.defaultPath || "C:");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set([externalPath || config.defaultPath || "C:"]));
  const [filesSelected, setFilesSelected] = useState<Set<string>>(new Set());
  const [activePane, setActivePane] = useState<'tree' | 'list'>('tree');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; source?: 'tree' | 'quickAccess' } | null>(null);
  const [clipboard, setClipboard] = useState<{ paths: string[]; op: 'copy' | 'move' } | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(config.sidebarWidth !== undefined ? config.sidebarWidth : 260);
  const [prevSidebarWidth, setPrevSidebarWidth] = useState(config.sidebarWidth || 260);
  const [quickAccessHeight, setQuickAccessHeight] = useState(config.quickAccessHeight || 200);
  const [isResizing, setIsResizing] = useState(false);
  const [isResizingQuickAccess, setIsResizingQuickAccess] = useState(false);
  const [filterQuickAccess, setFilterQuickAccess] = useState(false);
  const [renamingTreePath, setRenamingTreePath] = useState<string | null>(null);
  const [renameTreeText, setRenameTreeText] = useState('');
  const [hasSystemClipboardFiles, setHasSystemClipboardFiles] = useState(false);

  // Web Folders (Box / Cloud) State
  const [webFolderEditOpen, setWebFolderEditOpen] = useState(false);
  const [editingWebFolder, setEditingWebFolder] = useState<WebFolderItem | null>(null);
  const [defaultPairLocalPath, setDefaultPairLocalPath] = useState<string>('');
  const [webFolderMenu, setWebFolderMenu] = useState<{ x: number; y: number; item: WebFolderItem } | null>(null);
  const [activeWebFolderId, setActiveWebFolderId] = useState<string | null>(null);
  const [webFoldersCollapsed, setWebFoldersCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('mhz_web_folders_collapsed') === '1';
  });
  const [webFolderStates, setWebFolderStates] = useState<Record<string, {
    isOpen: boolean;
    subpath: string[];
    autoExtractZip: boolean;
    uploadUnlocked: boolean;
    remainingSeconds: number;
    lastDownload?: { fileName: string; targetDir: string };
  }>>({});

  const webFolders = config.webFolders || [];

  useEffect(() => {
    let unlistenState: (() => void) | null = null;
    let unlistenDl: (() => void) | null = null;
    let unlistenClosed: (() => void) | null = null;

    listen<{
      id: string;
      isOpen?: boolean;
      subpath?: string[];
      autoExtractZip?: boolean;
      uploadUnlocked?: boolean;
      remainingSeconds?: number;
    }>('web-folder-live-state', (ev) => {
      const p = ev.payload;
      if (!p || !p.id) return;
      setWebFolderStates((prev) => {
        const cur = prev[p.id] || {
          isOpen: true,
          subpath: [],
          autoExtractZip: true,
          uploadUnlocked: false,
          remainingSeconds: 0,
        };
        return {
          ...prev,
          [p.id]: {
            ...cur,
            isOpen: p.isOpen !== undefined ? p.isOpen : true,
            subpath: Array.isArray(p.subpath) ? p.subpath : cur.subpath,
            autoExtractZip: p.autoExtractZip !== undefined ? p.autoExtractZip : cur.autoExtractZip,
            uploadUnlocked: p.uploadUnlocked !== undefined ? p.uploadUnlocked : cur.uploadUnlocked,
            remainingSeconds: p.remainingSeconds !== undefined ? p.remainingSeconds : cur.remainingSeconds,
          },
        };
      });
    }).then((fn) => { unlistenState = fn; });

    listen<{
      id: string;
      targetDir: string;
      fileName: string;
    }>('web-folder-download-completed', (ev) => {
      const p = ev.payload;
      if (!p || !p.id) return;
      setWebFolderStates((prev) => {
        const cur = prev[p.id] || {
          isOpen: true,
          subpath: [],
          autoExtractZip: true,
          uploadUnlocked: false,
          remainingSeconds: 0,
        };
        return {
          ...prev,
          [p.id]: {
            ...cur,
            lastDownload: { fileName: p.fileName, targetDir: p.targetDir },
          },
        };
      });
      setRefreshTrigger((prev) => prev + 1);
    }).then((fn) => { unlistenDl = fn; });

    listen<{ label: string }>('web-folder-window-closed', (ev) => {
      const label = ev.payload?.label || '';
      if (!label.startsWith('web-folder-')) return;
      const closedCleanId = label.slice('web-folder-'.length);
      setWebFolderStates((prev) => {
        const next = { ...prev };
        for (const wf of config.webFolders || []) {
          const clean = wf.id.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
          if (clean === closedCleanId && next[wf.id]) {
            next[wf.id] = {
              ...next[wf.id],
              isOpen: false,
              uploadUnlocked: false,
              remainingSeconds: 0,
            };
          }
        }
        return next;
      });
    }).then((fn) => { unlistenClosed = fn; });

    return () => {
      if (unlistenState) unlistenState();
      if (unlistenDl) unlistenDl();
      if (unlistenClosed) unlistenClosed();
    };
  }, [config.webFolders]);

  const webFolderBadges = useMemo<Record<string, WebFolderBadgeInfo>>(() => {
    const map: Record<string, WebFolderBadgeInfo> = {};
    for (const wf of webFolders) {
      const base = (wf.linkedLocalPath || '').trim().replace(/[\\/]+$/, '');
      if (!base) continue;
      const st = webFolderStates[wf.id];
      const isOpen = !!st?.isOpen;
      const uploadUnlocked = !!st?.uploadUnlocked;
      const subpath = st?.subpath || [];
      const baseKey = base.toLowerCase();

      map[baseKey] = {
        wfName: wf.name,
        isOpen,
        uploadUnlocked,
        safetyLevel: wf.safetyLevel || 'caution',
        isCurrentTarget: isOpen && subpath.length === 0,
      };

      if (isOpen && subpath.length > 0) {
        const targetFull = [base, ...subpath].join('\\').toLowerCase();
        map[targetFull] = {
          wfName: wf.name,
          isOpen: true,
          uploadUnlocked,
          safetyLevel: wf.safetyLevel || 'caution',
          isCurrentTarget: true,
          subpathLabel: subpath.join(' / '),
        };
      }
    }
    return map;
  }, [webFolders, webFolderStates]);

  const handleSelectAndOpenWebFolder = async (wf: WebFolderItem) => {
    setActiveWebFolderId(wf.id);
    if (wf.linkedLocalPath) {
      const st = webFolderStates[wf.id];
      const base = wf.linkedLocalPath.replace(/[\\/]+$/, '');
      const target = st?.isOpen && st.subpath.length > 0
        ? [base, ...st.subpath].join('\\')
        : base;
      setSelected(target);
      setSelectedPaths(new Set([target]));
    }
    await handleOpenSafeWebFolder(wf);
  };

  const handleOpenSafeWebFolder = async (wf: WebFolderItem) => {
    try {
      await invoke('open_safe_web_folder_window', {
        id: wf.id,
        name: wf.name,
        url: wf.url,
        linkedLocalPath: wf.linkedLocalPath || '',
        safetyLevel: wf.safetyLevel || 'caution',
      });
    } catch (e) {
      showMessage('Web Folder Error', `Failed to open web folder: ${String(e)}`);
    }
  };

  const handleSaveWebFolder = (item: WebFolderItem) => {
    const existing = config.webFolders || [];
    const idx = existing.findIndex((w) => w.id === item.id);
    let updated: WebFolderItem[];
    if (idx >= 0) {
      updated = [...existing];
      updated[idx] = item;
    } else {
      updated = [...existing, item];
    }
    onSaveConfig({ webFolders: updated });
  };

  const handleDeleteWebFolder = (id: string) => {
    const existing = config.webFolders || [];
    onSaveConfig({ webFolders: existing.filter((w) => w.id !== id) });
  };

  const sidebarWidthRef = useRef(sidebarWidth);
  const quickAccessHeightRef = useRef(quickAccessHeight);
  const quickAccessRef = useRef<HTMLDivElement>(null);
  const draggedRef = useRef(false);

  useEffect(() => { sidebarWidthRef.current = sidebarWidth; }, [sidebarWidth]);
  useEffect(() => { quickAccessHeightRef.current = quickAccessHeight; }, [quickAccessHeight]);

  // Message Dialog State
  const [msgDialogOpen, setMsgDialogOpen] = useState(false);
  const [msgDialogTitle, setMsgDialogTitle] = useState('');
  const [msgDialogMessage, setMsgDialogMessage] = useState('');

  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    resolve?: (value: boolean) => void;
  }>({ open: false, title: '', message: '' });

  const showMessage = (title: string, message: string) => {
    setMsgDialogTitle(title);
    setMsgDialogMessage(message);
    setMsgDialogOpen(true);
  };

  const showConfirm = (title: string, message: string) => {
    return new Promise<boolean>((resolve) => {
      setConfirmState({ open: true, title, message, resolve });
    });
  };

  const activeAllowedPaths = useMemo(() => {
    if (!filterQuickAccess) return undefined;

    // 필터링 활성화 시 전체 Quick Access 목록을 허용 경로로 사용
    return config.quickAccess;
  }, [filterQuickAccess, config.quickAccess]);

  // 트리의 루트는 항상 My PC로 고정하여 일관성 유지
  const treeRoot = { path: "My PC", name: "My PC" };

  // Props로부터 expandedPaths 초기화 및 관리
  const expandedPaths = new Set(config.expandedPaths || ["My PC"]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    window.addEventListener('mhz-close-context-menu', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('mhz-close-context-menu', closeMenu);
    };
  }, []);

  // 시스템 클립보드에 파일이 있는지 확인 (창 포커스 시점)
  useEffect(() => {
    const checkClipboard = async () => {
      const paths = await invoke<string[]>('get_files_from_clipboard');
      setHasSystemClipboardFiles(paths.length > 0);
    };

    window.addEventListener('focus', checkClipboard);
    checkClipboard(); // 초기 실행

    return () => window.removeEventListener('focus', checkClipboard);
  }, []);


  useEffect(() => {
    if (externalPath) {
      if (externalPath !== selected) {
        setSelected(externalPath);
        setSelectedPaths(new Set([externalPath]));
      }
      if (externalSelect) {
        setFilesSelected(new Set([externalSelect]));
      } else {
        setFilesSelected(new Set());
      }
    }
  }, [externalPath, externalSelect]);


  useEffect(() => {
    // 외부 명령(URL 파라미터)으로 인한 이동이 아닐 때만 선택을 초기화합니다.

    if (!externalPath) {
      setFilesSelected(new Set());
    }
  }, [selected]);

  // 렌더링 시점에 설정 상태 확인 로그


  useEffect(() => {
    if (onNavigate) onNavigate(selected);
  }, [selected, onNavigate]);

  const handleGoUp = async () => {
    if (!selected || selected === 'My PC') return;
    try {
      const parent = await dirname(selected);
      if (parent && parent !== selected) {
        setSelected(parent);
        setSelectedPaths(new Set([parent]));
        if (onNavigate) onNavigate(parent);
      }
    } catch (err) {
      console.error('Failed to go up:', err);
    }
  };

  useImperativeHandle(ref, () => ({
    compress: () => {
      window.dispatchEvent(new CustomEvent('mhz-file-action', { detail: { action: 'compress' } }));
    },
    extract: () => {
      window.dispatchEvent(new CustomEvent('mhz-file-action', { detail: { action: 'extract' } }));
    },
    newFolder: () => {
      handleCreateFolder(selected);
    },
    newMdFile: () => {
      window.dispatchEvent(new CustomEvent('mhz-file-action', { detail: { action: 'new-md-file' } }));
    },
    copy: () => {
      const targetPaths = filesSelected.size > 0 ? Array.from(filesSelected) : Array.from(selectedPaths);
      if (targetPaths.length > 0) handleCopy(targetPaths);
    },
    paste: () => {
      handlePaste(selected);
    },
    deleteSelected: () => {
      const targetPaths = filesSelected.size > 0 ? Array.from(filesSelected) : Array.from(selectedPaths);
      if (targetPaths.length > 0) handleDelete(targetPaths);
    },
    refresh: () => {
      setRefreshTrigger((p) => p + 1);
    },
    goUp: () => {
      handleGoUp();
    },
    navigate: (path: string) => {
      setSelected(path);
      setSelectedPaths(new Set([path]));
      if (onNavigate) onNavigate(path);
    },
    openPowerShellManager: () => {
      const selFiles = filesSelected.size > 0 ? Array.from(filesSelected) : [];
      const firstPs1 = selFiles.find((p) => p.toLowerCase().endsWith('.ps1'));
      openPowerShellManagerWindow({
        workingDir: selected && selected !== 'My PC' ? selected : '',
        selectedFiles: selFiles,
        scriptFilePath: firstPs1 || '',
      });
    },
  }));

  useEffect(() => {
    if (onSelectionStatusChange) {
      const hasSelected = filesSelected.size > 0;
      const isZip = Array.from(filesSelected).some((p) => p.toLowerCase().endsWith('.zip'));
      const canP = (!!clipboard && clipboard.paths.length > 0) || hasSystemClipboardFiles;
      const canUp = Boolean(selected && selected !== 'My PC' && selected.length > 3);
      onSelectionStatusChange({
        hasSelectedFiles: hasSelected,
        isZipSelected: isZip,
        canPaste: canP,
        canGoUp: canUp,
        currentPath: selected,
      });
    }
  }, [filesSelected, clipboard, hasSystemClipboardFiles, selected, onSelectionStatusChange]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing) {
        draggedRef.current = true;
        setSidebarWidth(Math.max(150, e.clientX));
      }
      if (isResizingQuickAccess && quickAccessRef.current) {
        const rect = quickAccessRef.current.getBoundingClientRect();
        const newHeight = e.clientY - rect.top;
        setQuickAccessHeight(Math.max(50, newHeight));
      }
    };
    const handleMouseUp = () => {
      if (isResizing) {
        setIsResizing(false);
        onSaveConfig({ sidebarWidth: sidebarWidthRef.current }); // 리사이징 종료 시 저장
      }
      if (isResizingQuickAccess) {
        setIsResizingQuickAccess(false);
        onSaveConfig({ quickAccessHeight: quickAccessHeightRef.current });
      }
    };

    if (isResizing || isResizingQuickAccess) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, isResizingQuickAccess]);

  const handleSetDefault = (path: string) => {
    onSaveConfig({ defaultPath: path });
  };

  const handleAddToQuickAccess = (paths: string | string[]) => {
    const list = Array.isArray(paths) ? paths : [paths];
    const newItems = list.filter(p => !config.quickAccess.includes(p));
    if (newItems.length > 0) {
      onSaveConfig({ quickAccess: [...config.quickAccess, ...newItems] });
    }
  };

  const handleRemoveQuickAccess = (path: string) => {
    const newQuickAccess = config.quickAccess.filter(p => p !== path);
    onSaveConfig({ quickAccess: newQuickAccess });
  };

  const handleToggleExpand = (path: string) => {
    const next = new Set(expandedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    onSaveConfig({ expandedPaths: Array.from(next) });
  };

  const handleTreeSelect = (paths: string | string[], multi: boolean) => {
    const pathList = Array.isArray(paths) ? paths : [paths];
    const targetPath = pathList[pathList.length - 1];
    setSelected(targetPath);
    setSelectedPaths(prev => {
      if (multi) {
        const next = new Set(prev);
        pathList.forEach(p => (next.has(p) ? next.delete(p) : next.add(p)));
        return next;
      }
      return new Set(pathList);
    });
    setActivePane('tree');
  };

  // // Filter Tree 모드에서 루트가 변경되면 자동으로 펼침
  // useEffect(() => {
  //   if (treeRoot.path !== "My PC" && !expandedPaths.has(treeRoot.path)) {
  //     handleToggleExpand(treeRoot.path);
  //   }
  // }, [treeRoot.path]);

  const handleSetPermission = (path: string, type: 'editable' | 'readonly') => {
    const currentEditable = config.editableFolders || [];
    const currentReadonly = config.readonlyFolders || [];

    if (type === 'editable') {
      if (!currentEditable.includes(path)) {
        const newReadonly = currentReadonly.filter(p => p !== path);
        onSaveConfig({
          editableFolders: [...currentEditable, path],
          readonlyFolders: newReadonly
        });
      }
    } else {
      if (!currentReadonly.includes(path)) {
        const newEditable = currentEditable.filter(p => p !== path);
        onSaveConfig({
          readonlyFolders: [...currentReadonly, path],
          editableFolders: newEditable
        });
      }
    }
    setContextMenu(null);
  };

  const handleClearPermission = (path: string) => {
    const newEditable = (config.editableFolders || []).filter(p => p !== path);
    const newReadonly = (config.readonlyFolders || []).filter(p => p !== path);
    onSaveConfig({ editableFolders: newEditable, readonlyFolders: newReadonly });
    setContextMenu(null);
  };

  const handleTreeContextMenu = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('mhz-close-context-menu'));
    setContextMenu({ x: e.clientX, y: e.clientY, path, source: 'tree' });
  };

  const handleCopy = async (paths: string[]) => {
    setClipboard({ paths, op: 'copy' });
    try {
      await invoke('copy_files_to_clipboard', { paths });
    } catch (e) {
      console.error('Failed to copy to system clipboard:', e);
    }
  };

  const handleCut = async (paths: string[]) => {
    // Check permission for source paths (need delete permission)
    for (const path of paths) {
      if (!checkPathPermission(path, config.editableFolders, config.readonlyFolders)) {
        showMessage('Permission Error', `You do not have permission to edit '${path}'.`);
        return;
      }
    }
    setClipboard({ paths, op: 'move' });
    try {
      await invoke('copy_files_to_clipboard', { paths });
    } catch (e) {
      console.error('Failed to copy to system clipboard during cut:', e);
    }
  };

  const handlePaste = async (targetDir: string) => {
    if (!checkPathPermission(targetDir, config.editableFolders, config.readonlyFolders)) {
      showMessage('Permission Error', `You do not have write permission for '${targetDir}'.`);
      return;
    }

    // 1. 시스템 클립보드에서 경로 가져오기
    const systemPaths = await invoke<string[]>('get_files_from_clipboard');

    if (systemPaths.length === 0) {
      console.log("[Paste Action] System clipboard is empty");
      return;
    }

    // 2. 실행할 작업 결정 (기본값 'copy')
    // 현재 인스턴스의 내부 클립보드와 경로가 일치하고 op가 'move'인 경우에만 'move'로 처리
    let op: 'copy' | 'move' = 'copy';
    if (
      clipboard &&
      clipboard.op === 'move' &&
      clipboard.paths.length === systemPaths.length &&
      clipboard.paths.every((p, i) => p === systemPaths[i])
    ) {
      op = 'move';
    }

    try {
      const createdPaths = await pasteFiles(systemPaths, targetDir, op);
      if (createdPaths && createdPaths.length > 0) {
        if (op === 'move') setClipboard(null);
        setRefreshTrigger(p => p + 1);
        const normTarget = targetDir.replace(/[/\\]+/g, '/').toLowerCase().replace(/\/$/, '');
        const normSelected = selected.replace(/[/\\]+/g, '/').toLowerCase().replace(/\/$/, '');
        if (normTarget === normSelected) {
          setFilesSelected(new Set(createdPaths));
          setTimeout(() => {
            setFilesSelected(new Set(createdPaths));
          }, 80);
        }
      }
    } catch (e: any) {
      showMessage('Invalid Operation', e.message);
    }
  };

  const handleDelete = async (paths: string[]) => {
    for (const path of paths) {
      if (!checkPathPermission(path, config.editableFolders, config.readonlyFolders)) {
        showMessage('Permission Error', `You do not have permission to delete '${path}'.`);
        return;
      }
    }
    const confirmed = await showConfirm('Confirm Delete', `Are you sure you want to move ${paths.length} item(s) to the recycle bin?`);
    if (confirmed) {
      const success = await deleteFiles(paths);
      if (success) {
        setRefreshTrigger(p => p + 1);
      }
    }
  };

  const handleMove = async (sourcePaths: string[], targetDir: string, op: 'move' | 'copy') => {
    if (!checkPathPermission(targetDir, config.editableFolders, config.readonlyFolders)) {
      showMessage('Permission Error', `You do not have write permission for '${targetDir}'.`);
      return;
    }
    if (op === 'move' && !sourcePaths.every(p => checkPathPermission(p, config.editableFolders, config.readonlyFolders))) {
      showMessage('Permission Error', `You do not have permission to edit the source files.`);
      return;
    }
    try {
      const createdPaths = await pasteFiles(sourcePaths, targetDir, op);
      if (createdPaths && createdPaths.length > 0) {
        setRefreshTrigger(p => p + 1);
        // 다른 창(드래그 원본 창 등)도 목록을 갱신하도록 알림
        emit('mhz-refresh-files').catch(() => {});
        const normTarget = targetDir.replace(/[/\\]+/g, '/').toLowerCase().replace(/\/$/, '');
        const normSelected = selected.replace(/[/\\]+/g, '/').toLowerCase().replace(/\/$/, '');
        if (normTarget === normSelected) {
          setFilesSelected(new Set(createdPaths));
          setTimeout(() => {
            setFilesSelected(new Set(createdPaths));
          }, 80);
        }
      }
    } catch (e: any) {
      showMessage('Invalid Operation', e.message);
    }
  };

  const handleStartTreeRename = (path: string, name: string) => {
    setRenamingTreePath(path);
    setRenameTreeText(name);
  };

  const handleCancelTreeRename = () => {
    setRenamingTreePath(null);
    setRenameTreeText('');
  };

  const handleFinishTreeRename = async () => {
    if (!renamingTreePath) {
      handleCancelTreeRename();
      return;
    }

    if (renameTreeText === '' || renameTreeText.includes('/') || renameTreeText.includes('\\')) {
      showMessage('Invalid Name', 'The folder name cannot be empty or contain slashes.');
      handleCancelTreeRename();
      return;
    }

    try {
      const oldPath = renamingTreePath;
      const newPath = await join(await dirname(oldPath), renameTreeText);

      if (oldPath.toLowerCase() !== newPath.toLowerCase()) {
        await rename(oldPath, newPath);
        setRefreshTrigger(p => p + 1);
      }
    } catch (error) {
      console.error('Failed to rename:', error);
      showMessage('Rename Failed', String(error));
    } finally {
      handleCancelTreeRename();
    }
  };

  const handleCompress = async (paths: string[]) => {
    if (paths.length === 0) return;
    try {
      const parentDir = await dirname(paths[0]);
      if (!checkPathPermission(parentDir, config.editableFolders, config.readonlyFolders)) {
        showMessage('Permission Error', `You do not have permission to create files in '${parentDir}'.`);
        return;
      }
      // 백엔드(Rust)에 'compress_files' 명령어가 구현되어 있다고 가정합니다. 실제 구현된 커맨드 이름 및 파라미터에 맞게 수정해 주세요.
      await invoke('compress_files', { paths, targetDir: parentDir });
      setRefreshTrigger(p => p + 1);
    } catch (error) {
      console.error('Compression failed:', error);
      showMessage('Compression Failed', String(error));
    }
  };

  const handleExtract = async (path: string) => {
    try {
      const parentDir = await dirname(path);
      if (!checkPathPermission(parentDir, config.editableFolders, config.readonlyFolders)) {
        showMessage('Permission Error', `You do not have permission to extract files into '${parentDir}'.`);
        return;
      }
      await invoke('extract_zip', { zipPath: path, targetDir: parentDir });
      setRefreshTrigger(p => p + 1);
    } catch (error) {
      console.error('Extraction failed:', error);
    }
  };

  const handleOpenInNewWindow = async (targetPath: string, isDirectory?: boolean) => {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const { getCurrentWindow } = await import('@tauri-apps/api/window');

      let urlPath = targetPath;
      let urlSelect = "";

      // 파일인 경우 부모 폴더를 열고 해당 파일을 선택하도록 설정
      if (isDirectory === false) {
        const parentPath = await dirname(targetPath);
        if (parentPath !== targetPath) {
          urlPath = parentPath;
          urlSelect = `&select=${encodeURIComponent(targetPath)}`;
        }
      }
      // 폴더인 경우(isDirectory가 true이거나 정보가 없는 경우 기본값) urlPath를 그대로 사용

      // 현재 창의 위치를 가져와서 같은 모니터에 새 창을 띄움
      let posX: number | undefined;
      let posY: number | undefined;
      try {
        const currentWin = getCurrentWindow();
        const position = await currentWin.outerPosition();
        posX = position.x + 50;
        posY = position.y + 50;
      } catch (e) {
        console.warn('현재 창 위치를 가져올 수 없습니다:', e);
      }

      const label = 'win_' + Math.random().toString(36).substring(2, 10);
      const url = `index.html?path=${encodeURIComponent(urlPath)}${urlSelect}`;

      new WebviewWindow(label, {
        url,
        title: `MHZipy - ${targetPath}`,
        // 메인 창(tauri.conf.json)과 동일하게 OS 네이티브 드롭을 꺼서 HTML5 Drag&Drop(창 간 포함)이 동작하도록 함
        dragDropEnabled: false,
        // 메인 창과 동일하게 OS 기본 타이틀바를 제거하고 앱 자체 Toolbar를 헤더로 사용
        decorations: false,
        width: 1280,
        height: 960,
        ...(posX !== undefined && posY !== undefined ? { x: posX, y: posY } : {})
      });
    } catch (e) {
      console.error('Failed to open new window:', e);
    }
  };

  const handleCreateFolder = async (parentPath: string) => {
    if (!checkPathPermission(parentPath, config.editableFolders, config.readonlyFolders)) {
      showMessage('Permission Error', `You do not have permission to create folders in '${parentPath}'.`);
      return;
    }
    setContextMenu(null);

    try {
      const entries = await invoke<any[]>('read_directory', { path: parentPath });
      const existingNames = new Set(entries.map((e: any) => e.name));

      let baseName = "New Folder";
      let newName = baseName;
      let counter = 2;

      while (existingNames.has(newName)) {
        newName = `${baseName} (${counter})`;
        counter++;
      }

      const newPath = await join(parentPath, newName);
      await mkdir(newPath);
      setRefreshTrigger(p => p + 1);
    } catch (error) {
      console.error('Failed to create folder:', error);
    }
  };

  const handleCreateMdFile = async (parentPath: string) => {
    if (!checkPathPermission(parentPath, config.editableFolders, config.readonlyFolders)) {
      showMessage('Permission Error', `You do not have permission to create files in '${parentPath}'.`);
      return;
    }
    setContextMenu(null);
    if (selected !== parentPath) {
      setSelected(parentPath);
      setSelectedPaths(new Set([parentPath]));
    }
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('mhz-file-action', { detail: { action: 'new-md-file' } }));
    }, 50);
  };

  const canWriteToSelectedPaths = useMemo(() => {
    if (selectedPaths.size === 0) return false;
    return Array.from(selectedPaths).every(p => checkPathPermission(p, config.editableFolders, config.readonlyFolders));
  }, [selectedPaths, config.editableFolders, config.readonlyFolders]);

  const canWriteToContextMenuPath = useMemo(() => {
    if (!contextMenu) return false;
    return checkPathPermission(contextMenu.path, config.editableFolders, config.readonlyFolders);
  }, [contextMenu, config.editableFolders, config.readonlyFolders]);

  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (contextMenu && menuRef.current) {
      const el = menuRef.current;
      const rect = el.getBoundingClientRect();
      const margin = 10;
      let left = contextMenu.x;
      let top = contextMenu.y;

      if (left + rect.width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - rect.width - margin);
      }
      if (top + rect.height > window.innerHeight - margin) {
        top = Math.max(margin, window.innerHeight - rect.height - margin);
      }

      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }
  }, [contextMenu]);

  const getMenuPosition = () => {
    if (!contextMenu) return {};
    const { x, y } = contextMenu;
    const margin = 10;
    const left = Math.max(margin, Math.min(x, window.innerWidth - 200));
    const top = Math.max(margin, Math.min(y, window.innerHeight - 350));

    return {
      position: 'fixed' as const,
      left: `${left}px`,
      top: `${top}px`,
      zIndex: 1000,
    };
  };

  useEffect(() => {
    const handleGlobalKeyDown = async (e: KeyboardEvent) => {
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement || contextMenu) {
        return;
      }

      if (e.key === 'Escape') {
        if (filesSelected.size > 0) {
          setFilesSelected(new Set());
        }
        return;
      }

      const isCtrlOrMeta = e.ctrlKey || e.metaKey;

      if (isCtrlOrMeta && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        if (activePane === 'list' && filesSelected.size > 0) {
          const paths = Array.from(filesSelected);
          handleCopy(paths);
        } else if (activePane === 'tree' && selectedPaths.size > 0) {
          handleCopy(Array.from(selectedPaths));
        }
      } else if (isCtrlOrMeta && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        if (activePane === 'list' && filesSelected.size > 0) {
          const paths = Array.from(filesSelected);
          handleCut(paths);
        } else if (activePane === 'tree' && selectedPaths.size > 0) {
          const paths = Array.from(selectedPaths);
          handleCut(paths);
        }
      } else if (isCtrlOrMeta && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        handlePaste(selected);
      } else if (e.key === 'Delete') {
        e.preventDefault();
        if (activePane === 'list' && filesSelected.size > 0) {
          handleDelete(Array.from(filesSelected));
        } else if (activePane === 'tree' && selectedPaths.size > 0) {
          handleDelete(Array.from(selectedPaths));
        }
      } else if (e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        if (activePane === 'tree' && selectedPaths.size > 0) {
          handleCompress(Array.from(selectedPaths));
        }
      } else if (isCtrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('mhz-file-action', { detail: { action: 'new-md-file' } }));
      } else if (e.key === 'F5' || (isCtrlOrMeta && e.key.toLowerCase() === 'r')) {
        e.preventDefault();
        setRefreshTrigger((p) => p + 1);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [activePane, filesSelected, selectedPaths, selected, clipboard, config.editableFolders, config.readonlyFolders, contextMenu]);

  const saveRecentFolder = (folderPath: string) => {
    const current = config.recentOpenedFolders || [];
    const filtered = current.filter((p: string) => p !== folderPath);
    const updated = [folderPath, ...filtered].slice(0, 100);
    onSaveConfig({ recentOpenedFolders: updated });
  };

  const handleOpenInExplorer = async (path: string, isDirectory?: boolean) => {
    try {
      if (isDirectory) {
        saveRecentFolder(path);
        // For directories, open them directly in the file explorer.
        await invoke('open_file', { path });
      } else {
        const parentPath = path.substring(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')));
        if (parentPath) saveRecentFolder(parentPath);
        // For files, open the parent folder and select the file.
        await invoke('open_in_explorer', { path });
      }
    } catch (e) {
      console.error('Failed to open in explorer:', e);
    }
  };

  const searchViewElement = (
    <div style={{ display: currentView === 'search' ? 'flex' : 'none', flex: 1, minHeight: 0, width: '100%', flexDirection: 'column' }}>
      <SearchView
        searchQuery={searchQuery || ''}
        onSearchChange={onSearchChange}
        onNavigate={(path) => {
          setSelected(path);
          setSelectedPaths(new Set([path]));
          onSaveConfig({ view: 'folder' }); // 폴더 뷰로 전환
        }}
        onCopy={handleCopy}
        onCut={handleCut}
        onPaste={handlePaste}
        onDelete={handleDelete}
        onExtract={handleExtract}
        onOpenInNewWindow={handleOpenInNewWindow}
        onOpenInExplorer={handleOpenInExplorer}
        refreshTrigger={refreshTrigger}
        quickAccess={config.quickAccess}
        searchConfig={config.search}
        columnSettings={config.columnSettings}
        clipboard={clipboard}
        canPaste={!!clipboard && clipboard.paths.length > 0}
        onColumnSettingsChange={(newSettings) => onSaveConfig({ columnSettings: newSettings })}
        onSaveSearchConfig={(newSearchConfig) => onSaveConfig({ search: newSearchConfig })}
        usePdfWorker={config.usePdfWorker}
        useImageViewer={config.useImageViewer}
        useVideoPlayer={config.useVideoPlayer}
        recentOpenedFolders={config.recentOpenedFolders}
        pdfExportPath={pdfExportPath}
      />
    </div>
  );

  const canPasteVisible = (!!clipboard && clipboard.paths.length > 0) || hasSystemClipboardFiles;

  return (
    <>
      {searchViewElement}
      <div className="mhz-explorer" style={{ display: currentView === 'search' ? 'none' : 'flex' }}>
        <aside className="mhz-explorer__tree" style={{ width: sidebarWidth, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div
            ref={quickAccessRef}
            className="quick-access-section"
            style={{ padding: '0 10px', height: quickAccessHeight, overflowY: 'auto', flexShrink: 0 }}
          >
            <QuickAccessTree
              quickAccessPaths={config.quickAccess}
              selectedPath={selected}
              filterQuickAccess={filterQuickAccess}
              onToggleFilterQuickAccess={(checked) => setFilterQuickAccess(checked)}
              onSelectPath={(qaPath) => {
                setSelected(qaPath);
                setSelectedPaths(new Set([qaPath]));
              }}
              onUpdateQuickAccessPaths={(newPaths) => onSaveConfig({ quickAccess: newPaths })}
            />

            {/* 🌐 Web Folders Section */}
            <div
              className="quick-access-title"
              style={{
                marginTop: '6px',
                borderTop: '1px solid rgba(255,255,255,0.06)',
                paddingTop: '6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '4px',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', overflow: 'hidden' }}>
                <span>🌐</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  Web Folders
                </span>
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => {
                    if (webFoldersCollapsed) {
                      setWebFoldersCollapsed(false);
                      try {
                        localStorage.setItem('mhz_web_folders_collapsed', '0');
                      } catch {}
                    }
                    setEditingWebFolder(null);
                    setDefaultPairLocalPath(selected || '');
                    setWebFolderEditOpen(true);
                  }}
                  title="Add Box or Web Folder with Upload Safety Guard"
                  style={{
                    background: 'rgba(56, 189, 248, 0.14)',
                    border: '1px solid rgba(56, 189, 248, 0.35)',
                    color: '#38bdf8',
                    borderRadius: '4px',
                    padding: '1px 6px',
                    fontSize: '0.72rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  + Add
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWebFoldersCollapsed((prev) => {
                      const next = !prev;
                      try {
                        localStorage.setItem('mhz_web_folders_collapsed', next ? '1' : '0');
                      } catch {}
                      return next;
                    });
                  }}
                  title={webFoldersCollapsed ? 'Expand Web Folders' : 'Collapse Web Folders'}
                  style={{
                    background: 'rgba(148, 163, 184, 0.12)',
                    border: '1px solid rgba(148, 163, 184, 0.25)',
                    color: '#cbd5e1',
                    borderRadius: '4px',
                    padding: '1px 5px',
                    fontSize: '0.7rem',
                    cursor: 'pointer',
                    lineHeight: 1.2,
                  }}
                >
                  {webFoldersCollapsed ? '▶' : '▼'}
                </button>
              </div>
            </div>

            {!webFoldersCollapsed && (
              webFolders.length === 0 ? (
                <div
                  onClick={() => {
                    setEditingWebFolder(null);
                    setDefaultPairLocalPath(selected || '');
                    setWebFolderEditOpen(true);
                  }}
                  style={{
                    padding: '6px 8px',
                    fontSize: '0.78rem',
                    color: 'var(--mhz-text-dim)',
                    fontStyle: 'italic',
                    cursor: 'pointer',
                  }}
                >
                  + Click to add Box / Web Folder...
                </div>
              ) : (
                webFolders.map((wf) => {
                  const safetyBadge =
                    wf.safetyLevel === 'strict' ? '🔴' : wf.safetyLevel === 'download_only' ? '🟢' : '🟡';
                  const wfState = webFolderStates[wf.id];
                  const isActiveWf = activeWebFolderId === wf.id;
                  return (
                    <div
                      key={wf.id}
                      onClick={() => handleSelectAndOpenWebFolder(wf)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu(null);
                        setWebFolderMenu({ x: e.clientX, y: e.clientY, item: wf });
                      }}
                      className={`qa-item ${isActiveWf ? 'selected' : ''}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '4px',
                        borderLeft: wfState?.isOpen
                          ? '3px solid #22c55e'
                          : isActiveWf
                            ? '3px solid #38bdf8'
                            : '3px solid transparent',
                      }}
                      title={`${wf.name}\nURL: ${wf.url}${wf.linkedLocalPath ? `\nLinked Local: ${wf.linkedLocalPath}` : ''}\nSafety: ${wf.safetyLevel.toUpperCase()} (Click to show status in FolderTree & open Safe Web Folder Window)`}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', overflow: 'hidden', flex: 1 }}>
                        <span style={{ fontSize: '0.75em' }}>{safetyBadge}</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {wf.name}
                        </span>
                        {wfState?.isOpen && (
                          <span
                            style={{
                              fontSize: '0.68rem',
                              padding: '0px 4px',
                              borderRadius: '4px',
                              background: wfState.uploadUnlocked ? 'rgba(234, 179, 8, 0.22)' : 'rgba(34, 197, 94, 0.2)',
                              color: wfState.uploadUnlocked ? '#fde047' : '#86efac',
                              flexShrink: 0,
                            }}
                          >
                            {wfState.uploadUnlocked ? '🔓' : '🟢'}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                        {wf.linkedLocalPath && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelected(wf.linkedLocalPath);
                              setSelectedPaths(new Set([wf.linkedLocalPath]));
                            }}
                            title={`Go to Linked Local Folder: ${wf.linkedLocalPath}`}
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              padding: '1px 3px',
                              fontSize: '0.82em',
                              opacity: 0.85,
                            }}
                          >
                            📁
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )
            )}
          </div>
          <div
            onMouseDown={(e) => { e.preventDefault(); setIsResizingQuickAccess(true); }}
            style={{ height: '3px', cursor: 'row-resize', backgroundColor: 'var(--mhz-border)', flexShrink: 0 }}
          />
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {(() => {
              const activeWf =
                webFolders.find((w) => w.id === activeWebFolderId) ||
                webFolders.find((w) => webFolderStates[w.id]?.isOpen);
              if (!activeWf) return null;
              const st = webFolderStates[activeWf.id] || {
                isOpen: false,
                subpath: [],
                autoExtractZip: true,
                uploadUnlocked: false,
                remainingSeconds: 0,
              };
              const baseLocal = (activeWf.linkedLocalPath || '').trim().replace(/[\\/]+$/, '');
              const safetyColor =
                activeWf.safetyLevel === 'strict'
                  ? '#f87171'
                  : activeWf.safetyLevel === 'download_only'
                    ? '#4ade80'
                    : '#facc15';
              const formatRem = (sec: number) => {
                const m = Math.floor(sec / 60);
                const s = sec % 60;
                return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
              };
              return (
                <div
                  style={{
                    margin: '6px 6px 8px 6px',
                    padding: '8px 10px',
                    borderRadius: '7px',
                    background: 'rgba(15, 23, 42, 0.78)',
                    border: st.isOpen
                      ? '1px solid rgba(56, 189, 248, 0.45)'
                      : '1px solid rgba(148, 163, 184, 0.25)',
                    fontSize: '0.76rem',
                    color: '#e2e8f0',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', marginBottom: '6px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontWeight: 700, overflow: 'hidden' }}>
                      <span>🌐</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {activeWf.name}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                      <span
                        style={{
                          padding: '1px 6px',
                          borderRadius: '999px',
                          fontSize: '0.68rem',
                          fontWeight: 700,
                          background: st.isOpen ? 'rgba(34, 197, 94, 0.2)' : 'rgba(148, 163, 184, 0.18)',
                          color: st.isOpen ? '#86efac' : '#94a3b8',
                          border: st.isOpen ? '1px solid rgba(34, 197, 94, 0.45)' : '1px solid rgba(148, 163, 184, 0.3)',
                        }}
                      >
                        {st.isOpen ? '🟢 Open' : '⚪ Closed'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setActiveWebFolderId(null)}
                        title="Hide Web Folder Status Panel"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#94a3b8',
                          cursor: 'pointer',
                          padding: '0 3px',
                          fontSize: '0.78rem',
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Status Pills */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '7px' }}>
                    <span
                      style={{
                        padding: '1px 6px',
                        borderRadius: '4px',
                        fontSize: '0.68rem',
                        background: 'rgba(30, 41, 59, 0.9)',
                        border: '1px solid rgba(148, 163, 184, 0.25)',
                        color: safetyColor,
                        fontWeight: 600,
                      }}
                    >
                      🛡️ {activeWf.safetyLevel.toUpperCase()}
                    </span>
                    <span
                      style={{
                        padding: '1px 6px',
                        borderRadius: '4px',
                        fontSize: '0.68rem',
                        background: st.uploadUnlocked ? 'rgba(234, 179, 8, 0.2)' : 'rgba(30, 41, 59, 0.9)',
                        border: st.uploadUnlocked ? '1px solid rgba(250, 204, 21, 0.5)' : '1px solid rgba(148, 163, 184, 0.25)',
                        color: st.uploadUnlocked ? '#fde047' : '#cbd5e1',
                        fontWeight: 600,
                      }}
                    >
                      {st.uploadUnlocked
                        ? `🔓 Upload Unlocked (${formatRem(st.remainingSeconds)})`
                        : '🔒 Upload Locked'}
                    </span>
                    {baseLocal && (
                      <span
                        style={{
                          padding: '1px 6px',
                          borderRadius: '4px',
                          fontSize: '0.68rem',
                          background: st.autoExtractZip ? 'rgba(56, 189, 248, 0.16)' : 'rgba(30, 41, 59, 0.9)',
                          border: '1px solid rgba(56, 189, 248, 0.35)',
                          color: st.autoExtractZip ? '#7dd3fc' : '#94a3b8',
                        }}
                      >
                        📦 Auto-Unpack: {st.autoExtractZip ? 'ON' : 'OFF'}
                      </span>
                    )}
                  </div>

                  {/* Live Web Hierarchy Tree mapped to Local Folder */}
                  <div
                    style={{
                      padding: '5px 6px',
                      borderRadius: '5px',
                      background: 'rgba(2, 6, 23, 0.55)',
                      border: '1px solid rgba(148, 163, 184, 0.18)',
                    }}
                  >
                    <div style={{ fontSize: '0.68rem', color: '#94a3b8', marginBottom: '3px', fontWeight: 600 }}>
                      Web Folder Hierarchy {baseLocal ? '(Click to open local folder)' : '(No Linked Local Folder)'}:
                    </div>
                    <div
                      onClick={() => {
                        if (baseLocal) {
                          setSelected(baseLocal);
                          setSelectedPaths(new Set([baseLocal]));
                        }
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '2px 4px',
                        borderRadius: '4px',
                        cursor: baseLocal ? 'pointer' : 'default',
                        background: st.subpath.length === 0 ? 'rgba(56, 189, 248, 0.18)' : 'transparent',
                        color: st.subpath.length === 0 ? '#7dd3fc' : '#cbd5e1',
                        fontWeight: st.subpath.length === 0 ? 700 : 500,
                      }}
                      title={baseLocal || activeWf.url}
                    >
                      <span>📁</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {baseLocal ? baseLocal.split(/[\\/]/).pop() || baseLocal : `${activeWf.name} (Root)`}
                      </span>
                      {st.subpath.length === 0 && (
                        <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: '#38bdf8' }}>● Current</span>
                      )}
                    </div>
                    {st.subpath.map((seg, idx) => {
                      const isLeaf = idx === st.subpath.length - 1;
                      const subLocalPath = baseLocal
                        ? [baseLocal, ...st.subpath.slice(0, idx + 1)].join('\\')
                        : '';
                      return (
                        <div
                          key={`${seg}-${idx}`}
                          onClick={() => {
                            if (subLocalPath) {
                              setSelected(subLocalPath);
                              setSelectedPaths(new Set([subLocalPath]));
                            }
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            padding: `2px 4px 2px ${(idx + 1) * 12 + 4}px`,
                            borderRadius: '4px',
                            cursor: subLocalPath ? 'pointer' : 'default',
                            background: isLeaf ? 'rgba(56, 189, 248, 0.18)' : 'transparent',
                            color: isLeaf ? '#7dd3fc' : '#cbd5e1',
                            fontWeight: isLeaf ? 700 : 500,
                          }}
                          title={subLocalPath || seg}
                        >
                          <span style={{ color: '#64748b' }}>└</span>
                          <span>📂</span>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {seg}
                          </span>
                          {isLeaf && (
                            <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: '#38bdf8' }}>● Target</span>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {st.lastDownload && (
                    <div
                      onClick={() => {
                        if (st.lastDownload?.targetDir) {
                          setSelected(st.lastDownload.targetDir);
                          setSelectedPaths(new Set([st.lastDownload.targetDir]));
                        }
                      }}
                      style={{
                        marginTop: '6px',
                        padding: '4px 6px',
                        borderRadius: '4px',
                        background: 'rgba(20, 83, 45, 0.45)',
                        border: '1px solid rgba(74, 222, 128, 0.35)',
                        color: '#bbf7d0',
                        fontSize: '0.69rem',
                        cursor: 'pointer',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={`Click to open downloaded folder:\n${st.lastDownload.targetDir}`}
                    >
                      ✅ Downloaded: {st.lastDownload.fileName}
                    </div>
                  )}
                </div>
              );
            })()}
            {!filterQuickAccess ? (
              <FolderTree
                path={treeRoot.path}
                name={treeRoot.name}
                onSelect={handleTreeSelect}
                activePath={selected}
                selectedPaths={selectedPaths}
                expandedPaths={expandedPaths}
                onToggleExpand={handleToggleExpand}
                onMove={handleMove}
                onContextMenu={handleTreeContextMenu}
                refreshTrigger={refreshTrigger}
                editableFolders={config.editableFolders}
                readonlyFolders={config.readonlyFolders}
                allowedPaths={activeAllowedPaths}
                clipboard={clipboard}
                renamingPath={renamingTreePath}
                renameText={renameTreeText}
                onRenameTextChange={setRenameTreeText}
                onStartRename={handleStartTreeRename}
                onFinishRename={handleFinishTreeRename}
                onCancelRename={handleCancelTreeRename}
                showMessage={showMessage}
                webFolderBadges={webFolderBadges}
                isRoot
                depth={0}
              />
            ) : (
              config.quickAccess
                .filter(qaPath => {
                  if (!selected.startsWith(qaPath)) return false;
                  if (selected.length === qaPath.length) return true;
                  const sep = selected[qaPath.length];
                  return sep === '\\' || sep === '/';
                })
                .sort((a, b) => b.length - a.length)
                .slice(0, 1)
                .map((qaPath) => (
                  <FolderTree
                    key={qaPath}
                    path={qaPath}
                    name={qaPath.split(/[/\\]/).filter(Boolean).pop() || qaPath}
                    depth={0}
                    onSelect={handleTreeSelect}
                    activePath={selected}
                    selectedPaths={selectedPaths}
                    expandedPaths={expandedPaths}
                    onToggleExpand={handleToggleExpand}
                    onMove={handleMove}
                    onContextMenu={handleTreeContextMenu}
                    refreshTrigger={refreshTrigger}
                    editableFolders={config.editableFolders}
                    readonlyFolders={config.readonlyFolders}
                    allowedPaths={activeAllowedPaths}
                    clipboard={clipboard}
                    renamingPath={renamingTreePath}
                    renameText={renameTreeText}
                    onRenameTextChange={setRenameTreeText}
                    onStartRename={handleStartTreeRename}
                    onFinishRename={handleFinishTreeRename}
                    onCancelRename={handleCancelTreeRename}
                    showMessage={showMessage}
                    webFolderBadges={webFolderBadges}
                    isRoot
                  />
                ))
            )}
          </div>
        </aside>
        <div
          className="mhz-resizer"
          onMouseDown={() => {
            draggedRef.current = false;
            setIsResizing(true);
          }}
          onClick={() => {
            if (draggedRef.current) return;
            if (sidebarWidth > 0) {
              setPrevSidebarWidth(sidebarWidth);
              setSidebarWidth(0);
              onSaveConfig({ sidebarWidth: 0 });
            } else {
              const newWidth = prevSidebarWidth > 0 ? prevSidebarWidth : 260;
              setSidebarWidth(newWidth);
              onSaveConfig({ sidebarWidth: newWidth });
            }
          }}
          onDoubleClick={() => {
            setSidebarWidth(0);
            onSaveConfig({ sidebarWidth: 0 });
          }}
          style={{ width: '3px', cursor: 'col-resize' }}
        />
        <section className="mhz-explorer__files" >
          {/* <div className="mhz-explorer__path">{selected}</div> */}
          <FileList
            path={selected}
            selectedFiles={filesSelected}
            onSelectFiles={setFilesSelected}
            onFocus={() => setActivePane('list')}
            onNavigate={(path) => {
              setSelected(path);
              setSelectedPaths(new Set([path]));
            }}
            onCopy={handleCopy}
            onCut={handleCut}
            onPaste={() => handlePaste(selected)}
            onMove={handleMove}
            onDelete={handleDelete}
            onExtract={handleExtract}
            onOpenInNewWindow={handleOpenInNewWindow}
            onOpenInExplorer={handleOpenInExplorer}
            refreshTrigger={refreshTrigger}
            onRefresh={() => setRefreshTrigger(p => p + 1)}
            searchQuery={searchQuery}
            editableFolders={config.editableFolders}
            readonlyFolders={config.readonlyFolders}
            columnSettings={config.columnSettings}
            clipboard={clipboard}
            canPaste={!!clipboard && clipboard.paths.length > 0}
            onColumnSettingsChange={(newSettings) => onSaveConfig({ columnSettings: newSettings })}
            usePdfWorker={config.usePdfWorker}
            useImageViewer={config.useImageViewer}
            useVideoPlayer={config.useVideoPlayer}
            pdfExportPath={pdfExportPath}
            onSetDefault={handleSetDefault}
            onAddToQuickAccess={handleAddToQuickAccess}
          />
        </section>
        {contextMenu && (
          <div ref={menuRef} className="context-menu" style={getMenuPosition()}>
            {contextMenu.source === 'quickAccess' ? (
              <div className="context-menu-item delete" onClick={() => handleRemoveQuickAccess(contextMenu.path)}>
                <span>{t('contextMenu.removeFromQuickAccess', { defaultValue: 'Remove from Quick Access' })}</span>
              </div>
            ) : (
              <>
                <div className={`context-menu-item ${!canWriteToSelectedPaths ? 'disabled' : ''}`} onClick={canWriteToSelectedPaths ? () => handleCut(Array.from(selectedPaths)) : undefined} style={{ padding: '2px 10px' }}>
                  <span>{t('contextMenu.cut', { defaultValue: 'Cut' })}</span> <span className="shortcut">Ctrl+X</span>
                </div>
                <div className="context-menu-item" onClick={() => handleCopy(Array.from(selectedPaths))} style={{ padding: '2px 10px' }}>
                  <span>{t('contextMenu.copy', { defaultValue: 'Copy' })}</span> <span className="shortcut">Ctrl+C</span>
                </div>
                <div className={`context-menu-item ${!canWriteToContextMenuPath ? 'disabled' : ''}`} onClick={canWriteToContextMenuPath ? () => handleCreateFolder(contextMenu.path) : undefined} style={{ padding: '2px 10px' }}>
                  <span>{t('contextMenu.createFolder', { defaultValue: 'Create Folder' })}</span>
                </div>
                <div className={`context-menu-item ${!canWriteToContextMenuPath ? 'disabled' : ''}`} onClick={canWriteToContextMenuPath ? () => handleCreateMdFile(contextMenu.path) : undefined} style={{ padding: '2px 10px' }}>
                  <span>{t('contextMenu.createMarkdownFile', { defaultValue: 'Create Markdown File' })}</span>
                </div>
                {canPasteVisible && (
                  <div className={`context-menu-item ${!canWriteToContextMenuPath ? 'disabled' : ''}`} onClick={canWriteToContextMenuPath ? () => handlePaste(contextMenu.path) : undefined} style={{ padding: '2px 10px' }}>
                    <span>{t('contextMenu.paste', { defaultValue: 'Paste' })}</span> <span className="shortcut">Ctrl+V</span>
                  </div>
                )}
                <div className="context-menu-separator"></div>
              <div className="context-menu-item" onClick={() => handleOpenInNewWindow(contextMenu.path, true)} style={{ padding: '2px 10px' }}>
                <span>{t('contextMenu.openInNewWindow', { defaultValue: 'Open in New Window' })}</span> <span className="shortcut">Ctrl+Enter</span>
                </div>
                <div className="context-menu-item" onClick={() => handleOpenInExplorer(contextMenu.path, true)} style={{ padding: '2px 10px' }}>
                  {t('contextMenu.openInExplorer', { defaultValue: 'Open in File Explorer' })}
                </div>
                <div className="context-menu-separator"></div>
                <div className={`context-menu-item delete ${!canWriteToSelectedPaths ? 'disabled' : ''}`} onClick={canWriteToSelectedPaths ? () => handleDelete(Array.from(selectedPaths)) : undefined} style={{ padding: '2px 10px' }}>
                  <span>{t('contextMenu.delete', { defaultValue: 'Delete' })}</span> <span className="shortcut">Del</span>
                </div>
                <div className="context-menu-separator"></div>
                {selectedPaths.size === 1 && (
                  <div className="context-menu-item" onClick={() => handleSetDefault(contextMenu.path)} style={{ padding: '2px 10px' }}>{t('contextMenu.setAsDefaultFolder', { defaultValue: 'Set as Default Folder' })}</div>
                )}
                <div className="context-menu-item" onClick={() => Array.from(selectedPaths).forEach(p => handleAddToQuickAccess(p))} style={{ padding: '2px 10px' }}>
                  {t('contextMenu.addToQuickAccess', { defaultValue: 'Add to Quick Access' })}
                </div>
                <div
                  className="context-menu-item"
                  onClick={() => {
                    const targetPath = contextMenu.path;
                    setContextMenu(null);
                    setEditingWebFolder(null);
                    setDefaultPairLocalPath(targetPath);
                    setWebFolderEditOpen(true);
                  }}
                  style={{ padding: '2px 10px' }}
                >
                  🌐 Pair with Web Folder (Box)...
                </div>
                <div
                  className="context-menu-item"
                  onClick={() => {
                    const targetPath = contextMenu.path;
                    setContextMenu(null);
                    openPowerShellManagerWindow({
                      workingDir: targetPath,
                      selectedFiles: Array.from(selectedPaths),
                    });
                  }}
                  style={{ padding: '2px 10px' }}
                >
                  ⚡ Open PowerShell Studio Here
                </div>
                <div className="context-menu-separator"></div>
                <div className="context-menu-item" onClick={() => handleSetPermission(contextMenu.path, 'editable')} style={{ padding: '2px 10px' }}>{t('contextMenu.setAsEditable', { defaultValue: 'Set as Editable' })}</div>
                <div className="context-menu-item" onClick={() => handleSetPermission(contextMenu.path, 'readonly')} style={{ padding: '2px 10px' }}>{t('contextMenu.setAsReadOnly', { defaultValue: 'Set as Read-only' })}</div>
                <div className="context-menu-item" onClick={() => handleClearPermission(contextMenu.path)} style={{ padding: '2px 10px' }}>{t('contextMenu.clearPermission', { defaultValue: 'Clear Permission' })}</div>
              </>
            )}
          </div>
        )}

        {webFolderMenu && (
          <div
            className="context-menu"
            style={{
              position: 'fixed',
              left: Math.min(webFolderMenu.x, window.innerWidth - 240),
              top: Math.min(webFolderMenu.y, window.innerHeight - 220),
              zIndex: 2500,
            }}
            onMouseLeave={() => setWebFolderMenu(null)}
          >
            <div
              className="context-menu-item"
              onClick={() => {
                const item = webFolderMenu.item;
                setWebFolderMenu(null);
                handleOpenSafeWebFolder(item);
              }}
              style={{ padding: '4px 10px' }}
            >
              <span>🛡️ Open Safe Web Folder Window</span>
            </div>
            <div
              className="context-menu-item"
              onClick={() => {
                const item = webFolderMenu.item;
                setWebFolderMenu(null);
                invoke('open_file', { path: item.url }).catch(() => {});
              }}
              style={{ padding: '4px 10px' }}
            >
              <span>🌍 Open in System Browser</span>
            </div>
            {webFolderMenu.item.linkedLocalPath && (
              <>
                <div className="context-menu-separator"></div>
                <div
                  className="context-menu-item"
                  onClick={() => {
                    const localPath = webFolderMenu.item.linkedLocalPath;
                    setWebFolderMenu(null);
                    setSelected(localPath);
                    setSelectedPaths(new Set([localPath]));
                  }}
                  style={{ padding: '4px 10px' }}
                >
                  <span>📁 Go to Linked Local Folder</span>
                </div>
              </>
            )}
            <div className="context-menu-separator"></div>
            <div
              className="context-menu-item"
              onClick={() => {
                const item = webFolderMenu.item;
                setWebFolderMenu(null);
                setEditingWebFolder(item);
                setWebFolderEditOpen(true);
              }}
              style={{ padding: '4px 10px' }}
            >
              <span>✏️ Edit Web Folder &amp; Safety Level...</span>
            </div>
            <div
              className="context-menu-item delete"
              onClick={() => {
                const item = webFolderMenu.item;
                setWebFolderMenu(null);
                handleDeleteWebFolder(item.id);
              }}
              style={{ padding: '4px 10px' }}
            >
              <span>🗑️ Remove Web Folder</span>
            </div>
          </div>
        )}

        <WebFolderEditModal
          open={webFolderEditOpen}
          initialItem={editingWebFolder}
          defaultLocalPath={defaultPairLocalPath}
          onClose={() => setWebFolderEditOpen(false)}
          onSave={handleSaveWebFolder}
        />

        <MessageDialog
          open={msgDialogOpen}
          title={msgDialogTitle}
          message={msgDialogMessage}
          onClose={() => setMsgDialogOpen(false)}
        />
        <ConfirmDialog
          open={confirmState.open}
          title={confirmState.title}
          message={confirmState.message}
          onConfirm={() => {
            if (confirmState.resolve) confirmState.resolve(true);
            setConfirmState(prev => ({ ...prev, open: false }));
          }}
          onCancel={() => {
            if (confirmState.resolve) confirmState.resolve(false);
            setConfirmState(prev => ({ ...prev, open: false }));
          }}
          okLabel="Yes"
          cancelLabel="No"
        />
      </div>
    </>
  );
});

export default FileExplorer;

import { useState, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { rename, mkdir } from '@tauri-apps/plugin-fs';
import { confirm } from '@tauri-apps/plugin-dialog';
import ErrorDialog from './ErrorDialog';
import { basename, dirname, join } from '@tauri-apps/api/path';
import { checkPathPermission } from '../command/fileOperations';
import { openPdfInWindow } from '../PDFViewer/PDFViewer';
import MessageDialog from '../common/MessageDialog';

interface FileListProps {
  path: string | null;
  selectedFiles: Set<string>;
  onSelectFiles: (files: Set<string>) => void;
  onFocus: () => void;
  onNavigate: (path: string) => void;
  onCopy: (paths: string[]) => void;
  onCut: (paths: string[]) => void;
  onPaste: (targetDir: string) => void;
  onDelete: (paths: string[]) => void;
  onExtract: (path: string) => void;
  onMove?: (sourcePaths: string[], targetDir: string, op: 'move' | 'copy') => void;
  onOpenInNewWindow: (path: string, isDirectory?: boolean) => void;
  onOpenInExplorer: (path: string, isDirectory?: boolean) => void;
  refreshTrigger?: number;
  searchQuery?: string;
  filesOverride?: FileData[];
  editableFolders?: string[];
  readonlyFolders?: string[];
  autoFitTrigger?: number;
  enableAutoResize?: boolean;
  columnSettings?: { key: string; visible: boolean }[];
  clipboard?: { paths: string[]; op: 'copy' | 'move' } | null;
  canPaste?: boolean;
  onColumnSettingsChange?: (settings: { key: string; visible: boolean }[]) => void;
}

interface FileData {
  name: string;
  path: string;
  size: number;
  extension: string;
  type: string;
  mtime: Date | null;
  birthtime: Date | null;
  atime: Date | null;
  readonly: boolean;
  isDirectory: boolean;
}

type SortKey = 'name' | 'path' | 'size' | 'extension' | 'type' | 'mtime' | 'birthtime' | 'atime';
type SortDirection = 'asc' | 'desc';

interface FilterConfig {
  operator: 'contains' | 'gt' | 'lt' | 'range' | 'after' | 'before' | 'between';
  value: string;
  value2: string;
  unit: number; // for size multiplier
}

const COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  size: 'Size',
  type: 'Type',
  birthtime: 'Date Created',
  mtime: 'Date Modified',
  atime: 'Date Accessed',
  path: 'Path'
};

export default function FileList({
  path,
  selectedFiles,
  onSelectFiles,
  onFocus,
  onNavigate,
  onCopy,
  onPaste,
  onCut,
  onDelete,
  onMove,
  onOpenInNewWindow,
  onOpenInExplorer,
  refreshTrigger,
  searchQuery,
  filesOverride,
  editableFolders,
  readonlyFolders,
  autoFitTrigger,
  enableAutoResize = false,
  columnSettings,
  clipboard,
  canPaste,
  onColumnSettingsChange
}: FileListProps) {
  const [files, setFiles] = useState<FileData[]>([]);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'name',
    direction: 'asc',
  });

  const [activeFilters, setActiveFilters] = useState<Record<string, FilterConfig>>({});
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [filterState, setFilterState] = useState<FilterConfig>({ operator: 'contains', value: '', value2: '', unit: 1 });

  const [version, setVersion] = useState(0); // 파일 목록 갱신용

  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; type: 'file' | 'container' | 'header' } | null>(null);

  // Zip Dialog State
  const [zipDialogOpen, setZipDialogOpen] = useState(false);
  const [zipPath, setZipPath] = useState<string | null>(null);
  const [zipEntries, setZipEntries] = useState<{ name: string; isDir: boolean; size: number; isEncrypted: boolean }[]>([]);
  const [selectedZipEntries, setSelectedZipEntries] = useState<Set<string>>(new Set());
  const [zipDialogPos, setZipDialogPos] = useState({ x: 100, y: 100 });
  const [zipDialogSize, setZipDialogSize] = useState({ width: 600, height: 500 });
  const [extractPath, setExtractPath] = useState('');
  const [extractPassword, setExtractPassword] = useState('');
  const [isZipEncrypted, setIsZipEncrypted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractProgress, setExtractProgress] = useState<{ total: number; processed: number; filename: string; startTime: number } | null>(null);
  const [extractProgressPos, setExtractProgressPos] = useState({ x: 300, y: 300 });

  // Error dialog state
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);
  const [errorDialogTitle, setErrorDialogTitle] = useState('Error');
  const [errorDialogMessage, setErrorDialogMessage] = useState('');
  const [errorDialogDetails, setErrorDialogDetails] = useState<string | undefined>(undefined);

  // Compress Dialog State
  const [compressDialogOpen, setCompressDialogOpen] = useState(false);
  const [compressName, setCompressName] = useState('');
  const [compressMethod, setCompressMethod] = useState('deflated');
  const [compressPassword, setCompressPassword] = useState('');
  const [compressEncryption, setCompressEncryption] = useState('zipcrypto');
  const [compressProgress, setCompressProgress] = useState<{ total: number; processed: number; filename: string; startTime: number } | null>(null);

  // Permission/Message Dialog State
  const [msgDialogOpen, setMsgDialogOpen] = useState(false);
  const [msgDialogTitle, setMsgDialogTitle] = useState('');
  const [msgDialogMessage, setMsgDialogMessage] = useState('');

  const showMessage = (title: string, message: string) => {
    setMsgDialogTitle(title);
    setMsgDialogMessage(message);
    setMsgDialogOpen(true);
  };

  // Column Resizing State
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    name: 250,
    path: 150,
    size: 100,
    type: 120,
    birthtime: 150,
    mtime: 150,
    atime: 150
  });

  const defaultSettings = useMemo(() => [
    { key: 'name', visible: true },
    { key: 'size', visible: true },
    { key: 'type', visible: true },
    { key: 'birthtime', visible: true },
    { key: 'mtime', visible: true },
    { key: 'atime', visible: true },
    { key: 'path', visible: true },
  ], []);

  const activeColumnSettings = (columnSettings && columnSettings.length > 0) ? columnSettings : defaultSettings;

  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const columnWidthsRef = useRef(columnWidths);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);

  // Drag Selection State
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  useEffect(() => {
    columnWidthsRef.current = columnWidths;
  }, [columnWidths]);

  // Auto Resize Logic
  useEffect(() => {
    if (!enableAutoResize || !containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (width <= 0) continue;

        const currentWidths = columnWidthsRef.current;
        const cols = activeColumnSettings.filter(c => c.visible).map(c => c.key);
        const currentTotal = cols.reduce((acc, key) => acc + (currentWidths[key] || 0), 0);

        if (currentTotal > 0 && Math.abs(width - currentTotal) > 5) {
          const ratio = width / currentTotal;
          setColumnWidths(prev => {
            const next = { ...prev };
            cols.forEach(key => {
              next[key] = Math.max(50, Math.floor((prev[key] || 0) * ratio));
            });
            return next;
          });
        }
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [enableAutoResize, activeColumnSettings]);

  useEffect(() => {
    if (filesOverride) {
      setFiles(filesOverride);
      setLastSelectedIndex(null);
      setAnchorIndex(null);
      return;
    }
    if (!path) return;
    setLastSelectedIndex(null);
    setAnchorIndex(null);
    let isMounted = true;

    const loadFiles = async () => {
      try {
        const entries = await invoke<any[]>('read_directory', { path });
        if (!isMounted) return;

        const filesWithStats = entries.map((entry) => {
          const isDir = entry.isDirectory;
          const extension = isDir ? '' : (entry.name.split('.').pop() || '');
          const type = isDir ? 'File folder' : (extension ? `${extension.toUpperCase()} File` : 'File');

          return {
            name: entry.name,
            path: entry.path,
            size: entry.size,
            extension,
            type,
            mtime: entry.mtime ? new Date(entry.mtime) : null,
            birthtime: entry.birthtime ? new Date(entry.birthtime) : null,
            atime: entry.atime ? new Date(entry.atime) : null,
            readonly: entry.readonly,
            isDirectory: isDir,
          };
        });

        if (isMounted) {
          setFiles(filesWithStats);
        }
      } catch (error) {
        if (isMounted) {
          console.error('Failed to read files:', error);
          setFiles([]);
        }
      }
    };
    loadFiles();
    return () => {
      isMounted = false;
    };
  }, [path, version, refreshTrigger, filesOverride]);

  // 검색어가 변경되면 포커스 인덱스 초기화
  useEffect(() => {
    setLastSelectedIndex(null);
    setAnchorIndex(null);
  }, [searchQuery]);

  // Column Resize Handlers
  const handleResizeStart = (e: React.MouseEvent, colKey: string) => {
    e.preventDefault();
    e.stopPropagation();
    setResizingCol(colKey);
    resizeStartRef.current = { x: e.clientX, width: columnWidths[colKey] };
  };

  useEffect(() => {
    const handleResizeMove = (e: MouseEvent) => {
      if (!resizingCol || !resizeStartRef.current) return;
      const diff = e.clientX - resizeStartRef.current.x;
      const newWidth = Math.max(50, resizeStartRef.current.width + diff);
      setColumnWidths(prev => ({ ...prev, [resizingCol]: newWidth }));
    };

    const handleResizeEnd = () => {
      setResizingCol(null);
      resizeStartRef.current = null;
    };

    if (resizingCol) {
      window.addEventListener('mousemove', handleResizeMove);
      window.addEventListener('mouseup', handleResizeEnd);
    }
    return () => {
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
    };
  }, [resizingCol]);

  const handleHeaderContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, type: 'header' });
  };

  const toggleColumnVisibility = (key: string) => {
    const newSettings = activeColumnSettings.map(col =>
      col.key === key ? { ...col, visible: !col.visible } : col
    );
    if (newSettings.some(c => c.visible)) {
      onColumnSettingsChange?.(newSettings);
    }
  };

  const handleColumnReorder = (sourceKey: string, targetKey: string) => {
    const newSettings = [...activeColumnSettings];
    const sourceIdx = newSettings.findIndex(c => c.key === sourceKey);
    const targetIdx = newSettings.findIndex(c => c.key === targetKey);

    if (sourceIdx === -1 || targetIdx === -1 || sourceIdx === targetIdx) return;

    const [moved] = newSettings.splice(sourceIdx, 1);
    newSettings.splice(targetIdx, 0, moved);

    onColumnSettingsChange?.(newSettings);
  };

  const handleOpenFilter = (e: React.MouseEvent, colKey: string) => {
    e.stopPropagation();
    const isOpen = openFilter === colKey;
    setOpenFilter(isOpen ? null : colKey);
    setFilterState(activeFilters[colKey] || { operator: 'contains', value: '', value2: '', unit: 1 });
  };

  const handleAutoFit = (colKey: string) => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;
    context.font = '0.9em sans-serif'; // CSS 폰트와 유사하게 설정

    let headerText = colKey;
    switch (colKey) {
      case 'name': headerText = 'Name'; break;
      case 'size': headerText = 'Size'; break;
      case 'type': headerText = 'Type'; break;
      case 'birthtime': headerText = 'Date Created'; break;
      case 'mtime': headerText = 'Date Modified'; break;
      case 'atime': headerText = 'Date Accessed'; break;
      case 'path': headerText = 'Path'; break;
    }

    let maxWidth = context.measureText(headerText).width + 40; // 헤더 텍스트 + 여백 + 정렬 아이콘

    files.forEach(file => {
      let text = '';
      switch (colKey) {
        case 'name': text = file.name; break;
        case 'path': text = file.path; break;
        case 'size': text = formatSize(file.size, file.isDirectory); break;
        case 'type': text = file.type; break;
        case 'mtime': text = formatDate(file.mtime); break;
        case 'birthtime': text = formatDate(file.birthtime); break;
        case 'atime': text = formatDate(file.atime); break;
      }
      const width = context.measureText(text).width + 20; // 콘텐츠 텍스트 + 여백
      if (width > maxWidth) maxWidth = width;
    });

    // 최대 800px로 제한
    setColumnWidths(prev => ({ ...prev, [colKey]: Math.min(maxWidth, 800) }));
  };

  // 외부 트리거가 변경되면 모든 컬럼을 Auto-fit 합니다.
  useEffect(() => {
    if (autoFitTrigger === undefined) return;
    const cols: Array<keyof typeof columnWidths> = ['name', 'path', 'size', 'type', 'birthtime', 'mtime', 'atime'];
    // Slight timeout to ensure DOM/layout ready
    setTimeout(() => {
      cols.forEach(c => handleAutoFit(c as string));
    }, 50);
  }, [autoFitTrigger, files]);

  const handleFitToScreen = () => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;

    const cols = activeColumnSettings.filter(c => c.visible).map(c => c.key);
    const currentTotal = cols.reduce((acc, key) => acc + (columnWidths[key] || 0), 0);

    if (currentTotal <= 0) return;

    const ratio = containerWidth / currentTotal;

    setColumnWidths(prev => {
      const next = { ...prev };
      cols.forEach(key => {
        next[key] = Math.max(50, Math.floor((prev[key] || 0) * ratio));
      });
      return next;
    });
  };

  const handleSort = (key: SortKey) => {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  const sortedFiles = [...files]
    .filter((file) => !searchQuery || file.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .filter((file) => {
      for (const [key, filter] of Object.entries(activeFilters)) {
        let val: any = null;
        if (key === 'name') val = file.name;
        else if (key === 'path') val = file.path;
        else if (key === 'type') val = file.type;
        else if (key === 'size') val = file.size;
        else if (key === 'birthtime') val = file.birthtime;
        else if (key === 'mtime') val = file.mtime;
        else if (key === 'atime') val = file.atime;

        if (val === null) return false;

        if (['name', 'path', 'type'].includes(key)) {
          if (filter.value && !String(val).toLowerCase().includes(filter.value.toLowerCase())) return false;
        } else if (key === 'size') {
          const size = Number(val);
          const v1 = Number(filter.value) * filter.unit;
          const v2 = Number(filter.value2) * filter.unit;
          if (filter.operator === 'gt' && size <= v1) return false;
          if (filter.operator === 'lt' && size >= v1) return false;
          if (filter.operator === 'range' && (size < v1 || size > v2)) return false;
        } else if (['birthtime', 'mtime', 'atime'].includes(key)) {
          const date = val as Date;
          const time = date.getTime();
          const d1 = new Date(filter.value).getTime();
          const d2 = new Date(filter.value2).getTime();

          if (isNaN(d1)) continue; // Invalid date input

          if (filter.operator === 'after' && time <= d1) return false;
          if (filter.operator === 'before' && time >= d1) return false;
          if (filter.operator === 'between' && (time < d1 || time > d2)) return false;
        }
      }
      return true;
    })
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }

      const { key, direction } = sortConfig;
      let result = 0;

      if (key === 'name') {
        result = a.name.localeCompare(b.name, undefined, { numeric: true });
      } else if (key === 'path') {
        result = a.path.localeCompare(b.path);
      } else if (key === 'size') {
        result = a.size - b.size;
      } else if (key === 'extension') {
        result = a.extension.localeCompare(b.extension);
      } else if (key === 'type') {
        result = a.type.localeCompare(b.type);
      } else if (key === 'mtime') {
        const timeA = a.mtime?.getTime() || 0;
        const timeB = b.mtime?.getTime() || 0;
        result = timeA - timeB;
      } else if (key === 'birthtime') {
        const timeA = a.birthtime?.getTime() || 0;
        const timeB = b.birthtime?.getTime() || 0;
        result = timeA - timeB;
      } else if (key === 'atime') {
        const timeA = a.atime?.getTime() || 0;
        const timeB = b.atime?.getTime() || 0;
        result = timeA - timeB;
      }

      return direction === 'asc' ? result : -result;
    });

  useEffect(() => {
    if (searchQuery) {
      // console.log('Current Search Folder:', path);
      // console.log('Filtered Files:', sortedFiles);
    }
  }, [searchQuery, path, files, sortConfig]);

  const formatSize = (bytes: number, isDir?: boolean) => {
    if (isDir) return '';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (date: Date | null) => {
    if (!date) return '-';
    return date.toLocaleString();
  };

  // Close context menu on click
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  // Selection Logic
  const handleFileClick = (e: React.MouseEvent, file: FileData, index: number) => {
    e.stopPropagation();
    setContextMenu(null);
    const isMulti = e.ctrlKey || e.metaKey;
    const newSelected = new Set(isMulti ? selectedFiles : []);

    // Shift Click: Anchor부터 현재까지 선택
    if (e.shiftKey && (anchorIndex !== null || lastSelectedIndex !== null) && sortedFiles.length > 0) {
      const startIdx = anchorIndex ?? lastSelectedIndex ?? index;
      const start = Math.min(startIdx, index);
      const end = Math.max(startIdx, index);
      for (let i = start; i <= end; i++) {
        newSelected.add(sortedFiles[i].path);
      }
      setLastSelectedIndex(index); // 포커스 이동, 앵커 유지
    } else {
      // 일반 클릭 또는 Ctrl 클릭
      if (isMulti) {
        if (newSelected.has(file.path)) newSelected.delete(file.path);
        else newSelected.add(file.path);
      } else {
        newSelected.add(file.path);
      }
      setLastSelectedIndex(index);
      setAnchorIndex(index); // 앵커 이동
    }
    onSelectFiles(newSelected);
  };

  // Drag Selection Logic
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left click
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      dragStartRef.current = {
        x: (e.clientX - rect.left) + containerRef.current.scrollLeft,
        y: (e.clientY - rect.top) + containerRef.current.scrollTop
      };
      setIsSelecting(true);
      onSelectFiles(new Set()); // Clear selection on drag start
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isSelecting || !dragStartRef.current || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const currentX = (e.clientX - rect.left) + containerRef.current.scrollLeft;
      const currentY = (e.clientY - rect.top) + containerRef.current.scrollTop;

      const newRect = {
        x: Math.min(dragStartRef.current.x, currentX),
        y: Math.min(dragStartRef.current.y, currentY),
        w: Math.abs(currentX - dragStartRef.current.x),
        h: Math.abs(currentY - dragStartRef.current.y)
      };
      setSelectionRect(newRect);

      // Calculate intersection
      const newSelected = new Set<string>();
      sortedFiles.forEach((file) => {
        const el = fileRefs.current.get(file.path);
        if (el) {
          const itemRect = {
            x: el.offsetLeft,
            y: el.offsetTop,
            w: el.offsetWidth,
            h: el.offsetHeight
          };

          // Simple AABB intersection
          if (
            newRect.x < itemRect.x + itemRect.w &&
            newRect.x + newRect.w > itemRect.x &&
            newRect.y < itemRect.y + itemRect.h &&
            newRect.y + newRect.h > itemRect.y
          ) {
            newSelected.add(file.path);
          }
        }
      });
      onSelectFiles(newSelected);
    };

    const handleMouseUp = () => {
      setIsSelecting(false);
      setSelectionRect(null);
      dragStartRef.current = null;
    };

    if (isSelecting) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isSelecting, sortedFiles, onSelectFiles]);

  const handleRename = async () => {
    if (!renamingFile || !renameText) {
      setRenamingFile(null);
      return;
    }
    if (!checkPathPermission(renamingFile, editableFolders, readonlyFolders)) {
      showMessage('Permission Error', 'You do not have permission to edit this file.');
      setRenamingFile(null);
      return;
    }
    try {
      const oldPath = renamingFile;
      const newPath = await join(await dirname(oldPath), renameText);
      await rename(oldPath, newPath);
      setVersion(v => v + 1);
    } catch (error) {
      console.error('Failed to rename:', error);
    } finally {
      setRenamingFile(null);
    }
  };

  const handleCreateFolder = async () => {
    if (!path) return;
    if (!checkPathPermission(path, editableFolders, readonlyFolders)) {
      showMessage('Permission Error', 'You do not have permission to create folders here.');
      return;
    }
    setContextMenu(null);

    let baseName = "New Folder";
    let newName = baseName;
    let counter = 2;

    const existingNames = new Set(files.map(f => f.name));
    while (existingNames.has(newName)) {
      newName = `${baseName} (${counter})`;
      counter++;
    }

    try {
      const newPath = await join(path, newName);
      await mkdir(newPath);
      setVersion(v => v + 1); // Trigger refresh
      // Auto-select and enter rename mode for the new folder
      setRenamingFile(newPath);
      setRenameText(newName);
      onSelectFiles(new Set([newPath]));
    } catch (error) {
      console.error('Failed to create folder:', error);
      setErrorDialogTitle('Create Folder Failed');
      setErrorDialogMessage('Could not create folder.');
      setErrorDialogDetails(String(error));
      setErrorDialogOpen(true);
    }
  };

  const canWriteToCurrentPath = useMemo(() => {
    if (!path) return false; // Disable in search view
    return checkPathPermission(path, editableFolders, readonlyFolders);
  }, [path, editableFolders, readonlyFolders]);

  const canExtractHere = useMemo(() => {
    if (selectedFiles.size !== 1 || !path) return false;
    const filePath = Array.from(selectedFiles)[0];
    if (!filePath.toLowerCase().endsWith('.zip')) return false;
    return checkPathPermission(path, editableFolders, readonlyFolders);
  }, [selectedFiles, path, editableFolders, readonlyFolders]);

  const canCompress = useMemo(() => {
    if (selectedFiles.size === 0 || !path) return false;
    return checkPathPermission(path, editableFolders, readonlyFolders);
  }, [selectedFiles, path, editableFolders, readonlyFolders]);

  const performDelete = async () => {
    if (selectedFiles.size === 0) return;
    const fullPaths = Array.from(selectedFiles);
    for (const p of fullPaths) {
      if (!checkPathPermission(p, editableFolders, readonlyFolders)) {
        showMessage('Permission Error', `You do not have permission to delete '${p}'.`);
        return;
      }
    }
    onDelete(fullPaths);
    // Note: We don't clear selection here immediately as we rely on refreshTrigger from parent
    // but we could optimistically clear it if needed.
  };

  const performCopy = () => {
    if (selectedFiles.size === 0) return;
    const fullPaths = Array.from(selectedFiles);
    onCopy(fullPaths);
  };

  const performCut = () => {
    if (selectedFiles.size === 0) return;
    for (const p of Array.from(selectedFiles)) {
      if (!checkPathPermission(p, editableFolders, readonlyFolders)) {
        showMessage('Permission Error', `You do not have permission to edit '${p}'.`);
        return;
      }
    }
    const fullPaths = Array.from(selectedFiles);
    onCut(fullPaths);
  };

  const performCompress = () => {
    if (selectedFiles.size === 0) return;

    (async () => {
      // 압축 파일 생성 위치: 첫 번째 선택된 파일의 부모 폴더
      const firstFile = Array.from(selectedFiles)[0];
      // const parentDir = await dirname(firstFile);

      // 기본 압축 파일명 설정
      let defaultName = "Archive.zip";
      if (selectedFiles.size === 1) {
        const name = await basename(firstFile);
        const extIndex = name.lastIndexOf('.');
        defaultName = (extIndex > 0 ? name.substring(0, extIndex) : name) + ".zip";
      } else {
        if (path) {
          const parentName = await basename(path);
          defaultName = `${parentName}.zip`;
        } else {
          defaultName = "Archive.zip";
        }
      }
      setCompressName(defaultName);
      setCompressMethod('deflated');
      setCompressPassword('');
      setCompressEncryption('zipcrypto');
      setCompressProgress(null);
      setCompressDialogOpen(true);
    })();
  };

  const performExtract = async () => {
    if (selectedFiles.size !== 1) return;
    const fullPath = Array.from(selectedFiles)[0];

    // Find file data in current list or search results
    const fileData = files.find(f => f.path === fullPath) || filesOverride?.find(f => f.path === fullPath);
    if (!fileData) return;

    if (!checkPathPermission(fullPath, editableFolders, readonlyFolders)) {
      showMessage('Permission Error', 'You do not have permission to extract here.');
      return;
    }

    try {
      // Check if ZIP requires a password
      const entries = await invoke<{ isEncrypted: boolean }[]>('list_zip_contents', { zipPath: fullPath });
      const isEncrypted = entries.some(e => e.isEncrypted);

      if (isEncrypted) {
        // If encrypted, open the Zip Content Dialog to handle password entry
        await openZipFile(fileData);
      } else {
        // If not encrypted, extract to the current directory in background
        const targetDir = await dirname(fullPath);
        await executeZipExtraction(fullPath, null, targetDir);
      }
    } catch (error) {
      // If metadata reading fails (e.g. encrypted headers), fallback to dialog
      await openZipFile(fileData);
    }

    setContextMenu(null);
  };

  const handleContextMenu = (e: React.MouseEvent, file?: FileData, index?: number) => {
    e.preventDefault();
    e.stopPropagation();

    if (file && index !== undefined) {
      // 선택되지 않은 파일 위에서 우클릭 시 해당 파일만 선택
      if (!selectedFiles.has(file.path)) {
        onSelectFiles(new Set([file.path]));
        setLastSelectedIndex(index);
        setAnchorIndex(index);
      }
      setContextMenu({ x: e.clientX, y: e.clientY, type: 'file' });
    } else {
      // 빈 공간 우클릭
      setContextMenu({ x: e.clientX, y: e.clientY, type: 'container' });
    }
  };

  const openZipFile = async (file: FileData) => {
    try {
      const entries = await invoke<{ name: string; isDir: boolean; size: number; isEncrypted: boolean }[]>('list_zip_contents', { zipPath: file.path });
      // Sort: Directories first
      entries.sort((a, b) => (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1) || a.name.localeCompare(b.name));
      setZipEntries(entries);
      setZipPath(file.path);

      const hasEncrypted = entries.some(e => e.isEncrypted);
      setIsZipEncrypted(hasEncrypted);
      setExtractPassword(''); // 목록 조회 시에는 암호를 사용하지 않으므로 초기화
      setShowPassword(false);
      setExtractError(null);

      if (path) {
        const zipName = file.name;
        const folderName = zipName.substring(0, zipName.lastIndexOf('.')) || zipName;
        const defaultPath = await join(path, folderName);
        setExtractPath(defaultPath);
      }

      setZipDialogOpen(true);
      setSelectedZipEntries(new Set());

    } catch (error) {
      console.error('Failed to list zip contents:', error);
      setExtractError(String(error));
      setIsZipEncrypted(true);
      setZipDialogOpen(true);
      setZipEntries([]);
      setZipPath(file.path);
      setShowPassword(false);
      // also show detailed modal
      setErrorDialogTitle('Failed to read ZIP contents');
      setErrorDialogMessage('An error occurred while reading the ZIP file content. It might be password protected. Please enter the password and try again.');
      setErrorDialogDetails(String(error));
      setErrorDialogOpen(true);
    }
  };

  const openItem = async (file: FileData) => {
    if (file.isDirectory) {
      onNavigate(file.path);
      return;
    }
    if (file.name.toLowerCase().endsWith('.zip')) {
      await openZipFile(file);
    } else if (file.name.toLowerCase().endsWith('.pdf')) {
      await openPdfInWindow({ path: file.path, name: file.name });
    } else {
      // console.log('Opening file:', file.path);
      await invoke('open_file', { path: file.path });
    }
  };

  const openItems = async (items: FileData[]) => {
    if (items.length === 1) {
      await openItem(items[0]);
      return;
    }
    for (const item of items) {
      if (item.isDirectory) continue;
      if (item.name.toLowerCase().endsWith('.zip')) {
        await openZipFile(item);
      } else if (item.name.toLowerCase().endsWith('.pdf')) {
        await openPdfInWindow({ path: item.path, name: item.name });
      } else {
        // console.log('Opening file:', item.path);
        await invoke('open_file', { path: item.path });
      }
    }
  };

  const handleFileDoubleClick = async (e: React.MouseEvent, file: FileData) => {
    e.stopPropagation();
    const selectedData = sortedFiles.filter(f => selectedFiles.has(f.path));
    if (selectedFiles.has(file.path) && selectedData.length > 1) {
      await openItems(selectedData);
    } else {
      await openItem(file);
    }
  };

  const handleZipEntryClick = (e: React.MouseEvent, entryName: string) => {
    e.stopPropagation();
    const newSelected = new Set(e.ctrlKey || e.metaKey ? selectedZipEntries : []);
    if (e.ctrlKey || e.metaKey) {
      if (newSelected.has(entryName)) newSelected.delete(entryName);
      else newSelected.add(entryName);
    } else {
      newSelected.add(entryName);
    }
    setSelectedZipEntries(newSelected);
  };

  const handleZipDragStart = (e: React.DragEvent, entryName: string) => {
    if (!zipPath) return;
    const files = selectedZipEntries.has(entryName) ? Array.from(selectedZipEntries) : [entryName];
    const data = JSON.stringify({
      action: 'extract_zip_files',
      zipPath: zipPath,
      files: files
    });
    e.dataTransfer.setData('application/json', data);
    e.dataTransfer.setData('text/plain', data); // 호환성을 위해 text/plain 추가
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleZipHeaderMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = zipDialogPos.x;
    const startTop = zipDialogPos.y;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      setZipDialogPos({ x: startLeft + dx, y: startTop + dy });
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleZipResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = zipDialogSize.width;
    const startHeight = zipDialogSize.height;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      setZipDialogSize({
        width: Math.max(300, startWidth + dx),
        height: Math.max(200, startHeight + dy)
      });
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleExtractProgressMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = extractProgressPos.x;
    const startTop = extractProgressPos.y;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      setExtractProgressPos({ x: startLeft + dx, y: startTop + dy });
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const executeZipExtraction = async (zipPath: string, files: string[] | null, targetDir: string, password?: string) => {
    console.log(`[Frontend] Extracting zip. Password provided: "${password || ''}"`);
    setExtractProgress({ total: 0, processed: 0, filename: 'Preparing...', startTime: Date.now() });
    let unlisten: UnlistenFn | undefined;

    try {
      unlisten = await listen<{ total: number; processed: number; filename: string }>('extract-progress', (event) => {
        setExtractProgress(prev => ({
          total: event.payload.total,
          processed: event.payload.processed,
          filename: event.payload.filename,
          startTime: prev ? prev.startTime : Date.now()
        }));
      });

      await invoke('extract_zip_files', {
        zipPath,
        files,
        targetDir,
        overwrite: false,
        password: password || null
      });
      setVersion(v => v + 1);
    } catch (error) {
      const errStr = String(error);
      if (errStr === 'FILE_EXISTS') {
        const confirmed = await confirm(
          'Some files already exist. Do you want to overwrite them?',
          { title: 'Confirm Overwrite', kind: 'warning' }
        );
        if (confirmed) {
          try {
            await invoke('extract_zip_files', {
              zipPath,
              files,
              targetDir,
              overwrite: true,
              password: password || null
            });
            setVersion(v => v + 1);
          } catch (e) {
            const estr = String(e);
            console.error('Extraction failed:', e);
            if (estr.includes('Password required') || estr.includes('Invalid password')) {
              setExtractError(estr);
            } else {
              setErrorDialogTitle('Extraction Failed');
              setErrorDialogMessage('An error occurred during extraction. Please check the details below.');
              setErrorDialogDetails(estr);
              setErrorDialogOpen(true);
            }
          }
        }
      } else {
        console.error('Extraction failed:', error);
        if (errStr.includes('Password required') || errStr.includes('Invalid password')) {
          setExtractError(errStr);
        } else {
          setErrorDialogTitle('Extraction Failed');
          setErrorDialogMessage('An error occurred during extraction. Please check the details below.');
          setErrorDialogDetails(errStr);
          setErrorDialogOpen(true);
        }
      }
    } finally {
      if (unlisten) unlisten();
      setExtractProgress(null);
    }
  };

  const handleContainerDrop = async (e: React.DragEvent, targetDir?: string) => {
    e.preventDefault();
    e.stopPropagation();
    const destPath = targetDir || path;
    if (!destPath) return;

    let dataString = e.dataTransfer.getData('application/json');
    if (!dataString) dataString = e.dataTransfer.getData('text/plain'); // fallback 확인
    if (!dataString) return;

    if (!checkPathPermission(destPath, editableFolders, readonlyFolders)) {
      await confirm('You do not have write permission for this folder.', { title: 'Permission Error', kind: 'error' });
      return;
    }
    try {
      const data = JSON.parse(dataString);
      if (data.action === 'extract_zip_files' && data.zipPath) {
        await executeZipExtraction(data.zipPath, data.files, destPath);
      } else if (data.paths && Array.isArray(data.paths) && onMove) {
        const op = (e.ctrlKey || e.metaKey) ? 'copy' : 'move';
        onMove(data.paths, destPath, op);
      }
    } catch (e) {
      // ignore
    }
  };

  const handleExtractSelectedClick = async () => {
    if (!zipPath || !path) return;
    if (selectedZipEntries.size === 0) {
      await confirm('Please select files to extract.', { title: 'Notification', kind: 'info' });
      return;
    }
    setExtractError(null);
    try {
      await executeZipExtraction(zipPath, Array.from(selectedZipEntries), extractPath || path, extractPassword);
    } catch (e) {
      const err = String(e);
      if (err.includes('Password required') || err.includes('Invalid password')) {
        setExtractError(err);
        // Keep ZIP dialog open so user can re-enter password
        setZipDialogOpen(true);
      } else {
        // show modal for other errors
        setErrorDialogTitle('Extraction Failed');
        setErrorDialogMessage('An error occurred during extraction. Please check the details below.');
        setErrorDialogDetails(err);
        setErrorDialogOpen(true);
      }
    }
  };

  const handleExtractAllClick = async () => {
    if (!zipPath || !path) return;
    // extractPath가 있으면 그곳으로, 없으면 현재 경로로
    const target = extractPath || path;
    setExtractError(null);
    try {
      await executeZipExtraction(zipPath, null, target, extractPassword);
    } catch (e) {
      const err = String(e);
      if (err.includes('Password required') || err.includes('Invalid password')) {
        setExtractError(err);
        setZipDialogOpen(true);
      } else {
        setErrorDialogTitle('Extraction Failed');
        setErrorDialogMessage('An error occurred during extraction. Please check the details below.');
        setErrorDialogDetails(err);
        setErrorDialogOpen(true);
      }
    }
  };

  const handleExecuteCompress = async () => {
    if (!path || !compressName) return;

    setCompressProgress({ total: 0, processed: 0, filename: 'Preparing...', startTime: Date.now() });

    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await listen<{ total: number; processed: number; filename: string }>('compress-progress', (event) => {
        setCompressProgress(prev => ({
          total: event.payload.total,
          processed: event.payload.processed,
          filename: event.payload.filename,
          startTime: prev ? prev.startTime : Date.now()
        }));
      });

      try {
        const fullPaths = Array.from(selectedFiles);
        const targetDir = await dirname(fullPaths[0]);
        const targetZipPath = await join(targetDir, compressName.endsWith('.zip') ? compressName : `${compressName}.zip`);

        await invoke('compress_files', {
          paths: fullPaths,
          targetZipPath,
          method: compressMethod,
          password: compressPassword || null,
          encryptionMode: compressEncryption
        });

        setCompressDialogOpen(false);
        setVersion(v => v + 1);

        // Verify that the resulting ZIP reflects encryption when a password was provided.
        if (compressPassword) {
          try {
            const entries = await invoke<{ name: string; isDir: boolean; size: number; isEncrypted: boolean }[]>('list_zip_contents', { zipPath: targetZipPath });
            const hasEncrypted = entries.some(e => e.isEncrypted);
            if (!hasEncrypted) {
              setErrorDialogTitle('Compression Password Warning');
              setErrorDialogMessage('A password was provided for compression, but the generated ZIP does not indicate encryption. If decryption is required, the password might not have been applied.');
              setErrorDialogDetails(`대상: ${targetZipPath}\n엔트리 수: ${entries.length}\n암호화된 엔트리: ${entries.filter(e => e.isEncrypted).length}`);
              setErrorDialogOpen(true);
            }
          } catch (e) {
            console.error('Failed to verify zip contents:', e);
            // Non-fatal: show details so user can inspect
            setErrorDialogTitle('Compression Verification Failed');
            setErrorDialogMessage('An error occurred while verifying the generated ZIP file content.');
            setErrorDialogDetails(String(e));
            setErrorDialogOpen(true);
          }
        }
      } catch (error) {
        console.error('Compression failed:', error);
        setErrorDialogTitle('Compression Failed');
        setErrorDialogMessage('An error occurred during file compression. Please check the details below.');
        setErrorDialogDetails(String(error));
        setErrorDialogOpen(true);
      } finally {
        if (unlisten) unlisten();
        setCompressProgress(null);
      }
    } catch (err) {
      // Listener setup failed
    }
  };

  const handleContainerDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = (e.ctrlKey || e.metaKey) ? 'copy' : 'move';
  };

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (renamingFile) return; // 이름 변경 중에는 키보드 네비게이션 중단
    if (e.key === 'Escape') {
      setContextMenu(null);
    }
    if (sortedFiles.length === 0) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      const selectedData = sortedFiles.filter(f => selectedFiles.has(f.path));

      // Ctrl+Enter: 새 창에서 열기
      if (e.ctrlKey || e.metaKey) {
        if (selectedData.length > 0) {
          onOpenInNewWindow(selectedData[0].path, selectedData[0].isDirectory);
        } else if (lastSelectedIndex !== null && sortedFiles[lastSelectedIndex]) {
          onOpenInNewWindow(sortedFiles[lastSelectedIndex].path, sortedFiles[lastSelectedIndex].isDirectory);
        }
        return;
      }

      if (selectedData.length > 0) {
        await openItems(selectedData);
      } else if (lastSelectedIndex !== null && sortedFiles[lastSelectedIndex]) {
        await openItem(sortedFiles[lastSelectedIndex]);
      }
      return;
    }

    if (e.key === 'F2' && selectedFiles.size === 1) {
      const filePath = Array.from(selectedFiles)[0];
      if (!checkPathPermission(filePath, editableFolders, readonlyFolders)) {
        e.preventDefault();
        showMessage('Permission Error', 'You do not have permission to rename this item.');
        return;
      }
      setRenamingFile(filePath);
      basename(filePath).then(name => setRenameText(name));
      return;
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      const allNames = new Set(sortedFiles.map(f => f.name));
      onSelectFiles(allNames);
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      setContextMenu(null);
      e.preventDefault();
      let newIndex = lastSelectedIndex === null ? -1 : lastSelectedIndex;

      if (e.key === 'ArrowDown') newIndex = Math.min(newIndex + 1, sortedFiles.length - 1);
      else newIndex = Math.max(newIndex - 1, 0);

      setLastSelectedIndex(newIndex);

      // Scroll into view
      const el = fileRefs.current.get(sortedFiles[newIndex].path);
      el?.scrollIntoView({ block: 'nearest' });

      if (e.shiftKey) {
        const startIdx = anchorIndex ?? lastSelectedIndex ?? newIndex;
        if (anchorIndex === null) setAnchorIndex(startIdx);

        const start = Math.min(startIdx, newIndex);
        const end = Math.max(startIdx, newIndex);
        const newSelected = new Set<string>();
        for (let i = start; i <= end; i++) {
          newSelected.add(sortedFiles[i].path);
        }
        onSelectFiles(newSelected);
      } else {
        onSelectFiles(new Set([sortedFiles[newIndex].path]));
        setAnchorIndex(newIndex);
      }
    }
  };

  const handleDragStart = (e: React.DragEvent, file: FileData) => {
    let filesToDrag = Array.from(selectedFiles);
    if (!selectedFiles.has(file.path)) {
      filesToDrag = [file.path];
    }

    const filesToDragObjects = files.filter(f => filesToDrag.includes(f.path));

    e.dataTransfer.setData('application/json', JSON.stringify({
      paths: filesToDrag,
      files: filesToDragObjects
    }));

    // 다른 앱(메모장, VSCode 등)으로 드래그 시 경로 텍스트 전달
    // 웹메일 등에서 파일 내용 대신 경로 텍스트가 입력되는 것을 방지하기 위해 text/plain 설정 제거
    // e.dataTransfer.setData('text/plain', filesToDrag.join('\n'));

    // 일부 앱(브라우저 등)을 위한 URI 리스트 전달
    const uriList = filesToDrag.map(p => {
      return 'file:///' + p.replace(/\\/g, '/');
    }).join('\r\n');
    e.dataTransfer.setData('text/uri-list', uriList);

    // Windows Explorer 등에서 단일 파일 드래그 지원을 위한 DownloadURL 설정 (Chromium 기반 Webview)
    if (filesToDrag.length === 1) {
      const filePath = filesToDrag[0];
      const fileName = filePath.split(/[/\\]/).pop() || 'file';
      const url = 'file:///' + filePath.replace(/\\/g, '/');
      e.dataTransfer.setData('DownloadURL', `application/octet-stream:${fileName}:${url}`);
    }

    e.dataTransfer.effectAllowed = 'copyMove';

    // 드래그 시각적 효과: 드래그 고스트 이미지 생성
    const dragGhost = document.createElement('div');
    dragGhost.style.padding = '5px 10px';
    dragGhost.style.background = '#007bff';
    dragGhost.style.color = 'white';
    dragGhost.style.borderRadius = '4px';
    dragGhost.style.fontSize = '12px';
    dragGhost.style.position = 'absolute';
    dragGhost.style.top = '-1000px';
    dragGhost.innerText = `📦 ${filesToDrag.length}개 항목 이동 중`;
    document.body.appendChild(dragGhost);
    e.dataTransfer.setDragImage(dragGhost, 0, 0);
    // 메인 스레드 완료 후 요소 삭제
    setTimeout(() => document.body.removeChild(dragGhost), 0);
  };

  const getMenuPosition = () => {
    if (!contextMenu) return {};
    const { x, y } = contextMenu;

    const style: any = {
      position: 'fixed',
      width: '180px',
      fontSize: '12px',
      zIndex: 1000,
    };

    // 화면 오른쪽/아래쪽 경계를 넘어가면 반대 방향으로 펼침
    if (x + 180 > window.innerWidth) {
      style.right = window.innerWidth - x;
    } else {
      style.left = x;
    }

    if (y + 250 > window.innerHeight) {
      style.bottom = window.innerHeight - y;
    } else {
      style.top = y;
    }

    return style;
  };

  // path가 없고 filesOverride도 없으면 안내 메시지
  if (!path && !filesOverride) return <div style={{ padding: '20px', color: '#888' }}>Select a folder to view files.</div>;

  const cellStyle = { padding: '0 8px', borderRight: '1px solid #eee', display: 'flex', alignItems: 'center', flexShrink: 0 } as const;

  const renderResizer = (colKey: string) => (
    <div
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: '12px',
        // right: '-6px',
        cursor: 'col-resize',
        zIndex: 10,
        opacity: 0,
      }}
      onMouseDown={(e) => handleResizeStart(e, colKey)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        handleFitToScreen();
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );

  const renderFilterPopup = (colKey: string) => {
    const isSize = colKey === 'size';
    const isDate = ['mtime', 'birthtime', 'atime'].includes(colKey);

    return (
      <div
        style={{
          position: 'absolute', top: '100%', left: 0, backgroundColor: 'white',
          border: '1px solid #ccc', padding: '10px', zIndex: 100,
          boxShadow: '0 4px 8px rgba(0,0,0,0.1)', minWidth: '220px',
          cursor: 'default', color: 'black', fontWeight: 'normal'
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* <div style={{ marginBottom: '8px', fontWeight: 'bold' }}>Filter: {colKey}</div> */}

        {isSize ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <select
              value={filterState.operator}
              onChange={e => setFilterState({ ...filterState, operator: e.target.value as any })}
              style={{ width: '100%', padding: '4px' }}
            >
              <option value="gt">Greater than (&gt;)</option>
              <option value="lt">Less than (&lt;)</option>
              <option value="range">Range</option>
            </select>
            <div style={{ display: 'flex', gap: '5px' }}>
              <input type="number" value={filterState.value} onChange={e => setFilterState({ ...filterState, value: e.target.value })} style={{ flex: 1, padding: '4px' }} placeholder="Size" />
              <select value={filterState.unit} onChange={e => setFilterState({ ...filterState, unit: Number(e.target.value) })} style={{ width: '60px' }}>
                <option value={1}>B</option>
                <option value={1024}>KB</option>
                <option value={1024 * 1024}>MB</option>
                <option value={1024 * 1024 * 1024}>GB</option>
              </select>
            </div>
            {filterState.operator === 'range' && (
              <input type="number" value={filterState.value2} onChange={e => setFilterState({ ...filterState, value2: e.target.value })} style={{ width: '100%', padding: '4px' }} placeholder="Max Size" />
            )}
          </div>
        ) : isDate ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <select
              value={filterState.operator}
              onChange={e => setFilterState({ ...filterState, operator: e.target.value as any })}
              style={{ width: '100%', padding: '4px' }}
            >
              <option value="after">After</option>
              <option value="before">Before</option>
              <option value="between">Between</option>
            </select>
            <input type="date" value={filterState.value} onChange={e => setFilterState({ ...filterState, value: e.target.value })} style={{ width: '100%', padding: '4px' }} />
            {filterState.operator === 'between' && (
              <input type="date" value={filterState.value2} onChange={e => setFilterState({ ...filterState, value2: e.target.value })} style={{ width: '100%', padding: '4px' }} />
            )}
          </div>
        ) : (
          <input
            type="text"
            value={filterState.value}
            onChange={e => setFilterState({ ...filterState, value: e.target.value })}
            placeholder="Contains..."
            style={{ width: '100%', padding: '4px', boxSizing: 'border-box' }}
            autoFocus
          />
        )}

        <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'flex-end', gap: '5px' }}>
          <button onClick={() => {
            const newFilters = { ...activeFilters };
            delete newFilters[colKey];
            setActiveFilters(newFilters);
            setOpenFilter(null);
          }}>Clear</button>
          <button onClick={() => {
            setActiveFilters({ ...activeFilters, [colKey]: filterState });
            setOpenFilter(null);
          }}>Apply</button>
        </div>
      </div>
    );
  };

  const renderHeaderCell = (colKey: string, label: string, align: 'left' | 'center' | 'right' = 'left') => {
    return (
      <div
        key={colKey}
        style={{ ...cellStyle, width: columnWidths[colKey], cursor: 'pointer', position: 'relative', overflow: 'visible' }}
        onClick={() => handleSort(colKey as SortKey)}
        onDoubleClick={() => handleAutoFit(colKey)}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('columnKey', colKey);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const sourceKey = e.dataTransfer.getData('columnKey');
          if (sourceKey && sourceKey !== colKey) {
            handleColumnReorder(sourceKey, colKey);
          }
        }}
        onContextMenu={handleHeaderContextMenu}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: align }}>
          {label} {sortConfig.key === colKey && (sortConfig.direction === 'asc' ? '▲' : '▼')}
        </span>
        <span
          onClick={(e) => handleOpenFilter(e, colKey)}
          style={{ marginLeft: '4px', padding: '0 4px', color: activeFilters[colKey] ? '#007bff' : '#ccc', fontWeight: 'bold' }}
          title="Filter"
        >
          Y
        </span>
        {renderResizer(colKey)}
        {openFilter === colKey && renderFilterPopup(colKey)}
      </div>
    );
  };

  const renderCell = (file: FileData, colKey: string) => {
    switch (colKey) {
      case 'name': return <><span style={{ marginRight: '8px' }}>{file.isDirectory ? '📁' : '📄'}</span><span title={file.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{file.name}</span></>;
      case 'size': return <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'right' }}>{formatSize(file.size, file.isDirectory)}</span>;
      case 'type': return <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{file.type}</span>;
      case 'birthtime': return <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'center' }}>{formatDate(file.birthtime)}</span>;
      case 'mtime': return <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'center' }}>{formatDate(file.mtime)}</span>;
      case 'atime': return <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'center' }}>{formatDate(file.atime)}</span>;
      case 'path': return <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{file.path}</span>;
      default: return null;
    }
  };

  return (
    <div
      style={{ padding: '0', height: '100%', width: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', outline: 'none' }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => handleContextMenu(e)}
      onFocus={onFocus}
      onDrop={handleContainerDrop}
      onDragOver={handleContainerDragOver}
    >
      <div
        ref={containerRef}
        style={{ flex: 1, overflowY: 'auto', overflowX: enableAutoResize ? 'hidden' : 'auto', position: 'relative', userSelect: 'none' }}
        onMouseDown={handleMouseDown}
      >
        <div
          style={{
            display: 'flex',
            fontWeight: 'bold',
            padding: '8px 0',
            borderBottom: '2px solid #eee',
            userSelect: 'none',
            fontSize: '0.9em',
            minWidth: 'fit-content',
            position: 'sticky',
            top: 0,
            backgroundColor: 'white',
            zIndex: 20
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={handleHeaderContextMenu}
        >
          {activeColumnSettings.map(col =>
            col.visible && renderHeaderCell(col.key, COLUMN_LABELS[col.key],
              col.key === 'size' ? 'right' : (['birthtime', 'mtime', 'atime'].includes(col.key) ? 'center' : 'left')
            )
          )}
        </div>

        {selectionRect && (
          <div style={{
            position: 'absolute',
            left: selectionRect.x,
            top: selectionRect.y,
            width: selectionRect.w,
            height: selectionRect.h,
            backgroundColor: 'rgba(0, 123, 255, 0.2)',
            border: '1px solid #007bff',
            pointerEvents: 'none',
            zIndex: 100
          }} />
        )}
        {sortedFiles.length === 0 ? (
          <div style={{ padding: '20px', color: '#888', textAlign: 'center' }}>
            {files.length > 0 && searchQuery ? 'No search results found.' : 'No files found.'}
          </div>
        ) : (
          <ul style={{ listStyleType: 'none', padding: 0, margin: 0 }}>
            {sortedFiles.map((file, index) => (
              <li
                key={file.path}
                ref={(el) => { if (el) fileRefs.current.set(file.path, el); }}
                onClick={(e) => handleFileClick(e, file, index)}
                onDoubleClick={(e) => handleFileDoubleClick(e, file)}
                onMouseDown={(e) => e.stopPropagation()}
                draggable
                onDragStart={(e) => handleDragStart(e, file)}
                onContextMenu={(e) => handleContextMenu(e, file, index)}
                onDragOver={(e) => {
                  if (file.isDirectory) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = (e.ctrlKey || e.metaKey) ? 'copy' : 'move';
                  }
                }}
                onDrop={(e) => {
                  if (file.isDirectory) handleContainerDrop(e, file.path);
                }}
                style={{
                  padding: '6px 0', borderBottom: '1px solid #f5f5f5', display: 'flex', alignItems: 'center', fontSize: '0.9em',
                  backgroundColor: selectedFiles.has(file.path) ? '#e6f3ff' : 'transparent',
                  cursor: 'default', minWidth: 'fit-content',
                  opacity: (clipboard?.op === 'move' && clipboard.paths.includes(file.path)) ? 0.5 : 1
                }}
              >
                {activeColumnSettings.map(col => col.visible && (
                  <div key={col.key} style={{ ...cellStyle, width: columnWidths[col.key], color: col.key === 'name' ? 'inherit' : '#666' }}>
                    {col.key === 'name' && renamingFile === file.path ? (
                      <input autoFocus value={renameText} onChange={(e) => setRenameText(e.target.value)}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenamingFile(null); }}
                        onBlur={handleRename} onClick={(e) => e.stopPropagation()} style={{ flex: 1 }}
                      />
                    ) : renderCell(file, col.key)}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>

      {contextMenu && (
        <div className="context-menu" style={getMenuPosition()}>
          {contextMenu.type === 'header' && (
            <>
              <div style={{ padding: '4px 10px', fontWeight: 'bold', color: '#666', borderBottom: '1px solid #eee', marginBottom: '4px' }}>Columns</div>
              {activeColumnSettings.map(col => (
                <div key={col.key} className="context-menu-item" onClick={() => toggleColumnVisibility(col.key)} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input type="checkbox" checked={col.visible} readOnly style={{ pointerEvents: 'none' }} />
                  <span>{COLUMN_LABELS[col.key]}</span>
                </div>
              ))}
            </>
          )}
          {contextMenu.type === 'file' && (
            <>
              <div className="context-menu-item" onClick={performCut} style={{ padding: '2px 10px' }}>
                <span>Cut</span> <span className="shortcut">Ctrl+X</span>
              </div>
              <div className="context-menu-item" onClick={performCopy} style={{ padding: '2px 10px' }}>
                <span>Copy</span> <span className="shortcut">Ctrl+C</span>
              </div>
              <div className={`context-menu-item ${selectedFiles.size !== 1 ? 'disabled' : ''}`} onClick={() => {
                if (selectedFiles.size === 1) {
                  const filePath = Array.from(selectedFiles)[0];
                  if (checkPathPermission(filePath, editableFolders, readonlyFolders)) {
                    (async () => {
                      setRenamingFile(filePath);
                      setRenameText(await basename(filePath));
                    })();
                  } else {
                    showMessage('Permission Error', 'You do not have permission to rename this item.');
                  }
                }
              }} style={{ padding: '2px 10px' }}>
                <span>Rename</span> <span className="shortcut">F2</span>
              </div>
              <div className="context-menu-item delete" onClick={performDelete} style={{ padding: '2px 10px' }}>
                <span>Delete</span> <span className="shortcut">Del</span>
              </div>
              <div className={`context-menu-item ${!canCompress ? 'disabled' : ''}`} onClick={canCompress ? performCompress : undefined} style={{ padding: '2px 10px' }}>
                <span>Compress</span>
              </div>
              <div className="context-menu-item" onClick={() => {
                if (selectedFiles.size > 0) {
                  const firstPath = Array.from(selectedFiles)[0];
                  const fileData = sortedFiles.find(f => f.path === firstPath) || filesOverride?.find(f => f.path === firstPath);
                  onOpenInNewWindow(firstPath, fileData?.isDirectory);
                }
                setContextMenu(null);
              }} style={{ padding: '2px 10px' }}>
                <span>Open in New Window</span> <span className="shortcut">Ctrl+Enter</span>
              </div>
              <div className="context-menu-item" onClick={() => {
                if (selectedFiles.size > 0) {
                  const firstPath = Array.from(selectedFiles)[0];
                  const fileData = sortedFiles.find(f => f.path === firstPath) || filesOverride?.find(f => f.path === firstPath);
                  onOpenInExplorer(firstPath, fileData?.isDirectory);
                }
                setContextMenu(null);
              }} style={{ padding: '2px 10px' }}>
                <span>Open in File Explorer</span>
              </div>
              {selectedFiles.size === 1 && Array.from(selectedFiles)[0].toLowerCase().endsWith('.zip') && (
                <div className={`context-menu-item ${!canExtractHere ? 'disabled' : ''}`} onClick={canExtractHere ? performExtract : undefined} style={{ padding: '2px 10px' }}>
                  <span>Extract Here</span>
                </div>
              )}
              <div style={{ borderTop: '1px solid #eee', margin: '4px 0' }}></div>
            </>
          )}
          {contextMenu.type !== 'header' && path && (
            <>
              <div className={`context-menu-item ${!canWriteToCurrentPath ? 'disabled' : ''}`} onClick={canWriteToCurrentPath ? handleCreateFolder : undefined} style={{ padding: '2px 10px' }}>
                <span>Create Folder</span>
              </div>
              {canPaste && (
                <div className={`context-menu-item ${!canWriteToCurrentPath ? 'disabled' : ''}`} onClick={() => {
                  if (canWriteToCurrentPath) onPaste(path);
                }} style={{ padding: '2px 10px' }}>
                  <span>Paste</span> <span className="shortcut">Ctrl+V</span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {zipDialogOpen && (
        <div style={{
          position: 'fixed', top: zipDialogPos.y, left: zipDialogPos.x,
          width: `${zipDialogSize.width}px`, height: `${zipDialogSize.height}px`,
          backgroundColor: 'white', zIndex: 1000,
          display: 'flex', flexDirection: 'column', borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)', overflow: 'hidden',
          border: '1px solid #ccc'
        }} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
          <div
            onMouseDown={handleZipHeaderMouseDown}
            style={{
              padding: '12px', borderBottom: '1px solid #eee',
              fontWeight: 'bold', display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', backgroundColor: '#f8f9fa', cursor: 'move'
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
              ZIP Content: {zipPath?.split(/[/\\]/).pop()}
            </span>
            <button
              onClick={() => setZipDialogOpen(false)}
              onMouseDown={(e) => e.stopPropagation()}
              style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '1.2em', padding: '0 8px' }}
            >×</button>
          </div>
          <div style={{ padding: '10px', borderBottom: '1px solid #eee', backgroundColor: '#fff', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontSize: '0.9em', fontWeight: 'bold', minWidth: '80px' }}>Extract to:</label>
              <input
                type="text"
                value={extractPath}
                onChange={(e) => setExtractPath(e.target.value)}
                style={{ flex: 1, padding: '4px', fontSize: '0.9em' }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontSize: '0.9em', fontWeight: 'bold', minWidth: '80px' }}>Password:</label>
              <div style={{ flex: 1, position: 'relative', display: 'flex' }}>
                <input
                  type={showPassword ? "text" : "password"}
                  value={extractPassword}
                  onChange={(e) => setExtractPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.stopPropagation();
                      handleExtractAllClick();
                    }
                  }}
                  disabled={!isZipEncrypted}
                  placeholder={isZipEncrypted ? "Enter password" : "No password"}
                  style={{ width: '100%', padding: '4px', paddingRight: '30px', fontSize: '0.9em', backgroundColor: isZipEncrypted ? 'white' : '#f0f0f0', boxSizing: 'border-box' }}
                />
                {isZipEncrypted && (
                  <button
                    onClick={() => setShowPassword(!showPassword)}
                    style={{
                      position: 'absolute',
                      right: '0',
                      top: '0',
                      bottom: '0',
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      padding: '0 8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    tabIndex={-1}
                    title={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? '🔒' : '👁️'}
                  </button>
                )}
              </div>
              {extractError && (
                <div style={{ color: '#c00', fontSize: '0.85em', marginTop: '6px' }}>
                  {extractError}
                </div>
              )}
            </div>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '0' }}>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {zipEntries.map((entry) => (
                <li
                  key={entry.name}
                  onClick={(e) => handleZipEntryClick(e, entry.name)}
                  draggable
                  onDragStart={(e) => handleZipDragStart(e, entry.name)}
                  style={{
                    padding: '8px 12px', borderBottom: '1px solid #f0f0f0',
                    backgroundColor: selectedZipEntries.has(entry.name) ? '#e6f3ff' : 'transparent',
                    cursor: 'default', display: 'flex', alignItems: 'center'
                  }}
                >
                  <span style={{ marginRight: '8px' }}>{entry.isDir ? '📁' : '📄'}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.name}
                    {entry.isEncrypted && <span style={{ marginLeft: '6px', fontSize: '0.8em' }}>🔒</span>}
                  </span>
                  <span style={{ color: '#888', fontSize: '0.9em' }}>{entry.isDir ? '' : formatSize(entry.size)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div style={{ padding: '10px', borderTop: '1px solid #eee', backgroundColor: '#f8f9fa', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85em', color: '#666', flex: 1 }}>
              Drag or click buttons to extract.
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handleExtractAllClick}
                style={{
                  padding: '6px 12px', cursor: 'pointer', backgroundColor: '#28a745', color: 'white',
                  border: 'none', borderRadius: '4px', fontSize: '0.9em'
                }}
              >
                Extract All
              </button>
              <button
                onClick={handleExtractSelectedClick}
                style={{
                  padding: '6px 12px', cursor: 'pointer', backgroundColor: '#007bff', color: 'white',
                  border: 'none', borderRadius: '4px', fontSize: '0.9em'
                }}
              >
                Extract Selected
              </button>
            </div>
          </div>
          <div
            onMouseDown={handleZipResizeMouseDown}
            style={{
              position: 'absolute', bottom: 0, right: 0,
              width: '16px', height: '16px',
              cursor: 'nwse-resize',
              zIndex: 10,
              display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end'
            }}
          >
            <div style={{ width: 0, height: 0, borderBottom: '10px solid #ccc', borderLeft: '10px solid transparent', margin: '2px' }}></div>
          </div>
        </div>
      )}

      {compressDialogOpen && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1100,
          display: 'flex', justifyContent: 'center', alignItems: 'center'
        }} onClick={() => setCompressDialogOpen(false)}>
          <div style={{
            backgroundColor: 'white', width: '400px', padding: '20px',
            borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            display: 'flex', flexDirection: 'column', gap: '15px'
          }} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
            <h3 style={{ margin: 0 }}>Compression Settings</h3>

            {compressProgress ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px 0' }}>
                <div style={{ fontSize: '0.9em', color: '#333' }}>
                  {compressProgress.total > 0
                    ? `${Math.round((compressProgress.processed / compressProgress.total) * 100)}% completed`
                    : 'Preparing...'}
                </div>
                <progress
                  value={compressProgress.processed}
                  max={compressProgress.total || 100}
                  style={{ width: '100%', height: '20px' }}
                />
                <div style={{ fontSize: '0.8em', color: '#666', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  Processing: {compressProgress.filename}
                </div>
                <div style={{ fontSize: '0.8em', color: '#666', textAlign: 'right' }}>
                  {(() => {
                    if (compressProgress.processed === 0 || compressProgress.total === 0) return 'Calculating...';
                    const elapsed = (Date.now() - compressProgress.startTime) / 1000;
                    const speed = compressProgress.processed / elapsed; // bytes per second
                    const remainingBytes = compressProgress.total - compressProgress.processed;
                    const remainingSeconds = remainingBytes / speed;
                    if (!isFinite(remainingSeconds)) return 'Calculating...';
                    return `Time remaining: approx ${Math.ceil(remainingSeconds)}s`;
                  })()}
                </div>
              </div>
            ) : (
              <>
                <div>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', fontSize: '0.9em' }}>Archive Name</label>
                  <input
                    type="text"
                    value={compressName}
                    onChange={(e) => setCompressName(e.target.value)}
                    style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
                    autoFocus
                  />
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', fontSize: '0.9em' }}>Compression Method</label>
                  <select
                    value={compressMethod}
                    onChange={(e) => setCompressMethod(e.target.value)}
                    style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
                  >
                    <option value="deflated">Deflate (Standard)</option>
                    <option value="stored">Store (No Compression)</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', fontSize: '0.9em' }}>Password (Optional)</label>
                  <input
                    type="password"
                    value={compressPassword}
                    onChange={(e) => setCompressPassword(e.target.value)}
                    style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
                    placeholder="Enter password to encrypt files"
                  />
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', fontSize: '0.9em' }}>Encryption Method</label>
                  <select
                    value={compressEncryption}
                    onChange={(e) => setCompressEncryption(e.target.value)}
                    style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
                    disabled={!compressPassword}
                  >
                    <option value="zipcrypto">ZipCrypto (Windows 기본 호환용)</option>
                    <option value="aes256">AES-256 (보안 강화)</option>
                  </select>
                  {compressPassword && (
                    <div style={{ fontSize: '0.75em', color: '#e11d48', marginTop: '4px', lineHeight: '1.4' }}>
                      {compressEncryption === 'zipcrypto' ? (
                        <span style={{ color: '#059669' }}>✔️ ZipCrypto is compatible with Windows standard Zip extractor.</span>
                      ) : (
                        <span>⚠️ AES-256 is more secure but incompatible with Windows built-in extractor. (Use 7-Zip/BandiZip)</span>
                      )}
                    </div>
                  )}
                </div>

                <div style={{ maxHeight: '100px', overflowY: 'auto', border: '1px solid #eee', padding: '5px', fontSize: '0.85em', color: '#666' }}>
                  <div>Target files ({selectedFiles.size}):</div>
                  {Array.from(selectedFiles).map(f => <div key={f}>{f}</div>)}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                  <button onClick={() => setCompressDialogOpen(false)} style={{ padding: '8px 16px', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={handleExecuteCompress} style={{ padding: '8px 16px', cursor: 'pointer', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px' }}>Compress</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {extractProgress && (
        <div style={{
          position: 'fixed', top: extractProgressPos.y, left: extractProgressPos.x,
          width: '350px', padding: '15px',
          backgroundColor: 'white', zIndex: 2000,
          borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          border: '1px solid #ccc',
          display: 'flex', flexDirection: 'column', gap: '10px',
          cursor: 'move'
        }} onMouseDown={handleExtractProgressMouseDown}>
          <h4 style={{ margin: 0, fontSize: '1em' }}>Extracting...</h4>
          <div style={{ fontSize: '0.9em', color: '#333' }}>
            {extractProgress.total > 0
              ? `${Math.round((extractProgress.processed / extractProgress.total) * 100)}% completed`
              : 'Preparing...'}
          </div>
          <progress
            value={extractProgress.processed}
            max={extractProgress.total || 100}
            style={{ width: '100%', height: '20px' }}
          />
          <div style={{ fontSize: '0.8em', color: '#666', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {extractProgress.filename}
          </div>
          <div style={{ fontSize: '0.8em', color: '#666', textAlign: 'right' }}>
            {(() => {
              if (extractProgress.processed === 0 || extractProgress.total === 0) return 'Calculating...';
              const elapsed = (Date.now() - extractProgress.startTime) / 1000;
              const speed = extractProgress.processed / elapsed;
              const remainingBytes = extractProgress.total - extractProgress.processed;
              const remainingSeconds = remainingBytes / speed;
              if (!isFinite(remainingSeconds)) return 'Calculating...';
              return `Time remaining: approx ${Math.ceil(remainingSeconds)}s`;
            })()}
          </div>
        </div>
      )}
      <ErrorDialog
        open={errorDialogOpen}
        title={errorDialogTitle}
        message={errorDialogMessage}
        details={errorDialogDetails}
        onClose={() => {
          setErrorDialogOpen(false);
          setErrorDialogDetails(undefined);
        }}
      />
      <MessageDialog
        open={msgDialogOpen}
        title={msgDialogTitle}
        message={msgDialogMessage}
        onClose={() => setMsgDialogOpen(false)}
      />
    </div>
  );
}

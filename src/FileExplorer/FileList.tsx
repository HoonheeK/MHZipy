import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { readDir, stat, rename } from '@tauri-apps/plugin-fs';
import { confirm } from '@tauri-apps/plugin-dialog';
import { join, basename } from '@tauri-apps/api/path';

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
  refreshTrigger?: number;
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

export default function FileList({ path, selectedFiles, onSelectFiles, onFocus, onNavigate, onCopy, onPaste, onCut, onDelete, onExtract, refreshTrigger }: FileListProps) {
  const [files, setFiles] = useState<FileData[]>([]);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'name',
    direction: 'asc',
  });
  const [version, setVersion] = useState(0); // 파일 목록 갱신용

  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; type: 'file' | 'container' } | null>(null);

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
  const [extractProgress, setExtractProgress] = useState<{ total: number; processed: number; filename: string; startTime: number } | null>(null);
  const [extractProgressPos, setExtractProgressPos] = useState({ x: 300, y: 300 });
  
  // Compress Dialog State
  const [compressDialogOpen, setCompressDialogOpen] = useState(false);
  const [compressName, setCompressName] = useState('');
  const [compressMethod, setCompressMethod] = useState('deflated');
  const [compressPassword, setCompressPassword] = useState('');
  const [compressProgress, setCompressProgress] = useState<{ total: number; processed: number; filename: string; startTime: number } | null>(null);

  // Column Resizing State
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    name: 250,
    size: 100,
    type: 120,
    birthtime: 150,
    mtime: 150,
    atime: 150
  });
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);

  // Drag Selection State
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  useEffect(() => {
    if (!path) return;
    setLastSelectedIndex(null);
    setAnchorIndex(null);
    let isMounted = true;

    const loadFiles = async () => {
      try {
        const entries = await readDir(path);
        if (!isMounted) return;

        const filesWithStats = await Promise.all(
          entries.map(async (entry) => {
            let fullPath = '';
            try {
              fullPath = await join(path, entry.name);
              const metadata = await stat(fullPath);
              const isDir = entry.isDirectory;
              const extension = isDir ? '' : (entry.name.split('.').pop() || '');
              const type = isDir ? 'File folder' : (extension ? `${extension.toUpperCase()} File` : 'File');
              
              return {
                name: entry.name,
                path: fullPath,
                size: metadata.size,
                extension,
                type,
                mtime: metadata.mtime ? new Date(metadata.mtime) : null,
                birthtime: metadata.birthtime ? new Date(metadata.birthtime) : null,
                atime: metadata.atime ? new Date(metadata.atime) : null,
                readonly: metadata.readonly,
                isDirectory: isDir,
              };
            } catch (error) {
              return { 
                name: entry.name, 
                path: fullPath, 
                size: 0, 
                extension: '', 
                type: '', 
                mtime: null, 
                birthtime: null, 
                atime: null, 
                readonly: false,
                isDirectory: entry.isDirectory
              };
            }
          })
        );

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
  }, [path, version, refreshTrigger]);

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

  const handleAutoFit = (colKey: string) => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;
    context.font = '0.9em sans-serif'; // CSS 폰트와 유사하게 설정

    let maxWidth = context.measureText(colKey).width + 30; // 헤더 텍스트 + 여백

    files.forEach(file => {
      let text = '';
      switch (colKey) {
        case 'name': text = file.name; break;
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

  const handleSort = (key: SortKey) => {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  const sortedFiles = [...files].sort((a, b) => {
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
    if (e.shiftKey && (anchorIndex !== null || lastSelectedIndex !== null)) {
      const startIdx = anchorIndex ?? lastSelectedIndex ?? index;
      const start = Math.min(startIdx, index);
      const end = Math.max(startIdx, index);
      for (let i = start; i <= end; i++) {
        newSelected.add(sortedFiles[i].name);
      }
      setLastSelectedIndex(index); // 포커스 이동, 앵커 유지
    } else {
      // 일반 클릭 또는 Ctrl 클릭
      if (isMulti) {
        if (newSelected.has(file.name)) newSelected.delete(file.name);
        else newSelected.add(file.name);
      } else {
        newSelected.add(file.name);
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
        x: e.clientX - rect.left + containerRef.current.scrollLeft,
        y: e.clientY - rect.top + containerRef.current.scrollTop
      };
      setIsSelecting(true);
      onSelectFiles(new Set()); // Clear selection on drag start
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isSelecting || !dragStartRef.current || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const currentX = e.clientX - rect.left + containerRef.current.scrollLeft;
      const currentY = e.clientY - rect.top + containerRef.current.scrollTop;

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
        const el = fileRefs.current.get(file.name);
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
            newSelected.add(file.name);
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
    if (!path || !renamingFile || !renameText || renamingFile === renameText) {
      setRenamingFile(null);
      return;
    }
    try {
      const oldPath = await join(path, renamingFile);
      const newPath = await join(path, renameText);
      await rename(oldPath, newPath);
      setVersion(v => v + 1);
    } catch (error) {
      console.error('Failed to rename:', error);
    } finally {
      setRenamingFile(null);
    }
  };

  const performDelete = async () => {
    if (!path || selectedFiles.size === 0) return;
    const fullPaths = await Promise.all(Array.from(selectedFiles).map(name => join(path, name)));
    onDelete(fullPaths);
    // Note: We don't clear selection here immediately as we rely on refreshTrigger from parent
    // but we could optimistically clear it if needed.
  };

  const performCopy = () => {
    if (!path) return;
    (async () => {
       const fullPaths = await Promise.all(Array.from(selectedFiles).map(name => join(path, name)));
       onCopy(fullPaths);
    })();
  };

  const performCut = () => {
    if (!path) return;
    (async () => {
       const fullPaths = await Promise.all(Array.from(selectedFiles).map(name => join(path, name)));
       onCut(fullPaths);
    })();
  };

  const performCompress = () => {
    if (!path) return;
    if (selectedFiles.size === 0) return;

    (async () => {
      // 기본 압축 파일명 설정
      let defaultName = "Archive.zip";
      if (selectedFiles.size === 1) {
        const name = Array.from(selectedFiles)[0];
        const extIndex = name.lastIndexOf('.');
        defaultName = (extIndex > 0 ? name.substring(0, extIndex) : name) + ".zip";
      } else {
        const parentName = await basename(path);
        defaultName = `${parentName}.zip`;
      }
      setCompressName(defaultName);
      setCompressMethod('deflated');
      setCompressPassword('');
      setCompressProgress(null);
      setCompressDialogOpen(true);
    })();
  };

  const performExtract = () => {
    if (!path || selectedFiles.size !== 1) return;
    (async () => {
       const fileName = Array.from(selectedFiles)[0];
       const fullPath = await join(path, fileName);
       onExtract(fullPath);
    })();
  };

  const handleContextMenu = (e: React.MouseEvent, file?: FileData, index?: number) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (file && index !== undefined) {
      // 선택되지 않은 파일 위에서 우클릭 시 해당 파일만 선택
      if (!selectedFiles.has(file.name)) {
        onSelectFiles(new Set([file.name]));
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
      await confirm(`ZIP 파일 내용을 읽을 수 없습니다.\n${String(error)}`, { title: '오류', kind: 'error' });
    }
  };

  const handleFileDoubleClick = async (e: React.MouseEvent, file: FileData) => {
    if (file.isDirectory) {
      e.stopPropagation();
      onNavigate(file.path);
      return;
    }
    if (file.name.toLowerCase().endsWith('.zip')) {
      e.stopPropagation();
      await openZipFile(file);
    } else {
      e.stopPropagation();
      console.log('Opening file:', file.path);
      await invoke('open_file', { path: file.path });
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
    setExtractProgress({ total: 0, processed: 0, filename: '준비 중...', startTime: Date.now() });
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
      if (error === 'FILE_EXISTS') {
        const confirmed = await confirm(
          '일부 파일이 이미 존재합니다. 덮어쓰시겠습니까?',
          { title: '파일 덮어쓰기 확인', kind: 'warning' }
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
            console.error('Extraction failed:', e);
            await confirm(`압축 해제 실패: ${String(e)}`, { title: '오류', kind: 'error' });
          }
        }
      } else {
        console.error('Extraction failed:', error);
        await confirm(`압축 해제 실패: ${String(error)}`, { title: '오류', kind: 'error' });
      }
    } finally {
      if (unlisten) unlisten();
      setExtractProgress(null);
    }
  };

  const handleContainerDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    let dataString = e.dataTransfer.getData('application/json');
    if (!dataString) dataString = e.dataTransfer.getData('text/plain'); // fallback 확인
    if (!dataString) return;

    try {
      const data = JSON.parse(dataString);
      if (data.action === 'extract_zip_files' && data.zipPath && path) {
        await executeZipExtraction(data.zipPath, data.files, path);
      }
    } catch (e) {
      // ignore
    }
  };

  const handleExtractSelectedClick = async () => {
    if (!zipPath || !path) return;
    if (selectedZipEntries.size === 0) {
      await confirm('추출할 파일을 선택해주세요.', { title: '알림', kind: 'info' });
      return;
    }
    await executeZipExtraction(zipPath, Array.from(selectedZipEntries), extractPath || path, extractPassword);
  };

  const handleExtractAllClick = async () => {
    if (!zipPath || !path) return;
    // extractPath가 있으면 그곳으로, 없으면 현재 경로로
    const target = extractPath || path;
    await executeZipExtraction(zipPath, null, target, extractPassword);
  };

  const handleExecuteCompress = async () => {
    if (!path || !compressName) return;
    
    setCompressProgress({ total: 0, processed: 0, filename: '준비 중...', startTime: Date.now() });
    
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
      const fullPaths = await Promise.all(Array.from(selectedFiles).map(name => join(path, name)));
      const targetZipPath = await join(path, compressName.endsWith('.zip') ? compressName : `${compressName}.zip`);
      
      await invoke('compress_files', { 
        paths: fullPaths, 
        targetZipPath, 
        method: compressMethod,
        password: compressPassword || null
      });
      
      setCompressDialogOpen(false);
      setVersion(v => v + 1);
    } catch (error) {
      console.error('Compression failed:', error);
      await confirm(`압축 실패: ${String(error)}`, { title: '오류', kind: 'error' });
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
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (renamingFile) return; // 이름 변경 중에는 키보드 네비게이션 중단
    if (e.key === 'Escape') {
      setContextMenu(null);
    }
    if (sortedFiles.length === 0) return;

    if (e.key === 'F2' && selectedFiles.size === 1) {
      const fileName = Array.from(selectedFiles)[0];
      setRenamingFile(fileName);
      setRenameText(fileName);
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
      const el = fileRefs.current.get(sortedFiles[newIndex].name);
      el?.scrollIntoView({ block: 'nearest' });

      if (e.shiftKey) {
        const startIdx = anchorIndex ?? lastSelectedIndex ?? newIndex;
        if (anchorIndex === null) setAnchorIndex(startIdx);
        
        const start = Math.min(startIdx, newIndex);
        const end = Math.max(startIdx, newIndex);
        const newSelected = new Set<string>();
        for (let i = start; i <= end; i++) {
          newSelected.add(sortedFiles[i].name);
        }
        onSelectFiles(newSelected);
      } else {
        onSelectFiles(new Set([sortedFiles[newIndex].name]));
        setAnchorIndex(newIndex);
      }
    }
  };

  const handleDragStart = (e: React.DragEvent, file: FileData) => {
    if (!path) return;
    // If dragging a file not in selection, select it (optional, but standard behavior usually)
    // If dragging selection, drag all.
    let filesToDrag = Array.from(selectedFiles);
    if (!selectedFiles.has(file.name)) {
      filesToDrag = [file.name];
    }
    
    // We need full paths. Since we can't await, we construct them manually or hope receiver handles it.
    // But FolderTree expects full paths.
    // We can use a synchronous approximation or just the names and source dir?
    // Let's try to send full paths assuming standard separator or just send names and source.
    // But FolderTree logic uses `onMove(paths)`.
    // Let's construct paths.
    // Note: This might be OS specific separator issue if we hardcode.
    // But we can't await `join` here.
    // Let's use a trick: send the source dir and filenames, let receiver join?
    // Or just hardcode separator based on navigator.platform?
    // Let's try to use the `path` prop which is `C:\...`.
    const separator = path.includes('\\') ? '\\' : '/';
    const fullPaths = filesToDrag.map(name => `${path}${path.endsWith(separator) ? '' : separator}${name}`);
    
    e.dataTransfer.setData('application/json', JSON.stringify({ paths: fullPaths }));
    e.dataTransfer.effectAllowed = 'copyMove';
  };

  if (!path) return <div style={{ padding: '20px', color: '#888' }}>폴더를 선택하여 파일을 확인하세요.</div>;

  const cellStyle = { padding: '0 8px', borderRight: '1px solid #eee', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 } as const;

  const renderResizer = (colKey: string) => (
    <div
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: '4px',
        cursor: 'col-resize',
        zIndex: 10,
      }}
      onMouseDown={(e) => handleResizeStart(e, colKey)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        handleAutoFit(colKey);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );

  return (
    <div 
      style={{ padding: '0', height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', outline: 'none' }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => handleContextMenu(e)}
      onFocus={onFocus}
      onDrop={handleContainerDrop}
      onDragOver={handleContainerDragOver}
    >
      <div 
        ref={containerRef}
        style={{ flex: 1, overflow: 'auto', position: 'relative', userSelect: 'none' }}
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
        >
          <div style={{ ...cellStyle, width: columnWidths.name, cursor: 'pointer', display: 'flex', alignItems: 'center', position: 'relative' }} onClick={() => handleSort('name')}>
            이름 {sortConfig.key === 'name' && (sortConfig.direction === 'asc' ? '▲' : '▼')}
            {renderResizer('name')}
          </div>
          <div style={{ ...cellStyle, width: columnWidths.size, cursor: 'pointer', textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', position: 'relative' }} onClick={() => handleSort('size')}>
            크기 {sortConfig.key === 'size' && (sortConfig.direction === 'asc' ? '▲' : '▼')}
            {renderResizer('size')}
          </div>
          <div style={{ ...cellStyle, width: columnWidths.type, cursor: 'pointer', display: 'flex', alignItems: 'center', position: 'relative' }} onClick={() => handleSort('type')}>
            Type {sortConfig.key === 'type' && (sortConfig.direction === 'asc' ? '▲' : '▼')}
            {renderResizer('type')}
          </div>
          <div style={{ ...cellStyle, width: columnWidths.birthtime, cursor: 'pointer', textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', position: 'relative' }} onClick={() => handleSort('birthtime')}>
            Date Created {sortConfig.key === 'birthtime' && (sortConfig.direction === 'asc' ? '▲' : '▼')}
            {renderResizer('birthtime')}
          </div>
          <div style={{ ...cellStyle, width: columnWidths.mtime, cursor: 'pointer', textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', position: 'relative' }} onClick={() => handleSort('mtime')}>
            Date Modified {sortConfig.key === 'mtime' && (sortConfig.direction === 'asc' ? '▲' : '▼')}
            {renderResizer('mtime')}
          </div>
          <div style={{ ...cellStyle, width: columnWidths.atime, cursor: 'pointer', textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', borderRight: 'none', position: 'relative' }} onClick={() => handleSort('atime')}>
            Date Accessed {sortConfig.key === 'atime' && (sortConfig.direction === 'asc' ? '▲' : '▼')}
            {renderResizer('atime')}
          </div>
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
          <div style={{ padding: '20px', color: '#888', textAlign: 'center' }}>파일이 없습니다.</div>
        ) : (
          <ul style={{ listStyleType: 'none', padding: 0, margin: 0 }}>
            {sortedFiles.map((file, index) => (
              <li 
                key={file.name} 
                ref={(el) => { if (el) fileRefs.current.set(file.name, el); }}
                onClick={(e) => handleFileClick(e, file, index)}
                onDoubleClick={(e) => handleFileDoubleClick(e, file)}
                onMouseDown={(e) => e.stopPropagation()}
                draggable
                onDragStart={(e) => handleDragStart(e, file)}
                onContextMenu={(e) => handleContextMenu(e, file, index)}
                style={{ 
                  padding: '6px 0', borderBottom: '1px solid #f5f5f5', display: 'flex', alignItems: 'center', fontSize: '0.9em',
                  backgroundColor: selectedFiles.has(file.name) ? '#e6f3ff' : 'transparent',
                  cursor: 'default', minWidth: 'fit-content'
                }}
              >
                <div style={{ ...cellStyle, width: columnWidths.name, display: 'flex', alignItems: 'center' }}>
                  <span style={{ marginRight: '8px' }}>{file.isDirectory ? '📁' : '📄'}</span>
                  {renamingFile === file.name ? (
                    <input
                      autoFocus
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') handleRename();
                        if (e.key === 'Escape') setRenamingFile(null);
                      }}
                      onBlur={handleRename}
                      onClick={(e) => e.stopPropagation()}
                      style={{ flex: 1 }}
                    />
                  ) : (
                    <span title={file.name}>{file.name}</span>
                  )}
                </div>
                <div style={{ ...cellStyle, width: columnWidths.size, textAlign: 'right', color: '#666' }}>
                  {formatSize(file.size, file.isDirectory)}
                </div>
                <div style={{ ...cellStyle, width: columnWidths.type, color: '#666' }}>
                  {file.type}
                </div>
                <div style={{ ...cellStyle, width: columnWidths.birthtime, textAlign: 'right', color: '#666' }}>
                  {formatDate(file.birthtime)}
                </div>
                <div style={{ ...cellStyle, width: columnWidths.mtime, textAlign: 'right', color: '#666' }}>
                  {formatDate(file.mtime)}
                </div>
                <div style={{ ...cellStyle, width: columnWidths.atime, textAlign: 'right', color: '#666' }}>
                  {formatDate(file.atime)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      
      {contextMenu && (
        <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
          {contextMenu.type === 'file' && (
            <>
              <div className="context-menu-item" onClick={performCut}>
                <span>잘라내기</span> <span className="shortcut">Ctrl+X</span>
              </div>
              <div className="context-menu-item" onClick={performCopy}>
                <span>복사</span> <span className="shortcut">Ctrl+C</span>
              </div>
              <div className="context-menu-item" onClick={() => {
                if (selectedFiles.size === 1) {
                  const fileName = Array.from(selectedFiles)[0];
                  setRenamingFile(fileName);
                  setRenameText(fileName);
                }
              }}>
                <span>이름 변경</span> <span className="shortcut">F2</span>
              </div>
              <div className="context-menu-item delete" onClick={performDelete}>
                <span>삭제</span> <span className="shortcut">Del</span>
              </div>
              <div className="context-menu-item" onClick={performCompress}>
                <span>압축하기</span>
              </div>
              {selectedFiles.size === 1 && Array.from(selectedFiles)[0].toLowerCase().endsWith('.zip') && (
                <div className="context-menu-item" onClick={performExtract}>
                  <span>여기에 풀기</span>
                </div>
              )}
              <div style={{ borderTop: '1px solid #eee', margin: '4px 0' }}></div>
            </>
          )}
          <div className="context-menu-item" onClick={() => {
            if (path) onPaste(path);
          }}>
            <span>붙여넣기</span> <span className="shortcut">Ctrl+V</span>
          </div>
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
        }} onClick={e => e.stopPropagation()}>
          <div 
            onMouseDown={handleZipHeaderMouseDown}
            style={{ 
              padding: '12px', borderBottom: '1px solid #eee', 
              fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', 
              alignItems: 'center', backgroundColor: '#f8f9fa', cursor: 'move' 
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
              ZIP 내용: {zipPath?.split(/[/\\]/).pop()}
            </span>
            <button 
              onClick={() => setZipDialogOpen(false)} 
              onMouseDown={(e) => e.stopPropagation()}
              style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '1.2em', padding: '0 8px' }}
            >×</button>
          </div>
            <div style={{ padding: '10px', borderBottom: '1px solid #eee', backgroundColor: '#fff', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <label style={{ fontSize: '0.9em', fontWeight: 'bold', minWidth: '80px' }}>풀릴 위치:</label>
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
                    disabled={!isZipEncrypted}
                    placeholder={isZipEncrypted ? "암호를 입력하세요" : "암호 없음"}
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
                      title={showPassword ? "암호 숨기기" : "암호 보이기"}
                    >
                      {showPassword ? '🔒' : '👁️'}
                    </button>
                  )}
                </div>
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
                드래그하거나 버튼을 눌러 추출하세요.
              </span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button 
                  onClick={handleExtractAllClick}
                  style={{
                    padding: '6px 12px', cursor: 'pointer', backgroundColor: '#28a745', color: 'white',
                    border: 'none', borderRadius: '4px', fontSize: '0.9em'
                  }}
                >
                  모든 항목 추출
                </button>
                <button 
                  onClick={handleExtractSelectedClick}
                  style={{
                    padding: '6px 12px', cursor: 'pointer', backgroundColor: '#007bff', color: 'white',
                    border: 'none', borderRadius: '4px', fontSize: '0.9em'
                  }}
                >
                  선택 항목 추출
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
          }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: 0 }}>압축 설정</h3>
            
            {compressProgress ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px 0' }}>
                <div style={{ fontSize: '0.9em', color: '#333' }}>
                  {compressProgress.total > 0 
                    ? `${Math.round((compressProgress.processed / compressProgress.total) * 100)}% 완료` 
                    : '준비 중...'}
                </div>
                <progress 
                  value={compressProgress.processed} 
                  max={compressProgress.total || 100} 
                  style={{ width: '100%', height: '20px' }} 
                />
                <div style={{ fontSize: '0.8em', color: '#666', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  처리 중: {compressProgress.filename}
                </div>
                <div style={{ fontSize: '0.8em', color: '#666', textAlign: 'right' }}>
                  {(() => {
                    if (compressProgress.processed === 0 || compressProgress.total === 0) return '계산 중...';
                    const elapsed = (Date.now() - compressProgress.startTime) / 1000;
                    const speed = compressProgress.processed / elapsed; // bytes per second
                    const remainingBytes = compressProgress.total - compressProgress.processed;
                    const remainingSeconds = remainingBytes / speed;
                    if (!isFinite(remainingSeconds)) return '계산 중...';
                    return `남은 시간: 약 ${Math.ceil(remainingSeconds)}초`;
                  })()}
                </div>
              </div>
            ) : (
            <>
            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', fontSize: '0.9em' }}>압축 파일 이름</label>
              <input 
                type="text" 
                value={compressName} 
                onChange={(e) => setCompressName(e.target.value)}
                style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
                autoFocus
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', fontSize: '0.9em' }}>압축 방식</label>
              <select 
                value={compressMethod} 
                onChange={(e) => setCompressMethod(e.target.value)}
                style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
              >
                <option value="deflated">Deflate (표준)</option>
                <option value="stored">Store (압축 안 함)</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', fontSize: '0.9em' }}>암호 (선택 사항)</label>
              <input 
                type="password" 
                value={compressPassword} 
                onChange={(e) => setCompressPassword(e.target.value)}
                style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
                placeholder="암호를 입력하면 파일이 암호화됩니다"
              />
            </div>

            <div style={{ maxHeight: '100px', overflowY: 'auto', border: '1px solid #eee', padding: '5px', fontSize: '0.85em', color: '#666' }}>
              <div>대상 파일 ({selectedFiles.size}개):</div>
              {Array.from(selectedFiles).map(f => <div key={f}>{f}</div>)}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button onClick={() => setCompressDialogOpen(false)} style={{ padding: '8px 16px', cursor: 'pointer' }}>취소</button>
              <button onClick={handleExecuteCompress} style={{ padding: '8px 16px', cursor: 'pointer', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px' }}>압축하기</button>
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
          <h4 style={{ margin: 0, fontSize: '1em' }}>압축 해제 중...</h4>
          <div style={{ fontSize: '0.9em', color: '#333' }}>
            {extractProgress.total > 0 
              ? `${Math.round((extractProgress.processed / extractProgress.total) * 100)}% 완료` 
              : '준비 중...'}
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
              if (extractProgress.processed === 0 || extractProgress.total === 0) return '계산 중...';
              const elapsed = (Date.now() - extractProgress.startTime) / 1000;
              const speed = extractProgress.processed / elapsed;
              const remainingBytes = extractProgress.total - extractProgress.processed;
              const remainingSeconds = remainingBytes / speed;
              if (!isFinite(remainingSeconds)) return '계산 중...';
              return `남은 시간: 약 ${Math.ceil(remainingSeconds)}초`;
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

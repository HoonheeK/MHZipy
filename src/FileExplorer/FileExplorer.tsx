import { useState, useEffect, useRef } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { dirname } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import FolderTree from "./FolderTree";
import FileList from "./FileList";
import SearchView from "../SearchView/SearchView";
import { deleteFiles, pasteFiles, checkPathPermission } from '../command/fileOperations';
import "./FileExplorer.css";

interface FileExplorerProps {
  config: { defaultPath: string; quickAccess: string[]; sidebarWidth?: number; expandedPaths?: string[]; quickAccessHeight?: number; view?: 'folder' | 'search'; editableFolders?: string[]; readonlyFolders?: string[] };
  onSaveConfig: (updates: Partial<{ defaultPath: string; quickAccess: string[]; sidebarWidth?: number; expandedPaths?: string[]; quickAccessHeight?: number; view?: 'folder' | 'search'; editableFolders?: string[]; readonlyFolders?: string[] }>) => void;
  currentView: 'folder' | 'search';
  searchQuery?: string;
}

export default function FileExplorer({ config, onSaveConfig, currentView, searchQuery }: FileExplorerProps) {
  const [selected, setSelected] = useState<string>(config.defaultPath || "C:");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set([config.defaultPath || "C:"]));
  const [filesSelected, setFilesSelected] = useState<Set<string>>(new Set());
  const [activePane, setActivePane] = useState<'tree' | 'list'>('tree');
  const [pathInput, setPathInput] = useState(config.defaultPath || "C:");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; source?: 'tree' | 'quickAccess' } | null>(null);
  const [clipboard, setClipboard] = useState<{ paths: string[]; op: 'copy' | 'move' } | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(config.sidebarWidth || 260);
  const [quickAccessHeight, setQuickAccessHeight] = useState(config.quickAccessHeight || 200);
  const [isResizing, setIsResizing] = useState(false);
  const [isResizingQuickAccess, setIsResizingQuickAccess] = useState(false);

  const sidebarWidthRef = useRef(sidebarWidth);
  const quickAccessHeightRef = useRef(quickAccessHeight);
  const quickAccessRef = useRef<HTMLDivElement>(null);

  useEffect(() => { sidebarWidthRef.current = sidebarWidth; }, [sidebarWidth]);
  useEffect(() => { quickAccessHeightRef.current = quickAccessHeight; }, [quickAccessHeight]);

  // Props로부터 expandedPaths 초기화 및 관리
  const expandedPaths = new Set(config.expandedPaths || ["C:\\"]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    if (contextMenu) {
      window.addEventListener('click', closeMenu);
    }
    return () => window.removeEventListener('click', closeMenu);
  }, [contextMenu]);

  useEffect(() => {
    setFilesSelected(new Set());
  }, [selected]);

  useEffect(() => {
    setPathInput(selected);
  }, [selected]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing) {
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

  const handlePathInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPathInput(e.target.value);
  };

  const handlePathInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      setSelected(pathInput);
      setSelectedPaths(new Set([pathInput]));
    }
  };

  const handleSetDefault = (path: string) => {
    onSaveConfig({ defaultPath: path });
  };

  const handleAddToQuickAccess = (path: string) => {
    if (!config.quickAccess.includes(path)) {
      onSaveConfig({ quickAccess: [...config.quickAccess, path] });
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
    setContextMenu({ x: e.clientX, y: e.clientY, path, source: 'tree' });
  };

  const handleQuickAccessContextMenu = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, path, source: 'quickAccess' });
  };

  const handleCopy = (paths: string[]) => {
    setClipboard({ paths, op: 'copy' });
  };

  const handleCut = (paths: string[]) => {
    // Check permission for source paths (need delete permission)
    for (const path of paths) {
      if (!checkPathPermission(path, config.editableFolders, config.readonlyFolders)) {
        confirm(`'${path}'에 대한 편집 권한이 없습니다.`, { title: '권한 오류', kind: 'error' });
        return;
      }
    }
    setClipboard({ paths, op: 'move' });
  };

  const handlePaste = async (targetDir: string) => {
    if (!checkPathPermission(targetDir, config.editableFolders, config.readonlyFolders)) {
      await confirm(`'${targetDir}'에 대한 쓰기 권한이 없습니다.`, { title: '권한 오류', kind: 'error' });
      return;
    }
    if (!clipboard || !clipboard.paths.length) return;
    
    const success = await pasteFiles(clipboard.paths, targetDir, clipboard.op);
    if (success) {
      if (clipboard.op === 'move') setClipboard(null);
      setRefreshTrigger(p => p + 1);
    }
  };

  const handleDelete = async (paths: string[]) => {
    for (const path of paths) {
      if (!checkPathPermission(path, config.editableFolders, config.readonlyFolders)) {
        await confirm(`'${path}'에 대한 삭제 권한이 없습니다.`, { title: '권한 오류', kind: 'error' });
        return;
      }
    }
    const success = await deleteFiles(paths);
    if (success) {
      setRefreshTrigger(p => p + 1);
    }
  };

  const handleMove = async (sourcePaths: string[], targetDir: string, op: 'move' | 'copy') => {
    if (!checkPathPermission(targetDir, config.editableFolders, config.readonlyFolders)) {
      await confirm(`'${targetDir}'에 대한 쓰기 권한이 없습니다.`, { title: '권한 오류', kind: 'error' });
      return;
    }
    if (op === 'move' && !sourcePaths.every(p => checkPathPermission(p, config.editableFolders, config.readonlyFolders))) {
      await confirm(`원본 파일에 대한 편집 권한이 없습니다.`, { title: '권한 오류', kind: 'error' });
      return;
    }
    const success = await pasteFiles(sourcePaths, targetDir, op);
    if (success) {
      setRefreshTrigger(p => p + 1);
    }
  };

  const handleExtract = async (path: string) => {
    try {
      if (!checkPathPermission(path, config.editableFolders, config.readonlyFolders)) {
        await confirm(`'${path}'에 대한 편집 권한이 없습니다.`, { title: '권한 오류', kind: 'error' });
        return;
      }
      const parentDir = await dirname(path);
      await invoke('extract_zip', { zipPath: path, targetDir: parentDir });
      setRefreshTrigger(p => p + 1);
    } catch (error) {
      console.error('Extraction failed:', error);
    }
  };

  const getMenuPosition = () => {
    if (!contextMenu) return {};
    const { x, y } = contextMenu;
    const width = 200;
    const height = 250;
    
    const style = {
      top: y,
      left: x,
      width: '200px',
      fontSize: '14px',
      transform: 'none'
    };

    let tx = '0';
    let ty = '0';

    if (x + width > window.innerWidth) {
      tx = '-100%';
    }
    if (y + height > window.innerHeight) {
      ty = '-100%';
    }
    
    if (tx !== '0' || ty !== '0') {
      style.transform = `translate(${tx}, ${ty})`;
    }
    
    return style;
  };

  useEffect(() => {
    const handleGlobalKeyDown = async (e: KeyboardEvent) => {
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.ctrlKey && e.key === 'c') {
        if (activePane === 'list' && filesSelected.size > 0) {
          const paths = Array.from(filesSelected);
          handleCopy(paths);
        } else if (activePane === 'tree' && selectedPaths.size > 0) {
          handleCopy(Array.from(selectedPaths));
        }
      } else if (e.ctrlKey && e.key === 'x') {
        if (activePane === 'list' && filesSelected.size > 0) {
          const paths = Array.from(filesSelected);
          handleCut(paths);
        } else if (activePane === 'tree' && selectedPaths.size > 0) {
          handleCut(Array.from(selectedPaths));
        }
      } else if (e.ctrlKey && e.key === 'v') {
        if (activePane === 'list' || activePane === 'tree') {
          handlePaste(selected);
        }
      } else if (e.key === 'Delete') {
        if (activePane === 'list' && filesSelected.size > 0) {
          const paths = Array.from(filesSelected);
          handleDelete(paths);
        } else if (activePane === 'tree' && selectedPaths.size > 0) {
          handleDelete(Array.from(selectedPaths));
        }
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [activePane, filesSelected, selectedPaths, selected]);

  if (currentView === 'search') {
    return (
      <SearchView 
        searchQuery={searchQuery || ''}
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
        refreshTrigger={refreshTrigger}
      />
    );
  }

  return (
    <div className="mhz-explorer">
      <aside className="mhz-explorer__tree" style={{ width: sidebarWidth, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: '5px', padding: '5px', alignItems: 'center', flexShrink: 0 }}>
          <input 
            type="text" 
            value={pathInput} 
            onChange={handlePathInputChange} 
            onKeyDown={handlePathInputKeyDown}
            style={{ flex: 1, padding: '4px', border: '1px solid #ccc', borderRadius: '4px' }}
          />
        </div>
        {config.quickAccess.length > 0 && (
          <>
          <div 
            ref={quickAccessRef}
            className="quick-access-section" 
            style={{ padding: '0 10px', height: quickAccessHeight, overflowY: 'auto', flexShrink: 0 }}
          >
            <div style={{ fontSize: '0.8em', fontWeight: 'bold', color: '#666', marginBottom: '5px', marginTop: '10px' }}>Quick Access</div>
            {config.quickAccess.map(qaPath => (
              <div 
                key={qaPath} 
                onClick={() => { setSelected(qaPath); setSelectedPaths(new Set([qaPath])); }}
                onContextMenu={(e) => handleQuickAccessContextMenu(e, qaPath)}
                style={{ cursor: 'pointer', padding: '4px 5px', fontSize: '0.9em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderRadius: '4px', backgroundColor: selected === qaPath ? '#e6f3ff' : 'transparent' }}
                title={qaPath}
              >
                📁 {qaPath.split(/[/\\]/).pop() || qaPath}
              </div>
            ))}
          </div>
          <div 
            onMouseDown={(e) => { e.preventDefault(); setIsResizingQuickAccess(true); }}
            style={{ height: '4px', cursor: 'row-resize', backgroundColor: '#f0f0f0', borderTop: '1px solid #ddd', borderBottom: '1px solid #ddd', flexShrink: 0 }}
          />
          </>
        )}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <FolderTree 
            path="C:\" 
            name="C:" 
            onSelect={(paths, multi) => {
              const pathList = Array.isArray(paths) ? paths : [paths];
              const targetPath = pathList[pathList.length - 1];
              setSelected(targetPath);
              setSelectedPaths(prev => {
                if (multi) {
                  const next = new Set(prev);
                  pathList.forEach(p => next.has(p) ? next.delete(p) : next.add(p));
                  return next;
                }
                return new Set(pathList);
              });
              setActivePane('tree');
            }}
            activePath={selected}
            selectedPaths={selectedPaths}
            expandedPaths={expandedPaths}
            onToggleExpand={handleToggleExpand}
            onMove={handleMove}
            onContextMenu={handleTreeContextMenu}
            refreshTrigger={refreshTrigger}
          />
        </div>
      </aside>
      <div 
        className="mhz-resizer"
        onMouseDown={() => setIsResizing(true)}
        onDoubleClick={() => {
          setSidebarWidth(0);
          onSaveConfig({ sidebarWidth: 0 });
        }}
        style={{ width: '4px', cursor: 'col-resize', backgroundColor: '#f0f0f0', borderLeft: '1px solid #ddd' }}
      />
      <section className="mhz-explorer__files">
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
          onDelete={handleDelete}
          onExtract={handleExtract}
          refreshTrigger={refreshTrigger}
          searchQuery={searchQuery}
          editableFolders={config.editableFolders}
          readonlyFolders={config.readonlyFolders}
        />
      </section>
      {contextMenu && (
        <div className="context-menu" style={getMenuPosition()}>
          {contextMenu.source === 'quickAccess' ? (
            <div className="context-menu-item delete" onClick={() => handleRemoveQuickAccess(contextMenu.path)}>
              <span>Quick Access에서 삭제</span>
            </div>
          ) : (
            <>
              <div className="context-menu-item" onClick={() => handleCut(Array.from(selectedPaths))}>
                <span>잘라내기</span> <span className="shortcut">Ctrl+X</span>
              </div>
              <div className="context-menu-item" onClick={() => handleCopy(Array.from(selectedPaths))}>
                <span>복사</span> <span className="shortcut">Ctrl+C</span>
              </div>
              <div className="context-menu-item" onClick={() => handlePaste(contextMenu.path)}>
                <span>붙여넣기</span> <span className="shortcut">Ctrl+V</span>
              </div>
              <div className="context-menu-separator"></div>
              <div className="context-menu-item delete" onClick={() => handleDelete(Array.from(selectedPaths))}>
                <span>삭제</span> <span className="shortcut">Del</span>
              </div>
              <div className="context-menu-separator"></div>
              {selectedPaths.size === 1 && (
                <div className="context-menu-item" onClick={() => handleSetDefault(contextMenu.path)}>기본 폴더로 지정</div>
              )}
              <div className="context-menu-item" onClick={() => Array.from(selectedPaths).forEach(p => handleAddToQuickAccess(p))}>
                Quick Access 추가
              </div>
              <div className="context-menu-separator"></div>
              <div className="context-menu-item" onClick={() => handleSetPermission(contextMenu.path, 'editable')}>Set as Editable</div>
              <div className="context-menu-item" onClick={() => handleSetPermission(contextMenu.path, 'readonly')}>Set as Read-only</div>
              <div className="context-menu-item" onClick={() => handleClearPermission(contextMenu.path)}>Clear Permission</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

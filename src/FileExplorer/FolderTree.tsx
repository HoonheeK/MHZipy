import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { checkPathPermission } from '../command/fileOperations';

interface FolderTreeProps {
  path: string;
  name: string;
  onSelect: (paths: string | string[], multi: boolean) => void;
  activePath?: string | null;
  selectedPaths: Set<string>;
  expandedPaths: Set<string>;
  onToggleExpand: (path: string) => void;
  onMove: (sourcePaths: string[], targetDir: string, op: 'move' | 'copy') => void;
  refreshTrigger?: number;
  onContextMenu?: (e: React.MouseEvent, path: string) => void;
  clipboard?: { paths: string[]; op: 'copy' | 'move' } | null;
  editableFolders?: string[];
  readonlyFolders?: string[];
  allowedPaths?: string[];
  renamingPath?: string | null;
  onStartRename?: (path: string, currentName: string) => void;
  onFinishRename?: () => void;
  onCancelRename?: () => void;
  renameText?: string;
  onRenameTextChange?: (text: string) => void;
  showMessage?: (title: string, message: string) => void;
}

export default function FolderTree({ path, name, onSelect, activePath, selectedPaths, expandedPaths, onToggleExpand, onMove, refreshTrigger, onContextMenu, clipboard, editableFolders, readonlyFolders, allowedPaths, renamingPath, onStartRename, onFinishRename, onCancelRename, renameText, onRenameTextChange, showMessage }: FolderTreeProps) {
  const isAncestorOf = (ancestor: string, descendant: string) => {
    if (!descendant.startsWith(ancestor)) return false;
    if (descendant.length === ancestor.length) return true;

    const ancestorHasSlash = ancestor.endsWith('\\') || ancestor.endsWith('/');
    if (ancestorHasSlash) {
      return true;
    }

    const sep = descendant[ancestor.length];
    return sep === '\\' || sep === '/';
  };

  if (allowedPaths && path !== 'My PC' && !allowedPaths.some(allowed => isAncestorOf(path, allowed) || isAncestorOf(allowed, path))) {
    return null;
  }
  const [subFolders, setSubFolders] = useState<{ name: string; path: string }[]>([]);
  const nodeRef = useRef<HTMLDivElement>(null);

  const isExpanded = expandedPaths.has(path);
  const isSelected = selectedPaths.has(path);
  const isEditable = checkPathPermission(path, editableFolders, readonlyFolders);
  const isCut = clipboard?.op === 'move' && clipboard.paths.includes(path);

  useEffect(() => {
    if (isSelected && nodeRef.current) {
      nodeRef.current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [isSelected]);

  // activePath가 변경되면 해당 경로의 부모 폴더들을 자동으로 펼침
  useEffect(() => {
    if (!activePath) return;

    // My PC는 항상 펼침 (activePath가 있을 때)
    if (path === 'My PC') {
      if (!isExpanded) onToggleExpand(path);
      return;
    }

    // 현재 폴더가 activePath의 조상 폴더인 경우 펼침
    if (activePath.startsWith(path) && activePath !== path) {
      const charAfterPath = activePath[path.length];
      const isBoundary = path.endsWith('\\') || path.endsWith('/') || charAfterPath === '\\' || charAfterPath === '/';

      if (isBoundary && !isExpanded) {
        onToggleExpand(path);
      }
    }
  }, [activePath, path, isExpanded, onToggleExpand]);

  useEffect(() => {
    let isMounted = true;
    if (isExpanded) {
      const loadSubFolders = async () => {
        try {
          if (path === 'My PC') {
            try {
              const drives = await invoke<string[]>('get_available_drives');
              const validDrives = drives.map((drive) => {
                let name = drive;
                if (drive.toLowerCase().includes('onedrive')) {
                  name = drive.replace(/[/\\]$/, '').split(/[/\\]/).pop() || 'OneDrive';
                } else if (drive.endsWith(':\\') || drive.endsWith(':/')) {
                  name = `Local Disk (${drive.replace(/[\\/]$/, '')})`;
                }
                return { name, path: drive };
              });

              if (isMounted) {
                const finalDrives = allowedPaths
                  ? validDrives.filter((drive) => allowedPaths.some((allowed) => allowed.startsWith(drive.path)))
                  : validDrives;
                setSubFolders(finalDrives);
              }
            } catch (e) {
              console.error('Failed to get drives:', e);
            }
            return;
          }

          const entries = await invoke<{ name: string; path: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }[]>('read_directory', { path });
          if (!isMounted) return;

          let folders = entries
            .filter((entry) => entry.isDirectory)
            .map((entry) => ({
              name: entry.name,
              path: entry.path,
            }));
          if (!isMounted) return;

          // 이름순 정렬
          folders.sort((a, b) => a.name.localeCompare(b.name));
          setSubFolders(folders);
        } catch (error) {
          if (isMounted) {
            console.error(`Failed to read directory ${path}:`, error);
          }
        }
      };
      loadSubFolders();
    }
    return () => {
      isMounted = false;
    };
  }, [isExpanded, path, refreshTrigger, allowedPaths]);

  const getRangePaths = (start: string, end: string): string[] => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('.folder-tree-node'));
    const startIdx = nodes.findIndex(n => n.dataset.path === start);
    const endIdx = nodes.findIndex(n => n.dataset.path === end);
    if (startIdx === -1 || endIdx === -1) return [end];

    const low = Math.min(startIdx, endIdx);
    const high = Math.max(startIdx, endIdx);

    return nodes.slice(low, high + 1).map(n => n.dataset.path!).filter(Boolean);
  };

  const handleRenameInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // Prevent tree navigation while renaming
    if (e.key === 'Enter') {
      onFinishRename?.();
    } else if (e.key === 'Escape') {
      onCancelRename?.();
    }
  };

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (renamingPath) return; // Disable navigation if any item is being renamed.

    if (e.key === 'F2') {
      e.stopPropagation();
      if (selectedPaths.size === 1 && selectedPaths.has(path)) {
        if (isEditable) {
          onStartRename?.(path, name);
        } else {
          showMessage?.('Permission Error', 'You do not have permission to rename this item.');
        }
      }
      return;
    }

    if (e.key === 'Tab') {
      if (e.shiftKey) {
        // Shift + Tab 키 입력 시 Quick Access 섹션으로 이동
        e.preventDefault();
        const quickAccessContainer = document.querySelector('.quick-access-section') as HTMLElement;
        if (quickAccessContainer) {
          quickAccessContainer.focus();
        }
      } else {
        // Tab 키 입력 시 하위 노드로 가지 않고 파일 리스트로 바로 이동
        e.preventDefault();
        const fileListContainer = document.querySelector('.mhz-explorer__files [tabindex="0"]') as HTMLElement;
        if (fileListContainer) {
          fileListContainer.focus();
        }
      }
      return;
    }

    if (e.key === 'ArrowRight') {
      e.stopPropagation();
      if (!isExpanded) onToggleExpand(path);
    } else if (e.key === 'ArrowLeft') {
      e.stopPropagation();
      if (isExpanded) {
        onToggleExpand(path);
      } else {
        // Parent 폴더로 이동 (DOM 탐색)
        const current = e.currentTarget as HTMLElement;
        const parentNode = current.parentElement?.parentElement?.previousElementSibling as HTMLElement;
        if (parentNode && parentNode.classList.contains('folder-tree-node')) {
          parentNode.focus();
        }
      }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const nodes = Array.from(document.querySelectorAll('.folder-tree-node')) as HTMLElement[];
      const index = nodes.indexOf(e.currentTarget as HTMLElement);
      if (index !== -1) {
        const nextIndex = e.key === 'ArrowDown' ? index + 1 : index - 1;
        if (nextIndex >= 0 && nextIndex < nodes.length) {
          nodes[nextIndex].focus();

          if (e.shiftKey && activePath) {
            const targetPath = nodes[nextIndex].dataset.path;
            if (targetPath) {
              const range = getRangePaths(activePath, targetPath);
              onSelect(range, false); // Replace selection with range
            }
          } else {
            const targetPath = nodes[nextIndex].dataset.path;
            if (targetPath) onSelect(targetPath, false);
          }
        }
      }
    }
  };

  const handleToggle = (e: React.MouseEvent) => {
    if (e.shiftKey && activePath) {
      const range = getRangePaths(activePath, path);
      onSelect(range, false);
    } else if (e.ctrlKey || e.metaKey) {
      onSelect(path, true);
    } else {
      onSelect(path, false);
      onToggleExpand(path);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const data = e.dataTransfer.getData('application/json');
    if (data) {
      try {
        const parsed = JSON.parse(data);
        const paths = parsed.paths || parsed.files?.map((f: any) => f.path);
        if (Array.isArray(paths) && paths.length > 0) {
          const op = (e.ctrlKey || e.metaKey) ? 'copy' : 'move';
          onMove(paths, path, op);
        }
      } catch (err) {
        console.error('Failed to parse drop data', err);
      }
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // 선택되지 않은 항목 위에서 우클릭 시 해당 항목만 선택
    if (!selectedPaths.has(path)) {
      onSelect(path, false);
    }

    if (onContextMenu) {
      onContextMenu(e, path);
    }
  };

  return (
    <div style={{ marginLeft: '16px' }}>
      <div
        ref={nodeRef}
        className="folder-tree-node"
        data-path={path}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onFocus={() => onSelect(path, false)}
        onClick={handleToggle}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = (e.ctrlKey || e.metaKey) ? 'copy' : 'move';
        }}
        onDrop={handleDrop}
        onContextMenu={handleContextMenu}
        style={{
          cursor: 'pointer',
          userSelect: 'none',
          padding: '2px 4px',
          display: 'flex',
          alignItems: 'center',
          whiteSpace: 'nowrap',
          outline: 'none',
          border: '1px solid transparent',
          backgroundColor: isSelected ? '#cce8ff' : 'transparent',
          // Gray out folders that are NOT editable (and their descendants)
          color: !isEditable ? 'gray' : 'inherit',
          opacity: isCut ? 0.5 : 1,
        }}
      >
        {renamingPath === path ? (
          <>
            <span style={{ marginRight: '4px' }}>{isExpanded ? '📂' : '📁'}</span>
            <input
              type="text"
              value={renameText}
              onChange={e => onRenameTextChange?.(e.target.value)}
              onKeyDown={handleRenameInputKeyDown}
              onBlur={() => onFinishRename?.()}
              onClick={e => e.stopPropagation()}
              onFocus={e => e.target.select()}
              autoFocus
              style={{ outline: 'none', border: '1px solid #007bff', padding: '1px', flex: 1, marginRight: '4px', height: '1.5em' }}
            />
          </>
        ) : (
          <>
            <span style={{ marginRight: '4px' }}>{isExpanded ? '📂' : '📁'}</span>
            <span>{name}</span>
          </>
        )}
      </div>
      {isExpanded && (
        <div>
          {subFolders.map((folder) => (
            <FolderTree
              key={folder.path}
              path={folder.path}
              name={folder.name}
              onSelect={onSelect}
              activePath={activePath}
              selectedPaths={selectedPaths}
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
              onMove={onMove}
              refreshTrigger={refreshTrigger}
              onContextMenu={onContextMenu}
              editableFolders={editableFolders}
              readonlyFolders={readonlyFolders}
              clipboard={clipboard}
              renamingPath={renamingPath}
              renameText={renameText}
              onRenameTextChange={onRenameTextChange}
              onStartRename={onStartRename}
              onFinishRename={onFinishRename}
              onCancelRename={onCancelRename}
              showMessage={showMessage}
            />
          ))}
        </div>
      )}
    </div>
  );
}

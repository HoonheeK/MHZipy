import { useState, useEffect, useRef } from 'react';
import { readDir, exists } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';

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
}

export default function FolderTree({ path, name, onSelect, activePath, selectedPaths, expandedPaths, onToggleExpand, onMove, refreshTrigger, onContextMenu }: FolderTreeProps) {
  const [subFolders, setSubFolders] = useState<{ name: string; path: string }[]>([]);
  const nodeRef = useRef<HTMLDivElement>(null);

  const isExpanded = expandedPaths.has(path);
  const isSelected = selectedPaths.has(path);

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
            const drives = ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\'];
            const validDrives = [];
            for (const drive of drives) {
              try {
                if (await exists(drive)) {
                  validDrives.push({ name: `Local Disk (${drive.replace('\\', '')})`, path: drive });
                }
              } catch (e) {
                // 드라이브 접근 불가 시 무시
              }
            }
            if (isMounted) setSubFolders(validDrives);
            return;
          }

          console.log(`Reading dir: ${path}`);
          const entries = await readDir(path);
          if (!isMounted) return;
          
          const folders = await Promise.all(
            entries
              .filter((entry) => entry.isDirectory)
              .map(async (entry) => ({
                name: entry.name,
                path: await join(path, entry.name),
              }))
          );
          if (!isMounted) return;
          
          // 이름순 정렬
          folders.sort((a, b) => a.name.localeCompare(b.name));
          console.log(`Loaded ${folders.length} subfolders in ${path}`);
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
  }, [isExpanded, path, refreshTrigger]);

  const getRangePaths = (start: string, end: string): string[] => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('.folder-tree-node'));
    const startIdx = nodes.findIndex(n => n.dataset.path === start);
    const endIdx = nodes.findIndex(n => n.dataset.path === end);
    if (startIdx === -1 || endIdx === -1) return [end];
    
    const low = Math.min(startIdx, endIdx);
    const high = Math.max(startIdx, endIdx);
    
    return nodes.slice(low, high + 1).map(n => n.dataset.path!).filter(Boolean);
  };

  const handleKeyDown = async (e: React.KeyboardEvent) => {
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
    e.stopPropagation();
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
        const { paths } = JSON.parse(data);
        if (Array.isArray(paths) && paths.length > 0) {
          const op = e.ctrlKey ? 'copy' : 'move';
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
        onDragOver={(e) => e.preventDefault()}
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
          backgroundColor: isSelected ? '#cce8ff' : 'transparent'
        }}
      >
        <span style={{ marginRight: '4px' }}>{isExpanded ? '📂' : '📁'}</span>
        <span>{name}</span>
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

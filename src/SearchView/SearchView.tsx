import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { stat } from '@tauri-apps/plugin-fs';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core'; // invoke 추가
import { open } from '@tauri-apps/plugin-dialog';
import FileList from '../FileExplorer/FileList';
import { SearchConfig } from '../App';

interface SearchViewProps {
  searchQuery: string;
  onNavigate: (path: string) => void;
  onCopy: (paths: string[]) => void;
  onCut: (paths: string[]) => void;
  onPaste: (targetDir: string) => void;
  onDelete: (paths: string[]) => void;
  onExtract: (path: string) => void;
  onOpenInNewWindow: (path: string, isDirectory?: boolean) => void;
  refreshTrigger?: number;
  quickAccess?: string[];
  searchConfig?: SearchConfig;
  onSaveSearchConfig?: (config: SearchConfig) => void;
  onOpenInExplorer?: (path: string) => void;
  columnSettings?: { key: string; visible: boolean }[];
  canPaste?: boolean;
  clipboard?: { paths: string[]; op: 'copy' | 'move' } | null;
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

interface FileChangePayload {
  action: 'create' | 'delete';
  path: string;
  is_dir: boolean;
}

function getOptimalSearchRoots(paths: string[]): string[] {
  return paths.filter(path => 
    !paths.some(otherPath => path !== otherPath && (path.startsWith(otherPath + '\\') || path.startsWith(otherPath + '/')))
  );
}

// Utility: Parse Size String (e.g., "> 10MB")
const parseSizeQuery = (input: string) => {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  const match = trimmed.match(/^([><=]{1,2})?\s*([\d.]+)\s*([a-z]*)$/);
  if (!match) return null;

  const operator = match[1] || '=';
  const value = parseFloat(match[2]);
  const unit = match[3];

  let bytes = value;
  if (unit.includes('kb')) bytes *= 1024;
  else if (unit.includes('mb')) bytes *= 1024 * 1024;
  else if (unit.includes('gb')) bytes *= 1024 * 1024 * 1024;

  return { operator, bytes };
};

const FILE_TYPES = ['All', 'Folder', 'Image', 'Video', 'Audio', 'Archive', 'Document', 'Code'];

export default function SearchView({
  searchQuery,
  onNavigate,
  onCopy,
  onCut,
  onPaste,
  onDelete,
  onExtract,
  onOpenInNewWindow,
  refreshTrigger,
  quickAccess = [],
  searchConfig,
  onSaveSearchConfig,
  onOpenInExplorer,
  columnSettings,
  canPaste,
  clipboard,
  onColumnSettingsChange
}: SearchViewProps) {
  const [results, setResults] = useState<FileData[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [isIndexReady, setIsIndexReady] = useState(false); // 인덱스 준비 상태
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [searchMode, setSearchMode] = useState<'index' | 'directory'>(searchConfig?.searchMode || 'directory');
  const [directorySearchPaths, setDirectorySearchPaths] = useState<Set<string>>(new Set(searchConfig?.directorySearchPaths || quickAccess));
  const [isFolderSelectOpen, setIsFolderSelectOpen] = useState(false);
  const folderSelectRef = useRef<HTMLDivElement>(null);

  // Search & Filter State
  const [localQuery, setLocalQuery] = useState(searchConfig?.query || searchQuery);
  const [sizeQuery, setSizeQuery] = useState(searchConfig?.sizeQuery || '');
  const [useRegex, setUseRegex] = useState(searchConfig?.useRegex || false);
  const [showFilters, setShowFilters] = useState(searchConfig?.showFilters || false);
  const [selectedType, setSelectedType] = useState(searchConfig?.type || 'All');
  const [dateAfter, setDateAfter] = useState(searchConfig?.dateAfter || '');
  const [dateBefore, setDateBefore] = useState(searchConfig?.dateBefore || '');
  const [regexError, setRegexError] = useState<string | null>(null);

  // Sync prop to local state
  useEffect(() => {
    setLocalQuery(searchQuery);
  }, [searchQuery]);

  // 페이지(컴포넌트) 마운트 시 로컬 플래그를 확인해 인덱스 준비 상태를 복원
  useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        const flag = localStorage.getItem('mft_index_ready');
        if (flag === 'true') {
          setIsIndexReady(true);
        }
      }
    } catch (e) {
      console.warn('Failed to read mft_index_ready from localStorage:', e);
    }
  }, []);

  // Auto-save search config (Debounced)
  useEffect(() => {
    if (!onSaveSearchConfig) return;
    const handler = setTimeout(() => {
      onSaveSearchConfig({
        query: localQuery,
        useRegex,
        sizeQuery,
        type: selectedType,
        dateAfter,
        dateBefore,
        showFilters,
        searchMode,
        directorySearchPaths: Array.from(directorySearchPaths)
      });
    }, 1000);
    return () => clearTimeout(handler);
  }, [localQuery, useRegex, sizeQuery, selectedType, dateAfter, dateBefore, showFilters, searchMode, directorySearchPaths, onSaveSearchConfig]);

  // Regex 유효성 검사 및 에러 상태 관리 (사이드 이펙트 분리)
  useEffect(() => {
    if (useRegex && localQuery) {
      try {
        new RegExp(localQuery, 'i');
        setRegexError(null);
      } catch (e) {
        setRegexError('Invalid Regex');
      }
    } else {
      setRegexError(null);
    }
  }, [useRegex, localQuery]);

  // Only sync quickAccess if we don't have a saved config or if directorySearchPaths is empty
  useEffect(() => {
    if (!searchConfig && directorySearchPaths.size === 0) {
      setDirectorySearchPaths(new Set(quickAccess));
    }
  }, [quickAccess, searchConfig]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (folderSelectRef.current && !folderSelectRef.current.contains(event.target as Node)) {
        setIsFolderSelectOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // MFT 인덱싱 실행 함수
  const handleBuildIndex = async () => {
    setIsIndexing(true);
    setIsIndexReady(false); // 인덱싱 시작 시 준비 안된 상태로 변경
    try {
      const count = await invoke<number>('build_mft_index');
      alert(`Indexing complete: Found ${count} files.`);
      setIsIndexReady(true); // 인덱싱 완료 후 준비 상태로 변경
    } catch (error) {
      console.error('Indexing failed:', error);
      alert(`Indexing failed: ${String(error)}`);
    } finally {
      setIsIndexing(false);
    }
  };

  // 앱 시작 시 인덱스 로딩 및 실시간 파일 변경 감지
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let unlistenIndexReady: UnlistenFn | undefined;

    // 백엔드에서 인덱스가 준비되었다는 이벤트를 수신
    const setupIndexReadyListener = async () => {
      unlistenIndexReady = await listen<boolean>('index-ready', (event) => {
        if (event.payload) {
          console.log("Index is ready from saved file.");
          setIsIndexReady(true);
        }
      });
    }

    // 파일 변경 이벤트 리스너 설정
    const setupListener = async () => {
      unlisten = await listen<FileChangePayload[]>('file-changes', (event) => {
        // console.log('File changes received:', event.payload);
        setResults(currentResults => {
          let newResults = [...currentResults];
          for (const change of event.payload) {
            if (change.action === 'delete') {
              newResults = newResults.filter(r => r.path !== change.path);
            } else if (change.action === 'create') {
              // 현재 검색어와 일치하는 경우에만 추가
              const name = change.path.split(/[/\\]/).pop() || change.path;
              if (localQuery && name.toLowerCase().includes(localQuery.toLowerCase())) {
                // 중복 방지
                if (!newResults.some(r => r.path === change.path)) {
                   const ext = name.lastIndexOf('.') > 0 ? name.split('.').pop() || '' : '';
                   const newFile: FileData = {
                     name,
                     path: change.path,
                     isDirectory: change.is_dir,
                     size: 0, // 실시간 정보는 stat 호출이 필요하나, 일단 0으로 둠
                     extension: ext,
                     type: change.is_dir ? 'Folder' : `${ext.toUpperCase()} File`,
                     mtime: new Date(),
                     birthtime: new Date(),
                     atime: new Date(),
                     readonly: false,
                   };
                   newResults.push(newFile);
                }
              }
            }
          }
          return newResults;
        });
      });
    };

    setupIndexReadyListener();
    setupListener();

    return () => {
      unlisten?.();
      unlistenIndexReady?.();
    }
  }, [localQuery]); // localQuery가 변경될 때마다 리스너의 로직이 최신 검색어를 참조하도록 함

  useEffect(() => {
    if (!localQuery) {
      setResults([]);
      return;
    }
    
    if (searchMode === 'index' && !isIndexReady) {
      setResults([]);
      return;
    }

    if (searchMode === 'directory' && directorySearchPaths.size === 0) {
      setResults([]);
      return;
    }

    let isMounted = true;
    setIsSearching(true);

    const runSearch = async () => {
      try {
        let paths: string[] = [];
        if (searchMode === 'index') {
           paths = await invoke<string[]>('search_mft', { query: localQuery, useRegex });
        } else {
           const searchRoots = getOptimalSearchRoots(Array.from(directorySearchPaths));
           const searchPromises = searchRoots.map(p => invoke<string[]>('search_directory', { path: p, query: localQuery, useRegex }));
           const resultsFromAllRoots = await Promise.all(searchPromises);
           paths = Array.from(new Set(resultsFromAllRoots.flat()));
        }

        if (!isMounted) return;

        // 검색 결과 제한 (성능 최적화)
        const limitedPaths = paths.slice(0, 500);

        // 경로 문자열을 FileData 객체로 변환
        // 주의: 모든 파일에 대해 stat을 호출하면 느려질 수 있으므로 필요한 경우에만 호출하거나 비동기로 처리
        const fileDataList = await Promise.all(limitedPaths.map(async (fullPath) => {
          try {
            const name = fullPath.split(/[/\\]/).pop() || fullPath;
            const ext = name.lastIndexOf('.') > 0 ? name.split('.').pop() || '' : '';
            
            // 파일 상세 정보 가져오기 (실패 시 기본값 사용)
            let metadata;
            try {
               metadata = await stat(fullPath);
            } catch {
               // 파일이 없거나 접근 권한이 없는 경우
               return {
                 name,
                 path: fullPath,
                 size: 0,
                 extension: ext,
                 type: 'Unknown',
                 mtime: null,
                 birthtime: null,
                 atime: null,
                 readonly: false,
                 isDirectory: false
               };
            }

            return {
              name: name,
              path: fullPath,
              size: metadata.size,
              extension: ext,
              type: metadata.isDirectory ? 'Folder' : `${ext.toUpperCase()} File`,
              mtime: metadata.mtime ? new Date(metadata.mtime) : null,
              birthtime: metadata.birthtime ? new Date(metadata.birthtime) : null,
              atime: metadata.atime ? new Date(metadata.atime) : null,
              readonly: metadata.readonly,
              isDirectory: metadata.isDirectory,
            };
          } catch (e) {
            return null;
          }
        }));

        if (isMounted) {
          setResults(fileDataList.filter((f): f is FileData => f !== null));
        }
      } catch (e) {
        console.error("Search failed:", e);
      } finally {
        if (isMounted) setIsSearching(false);
      }
    };

    // Debounce search slightly to avoid too many calls while typing
    const timeoutId = setTimeout(runSearch, 300);
    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
    };
  }, [localQuery, useRegex, refreshTrigger, searchMode, directorySearchPaths, isIndexReady, quickAccess]);

  // --- Client-Side Filtering Logic ---
  const filteredResults = useMemo(() => {
    const parsedSize = parseSizeQuery(sizeQuery);
    let regex: RegExp | null = null;

    if (useRegex && localQuery) {
      try {
        regex = new RegExp(localQuery, 'i');
      } catch (e) {
      }
    }

    return results.filter(file => {
      // 1. Regex Filter (Client-side refinement)
      if (useRegex && regex) {
        if (!regex.test(file.name)) return false;
      }

      // 2. Type Filter
      if (selectedType !== 'All') {
        const ext = file.extension.toLowerCase();
        if (selectedType === 'Folder') { if (!file.isDirectory) return false; }
        else if (selectedType === 'Image') { if (!['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'].includes(ext)) return false; }
        else if (selectedType === 'Video') { if (!['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) return false; }
        else if (selectedType === 'Audio') { if (!['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return false; }
        else if (selectedType === 'Archive') { if (!['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return false; }
        else if (selectedType === 'Document') { if (!['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md'].includes(ext)) return false; }
        else if (selectedType === 'Code') { if (!['js', 'ts', 'tsx', 'jsx', 'html', 'css', 'json', 'rs', 'py', 'java'].includes(ext)) return false; }
      }

      // 3. Date Filter
      if (file.mtime) {
        const modifiedDate = new Date(file.mtime);
        if (dateAfter && modifiedDate < new Date(dateAfter)) return false;
        if (dateBefore) {
          const d = new Date(dateBefore);
          d.setHours(23, 59, 59, 999);
          if (modifiedDate > d) return false;
        }
      }

      // 4. Size Filter
      if (parsedSize) {
        const { operator, bytes } = parsedSize;
        if (operator === '>' && file.size <= bytes) return false;
        if (operator === '<' && file.size >= bytes) return false;
        if (operator === '>=' && file.size < bytes) return false;
        if (operator === '<=' && file.size > bytes) return false;
        if (operator === '=' && Math.floor(file.size / 1024) !== Math.floor(bytes / 1024)) return false;
      }

      return true;
    });
  }, [results, localQuery, useRegex, sizeQuery, selectedType, dateAfter, dateBefore]);


  const handleSelectFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
    });
    if (selected && typeof selected === 'string') {
      setDirectorySearchPaths(prev => new Set(prev).add(selected));
    }
  };

  const handleToggleDirectoryPath = (path: string) => {
    setDirectorySearchPaths(prev => {
      const newPaths = new Set(prev);
      newPaths.has(path) ? newPaths.delete(path) : newPaths.add(path);
      return newPaths;
    });
  };

  const handleFileListFocus = useCallback(() => {}, []);

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', flexDirection: 'column', backgroundColor: '#f8f9fa' }}>
      {/* Header & Search Bar Area */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid #e0e0e0', backgroundColor: '#fff', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 2px 4px rgba(0,0,0,0.02)' }}>
        
        {/* Top Row: Title & Search Mode */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h2 style={{ margin: 0, fontSize: '1.2em', color: '#333', display: 'flex', alignItems: 'center', gap: '6px' }}>
              🔍 <span style={{ fontWeight: '800', color: '#2563eb' }}>Quick Access Folder Search</span>
            </h2>
            <span style={{ fontSize: '0.85em', color: '#666', fontWeight: '500' }}>Intelligent File Search</span>
          </div>
          
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
             <div style={{ display: 'flex', gap: '8px', backgroundColor: '#f1f5f9', padding: '4px', borderRadius: '6px' }}>
               <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', padding: '2px 8px', borderRadius: '4px', backgroundColor: searchMode === 'index' ? '#fff' : 'transparent', boxShadow: searchMode === 'index' ? '0 1px 2px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.2s' }}>
                  <input type="radio" checked={searchMode === 'index'} onChange={() => setSearchMode('index')} style={{ display: 'none' }} />
                  <span style={{ fontSize: '0.85em', fontWeight: searchMode === 'index' ? 'bold' : 'normal', color: searchMode === 'index' ? '#2563eb' : '#64748b' }}>⚡ MFT Index</span>
               </label>
               <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', padding: '2px 8px', borderRadius: '4px', backgroundColor: searchMode === 'directory' ? '#fff' : 'transparent', boxShadow: searchMode === 'directory' ? '0 1px 2px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.2s' }}>
                  <input type="radio" checked={searchMode === 'directory'} onChange={() => setSearchMode('directory')} style={{ display: 'none' }} />
                  <span style={{ fontSize: '0.85em', fontWeight: searchMode === 'directory' ? 'bold' : 'normal', color: searchMode === 'directory' ? '#2563eb' : '#64748b' }}>📂 Folder</span>
               </label>
             </div>
             <button 
                onClick={() => setShowFilters(!showFilters)}
                style={{ 
                  display: 'flex', alignItems: 'center', gap: '4px', padding: '6px 12px', borderRadius: '6px', 
                  backgroundColor: showFilters ? '#2563eb' : '#fff', color: showFilters ? '#fff' : '#475569', 
                  border: '1px solid #cbd5e1', cursor: 'pointer', fontSize: '0.85em', fontWeight: '600', transition: 'all 0.2s'
                }}
              >
                <span>⚙️ Filter Settings</span>
              </button>
          </div>
        </div>

        {/* Search Input Row */}
        <div style={{ position: 'relative' }}>
          <div style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', fontSize: '1.1em' }}>
            {isSearching ? '⏳' : '🔎'}
          </div>
          <input 
            type="text"
            placeholder={useRegex ? "Search with Regex (e.g. ^report.*\\.pdf$)" : "Enter file name to search..."}
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            style={{ 
              width: '100%', padding: '10px 12px 10px 40px', borderRadius: '8px', border: regexError ? '2px solid #fca5a5' : '2px solid #e2e8f0', 
              fontSize: '1em', outline: 'none', transition: 'border-color 0.2s', boxSizing: 'border-box'
            }}
            onFocus={(e) => e.target.style.borderColor = regexError ? '#fca5a5' : '#3b82f6'}
            onBlur={(e) => e.target.style.borderColor = regexError ? '#fca5a5' : '#e2e8f0'}
          />
          <div style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', backgroundColor: '#f1f5f9', padding: '4px 8px', borderRadius: '4px' }}>
              <input 
                type="checkbox" 
                checked={useRegex}
                onChange={(e) => setUseRegex(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span style={{ fontSize: '0.75em', fontWeight: 'bold', color: '#475569' }}>REGEX</span>
            </label>
            {localQuery && (
              <button onClick={() => setLocalQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: '1.1em' }}>✕</button>
            )}
          </div>
        </div>
        
        {regexError && (
          <div style={{ color: '#ef4444', fontSize: '0.85em', fontWeight: '500', paddingLeft: '4px' }}>
            ⚠️ {regexError}: Invalid Regex format.
          </div>
        )}

        {/* Advanced Filters Panel */}
        {showFilters && (
          <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px', marginTop: '4px', animation: 'fadeIn 0.2s' }}>
            {/* Helper Tooltip */}
            <div style={{ backgroundColor: '#eff6ff', border: '1px solid #dbeafe', borderRadius: '6px', padding: '10px', marginBottom: '12px', fontSize: '0.85em', color: '#1e40af' }}>
              <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>💡 Search Tips</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <span style={{ fontWeight: '600' }}>Regex:</span> <code>^</code>(Start), <code>$</code>(End), <code>.*</code>(Contains)
                </div>
                <div>
                  <span style={{ fontWeight: '600' }}>Size:</span> <code>{'>'} 10MB</code>, <code>{'<'} 1GB</code>
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
              {/* Type Filter */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '0.85em', fontWeight: 'bold', color: '#64748b' }}>📂 File Type</label>
                <select 
                  value={selectedType}
                  onChange={(e) => setSelectedType(e.target.value)}
                  style={{ padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.9em' }}
                >
                  {FILE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              {/* Size Filter */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '0.85em', fontWeight: 'bold', color: '#64748b' }}>⚖️ File Size</label>
                <input 
                  type="text" 
                  placeholder="e.g. > 10MB"
                  value={sizeQuery}
                  onChange={(e) => setSizeQuery(e.target.value)}
                  style={{ padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.9em' }}
                />
              </div>

              {/* Date Filters */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '0.85em', fontWeight: 'bold', color: '#64748b' }}>📅 Date Modified (After)</label>
                <input 
                  type="date" 
                  value={dateAfter}
                  onChange={(e) => setDateAfter(e.target.value)}
                  style={{ padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.9em' }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '0.85em', fontWeight: 'bold', color: '#64748b' }}>📅 Date Modified (Before)</label>
                <input 
                  type="date" 
                  value={dateBefore}
                  onChange={(e) => setDateBefore(e.target.value)}
                  style={{ padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.9em' }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Context Specific Controls (Index Button or Folder Select) */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
          {searchMode === 'index' ? (
             <button 
              onClick={handleBuildIndex} 
              disabled={isIndexing}
              style={{ 
                padding: '6px 12px', 
                cursor: isIndexing ? 'wait' : 'pointer',
                backgroundColor: isIndexing ? '#ccc' : (isIndexReady ? '#10b981' : '#3b82f6'),
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '0.85em',
                fontWeight: '600',
                boxShadow: '0 1px 2px rgba(0,0,0,0.1)'
              }}
            >
              {isIndexing ? '⏳ Indexing...' : (isIndexReady ? '🔄 Re-index MFT' : '🚀 Run MFT Indexing')}
            </button>
          ) : (
            <div style={{ position: 'relative', width: '100%' }} ref={folderSelectRef}>
              <div 
                onClick={() => setIsFolderSelectOpen(!isFolderSelectOpen)}
                style={{ 
                  border: '1px solid #cbd5e1', 
                  padding: '6px 10px', 
                  borderRadius: '6px', 
                  cursor: 'pointer',
                  backgroundColor: '#fff',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '0.9em',
                  color: '#334155'
                }}
              >
                <span 
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={Array.from(directorySearchPaths).join('\n')}
                >
                  {directorySearchPaths.size === 0 
                    ? '📂 Select folder to search (includes Quick Access)...' 
                    : `📂 ${Array.from(directorySearchPaths).join(', ')}`}
                </span>
                <span style={{ fontSize: '0.8em', marginLeft: '5px' }}>{isFolderSelectOpen ? '▲' : '▼'}</span>
              </div>
              
              {isFolderSelectOpen && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, border: '1px solid #cbd5e1', borderTop: 'none', backgroundColor: '#fff', zIndex: 1000, maxHeight: '300px', overflowY: 'auto', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)', borderRadius: '0 0 6px 6px' }}>
                  {[...new Set([...quickAccess, ...directorySearchPaths])].sort().map(path => (
                    <div key={path} style={{ padding: '8px 12px', borderBottom: '1px solid #f1f5f9' }}>
                      <label title={path} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', width: '100%' }}>
                        <input
                          type="checkbox"
                          checked={directorySearchPaths.has(path)}
                          onChange={() => handleToggleDirectoryPath(path)}
                          style={{ marginRight: '8px' }}
                        />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.9em', color: '#475569' }}>{path}</span>
                      </label>
                    </div>
                  ))}
                  <div style={{ padding: '8px', textAlign: 'center', backgroundColor: '#f8fafc' }}>
                    <button onClick={handleSelectFolder} style={{ padding: '4px 10px', cursor: 'pointer', fontSize: '0.85em', color: '#2563eb', background: 'none', border: 'none', fontWeight: '600' }}>+ Browse other folders...</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Results Area */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 16px', borderBottom: '1px solid #eee', backgroundColor: '#fff', fontSize: '0.9em', color: '#64748b', display: 'flex', justifyContent: 'space-between' }}>
           <span>
             {isSearching ? (
               <span style={{ color: '#2563eb', fontWeight: '600' }}>
                 🔍 Searching for <span style={{ fontStyle: 'italic' }}>"{localQuery}"</span>...
               </span>
             ) : (
               <>
                 {localQuery ? (
                   <>✅ Search results: <span style={{ fontWeight: 'bold', color: '#2563eb' }}>{filteredResults.length}</span> items</>
                 ) : (
                   'Enter a query to start searching'
                 )}
               </>
             )}
           </span>
           {!isSearching && results.length !== filteredResults.length && (
             <span style={{ fontSize: '0.85em' }}>(Filtered: {results.length - filteredResults.length} excluded)</span>
           )}
        </div>
        <div style={{ flex: 1, minHeight: 0, opacity: isSearching ? 0.5 : 1, transition: 'opacity 0.2s' }}>
          <FileList
            path={null}
            filesOverride={filteredResults}
            selectedFiles={selectedFiles}
            onSelectFiles={setSelectedFiles}
            onFocus={handleFileListFocus}
            onNavigate={onNavigate}
            onCopy={onCopy}
            onCut={onCut}
            onPaste={onPaste}
            onDelete={onDelete}
            onExtract={onExtract}
            onOpenInNewWindow={onOpenInNewWindow}
            refreshTrigger={refreshTrigger}
            // searchQuery={localQuery} // 이 줄이 FileList 내부에서 단순 문자열 필터링을 유발하므로 제거합니다.
            enableAutoResize={true}
            onOpenInExplorer={onOpenInExplorer || (() => {})}
            columnSettings={columnSettings}
            clipboard={clipboard}
            canPaste={canPaste}
            onColumnSettingsChange={onColumnSettingsChange}
          />
        </div>
      </div>
    </div>
  );
}

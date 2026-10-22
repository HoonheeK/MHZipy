import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { stat } from '@tauri-apps/plugin-fs';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core'; // invoke 추가
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import FileList from '../FileExplorer/FileList';
import { SearchConfig } from '../App';
import MessageDialog from '../common/MessageDialog';

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
  onOpenInExplorer?: (path: string, isDirectory?: boolean) => void;
  recentOpenedFolders?: string[];
  columnSettings?: { key: string; visible: boolean }[];
  canPaste?: boolean;
  clipboard?: { paths: string[]; op: 'copy' | 'move' } | null;
  onColumnSettingsChange?: (settings: { key: string; visible: boolean }[]) => void;
  onSelectionChange?: (paths: Set<string>) => void;
  usePdfWorker?: boolean;
  useImageViewer?: boolean;
  pdfExportPath?: string;
  onSearchChange?: (query: string) => void;
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
  recentOpenedFolders,
  columnSettings,
  canPaste,
  clipboard,
  onColumnSettingsChange,
  onSelectionChange,
  usePdfWorker,
  useImageViewer,
  pdfExportPath,
  onSearchChange
}: SearchViewProps) {
  const { t } = useTranslation();
  const [results, setResults] = useState<FileData[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [isIndexReady, setIsIndexReady] = useState(false); // 인덱스 준비 상태
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [searchMode, setSearchMode] = useState<'index' | 'directory'>(searchConfig?.searchMode || 'directory');
  const [directorySearchPaths, setDirectorySearchPaths] = useState<Set<string>>(new Set(searchConfig?.directorySearchPaths || quickAccess));
  const [isFolderSelectOpen, setIsFolderSelectOpen] = useState(false);
  const folderSelectRef = useRef<HTMLDivElement>(null);
  const [localRefresh, setLocalRefresh] = useState(0);

  // 커스텀 다이얼로그 상태
  const [dialogState, setDialogState] = useState<{ open: boolean; title: string; message: string }>({
    open: false,
    title: '',
    message: '',
  });

  useEffect(() => {
    if (onSelectionChange) {
      onSelectionChange(selectedFiles);
    }
  }, [selectedFiles, onSelectionChange]);

  // Search & Filter State
  const [localQuery, setLocalQuery] = useState(searchConfig?.query || searchQuery);
  const [sizeQuery, setSizeQuery] = useState(searchConfig?.sizeQuery || '');
  const [useRegex, setUseRegex] = useState(searchConfig?.useRegex || false);
  const [showFilters, setShowFilters] = useState(searchConfig?.showFilters || false);
  const [selectedType, setSelectedType] = useState(searchConfig?.type || 'All');
  const [dateAfter, setDateAfter] = useState(searchConfig?.dateAfter || '');
  const [dateBefore, setDateBefore] = useState(searchConfig?.dateBefore || '');
  const [regexError, setRegexError] = useState<string | null>(null);

  const updateQuery = (newQuery: string) => {
    setLocalQuery(newQuery);
    if (!newQuery || !newQuery.trim()) {
      setIsSearching(false);
      setResults([]);
    }
    onSearchChange?.(newQuery);
  };

  // Sync prop to local state
  useEffect(() => {
    setLocalQuery(searchQuery);
    if (!searchQuery || !searchQuery.trim()) {
      setIsSearching(false);
      setResults([]);
    }
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
    if (isIndexing) return;
    setIsIndexing(true);
    try {
      const count = await invoke<number>('build_mft_index');
      setIsIndexReady(true);
      setDialogState({
        open: true,
        title: 'MFT Indexing Complete',
        message: `MFT indexing completed successfully.\nIndexed ${count.toLocaleString()} files and folders in total.`,
      });
    } catch (error) {
      console.error('Indexing failed:', error);
      setIsIndexReady(false);
      setDialogState({
        open: true,
        title: 'MFT Indexing Error',
        message: `An error occurred during MFT indexing:\n\n${String(error)}\n\n💡 Tip: Direct access to volume MFT (e.g., C:) may require running MHZipy as Administrator.`,
      });
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
    if (!localQuery || !localQuery.trim()) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    if (searchMode === 'index' && !isIndexReady) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    if (searchMode === 'directory' && directorySearchPaths.size === 0) {
      setResults([]);
      setIsSearching(false);
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
  }, [localQuery, useRegex, refreshTrigger, searchMode, directorySearchPaths, isIndexReady, quickAccess, localRefresh]);

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

  const handleFileListFocus = useCallback(() => { }, []);

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, width: '100%', flexDirection: 'column', backgroundColor: '#0b0f19' }}>
      {/* Header & Search Bar Area */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', backgroundColor: '#0f172a', display: 'flex', flexDirection: 'column', gap: '12px' }}>

        {/* Top Row: Title & Search Mode */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h2 style={{ margin: 0, fontSize: '1.15em', color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '6px' }}>
              🔍 <span style={{ fontWeight: '700', color: '#38bdf8' }}>{t('search.title', { defaultValue: 'Quick Access Folder Search' })}</span>
            </h2>
          </div>

          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {searchMode === 'index' && (
              <button
                onClick={handleBuildIndex}
                disabled={isIndexing}
                title="Re-index NTFS Master File Table"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '5px 12px',
                  cursor: isIndexing ? 'wait' : 'pointer',
                  backgroundColor: isIndexing ? '#475569' : (isIndexReady ? '#10b981' : '#0284c7'),
                  color: 'white',
                  border: 'none',
                  borderRadius: '7px',
                  fontSize: '0.82em',
                  fontWeight: '600',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                  transition: 'all 0.15s'
                }}
              >
                {isIndexing ? '⏳ Indexing...' : (isIndexReady ? '🔄 Re-index MFT' : '🚀 Run MFT Indexing')}
              </button>
            )}

            <div style={{ display: 'flex', gap: '4px', backgroundColor: '#1e293b', padding: '3px', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
              <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', padding: '3px 10px', borderRadius: '6px', backgroundColor: searchMode === 'index' ? '#38bdf8' : 'transparent', transition: 'all 0.15s' }}>
                <input type="radio" checked={searchMode === 'index'} onChange={() => setSearchMode('index')} style={{ display: 'none' }} />
                <span style={{ fontSize: '0.82em', fontWeight: searchMode === 'index' ? '700' : '500', color: searchMode === 'index' ? '#0f172a' : '#94a3b8' }}>⚡ {t('search.mftIndex', { defaultValue: 'MFT Index' })}</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', padding: '3px 10px', borderRadius: '6px', backgroundColor: searchMode === 'directory' ? '#38bdf8' : 'transparent', transition: 'all 0.15s' }}>
                <input type="radio" checked={searchMode === 'directory'} onChange={() => setSearchMode('directory')} style={{ display: 'none' }} />
                <span style={{ fontSize: '0.82em', fontWeight: searchMode === 'directory' ? '700' : '500', color: searchMode === 'directory' ? '#0f172a' : '#94a3b8' }}>📂 {t('search.folder', { defaultValue: 'Folder' })}</span>
              </label>
            </div>

            <button
              onClick={() => setShowFilters(!showFilters)}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 12px', borderRadius: '7px',
                backgroundColor: showFilters ? '#0284c7' : '#1e293b', color: showFilters ? '#ffffff' : '#94a3b8',
                border: '1px solid rgba(255, 255, 255, 0.12)', cursor: 'pointer', fontSize: '0.82em', fontWeight: '600', transition: 'all 0.15s'
              }}
            >
              <span>⚙️ {t('search.filterSettings', { defaultValue: 'Filter Settings' })}</span>
            </button>
          </div>
        </div>

        {/* Search Input Row */}
        <div style={{ position: 'relative' }}>
          <div style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', fontSize: '1em' }}>
            {isSearching ? '⏳' : '🔎'}
          </div>
          <input
            type="text"
            placeholder={useRegex ? t('search.placeholderRegex', "Search with Regex (e.g. ^report.*\\.pdf$)") : t('search.placeholderNormal', "Enter file name to search...")}
            value={localQuery}
            onChange={(e) => updateQuery(e.target.value)}
            style={{
              width: '100%', padding: '9px 12px 9px 38px', borderRadius: '8px',
              backgroundColor: '#1e293b',
              color: '#f8fafc',
              border: regexError ? '1px solid #ef4444' : '1px solid rgba(255, 255, 255, 0.12)',
              fontSize: '0.95em', outline: 'none', transition: 'all 0.15s', boxSizing: 'border-box'
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = regexError ? '#ef4444' : '#38bdf8';
              e.currentTarget.style.boxShadow = regexError ? 'none' : '0 0 0 1px #38bdf8';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = regexError ? '#ef4444' : 'rgba(255, 255, 255, 0.12)';
              e.currentTarget.style.boxShadow = 'none';
            }}
            autoFocus
          />
          <div style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', backgroundColor: '#0f172a', border: '1px solid rgba(255, 255, 255, 0.08)', padding: '3px 8px', borderRadius: '5px' }}>
              <input
                type="checkbox"
                checked={useRegex}
                onChange={(e) => setUseRegex(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span style={{ fontSize: '0.72em', fontWeight: 'bold', color: '#38bdf8' }}>REGEX</span>
            </label>
            {localQuery && (
              <button onClick={() => updateQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: '1em', padding: '0 4px' }}>✕</button>
            )}
          </div>
        </div>

        {regexError && (
          <div style={{ color: '#f87171', fontSize: '0.82em', fontWeight: '500', paddingLeft: '4px' }}>
            ⚠️ {regexError}: Invalid Regex format.
          </div>
        )}

        {/* Advanced Filters Panel */}
        {showFilters && (
          <div style={{ backgroundColor: '#151d2f', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '8px', padding: '14px', marginTop: '2px' }}>
            {/* Helper Tooltip */}
            <div style={{ backgroundColor: 'rgba(56, 189, 248, 0.08)', border: '1px solid rgba(56, 189, 248, 0.2)', borderRadius: '6px', padding: '8px 12px', marginBottom: '12px', fontSize: '0.82em', color: '#bae6fd' }}>
              <div style={{ fontWeight: 'bold', marginBottom: '4px', color: '#38bdf8' }}>💡 Search Tips</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <span style={{ fontWeight: '600' }}>Regex:</span> <code>^</code>(Start), <code>$</code>(End), <code>.*</code>(Contains)
                </div>
                <div>
                  <span style={{ fontWeight: '600' }}>Size:</span> <code>{'>'} 10MB</code>, <code>{'<'} 1GB</code>
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '12px' }}>
              {/* Type Filter */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '0.82em', fontWeight: 'bold', color: '#94a3b8' }}>📂 {t('search.fileType', { defaultValue: 'File Type' })}</label>
                <select
                  value={selectedType}
                  onChange={(e) => setSelectedType(e.target.value)}
                  style={{ padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.12)', backgroundColor: '#1e293b', color: '#f8fafc', fontSize: '0.88em', outline: 'none' }}
                >
                  {FILE_TYPES.map(t => <option key={t} value={t} style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>{t}</option>)}
                </select>
              </div>

              {/* Size Filter */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '0.82em', fontWeight: 'bold', color: '#94a3b8' }}>⚖️ {t('search.fileSize', { defaultValue: 'File Size' })}</label>
                <input
                  type="text"
                  value={sizeQuery}
                  onChange={(e) => setSizeQuery(e.target.value)}
                  placeholder={t('search.sizePlaceholder', "e.g. > 10MB")}
                  style={{ padding: '6px 10px', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: '6px', backgroundColor: '#1e293b', color: '#f8fafc', fontSize: '0.88em', outline: 'none' }}
                />
              </div>

              {/* Date Filters */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '0.82em', fontWeight: 'bold', color: '#94a3b8' }}>📅 {t('search.dateModifiedAfter', { defaultValue: 'Date Modified (After)' })}</label>
                <input
                  type="date"
                  value={dateAfter}
                  onChange={(e) => setDateAfter(e.target.value)}
                  style={{ padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.12)', backgroundColor: '#1e293b', color: '#f8fafc', fontSize: '0.88em', outline: 'none', colorScheme: 'dark' }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '0.82em', fontWeight: 'bold', color: '#94a3b8' }}>📅 {t('search.dateModifiedBefore', { defaultValue: 'Date Modified (Before)' })}</label>
                <input
                  type="date"
                  value={dateBefore}
                  onChange={(e) => setDateBefore(e.target.value)}
                  style={{ padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.12)', backgroundColor: '#1e293b', color: '#f8fafc', fontSize: '0.88em', outline: 'none', colorScheme: 'dark' }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Context Specific Controls (Folder Select in Directory Mode) */}
        {searchMode === 'directory' && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '2px' }}>
            <div style={{ position: 'relative', width: '100%' }} ref={folderSelectRef}>
              <div
                onClick={() => setIsFolderSelectOpen(!isFolderSelectOpen)}
                style={{
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  padding: '7px 12px',
                  borderRadius: '7px',
                  cursor: 'pointer',
                  backgroundColor: '#1e293b',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '0.88em',
                  color: '#e2e8f0'
                }}
              >
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={Array.from(directorySearchPaths).join('\n')}
                >
                  {directorySearchPaths.size === 0
                    ? '📂 ' + t('search.selectFolder', { defaultValue: 'Select folder to search (includes Quick Access)...' })
                    : `📂 ${Array.from(directorySearchPaths).join(', ')}`}
                </span>
                <span style={{ fontSize: '0.8em', marginLeft: '6px', color: '#94a3b8' }}>{isFolderSelectOpen ? '▲' : '▼'}</span>
              </div>

              {isFolderSelectOpen && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, border: '1px solid rgba(255, 255, 255, 0.15)', borderTop: 'none', backgroundColor: '#1e293b', zIndex: 1000, maxHeight: '300px', overflowY: 'auto', boxShadow: '0 8px 16px rgba(0,0,0,0.4)', borderRadius: '0 0 8px 8px' }}>
                  {[...new Set([...quickAccess, ...directorySearchPaths])].sort().map(path => (
                    <div key={path} style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}>
                      <label title={path} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', width: '100%' }}>
                        <input
                          type="checkbox"
                          checked={directorySearchPaths.has(path)}
                          onChange={() => handleToggleDirectoryPath(path)}
                          style={{ marginRight: '8px' }}
                        />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.88em', color: '#e2e8f0' }}>{path}</span>
                      </label>
                    </div>
                  ))}
                  <div style={{ padding: '8px', textAlign: 'center', backgroundColor: '#151d2f' }}>
                    <button onClick={handleSelectFolder} style={{ padding: '4px 10px', cursor: 'pointer', fontSize: '0.82em', color: '#38bdf8', background: 'none', border: 'none', fontWeight: '600' }}>+ {t('search.browseFolders', { defaultValue: 'Browse other folders...' })}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Results Area */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column', backgroundColor: '#0b0f19' }}>
        <div style={{ padding: '8px 16px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', backgroundColor: '#0f172a', fontSize: '0.85em', color: '#94a3b8', display: 'flex', justifyContent: 'space-between' }}>
          <span>
            {isSearching ? (
              <span style={{ color: '#38bdf8', fontWeight: '600' }}>
                🔍 {t('search.searchingFor', { defaultValue: 'Searching for' })} <span style={{ fontStyle: 'italic' }}>"{localQuery}"</span>...
              </span>
            ) : (
              <>
                {localQuery ? (
                  <>✅ {t('search.searchResults', { defaultValue: 'Search results:' })} <span style={{ fontWeight: 'bold', color: '#38bdf8' }}>{filteredResults.length}</span> {t('search.items', { defaultValue: 'items' })}</>
                ) : (
                  t('search.enterQuery', { defaultValue: 'Enter a query to start searching' })
                )}
              </>
            )}
          </span>
          {!isSearching && results.length !== filteredResults.length && (
            <span style={{ fontSize: '0.82em', color: '#64748b' }}>(Filtered: {results.length - filteredResults.length} excluded)</span>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0, opacity: isSearching ? 0.5 : 1, transition: 'opacity 0.2s', overflowY: 'auto' }}>
          {(!localQuery && recentOpenedFolders && recentOpenedFolders.length > 0) ? (
            <div style={{ padding: '20px' }}>
              <h3 style={{ margin: '0 0 16px 0', color: '#f8fafc', fontSize: '1.05em', display: 'flex', alignItems: 'center', gap: '8px' }}>
                🕒 Recent Folders
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {recentOpenedFolders.map(folder => (
                  <div
                    key={folder}
                    onDoubleClick={() => onNavigate(folder)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (onOpenInExplorer) onOpenInExplorer(folder, true);
                    }}
                    style={{
                      padding: '12px 16px',
                      backgroundColor: '#1e293b',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      transition: 'all 0.15s'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = '#253347';
                      e.currentTarget.style.borderColor = '#38bdf8';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = '#1e293b';
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                    }}
                    title="Double click to open in App, Right click to open in Windows Explorer"
                  >
                    <span style={{ fontSize: '1.2em' }}>📁</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#e2e8f0', fontSize: '0.9em' }}>
                      {folder}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
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
              onRefresh={() => setLocalRefresh(r => r + 1)}
              enableAutoResize={true}
              onOpenInExplorer={onOpenInExplorer || (() => { })}
              columnSettings={columnSettings}
              clipboard={clipboard}
              canPaste={canPaste}
              onColumnSettingsChange={onColumnSettingsChange}
              pdfExportPath={pdfExportPath}
              usePdfWorker={usePdfWorker}
              useImageViewer={useImageViewer}
            />
          )}
        </div>
      </div>

      <MessageDialog
        open={dialogState.open}
        title={dialogState.title}
        message={dialogState.message}
        onClose={() => setDialogState((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
}

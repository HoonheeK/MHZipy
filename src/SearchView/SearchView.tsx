import { useState, useEffect } from 'react';
import { stat } from '@tauri-apps/plugin-fs';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core'; // invoke 추가
import FileList from '../FileExplorer/FileList';

interface SearchViewProps {
  searchQuery: string;
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

interface FileChangePayload {
  action: 'create' | 'delete';
  path: string;
  is_dir: boolean;
}

export default function SearchView({ searchQuery, onNavigate, onCopy, onCut, onPaste, onDelete, onExtract, refreshTrigger }: SearchViewProps) {
  const [results, setResults] = useState<FileData[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [isIndexReady, setIsIndexReady] = useState(false); // 인덱스 준비 상태
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

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

  // MFT 인덱싱 실행 함수
  const handleBuildIndex = async () => {
    setIsIndexing(true);
    setIsIndexReady(false); // 인덱싱 시작 시 준비 안된 상태로 변경
    try {
      const count = await invoke<number>('build_mft_index');
      alert(`인덱싱 완료: ${count}개의 파일을 찾았습니다.`);
      setIsIndexReady(true); // 인덱싱 완료 후 준비 상태로 변경
    } catch (error) {
      console.error('Indexing failed:', error);
      alert(`인덱싱 실패: ${String(error)}`);
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
              if (searchQuery && name.toLowerCase().includes(searchQuery.toLowerCase())) {
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
  }, [searchQuery]); // searchQuery가 변경될 때마다 리스너의 로직이 최신 검색어를 참조하도록 함

  useEffect(() => {
    if (!searchQuery || !isIndexReady) { // 인덱스가 준비되지 않았으면 검색 안함
      setResults([]);
      return;
    }

    let isMounted = true;
    setIsSearching(true);

    const runSearch = async () => {
      try {
        // Rust 백엔드의 MFT 검색 호출 (초고속 검색)
        const paths = await invoke<string[]>('search_mft', { query: searchQuery });
        
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

    runSearch();

    return () => {
      isMounted = false;
    };
  }, [searchQuery, refreshTrigger]);

  return (
    <div style={{ display: 'flex', height: '100%', flexDirection: 'column' }}>
      <div style={{ padding: '10px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong>Search Results for: "{searchQuery}"</strong>
          {isSearching && <span style={{ marginLeft: '10px', color: '#888' }}>(Searching...)</span>}
          {isIndexReady && <span style={{ marginLeft: '10px', color: '#666' }}>Found: {results.length}</span>}
        </div>
        <button 
          onClick={handleBuildIndex} 
          disabled={isIndexing}
          style={{ 
            padding: '6px 12px', 
            cursor: isIndexing ? 'wait' : 'pointer',
            backgroundColor: isIndexing ? '#ccc' : (isIndexReady ? '#28a745' : '#007bff'),
            color: 'white',
            border: 'none',
            borderRadius: '4px'
          }}
        >
          {isIndexing ? '인덱싱 중...' : (isIndexReady ? 'MFT 다시 인덱싱' : 'MFT 인덱싱 실행')}
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <FileList
          path={null}
          filesOverride={results}
          selectedFiles={selectedFiles}
          onSelectFiles={setSelectedFiles}
          onFocus={() => {}}
          onNavigate={onNavigate}
          onCopy={onCopy}
          onCut={onCut}
          onPaste={onPaste}
          onDelete={onDelete}
          onExtract={onExtract}
          refreshTrigger={refreshTrigger}
          searchQuery={searchQuery} // 하이라이팅 등을 위해 전달
        />
      </div>
    </div>
  );
}

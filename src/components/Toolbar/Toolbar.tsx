import React, { useState, useRef, useEffect } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  RotateCw,
  Folder,
  Search,
  Package,
  PackageOpen,
  FolderPlus,
  FilePlus,
  Copy,
  Settings,
  Info,
  BookOpen,
  ShieldCheck,
  ChevronDown,
  X,
  Square,
  HardDrive,
} from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import logoImg from '../../assets/logo.png';
import { useTranslation } from 'react-i18next';
import './Toolbar.css';

export interface ToolbarProps {
  // Brand Menu
  onAbout: () => void;
  onOpenSource: () => void;
  onPreference: () => void;
  onLicense: () => void;

  // Navigation
  onBack: () => void;
  canGoBack: boolean;
  onNext: () => void;
  canGoForward: boolean;
  onGoUp?: () => void;
  canGoUp?: boolean;
  onRefresh?: () => void;
  backHistory?: string[];
  forwardHistory?: string[];
  onJumpBack?: (index: number) => void;
  onJumpForward?: (index: number) => void;

  // Path & Filter
  currentPath: string;
  onNavigatePath: (path: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;

  // Core Actions
  hasSelectedFiles: boolean;
  isZipSelected: boolean;
  onCompress: () => void;
  onExtract: () => void;
  onNewFolder: () => void;
  onNewMdFile: () => void;

  // View Switcher
  currentView: 'folder' | 'search';
  onToggleView: (view: 'folder' | 'search') => void;
}

function getFolderName(path: string): string {
  if (!path) return '';
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return path;
  if (/^[A-Za-z]:$/.test(trimmed)) {
    return `${trimmed}\\`;
  }
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  onAbout,
  onOpenSource,
  onPreference,
  onLicense,
  onBack,
  canGoBack,
  onNext,
  canGoForward,
  onGoUp,
  canGoUp = true,
  onRefresh,
  backHistory = [],
  forwardHistory = [],
  onJumpBack,
  onJumpForward,
  currentPath,
  onNavigatePath,
  searchQuery,
  onSearchChange,
  hasSelectedFiles,
  isZipSelected,
  onCompress,
  onExtract,
  onNewFolder,
  onNewMdFile,
  currentView,
  onToggleView,
}) => {
  const { t } = useTranslation();
  const [isBrandMenuOpen, setIsBrandMenuOpen] = useState(false);
  const brandMenuRef = useRef<HTMLDivElement>(null);

  // History Dropdown State (Long-press / Right-click on Back/Forward buttons)
  const [activeHistoryMenu, setActiveHistoryMenu] = useState<'back' | 'forward' | null>(null);
  const backNavRef = useRef<HTMLDivElement>(null);
  const forwardNavRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLongPressTriggeredRef = useRef(false);

  const [addressInput, setAddressInput] = useState(currentPath);
  const [localSearch, setLocalSearch] = useState(searchQuery);

  // Close history menu on outside click or Escape key
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        activeHistoryMenu === 'back' &&
        backNavRef.current &&
        !backNavRef.current.contains(e.target as Node)
      ) {
        setActiveHistoryMenu(null);
      } else if (
        activeHistoryMenu === 'forward' &&
        forwardNavRef.current &&
        !forwardNavRef.current.contains(e.target as Node)
      ) {
        setActiveHistoryMenu(null);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveHistoryMenu(null);
      }
    };

    if (activeHistoryMenu) {
      document.addEventListener('mousedown', handleOutsideClick);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeHistoryMenu]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };
  }, []);

  const handleBackMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !canGoBack) return;
    isLongPressTriggeredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      if (canGoBack && backHistory && backHistory.length > 0) {
        isLongPressTriggeredRef.current = true;
        setActiveHistoryMenu('back');
      }
    }, 400);
  };

  const handleBackMouseUp = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleNavMouseLeave = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleBackClick = () => {
    if (isLongPressTriggeredRef.current) {
      isLongPressTriggeredRef.current = false;
      return;
    }
    if (activeHistoryMenu === 'back') {
      setActiveHistoryMenu(null);
      return;
    }
    onBack();
  };

  const handleBackContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (canGoBack && backHistory && backHistory.length > 0) {
      setActiveHistoryMenu((prev) => (prev === 'back' ? null : 'back'));
    }
  };

  const handleForwardMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !canGoForward) return;
    isLongPressTriggeredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      if (canGoForward && forwardHistory && forwardHistory.length > 0) {
        isLongPressTriggeredRef.current = true;
        setActiveHistoryMenu('forward');
      }
    }, 400);
  };

  const handleForwardMouseUp = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleForwardClick = () => {
    if (isLongPressTriggeredRef.current) {
      isLongPressTriggeredRef.current = false;
      return;
    }
    if (activeHistoryMenu === 'forward') {
      setActiveHistoryMenu(null);
      return;
    }
    onNext();
  };

  const handleForwardContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (canGoForward && forwardHistory && forwardHistory.length > 0) {
      setActiveHistoryMenu((prev) => (prev === 'forward' ? null : 'forward'));
    }
  };

  const reversedBackHistory = React.useMemo(() => {
    if (!backHistory) return [];
    return backHistory
      .map((path, originalIndex) => ({ path, originalIndex }))
      .reverse();
  }, [backHistory]);

  const reversedForwardHistory = React.useMemo(() => {
    if (!forwardHistory) return [];
    return forwardHistory
      .map((path, originalIndex) => ({ path, originalIndex }))
      .reverse();
  }, [forwardHistory]);

  // Sync address input when currentPath changes from outside
  useEffect(() => {
    setAddressInput(currentPath);
  }, [currentPath]);

  // Sync search input
  useEffect(() => {
    setLocalSearch(searchQuery);
  }, [searchQuery]);

  // Debounce search filter
  useEffect(() => {
    const timer = setTimeout(() => {
      if (localSearch !== searchQuery) {
        onSearchChange(localSearch);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [localSearch, searchQuery, onSearchChange]);

  // Close brand dropdown on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (brandMenuRef.current && !brandMenuRef.current.contains(e.target as Node)) {
        setIsBrandMenuOpen(false);
      }
    };
    if (isBrandMenuOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [isBrandMenuOpen]);

  const handleAddressKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const trimmed = addressInput.trim();
      if (trimmed) {
        onNavigatePath(trimmed);
      }
    } else if (e.key === 'Escape') {
      setAddressInput(currentPath);
    }
  };

  const [isMaximized, setIsMaximized] = useState(false);

  // 창 최대화 상태 감지
  useEffect(() => {
    let isMounted = true;
    const checkMaximized = async () => {
      try {
        const max = await invoke<boolean>('is_window_maximized');
        if (isMounted) setIsMaximized(max);
      } catch {
        try {
          const appWindow = getCurrentWindow();
          const max = await appWindow.isMaximized();
          if (isMounted) setIsMaximized(max);
        } catch {
          // ignore
        }
      }
    };

    checkMaximized();

    try {
      const appWindow = getCurrentWindow();
      const unlistenPromise = appWindow.onResized(() => {
        checkMaximized();
      });

      return () => {
        isMounted = false;
        unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
      };
    } catch {
      // fallback
    }
  }, []);

  const handleToggleMaximize = async (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    try {
      const newMax = await invoke<boolean>('toggle_maximize');
      setIsMaximized(newMax);
    } catch (err) {
      console.warn('Rust toggle_maximize fallback to getCurrentWindow:', err);
      try {
        const appWindow = getCurrentWindow();
        await appWindow.toggleMaximize();
        setIsMaximized(await appWindow.isMaximized());
      } catch (e2) {
        console.error('Failed to toggle maximize:', e2);
      }
    }
  };

  const handleCloseWindow = async (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    try {
      await invoke('close_window');
    } catch (err) {
      console.warn('Rust close_window fallback to getCurrentWindow:', err);
      try {
        const appWindow = getCurrentWindow();
        await appWindow.close();
      } catch (e2) {
        console.error('Failed to close window:', e2);
      }
    }
  };

  const isDraggingBrandRef = useRef(false);
  const brandMouseDownPosRef = useRef<{ x: number; y: number } | null>(null);

  const handleBrandMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      isDraggingBrandRef.current = false;
      brandMouseDownPosRef.current = { x: e.screenX, y: e.screenY };
    }
  };

  const handleBrandMouseMove = (e: React.MouseEvent) => {
    if (brandMouseDownPosRef.current && !isDraggingBrandRef.current) {
      const dist = Math.hypot(
        e.screenX - brandMouseDownPosRef.current.x,
        e.screenY - brandMouseDownPosRef.current.y
      );
      if (dist > 4) {
        isDraggingBrandRef.current = true;
        try {
          getCurrentWindow().startDragging();
        } catch (err) {
          console.warn('startDragging failed:', err);
        }
      }
    }
  };

  const handleBrandMouseUp = () => {
    brandMouseDownPosRef.current = null;
  };

  const handleBrandClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDraggingBrandRef.current) {
      isDraggingBrandRef.current = false;
      return;
    }
    setIsBrandMenuOpen((prev) => !prev);
  };

  return (
    <header className="mhz-toolbar">
      {/* 1. Left Group: Brand & Nav Buttons */}
      <div className="mhz-toolbar-group">
        {/* Brand Dropdown Menu */}
        <div className="brand-menu-wrapper" ref={brandMenuRef}>
          <button
            type="button"
            className={`brand-badge-btn ${isBrandMenuOpen ? 'active' : ''}`}
            onMouseDown={handleBrandMouseDown}
            onMouseMove={handleBrandMouseMove}
            onMouseUp={handleBrandMouseUp}
            onClick={handleBrandClick}
            title="MHZipy Menu (Click: Open Menu, Drag: Move Window)"
          >
            <img src={logoImg} alt="MHZipy" className="brand-app-icon" />
            <span className="brand-title">MHZipy</span>
            <ChevronDown size={13} className="brand-arrow" />
          </button>

          {isBrandMenuOpen && (
            <div className="brand-dropdown-menu" onMouseDown={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="brand-menu-item"
                onClick={() => {
                  setIsBrandMenuOpen(false);
                  onPreference();
                }}
              >
                <Settings size={15} />
                <span className="menu-text">{t('preferences.title', 'Preferences')}</span>
                <span className="menu-shortcut">Alt+P</span>
              </button>

              <button
                type="button"
                className="brand-menu-item"
                onClick={() => {
                  setIsBrandMenuOpen(false);
                  onLicense();
                }}
              >
                <ShieldCheck size={15} />
                <span className="menu-text">{t('preferences.license', 'License')}</span>
              </button>

              <div className="brand-menu-divider" />

              <button
                type="button"
                className="brand-menu-item"
                onClick={() => {
                  setIsBrandMenuOpen(false);
                  onAbout();
                }}
              >
                <Info size={15} />
                <span className="menu-text">{t('menu.about', 'About MHZipy')}</span>
              </button>

              <button
                type="button"
                className="brand-menu-item"
                onClick={() => {
                  setIsBrandMenuOpen(false);
                  onOpenSource();
                }}
              >
                <BookOpen size={15} />
                <span className="menu-text">{t('menu.openSource', 'Open Source')}</span>
              </button>
            </div>
          )}
        </div>

        <div className="mhz-toolbar-divider" />

        {/* Back Button with Long-press / Right-click History Dropdown */}
        <div className="tb-nav-btn-wrapper" ref={backNavRef}>
          <button
            type="button"
            className={`tb-btn ${activeHistoryMenu === 'back' ? 'active' : ''}`}
            onClick={handleBackClick}
            onMouseDown={handleBackMouseDown}
            onMouseUp={handleBackMouseUp}
            onMouseLeave={handleNavMouseLeave}
            onContextMenu={handleBackContextMenu}
            disabled={!canGoBack}
            title={`${t('menu.back', 'Back')} (Alt+Left)`}
          >
            <ChevronLeft size={16} />
          </button>

          {activeHistoryMenu === 'back' && canGoBack && reversedBackHistory.length > 0 && (
            <div className="tb-history-dropdown" onMouseDown={(e) => e.stopPropagation()}>
              <div className="tb-history-header">
                {t('toolbar.historyBack', 'History (Back)')}
              </div>
              {reversedBackHistory.map((item) => {
                const isDrive = /^[A-Za-z]:[\\/]?$/.test(item.path);
                const name = getFolderName(item.path);
                return (
                  <button
                    key={`back-hist-${item.originalIndex}`}
                    type="button"
                    className="tb-history-item"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveHistoryMenu(null);
                      onJumpBack?.(item.originalIndex);
                    }}
                    title={item.path}
                  >
                    <span className="tb-history-item-icon">
                      {isDrive ? <HardDrive size={15} /> : <Folder size={15} />}
                    </span>
                    <div className="tb-history-item-info">
                      <span className="tb-history-item-name">{name}</span>
                      <span className="tb-history-item-path">{item.path}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Forward Button with Long-press / Right-click History Dropdown */}
        <div className="tb-nav-btn-wrapper" ref={forwardNavRef}>
          <button
            type="button"
            className={`tb-btn ${activeHistoryMenu === 'forward' ? 'active' : ''}`}
            onClick={handleForwardClick}
            onMouseDown={handleForwardMouseDown}
            onMouseUp={handleForwardMouseUp}
            onMouseLeave={handleNavMouseLeave}
            onContextMenu={handleForwardContextMenu}
            disabled={!canGoForward}
            title={`${t('menu.forward', 'Forward')} (Alt+Right)`}
          >
            <ChevronRight size={16} />
          </button>

          {activeHistoryMenu === 'forward' && canGoForward && reversedForwardHistory.length > 0 && (
            <div className="tb-history-dropdown" onMouseDown={(e) => e.stopPropagation()}>
              <div className="tb-history-header">
                {t('toolbar.historyForward', 'History (Forward)')}
              </div>
              {reversedForwardHistory.map((item) => {
                const isDrive = /^[A-Za-z]:[\\/]?$/.test(item.path);
                const name = getFolderName(item.path);
                return (
                  <button
                    key={`fwd-hist-${item.originalIndex}`}
                    type="button"
                    className="tb-history-item"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveHistoryMenu(null);
                      onJumpForward?.(item.originalIndex);
                    }}
                    title={item.path}
                  >
                    <span className="tb-history-item-icon">
                      {isDrive ? <HardDrive size={15} /> : <Folder size={15} />}
                    </span>
                    <div className="tb-history-item-info">
                      <span className="tb-history-item-name">{name}</span>
                      <span className="tb-history-item-path">{item.path}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {onGoUp && (
          <button
            type="button"
            className="tb-btn"
            onClick={onGoUp}
            disabled={!canGoUp}
            title={`${t('menu.up', 'Up')} (Alt+Up)`}
          >
            <ArrowUp size={16} />
          </button>
        )}

        {onRefresh && (
          <button
            type="button"
            className="tb-btn"
            onClick={onRefresh}
            title={`${t('menu.refresh', 'Refresh')} (F5 / Ctrl+R)`}
          >
            <RotateCw size={15} />
          </button>
        )}
      </div>

      {/* 2. Center Group: Address Bar & In-Folder Filter */}
      {currentView === 'folder' && (
        <div className="tb-path-search-group">
          <div className="tb-address-bar" title={t('toolbar.currentLocation', 'Current Location (Press Enter to go)')}>
            <Folder size={15} color="#38bdf8" style={{ flexShrink: 0 }} />
            <input
              type="text"
              className="tb-address-input"
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
              onKeyDown={handleAddressKeyDown}
              placeholder={t('toolbar.enterPath', 'Enter directory path...')}
              spellCheck={false}
            />
          </div>

          <div className="tb-search-filter" title={t('menu.searchPlaceholder', 'Filter files in current folder')}>
            <Search size={14} color="#94a3b8" style={{ flexShrink: 0 }} />
            <input
              type="text"
              className="tb-search-input"
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder={t('toolbar.filterPlaceholder', 'Filter...')}
              spellCheck={false}
            />
            {localSearch && (
              <button
                type="button"
                className="tb-clear-btn"
                onClick={() => setLocalSearch('')}
                title={t('toolbar.clearFilter', 'Clear filter')}
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* 3. Action Buttons Group */}
      <div className="mhz-toolbar-group mhz-action-buttons">
        <div className="mhz-toolbar-divider" />

        {/* Compress Action */}
        <button
          type="button"
          className={`tb-btn ${hasSelectedFiles ? 'primary' : ''}`}
          onClick={onCompress}
          disabled={!hasSelectedFiles}
          title={`${t('fileList.compress', 'Compress')} (Alt+C)`}
        >
          <Package size={15} />
          <span className="tb-btn-text">{t('fileList.compress', 'Compress')}</span>
        </button>

        {/* Extract Action (Highlighted if ZIP selected) */}
        <button
          type="button"
          className={`tb-btn ${isZipSelected ? 'highlight-zip' : ''}`}
          onClick={onExtract}
          disabled={!isZipSelected}
          title={`${t('fileList.extract', 'Extract')} (Alt+E)`}
        >
          <PackageOpen size={15} />
          <span className="tb-btn-text">{t('fileList.extract', 'Extract')}</span>
        </button>

        {/* New Folder */}
        <button
          type="button"
          className="tb-btn"
          onClick={onNewFolder}
          title={`${t('contextMenu.createFolder', 'New Folder')} (Ctrl+Shift+N)`}
        >
          <FolderPlus size={15} />
          <span className="tb-btn-text">{t('contextMenu.createFolder', 'New Folder')}</span>
        </button>

        {/* New MD File */}
        <button
          type="button"
          className="tb-btn"
          onClick={onNewMdFile}
          title={`${t('contextMenu.createMarkdownFile', 'New MD File')} (Ctrl+Shift+M)`}
        >
          <FilePlus size={15} />
          <span className="tb-btn-text">{t('contextMenu.createMarkdownFile', 'New MD File')}</span>
        </button>
      </div>

      {/* 4. Drag Spacer: 빈 공간을 마우스로 잡고 창 이동 & 더블클릭 시 최대화/원래사이즈 토글 */}
      <div
        className="mhz-toolbar-drag-spacer"
        data-tauri-drag-region
        onMouseDown={(e) => {
          if (e.button === 0) {
            try {
              getCurrentWindow().startDragging();
            } catch {}
          }
        }}
        onDoubleClick={handleToggleMaximize}
        title="Drag to move window, double-click to toggle maximize"
      />

      {/* 5. Right Unified Controls: Folder/Search Button + Maximize/Close Buttons */}
      <div className="mhz-toolbar-group mhz-right-controls" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mhz-toolbar-divider" />

        {/* Folder / Search Button Switcher */}
        <div className="tb-view-switch">
          <button
            type="button"
            className={`tb-view-option ${currentView === 'folder' ? 'active' : ''}`}
            onClick={() => onToggleView('folder')}
            title={t('menu.folderView', 'Folder View')}
          >
            <Folder size={13} />
            <span>{t('menu.folderView', 'Folder')}</span>
          </button>
          <button
            type="button"
            className={`tb-view-option ${currentView === 'search' ? 'active' : ''}`}
            onClick={() => onToggleView('search')}
            title={t('menu.search', 'Search')}
          >
            <Search size={13} />
            <span>{t('menu.search', 'Search')}</span>
          </button>
        </div>

        {/* Window Controls: 바로 옆에 확대/원래사이즈 토글 및 Close(트레이) 버튼 배치 */}
        <div className="mhz-window-controls">
          <button
            type="button"
            className="mhz-win-ctrl-btn"
            onClick={handleToggleMaximize}
            onMouseDown={(e) => e.stopPropagation()}
            title={isMaximized ? t('viewer.restore', 'Restore Down') : t('viewer.maximize', 'Maximize')}
          >
            {isMaximized ? (
              <Copy size={13} style={{ transform: 'rotate(180deg)' }} />
            ) : (
              <Square size={12} />
            )}
          </button>

          <button
            type="button"
            className="mhz-win-ctrl-btn mhz-win-ctrl-close"
            onClick={handleCloseWindow}
            onMouseDown={(e) => e.stopPropagation()}
            title={getCurrentWindow().label === 'main' ? t('viewer.close', 'Close to System Tray') : t('viewer.close', 'Close Window')}
          >
            <X size={15} />
          </button>
        </div>
      </div>
    </header>
  );
};

export default Toolbar;

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
  Copy,
  ClipboardPaste,
  Trash2,
  Settings,
  Info,
  BookOpen,
  ShieldCheck,
  ChevronDown,
  X,
} from 'lucide-react';
import logoImg from '../../assets/logo.png';
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
  onCopy: () => void;
  onPaste: () => void;
  canPaste: boolean;
  onDelete: () => void;

  // View Switcher
  currentView: 'folder' | 'search';
  onToggleView: (view: 'folder' | 'search') => void;
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
  currentPath,
  onNavigatePath,
  searchQuery,
  onSearchChange,
  hasSelectedFiles,
  isZipSelected,
  onCompress,
  onExtract,
  onNewFolder,
  onCopy,
  onPaste,
  canPaste,
  onDelete,
  currentView,
  onToggleView,
}) => {
  const [isBrandMenuOpen, setIsBrandMenuOpen] = useState(false);
  const brandMenuRef = useRef<HTMLDivElement>(null);

  const [addressInput, setAddressInput] = useState(currentPath);
  const [localSearch, setLocalSearch] = useState(searchQuery);

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

  return (
    <header className="mhz-toolbar">
      {/* 1. Left Group: Brand & Nav Buttons */}
      <div className="mhz-toolbar-group">
        {/* Brand Dropdown Menu */}
        <div className="brand-menu-wrapper" ref={brandMenuRef}>
          <button
            type="button"
            className={`brand-badge-btn ${isBrandMenuOpen ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setIsBrandMenuOpen((prev) => !prev);
            }}
            title="MHZipy Menu (Settings, About, License)"
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
                <span className="menu-text">Preferences</span>
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
                <span className="menu-text">License</span>
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
                <span className="menu-text">About MHZipy</span>
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
                <span className="menu-text">Open Source</span>
              </button>
            </div>
          )}
        </div>

        <div className="mhz-toolbar-divider" />

        {/* Directory Navigation Buttons */}
        <button
          type="button"
          className="tb-btn"
          onClick={onBack}
          disabled={!canGoBack}
          title="Back (Alt+Left)"
        >
          <ChevronLeft size={16} />
        </button>

        <button
          type="button"
          className="tb-btn"
          onClick={onNext}
          disabled={!canGoForward}
          title="Forward (Alt+Right)"
        >
          <ChevronRight size={16} />
        </button>

        {onGoUp && (
          <button
            type="button"
            className="tb-btn"
            onClick={onGoUp}
            disabled={!canGoUp}
            title="Up to Parent Directory (Alt+Up)"
          >
            <ArrowUp size={16} />
          </button>
        )}

        {onRefresh && (
          <button
            type="button"
            className="tb-btn"
            onClick={onRefresh}
            title="Refresh (F5 / Ctrl+R)"
          >
            <RotateCw size={15} />
          </button>
        )}
      </div>

      {/* 2. Center Group: Address Bar & In-Folder Filter */}
      {currentView === 'folder' && (
        <div className="tb-path-search-group">
          <div className="tb-address-bar" title="Current Location (Press Enter to go)">
            <Folder size={15} color="#38bdf8" style={{ flexShrink: 0 }} />
            <input
              type="text"
              className="tb-address-input"
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
              onKeyDown={handleAddressKeyDown}
              placeholder="Enter directory path..."
              spellCheck={false}
            />
          </div>

          <div className="tb-search-filter" title="Filter files in current folder">
            <Search size={14} color="#94a3b8" style={{ flexShrink: 0 }} />
            <input
              type="text"
              className="tb-search-input"
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder="Filter..."
              spellCheck={false}
            />
            {localSearch && (
              <button
                type="button"
                className="tb-clear-btn"
                onClick={() => setLocalSearch('')}
                title="Clear filter"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* 3. Action Buttons Group */}
      <div className="mhz-toolbar-group">
        <div className="mhz-toolbar-divider" />

        {/* Compress Action */}
        <button
          type="button"
          className={`tb-btn ${hasSelectedFiles ? 'primary' : ''}`}
          onClick={onCompress}
          disabled={!hasSelectedFiles}
          title="Compress Selected Items to ZIP (Alt+C)"
        >
          <Package size={15} />
          <span className="tb-btn-text">Compress</span>
        </button>

        {/* Extract Action (Highlighted if ZIP selected) */}
        <button
          type="button"
          className={`tb-btn ${isZipSelected ? 'highlight-zip' : ''}`}
          onClick={onExtract}
          disabled={!isZipSelected}
          title="Extract Archive (Alt+E)"
        >
          <PackageOpen size={15} />
          <span className="tb-btn-text">Extract</span>
        </button>

        {/* New Folder */}
        <button
          type="button"
          className="tb-btn"
          onClick={onNewFolder}
          title="Create New Folder (Ctrl+Shift+N)"
        >
          <FolderPlus size={15} />
          <span className="tb-btn-text">New Folder</span>
        </button>

        {/* Copy */}
        <button
          type="button"
          className="tb-btn"
          onClick={onCopy}
          disabled={!hasSelectedFiles}
          title="Copy Selected Files (Ctrl+C)"
        >
          <Copy size={14} />
          <span className="tb-btn-text">Copy</span>
        </button>

        {/* Paste */}
        <button
          type="button"
          className="tb-btn"
          onClick={onPaste}
          disabled={!canPaste}
          title="Paste from Clipboard (Ctrl+V)"
        >
          <ClipboardPaste size={14} />
          <span className="tb-btn-text">Paste</span>
        </button>

        {/* Delete */}
        <button
          type="button"
          className="tb-btn tb-btn-danger"
          onClick={onDelete}
          disabled={!hasSelectedFiles}
          title="Delete to Recycle Bin (Del)"
        >
          <Trash2 size={14} />
          <span className="tb-btn-text">Delete</span>
        </button>
      </div>

      {/* 4. Right Group: View Switcher & Settings */}
      <div className="mhz-toolbar-group">
        <div className="mhz-toolbar-divider" />

        <div className="tb-view-switch">
          <button
            type="button"
            className={`tb-view-option ${currentView === 'folder' ? 'active' : ''}`}
            onClick={() => onToggleView('folder')}
            title="Explorer Folder View"
          >
            <Folder size={13} />
            <span>Folder</span>
          </button>
          <button
            type="button"
            className={`tb-view-option ${currentView === 'search' ? 'active' : ''}`}
            onClick={() => onToggleView('search')}
            title="Ultra-fast MFT Index Search"
          >
            <Search size={13} />
            <span>Search</span>
          </button>
        </div>
      </div>
    </header>
  );
};

export default Toolbar;

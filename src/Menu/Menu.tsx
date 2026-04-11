import { useState, useEffect } from 'react';
import './Menu.css';

interface MenuProps {
  onPreference: () => void;
  currentView: 'folder' | 'search';
  onToggleView: () => void;
  onSearch: (query: string) => void;
  onBack: () => void;
  canGoBack: boolean;
  onNext: () => void;
  canGoForward: boolean;
  searchQuery?: string;
}

export default function Menu({ onPreference, currentView, onToggleView, onSearch, onBack, canGoBack, onNext, canGoForward, searchQuery }: MenuProps) {
  const [localSearch, setLocalSearch] = useState(searchQuery || '');

  // Sync from parent if it changes
  useEffect(() => {
    if (searchQuery !== undefined && searchQuery !== localSearch) {
      setLocalSearch(searchQuery);
    }
  }, [searchQuery]);

  // Debounce search input
  useEffect(() => {
    const handler = setTimeout(() => {
      if (localSearch !== searchQuery) {
        onSearch(localSearch);
      }
    }, 300);
    return () => clearTimeout(handler);
  }, [localSearch, onSearch, searchQuery]);

  return (
    <div className="menu-bar">
      <div className="menu-left">
        {currentView === 'folder' && (
          <div className="navigation-buttons">
            <button onClick={onBack} disabled={!canGoBack} className="menu-button" title="Back">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
            </button>
            <button onClick={onNext} disabled={!canGoForward} className="menu-button" title="Forward">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
            </button>
          </div>
        )}
      </div>
      <div className="menu-center">
        {currentView === 'folder' && (
          <div className="search-container">
            <span className="search-icon">🔎</span>
            <input
              type="text"
              placeholder="Filter files in current folder..."
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              className="search-input"
            />
            {localSearch && (
              <button onClick={() => setLocalSearch('')} className="clear-search-button">✕</button>
            )}
          </div>
        )}
      </div>
      <div className="menu-right">
        <div className="view-toggle">
          <label className={`toggle-option ${currentView === 'folder' ? 'active' : ''}`} onClick={currentView === 'search' ? onToggleView : undefined}>
            <input type="radio" name="view" readOnly checked={currentView === 'folder'} />
            📂 Folder
          </label>
          <label className={`toggle-option ${currentView === 'search' ? 'active' : ''}`} onClick={currentView === 'folder' ? onToggleView : undefined}>
            <input type="radio" name="view" readOnly checked={currentView === 'search'} />
            🔍 Search
          </label>
        </div>
        <button onClick={onPreference} className="menu-button" title="Preferences" tabIndex={-1}>
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 0 2l-.15.08a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l-.22-.38a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1 0-2l.15-.08a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
    </div>
  );
}
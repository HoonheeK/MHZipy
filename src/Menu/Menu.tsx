import { useState } from 'react';
import "./Menu.css";
import logo from "../assets/logo.png";

interface MenuProps {
  onPreference?: () => void;
  currentView: 'folder' | 'search';
  onToggleView: () => void;
  onSearch?: (query: string) => void;
  onBack?: () => void;
  canGoBack?: boolean;
}

export default function Menu({ onPreference, currentView, onToggleView, onSearch, onBack, canGoBack }: MenuProps) {
  const [searchTerm, setSearchTerm] = useState('');

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && onSearch) {
      console.log('Search Enter pressed. Query:', searchTerm);
      onSearch(searchTerm);
    } else if (e.key === 'Escape') {
      setSearchTerm('');
      if (onSearch) onSearch('');
    }
  };

  return (
    <header className="mhz-menu">
      <nav className="mhz-menu__nav">
        <button 
          className="mhz-btn" 
          style={{ marginTop: "12px", opacity: canGoBack ? 1 : 0.5, cursor: canGoBack ? 'pointer' : 'default', marginRight: '8px' }} 
          onClick={canGoBack ? onBack : undefined}
          disabled={!canGoBack}
        >
          Back
        </button>
        <button className="mhz-btn" style={{ marginTop: "12px"}} onClick={onPreference}>Preference</button>
        {/* <button className="mhz-btn" style={{ marginTop: "12px"}} >Edit</button> */}
        <button className="mhz-btn" style={{ marginTop: "12px"}} onClick={onToggleView}>
          {currentView === 'folder' ? 'Search View' : 'Folder View'}
        </button>
        {/* <button className="mhz-btn" style={{ marginTop: "12px"}} onClick={onAutoFitColumns}>Auto-fit Columns</button> */}
        <input 
          type="text" 
          className="mhz-search-input" 
          placeholder="Search..." 
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </nav>
      <div className="mhz-menu__brand"><img src={logo} alt="MHZipy" /></div>
    </header>
  );
}

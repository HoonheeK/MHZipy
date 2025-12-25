import { useState } from 'react';
import "./Menu.css";

interface MenuProps {
  onPreference?: () => void;
  currentView: 'folder' | 'search';
  onToggleView: () => void;
  onSearch?: (query: string) => void;
}

export default function Menu({ onPreference, currentView, onToggleView, onSearch }: MenuProps) {
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
        <button className="mhz-btn" style={{ marginTop: "12px"}} onClick={onPreference}>Preference</button>
        {/* <button className="mhz-btn" style={{ marginTop: "12px"}} >Edit</button> */}
        <button className="mhz-btn" style={{ marginTop: "12px"}} onClick={onToggleView}>
          {currentView === 'folder' ? 'Search View' : 'Folder View'}
        </button>
        <input 
          type="text" 
          className="mhz-search-input" 
          placeholder="Search..." 
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </nav>
      <div className="mhz-menu__brand"><img src="./src/assets/logo.png" alt="MHZipy" /></div>
    </header>
  );
}

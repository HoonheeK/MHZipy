import "./Menu.css";

interface MenuProps {
  onPreference?: () => void;
  currentView: 'folder' | 'search';
  onToggleView: () => void;
}

export default function Menu({ onPreference, currentView, onToggleView }: MenuProps) {
  return (
    <header className="mhz-menu">
      <nav className="mhz-menu__nav">
        <button className="mhz-btn" style={{ marginTop: "12px"}} onClick={onPreference}>Preference</button>
        {/* <button className="mhz-btn" style={{ marginTop: "12px"}} >Edit</button> */}
        <button className="mhz-btn" style={{ marginTop: "12px"}} onClick={onToggleView}>
          {currentView === 'folder' ? 'Search View' : 'Folder View'}
        </button>
        <input type="text" className="mhz-search-input" placeholder="Search..." />
      </nav>
      <div className="mhz-menu__brand"><img src="./src/assets/logo.png" alt="MHZipy" /></div>
    </header>
  );
}

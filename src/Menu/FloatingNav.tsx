import { useState, useRef, useEffect } from 'react';
import './FloatingNav.css';

interface FloatingNavProps {
  onAbout: () => void;
  onOpenSource: () => void;
}

export default function FloatingNav({ onAbout, onOpenSource }: FloatingNavProps) {
  const [expanded, setExpanded] = useState(false);
  const widgetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (widgetRef.current && !widgetRef.current.contains(event.target as Node)) {
        setExpanded(false);
      }
    };
    if (expanded) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [expanded]);

  return (
    <div className="floating-nav-container">
      <div 
        ref={widgetRef}
        className={`floating-nav-widget ${expanded ? 'expanded' : ''}`}
        onClick={() => {
          if (!expanded) setExpanded(true);
        }}
      >
        <div className="floating-nav-icon" title="Menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </div>
        
        <div className="floating-nav-content">
          <button className="floating-nav-btn" onClick={(e) => { e.stopPropagation(); onAbout(); setExpanded(false); }}>
            About
          </button>
          <div className="floating-nav-divider"></div>
          <button className="floating-nav-btn" onClick={(e) => { e.stopPropagation(); onOpenSource(); setExpanded(false); }}>
            Open Source
          </button>
          <div className="floating-nav-divider"></div>
          <button className="floating-nav-close" onClick={(e) => { e.stopPropagation(); setExpanded(false); }} title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

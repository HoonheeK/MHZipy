import { open } from '@tauri-apps/plugin-shell';

interface OpenSourceDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function OpenSourceDialog({ isOpen, onClose }: OpenSourceDialogProps) {
  if (!isOpen) return null;

  const handleLink = (e: React.MouseEvent<HTMLAnchorElement>, url: string) => {
    e.preventDefault();
    open(url).catch(console.error);
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(15,23,42,0.7)',
      backdropFilter: 'blur(4px)',
      zIndex: 100000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'fadeIn 0.2s ease'
    }} onClick={onClose}>
      <div style={{
        backgroundColor: '#1e293b',
        border: '1px solid rgba(255,255,255,0.1)',
        padding: '32px',
        borderRadius: '16px',
        width: '90%',
        maxWidth: '600px',
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
        color: '#f8fafc',
        position: 'relative'
      }} onClick={e => e.stopPropagation()}>
        <button 
          onClick={onClose}
          style={{
            position: 'absolute', top: '16px', right: '16px',
            background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer'
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
        <h2 style={{ margin: '0 0 20px 0', fontSize: '1.5rem', fontWeight: 600 }}>Open Source Licenses</h2>
        
        <div style={{ flex: 1, overflowY: 'auto', paddingRight: '12px', color: '#cbd5e1', fontSize: '0.9rem', lineHeight: '1.6' }}>
          <div style={{ marginBottom: '24px' }}>
            <h3 style={{ margin: '0 0 8px 0', color: '#f8fafc' }}>Tauri</h3>
            <p style={{ margin: '0 0 4px 0', fontSize: '0.85rem', color: '#94a3b8' }}>Copyright (c) 2019-present, Tauri Contributors</p>
            <p style={{ margin: 0 }}>
              Licensed under <a href="#" onClick={(e) => handleLink(e, 'https://github.com/tauri-apps/tauri/blob/dev/LICENSE_MIT')} style={{ color: '#60a5fa', textDecoration: 'none' }}>MIT</a> / <a href="#" onClick={(e) => handleLink(e, 'https://github.com/tauri-apps/tauri/blob/dev/LICENSE_APACHE')} style={{ color: '#60a5fa', textDecoration: 'none' }}>Apache 2.0</a>
            </p>
          </div>
          <div style={{ marginBottom: '24px' }}>
            <h3 style={{ margin: '0 0 8px 0', color: '#f8fafc' }}>React</h3>
            <p style={{ margin: '0 0 4px 0', fontSize: '0.85rem', color: '#94a3b8' }}>Copyright (c) Meta Platforms, Inc. and affiliates.</p>
            <p style={{ margin: 0 }}>
              Licensed under <a href="#" onClick={(e) => handleLink(e, 'https://github.com/facebook/react/blob/main/LICENSE')} style={{ color: '#60a5fa', textDecoration: 'none' }}>MIT</a>
            </p>
          </div>
          <div style={{ marginBottom: '24px' }}>
            <h3 style={{ margin: '0 0 8px 0', color: '#f8fafc' }}>Vite</h3>
            <p style={{ margin: '0 0 4px 0', fontSize: '0.85rem', color: '#94a3b8' }}>Copyright (c) 2019-present, Yuxi (Evan) You and Vite contributors</p>
            <p style={{ margin: 0 }}>
              Licensed under <a href="#" onClick={(e) => handleLink(e, 'https://github.com/vitejs/vite/blob/main/LICENSE')} style={{ color: '#60a5fa', textDecoration: 'none' }}>MIT</a>
            </p>
          </div>
          <div style={{ marginBottom: '24px' }}>
            <h3 style={{ margin: '0 0 8px 0', color: '#f8fafc' }}>Lucide Icons</h3>
            <p style={{ margin: '0 0 4px 0', fontSize: '0.85rem', color: '#94a3b8' }}>Copyright (c) 2020-present Lucide Contributors</p>
            <p style={{ margin: 0 }}>
              Licensed under <a href="#" onClick={(e) => handleLink(e, 'https://github.com/lucide-icons/lucide/blob/main/LICENSE')} style={{ color: '#60a5fa', textDecoration: 'none' }}>ISC</a>
            </p>
          </div>
          <div style={{ marginBottom: '24px' }}>
            <h3 style={{ margin: '0 0 8px 0', color: '#f8fafc' }}>Rust Crates (zip, serde, rayon, etc.)</h3>
            <p style={{ margin: '0 0 4px 0', fontSize: '0.85rem', color: '#94a3b8' }}>Various Copyrights held by their respective authors</p>
            <p style={{ margin: 0 }}>
              Primarily licensed under <a href="#" onClick={(e) => handleLink(e, 'https://opensource.org/licenses/MIT')} style={{ color: '#60a5fa', textDecoration: 'none' }}>MIT</a> / <a href="#" onClick={(e) => handleLink(e, 'https://opensource.org/licenses/Apache-2.0')} style={{ color: '#60a5fa', textDecoration: 'none' }}>Apache 2.0</a>
            </p>
          </div>
          {/* Add more as needed */}
          <div style={{ marginTop: '32px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.1)', fontSize: '0.85rem', color: '#94a3b8' }}>
            This application uses various open-source libraries. We are grateful to the developers and contributors of these projects.
          </div>
        </div>
      </div>
    </div>
  );
}

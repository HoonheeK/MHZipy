import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { checkForUpdates } from '../utils/updater';
import { useTranslation } from 'react-i18next';

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
  disableUpdateCheck?: boolean;
  onToggleUpdateCheck?: (disabled: boolean) => void;
}

export default function AboutDialog({ isOpen, onClose, disableUpdateCheck, onToggleUpdateCheck }: AboutDialogProps) {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string>('');
  const [alertMessage, setAlertMessage] = useState<{title: string, message: string} | null>(null);
  const [confirmAction, setConfirmAction] = useState<{title: string, message: string, onConfirm: () => void} | null>(null);

  useEffect(() => {
    if (isOpen) {
      getVersion().then(setVersion).catch(console.error);
    }
  }, [isOpen]);

  if (!isOpen) return null;

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
        minWidth: '360px',
        maxWidth: '480px',
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
        color: '#f8fafc',
        textAlign: 'center',
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
        <div style={{ marginBottom: '24px' }}>
          <div style={{ width: '88px', height: '88px', margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <img
              src="/app-icon.png"
              alt="MHZipy Icon"
              style={{ width: '84px', height: '84px', borderRadius: '18px', boxShadow: '0 8px 24px rgba(0,0,0,0.45)', objectFit: 'contain' }}
            />
          </div>
        </div>
        <h2 style={{ margin: '0 0 8px 0', fontSize: '1.8rem', fontWeight: 600 }}>MHZipy</h2>
        <p style={{ margin: '0 0 24px 0', color: '#94a3b8', fontSize: '1rem' }}>Version {version}</p>
        
        <div style={{ backgroundColor: '#0f172a', padding: '16px', borderRadius: '8px', marginBottom: '24px', fontSize: '0.9rem', color: '#cbd5e1', lineHeight: '1.5' }}>
          A high-performance file management and archiving tool.
        </div>

        {/* App Updates Section */}
        <div style={{ backgroundColor: '#0f172a', padding: '16px', borderRadius: '8px', marginBottom: '24px', textAlign: 'left' }}>
          <span style={{ fontSize: '1.05rem', fontWeight: 600, color: '#f8fafc', display: 'block', marginBottom: '8px' }}>App Updates</span>
          <p style={{ fontSize: '0.85rem', color: '#94a3b8', margin: '0 0 12px 0' }}>
            Check if a newer version of MHZipy is available.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <button 
              style={{
                backgroundColor: '#3b82f6', color: '#ffffff', border: 'none', padding: '8px 16px',
                borderRadius: '6px', fontSize: '0.9rem', fontWeight: 500, cursor: 'pointer',
                transition: 'background-color 0.2s'
              }}
              onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#2563eb'}
              onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#3b82f6'}
              onClick={(e) => { 
                e.preventDefault(); 
                checkForUpdates(
                  true,
                  (title, message) => setAlertMessage({title, message}),
                  (title, message, onYes) => setConfirmAction({title, message, onConfirm: onYes})
                ); 
              }}
            >
              Check for Updates
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', margin: 0 }}>
              <input
                type="checkbox"
                checked={!disableUpdateCheck}
                onChange={(e) => onToggleUpdateCheck?.(!e.target.checked)}
                style={{ width: '16px', height: '16px', margin: 0, cursor: 'pointer' }}
              />
              <span style={{ fontSize: '0.9rem', color: '#cbd5e1' }}>
                {t('preferences.checkOnStartup', 'Check on Startup')}
              </span>
            </label>
          </div>
        </div>

        <div style={{ margin: '0 0 24px 0', fontSize: '0.95rem' }}>
          <a 
            href="#" 
            onClick={(e) => {
              e.preventDefault();
              import('@tauri-apps/plugin-shell').then(({ open }) => open('https://www.marh-sw.com'));
            }}
            style={{ color: '#60a5fa', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 500, transition: 'color 0.2s' }}
            onMouseOver={(e) => (e.currentTarget.style.color = '#93c5fd')}
            onMouseOut={(e) => (e.currentTarget.style.color = '#60a5fa')}
          >
            www.marh-sw.com
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
          </a>
        </div>

        <p style={{ margin: 0, fontSize: '0.85rem', color: '#64748b' }}>
          &copy; {new Date().getFullYear()} Marh Software. All rights reserved.
        </p>
      </div>

      {/* Custom Alert Modal */}
      {alertMessage && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,23,42,0.6)', zIndex: 100001, display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fadeIn 0.2s ease' }} onClick={e => e.stopPropagation()}>
          <div style={{ backgroundColor: '#ffffff', padding: '24px', borderRadius: '12px', minWidth: '320px', maxWidth: '400px', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, marginBottom: '12px', color: '#0f172a', fontSize: '1.2rem', fontWeight: 600 }}>{alertMessage.title}</h3>
            <p style={{ color: '#475569', marginBottom: '24px', fontSize: '0.95rem', lineHeight: '1.5' }}>{alertMessage.message}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button 
                style={{ backgroundColor: '#3b82f6', color: '#ffffff', border: 'none', padding: '8px 16px', borderRadius: '6px', fontSize: '0.9rem', cursor: 'pointer' }}
                onClick={() => setAlertMessage(null)}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Confirm Modal */}
      {confirmAction && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,23,42,0.6)', zIndex: 100001, display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fadeIn 0.2s ease' }} onClick={e => e.stopPropagation()}>
          <div style={{ backgroundColor: '#ffffff', padding: '24px', borderRadius: '12px', minWidth: '320px', maxWidth: '400px', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, marginBottom: '12px', color: '#0f172a', fontSize: '1.2rem', fontWeight: 600 }}>{confirmAction.title}</h3>
            <p style={{ color: '#475569', marginBottom: '24px', fontSize: '0.95rem', lineHeight: '1.5' }}>{confirmAction.message}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button 
                style={{ backgroundColor: '#f1f5f9', color: '#475569', border: '1px solid #cbd5e1', padding: '8px 16px', borderRadius: '6px', fontSize: '0.9rem', cursor: 'pointer' }}
                onClick={() => setConfirmAction(null)}
              >
                Cancel
              </button>
              <button 
                style={{ backgroundColor: '#3b82f6', color: '#ffffff', border: 'none', padding: '8px 16px', borderRadius: '6px', fontSize: '0.9rem', cursor: 'pointer' }}
                onClick={() => { confirmAction.onConfirm(); setConfirmAction(null); }}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


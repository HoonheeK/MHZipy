import { createPortal } from 'react-dom';

interface ErrorDialogProps {
  open: boolean;
  title?: string;
  message?: string;
  details?: string;
  onClose: () => void;
}

export default function ErrorDialog({ open, title = 'Notification', message = '', details, onClose }: ErrorDialogProps) {
  if (!open) return null;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(10, 15, 29, 0.75)', backdropFilter: 'blur(8px)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} style={{ width: '520px', maxWidth: '95%', background: '#0f172a', color: '#f8fafc', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: 12, boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 24px rgba(56, 189, 248, 0.15)', overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', fontWeight: 'bold', backgroundColor: 'rgba(17, 24, 39, 0.8)', color: '#f1f5f9' }}>{title}</div>
        <div style={{ padding: '16px 18px', color: '#cbd5e1' }}>
          <div style={{ marginBottom: 10 }}>{message}</div>
          {details && (
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#1e293b', padding: 10, borderRadius: 6, fontSize: '0.85em', color: '#f87171', border: '1px solid rgba(255, 255, 255, 0.06)' }}>{details}</pre>
          )}
        </div>
        <div style={{ padding: '12px 18px', borderTop: '1px solid rgba(255, 255, 255, 0.08)', backgroundColor: 'rgba(17, 24, 39, 0.5)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ padding: '8px 18px', cursor: 'pointer', backgroundColor: 'rgba(255, 255, 255, 0.08)', color: '#e2e8f0', border: '1px solid rgba(255, 255, 255, 0.15)', borderRadius: 6, fontWeight: 600 }}>Close</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

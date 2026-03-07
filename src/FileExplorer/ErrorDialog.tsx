
interface ErrorDialogProps {
  open: boolean;
  title?: string;
  message?: string;
  details?: string;
  onClose: () => void;
}

export default function ErrorDialog({ open, title = 'Notification', message = '', details, onClose }: ErrorDialogProps) {
  if (!open) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.45)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} style={{ width: '520px', maxWidth: '95%', background: 'white', borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.25)', overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #eee', fontWeight: 'bold' }}>{title}</div>
        <div style={{ padding: '12px 16px', color: '#222' }}>
          <div style={{ marginBottom: 8 }}>{message}</div>
          {details && (
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#f6f8fa', padding: 8, borderRadius: 4, fontSize: '0.85em', color: '#444' }}>{details}</pre>
          )}
        </div>
        <div style={{ padding: '8px 12px', borderTop: '1px solid #eee', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ padding: '8px 12px', cursor: 'pointer' }}>Close</button>
        </div>
      </div>
    </div>
  );
}

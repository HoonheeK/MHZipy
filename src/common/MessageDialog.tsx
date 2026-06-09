import { useEffect, useRef } from 'react';
import './MessageDialog.css';

interface MessageDialogProps {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
}

export default function MessageDialog({ open, title, message, onClose }: MessageDialogProps) {
  const okButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open && okButtonRef.current) {
      okButtonRef.current.focus();
    }

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (open) {
      window.addEventListener('keydown', handleGlobalKeyDown);
    }
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="message-dialog-overlay" onClick={onClose}>
      <div className="message-dialog" onClick={e => e.stopPropagation()}>
        <div className="message-dialog-header">{title}</div>
        <div className="message-dialog-body">{message}</div>
        <div className="message-dialog-footer">
          <button ref={okButtonRef} onClick={onClose} className="message-dialog-button">OK</button>
        </div>
      </div>
    </div>
  );
}

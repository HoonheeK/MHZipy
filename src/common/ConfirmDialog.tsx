import { useEffect, useRef } from 'react';
import './MessageDialog.css';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  okLabel?: string;
  cancelLabel?: string;
}

export default function ConfirmDialog({ open, title, message, onConfirm, onCancel, okLabel = 'OK', cancelLabel = 'Cancel' }: ConfirmDialogProps) {
  const okButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open && okButtonRef.current) {
      okButtonRef.current.focus();
    }
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (document.activeElement === cancelButtonRef.current) {
        okButtonRef.current?.focus();
      } else {
        cancelButtonRef.current?.focus();
      }
    }
  };

  return (
    <div className="message-dialog-overlay" onClick={onCancel} onKeyDown={handleKeyDown}>
      <div className="message-dialog" onClick={e => e.stopPropagation()}>
        <div className="message-dialog-header">{title}</div>
        <div className="message-dialog-body">{message}</div>
        <div className="message-dialog-footer" style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button ref={cancelButtonRef} onClick={onCancel} className="message-dialog-button">{cancelLabel}</button>
          <button ref={okButtonRef} onClick={onConfirm} className="message-dialog-button">{okLabel}</button>
        </div>
      </div>
    </div>
  );
}
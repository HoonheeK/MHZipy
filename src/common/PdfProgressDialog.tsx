import './PdfProgressDialog.css';

interface PdfProgressDialogProps {
  isOpen: boolean;
  onClose: () => void;
  progress: number;
  filename: string;
}

export default function PdfProgressDialog({ isOpen, progress, filename }: PdfProgressDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="pdf-progress-overlay">
      <div className="pdf-progress-dialog">
        <div className="pdf-progress-header">
          <h3>Exporting to PDF</h3>
        </div>
        <div className="pdf-progress-content">
          <p>Converting <strong>{filename}</strong>...</p>
          <div className="progress-bar-container">
            <div 
              className="progress-bar-fill" 
              style={{ width: `${Math.min(progress, 100)}%` }}
            ></div>
          </div>
          <div className="progress-text">
            {progress}%
          </div>
        </div>
      </div>
    </div>
  );
}

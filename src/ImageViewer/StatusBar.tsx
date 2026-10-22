import React from 'react';
import { ImageDimensions, ImageFileInfo } from './types';

interface StatusBarProps {
  currentFile: ImageFileInfo | null;
  dimensions: ImageDimensions;
  currentIndex: number;
  totalImages: number;
  zoomLevel: number;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  currentFile,
  dimensions,
  currentIndex,
  totalImages,
  zoomLevel,
}) => {
  if (!currentFile) {
    return (
      <footer className="mhz-iv-status-bar">
        <div className="mhz-iv-status-left">
          <span>Ready</span>
        </div>
        <div className="mhz-iv-status-right">
          <span>MHZipy Image Viewer</span>
        </div>
      </footer>
    );
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const ext = currentFile.path.split('.').pop()?.toUpperCase() || '';

  return (
    <footer className="mhz-iv-status-bar">
      <div className="mhz-iv-status-left">
        <div className="mhz-iv-status-item">
          <span className="mhz-iv-status-badge">
            {totalImages > 0 ? `${currentIndex + 1} / ${totalImages}` : '1 / 1'}
          </span>
          <strong title={currentFile.file_name}>{currentFile.file_name}</strong>
        </div>

        {dimensions.width > 0 && dimensions.height > 0 && (
          <div className="mhz-iv-status-item">
            <span>Resolution:</span>
            <strong>
              {dimensions.width} × {dimensions.height} px
            </strong>
          </div>
        )}

        {ext && (
          <div className="mhz-iv-status-item">
            <span>Format:</span>
            <strong>{ext}</strong>
          </div>
        )}

        {currentFile.file_size > 0 && (
          <div className="mhz-iv-status-item">
            <span>Size:</span>
            <span>{formatFileSize(currentFile.file_size)}</span>
          </div>
        )}
      </div>

      <div className="mhz-iv-status-right">
        <div className="mhz-iv-status-item">
          <span>Zoom:</span>
          <span className="mhz-iv-status-badge">{Math.round(zoomLevel * 100)}%</span>
        </div>
      </div>
    </footer>
  );
};

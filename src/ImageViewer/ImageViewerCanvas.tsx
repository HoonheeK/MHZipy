import React, { useRef, useState, useEffect, useCallback } from 'react';
import { ZoomMode, ImageDimensions } from './types';
import { convertFileSrc } from '@tauri-apps/api/core';

interface CanvasProps {
  filePath: string | null;
  dimensions: ImageDimensions;
  zoomLevel: number;
  zoomMode: ZoomMode;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  onZoomChange: (newZoom: number) => void;
  onSetZoomMode: (mode: ZoomMode) => void;
  onDimensionsLoaded: (dims: ImageDimensions) => void;
}

export const ImageViewerCanvas: React.FC<CanvasProps> = ({
  filePath,
  dimensions,
  zoomLevel,
  zoomMode,
  rotation,
  flipH,
  flipV,
  onZoomChange,
  onSetZoomMode,
  onDimensionsLoaded,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastFilePathRef = useRef<string | null>(null);

  // 뷰포트 맞춤/중앙 정렬
  const resetViewport = useCallback(() => {
    if (!containerRef.current || !filePath || dimensions.width <= 0 || dimensions.height <= 0) return;
    const { clientWidth: cw, clientHeight: ch } = containerRef.current;
    if (cw <= 0 || ch <= 0) return;

    // 회전 90도/270도일 때는 너비와 높이가 바뀜
    const isRotated90 = (rotation % 180) !== 0;
    const effW = isRotated90 ? dimensions.height : dimensions.width;
    const effH = isRotated90 ? dimensions.width : dimensions.height;

    if (zoomMode === 'fit') {
      const scaleX = (cw - 40) / effW;
      const scaleY = (ch - 40) / effH;
      const fitScale = Math.min(scaleX, scaleY, 1.0);
      onZoomChange(fitScale);
      setPan({
        x: (cw - effW * fitScale) / 2,
        y: (ch - effH * fitScale) / 2,
      });
    } else if (zoomMode === 'fit_width') {
      const scaleX = (cw - 40) / effW;
      onZoomChange(scaleX);
      setPan({
        x: (cw - effW * scaleX) / 2,
        y: 20,
      });
    } else if (zoomMode === 'actual') {
      onZoomChange(1.0);
      setPan({
        x: (cw - effW) / 2,
        y: (ch - effH) / 2,
      });
    }
  }, [filePath, dimensions, zoomMode, rotation, onZoomChange]);

  // 파일이 바뀌거나 rotation/zoomMode가 fit/actual 등으로 변경될 때 뷰포트 리셋
  useEffect(() => {
    if (!filePath) {
      lastFilePathRef.current = null;
      return;
    }
    const isNewFile = filePath !== lastFilePathRef.current;
    if (isNewFile) {
      lastFilePathRef.current = filePath;
      resetViewport();
    } else if (zoomMode !== 'free') {
      resetViewport();
    }
  }, [filePath, zoomMode, rotation, resetViewport]);

  // 창 크기 변경 시 자동 fit 재계산
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleResize = () => {
      if (zoomMode !== 'free') {
        resetViewport();
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [zoomMode, resetViewport]);

  // 마우스 휠 줌 (커서 위치 중심)
  const handleWheel = (e: React.WheelEvent) => {
    if (!filePath || !containerRef.current) return;
    e.preventDefault();

    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
    const nextZoom = Math.max(0.05, Math.min(30.0, zoomLevel * zoomFactor));

    const imageX = (mouseX - pan.x) / zoomLevel;
    const imageY = (mouseY - pan.y) / zoomLevel;

    const newPanX = mouseX - imageX * nextZoom;
    const newPanY = mouseY - imageY * nextZoom;

    onZoomChange(nextZoom);
    setPan({ x: newPanX, y: newPanY });
    onSetZoomMode('free');
  };

  // 마우스 드래그 패닝
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !filePath) return;
    setIsPanning(true);
    dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPanning) return;
    setPan({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  // 더블 클릭 시 Fit ↔ Actual(100%) 토글
  const handleDoubleClick = () => {
    if (zoomMode === 'fit') {
      onSetZoomMode('actual');
    } else {
      onSetZoomMode('fit');
    }
  };

  const displaySrc = filePath ? convertFileSrc(filePath) : '';

  return (
    <main
      className={`mhz-iv-canvas-viewport ${isPanning ? 'panning' : ''}`}
      ref={containerRef}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
    >
      {filePath ? (
        <div
          className="mhz-iv-image-container"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoomLevel})`,
            transformOrigin: '0 0',
          }}
        >
          <img
            key={filePath}
            src={displaySrc}
            alt="Viewer"
            className="mhz-iv-rendered-image"
            style={{
              transform: `rotate(${rotation}deg) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1})`,
              transformOrigin: 'center center',
            }}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              onDimensionsLoaded({
                width: img.naturalWidth,
                height: img.naturalHeight,
              });
            }}
          />
        </div>
      ) : (
        <div className="mhz-iv-empty-state">
          <p>No image loaded</p>
        </div>
      )}
    </main>
  );
};

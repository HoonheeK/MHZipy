import React, { useState, useEffect, useCallback } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  Scale,
  RotateCw,
  RotateCcw,
  FlipHorizontal,
  FlipVertical,
  Maximize,
  Minus,
  Square,
  X,
  Image as ImageIcon,
} from 'lucide-react';
import { ImageFileInfo, ImageDimensions, ZoomMode } from './types';
import { ImageViewerCanvas } from './ImageViewerCanvas';
import { ThumbnailStrip } from './ThumbnailStrip';
import { StatusBar } from './StatusBar';
import { useTranslation } from 'react-i18next';
import './ImageViewer.css';

interface ImageViewerProps {
  initialFilePath?: string;
}

export const ImageViewer: React.FC<ImageViewerProps> = ({ initialFilePath }) => {
  const { t } = useTranslation();
  const [folderImages, setFolderImages] = useState<ImageFileInfo[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [dimensions, setDimensions] = useState<ImageDimensions>({ width: 0, height: 0 });

  // 뷰포트 상태
  const [zoomLevel, setZoomLevel] = useState<number>(1.0);
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit');
  const [rotation, setRotation] = useState<number>(0);
  const [flipH, setFlipH] = useState<boolean>(false);
  const [flipV, setFlipV] = useState<boolean>(false);

  // UI 상태
  const [isFilmstripOpen, setIsFilmstripOpen] = useState<boolean>(true);
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // 창 최대화 및 전체화면 상태 감지
  useEffect(() => {
    const checkWindowState = async () => {
      try {
        const isMax = await invoke<boolean>('is_window_maximized');
        setIsMaximized(isMax);
      } catch {
        try {
          const win = getCurrentWindow();
          setIsMaximized(await win.isMaximized());
        } catch {}
      }

      try {
        const isFs = await invoke<boolean>('is_window_fullscreen');
        setIsFullscreen(isFs);
      } catch {
        try {
          const win = getCurrentWindow();
          setIsFullscreen(await win.isFullscreen());
        } catch {}
      }
    };
    checkWindowState();

    const unlistenPromise = getCurrentWindow().onResized(async () => {
      checkWindowState();
    });

    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFsChange);

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
      document.removeEventListener('fullscreenchange', handleFsChange);
    };
  }, []);

  // 창 컨트롤
  const handleMinimize = async (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    try {
      await invoke('minimize_window');
    } catch {
      getCurrentWindow().minimize();
    }
  };

  const handleToggleMaximize = async (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    try {
      const newMax = await invoke<boolean>('toggle_maximize');
      setIsMaximized(newMax);
    } catch {
      const win = getCurrentWindow();
      await win.toggleMaximize();
      setIsMaximized(await win.isMaximized());
    }
  };

  const handleClose = async (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    try {
      await invoke('close_window');
    } catch {
      getCurrentWindow().close();
    }
  };

  // 폴더 내 이미지 로드 및 초기 파일 선택
  useEffect(() => {
    if (!initialFilePath) return;

    const loadInitialFile = async () => {
      const normalized = initialFilePath.replace(/\\/g, '/');
      const lastSlash = normalized.lastIndexOf('/');
      const fileName = lastSlash !== -1 ? normalized.substring(lastSlash + 1) : normalized;
      const folderPath = lastSlash !== -1 ? initialFilePath.substring(0, lastSlash) : '';

      try {
        if (folderPath) {
          const images = await invoke<ImageFileInfo[]>('get_folder_images', { folderPath });
          setFolderImages(images);

          const idx = images.findIndex((img) => img.path.toLowerCase() === initialFilePath.toLowerCase());
          if (idx !== -1) {
            setCurrentIndex(idx);
          } else {
            // 폴더 목록에 없으면 단일 파일 항목으로 설정
            const singleItem: ImageFileInfo = {
              path: initialFilePath,
              file_name: fileName,
              file_size: 0,
              modified_millis: Date.now(),
            };
            setFolderImages([singleItem]);
            setCurrentIndex(0);
          }
        } else {
          const singleItem: ImageFileInfo = {
            path: initialFilePath,
            file_name: fileName,
            file_size: 0,
            modified_millis: Date.now(),
          };
          setFolderImages([singleItem]);
          setCurrentIndex(0);
        }
      } catch (err) {
        console.error('Failed to load folder images:', err);
        const singleItem: ImageFileInfo = {
          path: initialFilePath,
          file_name: fileName,
          file_size: 0,
          modified_millis: Date.now(),
        };
        setFolderImages([singleItem]);
        setCurrentIndex(0);
      }
    };

    loadInitialFile();
  }, [initialFilePath]);

  const currentFile = currentIndex >= 0 && currentIndex < folderImages.length ? folderImages[currentIndex] : null;

  // 창 제목 업데이트
  useEffect(() => {
    if (currentFile) {
      const title = `${currentFile.file_name} ${
        dimensions.width > 0 ? `(${dimensions.width}×${dimensions.height})` : ''
      } - MHZipy Image Viewer`;
      getCurrentWindow().setTitle(title).catch(() => {});
    }
  }, [currentFile, dimensions]);

  // 이전/다음 이미지 프리로딩
  useEffect(() => {
    if (folderImages.length === 0 || currentIndex < 0) return;
    const preloadIndices = [currentIndex - 1, currentIndex + 1, currentIndex + 2, currentIndex - 2].filter(
      (idx) => idx >= 0 && idx < folderImages.length,
    );

    preloadIndices.forEach((idx) => {
      const img = new Image();
      img.src = convertFileSrc(folderImages[idx].path);
    });
  }, [currentIndex, folderImages]);

  // 이전/다음 이미지 이동 핸들러
  const handlePrevImage = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex((prev) => prev - 1);
      setRotation(0);
      setFlipH(false);
      setFlipV(false);
      setZoomMode('fit');
    }
  }, [currentIndex]);

  const handleNextImage = useCallback(() => {
    if (currentIndex < folderImages.length - 1) {
      setCurrentIndex((prev) => prev + 1);
      setRotation(0);
      setFlipH(false);
      setFlipV(false);
      setZoomMode('fit');
    }
  }, [currentIndex, folderImages.length]);

  const handleSelectImage = useCallback((index: number) => {
    setCurrentIndex(index);
    setRotation(0);
    setFlipH(false);
    setFlipV(false);
    setZoomMode('fit');
  }, []);

  // 회전 및 반전 핸들러
  const handleRotateCW = useCallback(() => {
    setRotation((r) => (r + 90) % 360);
  }, []);

  const handleRotateCCW = useCallback(() => {
    setRotation((r) => (r - 90 + 360) % 360);
  }, []);

  const handleFlipH = useCallback(() => {
    setFlipH((f) => !f);
  }, []);

  const handleFlipV = useCallback(() => {
    setFlipV((f) => !f);
  }, []);

  const handleToggleFullscreen = useCallback(async (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    try {
      const newFs = await invoke<boolean>('toggle_fullscreen');
      setIsFullscreen(newFs);
    } catch {
      try {
        const win = getCurrentWindow();
        const cur = await win.isFullscreen();
        await win.setFullscreen(!cur);
        setIsFullscreen(!cur);
      } catch {
        try {
          if (!document.fullscreenElement) {
            await document.documentElement.requestFullscreen();
            setIsFullscreen(true);
          } else {
            await document.exitFullscreen();
            setIsFullscreen(false);
          }
        } catch (err) {
          console.warn('Fullscreen toggle failed:', err);
        }
      }
    }
  }, []);

  // 키보드 네비게이션 & 단축키
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 텍스트 입력 중일 때는 무시
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') {
        return;
      }

      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
          e.preventDefault();
          handleNextImage();
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          e.preventDefault();
          handlePrevImage();
          break;
        case 'Home':
          e.preventDefault();
          if (folderImages.length > 0) handleSelectImage(0);
          break;
        case 'End':
          e.preventDefault();
          if (folderImages.length > 0) handleSelectImage(folderImages.length - 1);
          break;
        case '+':
        case '=':
          e.preventDefault();
          setZoomLevel((z) => Math.min(30, z * 1.2));
          setZoomMode('free');
          break;
        case '-':
        case '_':
          e.preventDefault();
          setZoomLevel((z) => Math.max(0.05, z * 0.8));
          setZoomMode('free');
          break;
        case '0':
          e.preventDefault();
          setZoomMode('fit');
          break;
        case '1':
          e.preventDefault();
          setZoomMode('actual');
          break;
        case 'r':
        case 'R':
          e.preventDefault();
          handleRotateCW();
          break;
        case 'l':
        case 'L':
          e.preventDefault();
          handleRotateCCW();
          break;
        case 'h':
        case 'H':
          e.preventDefault();
          handleFlipH();
          break;
        case 'v':
        case 'V':
          e.preventDefault();
          handleFlipV();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          handleToggleFullscreen();
          break;
        case 'Escape':
          e.preventDefault();
          if (isFullscreen) {
            handleToggleFullscreen();
          } else {
            handleClose();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    handleNextImage,
    handlePrevImage,
    handleSelectImage,
    handleRotateCW,
    handleRotateCCW,
    handleFlipH,
    handleFlipV,
    handleToggleFullscreen,
    folderImages.length,
  ]);

  return (
    <div className="mhz-iv-container">
      {/* 1. Header Titlebar */}
      <header className="mhz-iv-header" data-tauri-drag-region>
        <div className="mhz-iv-title-left" data-tauri-drag-region>
          <div className="mhz-iv-app-badge">
            <ImageIcon size={15} color="#38bdf8" />
            <span className="mhz-iv-app-name">MHZipy Image Viewer</span>
          </div>
          {currentFile && (
            <span className="mhz-iv-filename" title={currentFile.file_name}>
              {currentFile.file_name}
            </span>
          )}
        </div>

        <div className="mhz-iv-win-controls" onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="mhz-iv-win-btn"
            onClick={handleToggleFullscreen}
            onMouseDown={(e) => e.stopPropagation()}
            title={isFullscreen ? `${t('viewer.exitFullscreen', { defaultValue: 'Exit Fullscreen' })} (F)` : `${t('viewer.fullscreen', { defaultValue: 'Fullscreen' })} (F)`}
          >
            {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            className="mhz-iv-win-btn"
            onClick={handleMinimize}
            onMouseDown={(e) => e.stopPropagation()}
            title={t('viewer.minimize', { defaultValue: 'Minimize' })}
          >
            <Minus size={14} />
          </button>
          <button
            className="mhz-iv-win-btn"
            onClick={handleToggleMaximize}
            onMouseDown={(e) => e.stopPropagation()}
            title={isMaximized ? t('viewer.restore', { defaultValue: 'Restore' }) : t('viewer.maximize', { defaultValue: 'Maximize' })}
          >
            <Square size={12} />
          </button>
          <button
            className="mhz-iv-win-btn close"
            onClick={handleClose}
            onMouseDown={(e) => e.stopPropagation()}
            title={`${t('viewer.close', { defaultValue: 'Close' })} (ESC)`}
          >
            <X size={15} />
          </button>
        </div>
      </header>

      {/* 2. Action Toolbar */}
      <div className="mhz-iv-toolbar">
        <div className="mhz-iv-toolbar-group">
          <button
            className="mhz-iv-tool-btn"
            onClick={handlePrevImage}
            disabled={currentIndex <= 0}
            title={`${t('viewer.prevImage', { defaultValue: 'Previous Image' })} (← / PageUp)`}
          >
            <ChevronLeft size={16} />
            <span>{t('viewer.prev', { defaultValue: 'Prev' })}</span>
          </button>
          <button
            className="mhz-iv-tool-btn"
            onClick={handleNextImage}
            disabled={currentIndex >= folderImages.length - 1}
            title={`${t('viewer.nextImage', { defaultValue: 'Next Image' })} (→ / PageDown)`}
          >
            <span>{t('viewer.next', { defaultValue: 'Next' })}</span>
            <ChevronRight size={16} />
          </button>
        </div>

        <div className="mhz-iv-toolbar-divider" />

        <div className="mhz-iv-toolbar-group">
          <button
            className="mhz-iv-tool-btn"
            onClick={() => {
              setZoomLevel((z) => Math.min(30, z * 1.2));
              setZoomMode('free');
            }}
            title={`${t('viewer.zoomIn', { defaultValue: 'Zoom In' })} (+)`}
          >
            <ZoomIn size={15} />
          </button>
          <button
            className="mhz-iv-tool-btn"
            onClick={() => {
              setZoomLevel((z) => Math.max(0.05, z * 0.8));
              setZoomMode('free');
            }}
            title={`${t('viewer.zoomOut', { defaultValue: 'Zoom Out' })} (-)`}
          >
            <ZoomOut size={15} />
          </button>
          <button
            className={`mhz-iv-tool-btn ${zoomMode === 'fit' ? 'active' : ''}`}
            onClick={() => setZoomMode('fit')}
            title={`${t('viewer.fitWindow', { defaultValue: 'Fit to Window' })} (0)`}
          >
            <Maximize2 size={15} />
            <span>{t('viewer.fit', { defaultValue: 'Fit' })}</span>
          </button>
          <button
            className={`mhz-iv-tool-btn ${zoomMode === 'actual' ? 'active' : ''}`}
            onClick={() => setZoomMode('actual')}
            title={`${t('viewer.originalSize', { defaultValue: 'Original Size 100%' })} (1)`}
          >
            <Scale size={15} />
            <span>100%</span>
          </button>
        </div>

        <div className="mhz-iv-toolbar-divider" />

        <div className="mhz-iv-toolbar-group">
          <button className="mhz-iv-tool-btn" onClick={handleRotateCCW} title={`${t('viewer.rotateLeft', { defaultValue: 'Rotate Left 90°' })} (L)`}>
            <RotateCcw size={15} />
          </button>
          <button className="mhz-iv-tool-btn" onClick={handleRotateCW} title={`${t('viewer.rotateRight', { defaultValue: 'Rotate Right 90°' })} (R)`}>
            <RotateCw size={15} />
          </button>
          <button
            className={`mhz-iv-tool-btn ${flipH ? 'active' : ''}`}
            onClick={handleFlipH}
            title={`${t('viewer.flipH', { defaultValue: 'Flip Horizontal' })} (H)`}
          >
            <FlipHorizontal size={15} />
          </button>
          <button
            className={`mhz-iv-tool-btn ${flipV ? 'active' : ''}`}
            onClick={handleFlipV}
            title={`${t('viewer.flipV', { defaultValue: 'Flip Vertical' })} (V)`}
          >
            <FlipVertical size={15} />
          </button>
        </div>

        <div className="mhz-iv-toolbar-divider" />

        <div className="mhz-iv-toolbar-group">
          <button
            className={`mhz-iv-tool-btn ${isFullscreen ? 'active' : ''}`}
            onClick={handleToggleFullscreen}
            title={isFullscreen ? `${t('viewer.exitFullscreen', { defaultValue: 'Exit Fullscreen' })} (F)` : `${t('viewer.fullscreen', { defaultValue: 'Fullscreen' })} (F)`}
          >
            {isFullscreen ? <Minimize2 size={15} /> : <Maximize size={15} />}
            <span>{isFullscreen ? t('viewer.exitFullscreen', { defaultValue: 'Exit' }) : t('viewer.fullscreen', { defaultValue: 'Full' })}</span>
          </button>
        </div>
      </div>

      {/* 3. Main Image Canvas */}
      <ImageViewerCanvas
        filePath={currentFile ? currentFile.path : null}
        dimensions={dimensions}
        zoomLevel={zoomLevel}
        zoomMode={zoomMode}
        rotation={rotation}
        flipH={flipH}
        flipV={flipV}
        onZoomChange={setZoomLevel}
        onSetZoomMode={setZoomMode}
        onDimensionsLoaded={setDimensions}
      />

      {/* 4. Filmstrip Drawer */}
      <ThumbnailStrip
        images={folderImages}
        currentIndex={currentIndex}
        onSelectImage={handleSelectImage}
        isOpen={isFilmstripOpen}
        onToggleOpen={() => setIsFilmstripOpen(!isFilmstripOpen)}
      />

      {/* 5. Status Bar */}
      <StatusBar
        currentFile={currentFile}
        dimensions={dimensions}
        currentIndex={currentIndex}
        totalImages={folderImages.length}
        zoomLevel={zoomLevel}
      />
    </div>
  );
};
export default ImageViewer;

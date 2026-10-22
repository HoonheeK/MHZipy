import React, { useEffect, useRef, useState } from 'react';
import { ImageFileInfo } from './types';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ChevronUp, ChevronDown, Film } from 'lucide-react';

interface ThumbnailStripProps {
  images: ImageFileInfo[];
  currentIndex: number;
  onSelectImage: (index: number) => void;
  isOpen: boolean;
  onToggleOpen: () => void;
}

export const ThumbnailStrip: React.FC<ThumbnailStripProps> = ({
  images,
  currentIndex,
  onSelectImage,
  isOpen,
  onToggleOpen,
}) => {
  const activeItemRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragRef = useRef<{
    isDown: boolean;
    startX: number;
    scrollLeft: number;
    hasMoved: boolean;
  }>({
    isDown: false,
    startX: 0,
    scrollLeft: 0,
    hasMoved: false,
  });

  // 현재 인덱스 변경 시 해당 썸네일로 스크롤
  useEffect(() => {
    if (activeItemRef.current && !dragRef.current.isDown) {
      activeItemRef.current.scrollIntoView({
        behavior: 'smooth',
        inline: 'center',
        block: 'nearest',
      });
    }
  }, [currentIndex]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !scrollContainerRef.current) return;
    dragRef.current = {
      isDown: true,
      startX: e.clientX,
      scrollLeft: scrollContainerRef.current.scrollLeft,
      hasMoved: false,
    };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current.isDown || !scrollContainerRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      if (Math.abs(dx) > 5) {
        dragRef.current.hasMoved = true;
        setIsDragging(true);
        scrollContainerRef.current.scrollLeft = dragRef.current.scrollLeft - dx;
      }
    };

    const handleMouseUp = () => {
      if (!dragRef.current.isDown) return;
      dragRef.current.isDown = false;
      setTimeout(() => setIsDragging(false), 50);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  if (images.length <= 1) return null;

  return (
    <aside className="mhz-iv-filmstrip-container">
      <div className="mhz-iv-filmstrip-header">
        <div className="mhz-iv-filmstrip-title">
          <Film size={14} />
          <span>
            Thumbnails ({images.length} files) - [ {currentIndex + 1} / {images.length} ]
          </span>
        </div>
        <button
          className="mhz-iv-filmstrip-toggle-btn"
          onClick={onToggleOpen}
          title={isOpen ? 'Collapse Thumbnails' : 'Expand Thumbnails'}
        >
          {isOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>

      {isOpen && (
        <div
          className={`mhz-iv-filmstrip-scroll ${isDragging ? 'is-dragging' : ''}`}
          ref={scrollContainerRef}
          onMouseDown={handleMouseDown}
        >
          {images.map((item, idx) => {
            const isActive = idx === currentIndex;
            const thumbSrc = convertFileSrc(item.path);

            return (
              <div
                key={item.path}
                ref={isActive ? activeItemRef : null}
                className={`mhz-iv-filmstrip-item ${isActive ? 'active' : ''}`}
                onClick={() => {
                  if (!dragRef.current.hasMoved) {
                    onSelectImage(idx);
                  }
                }}
                title={item.file_name}
              >
                <div className="mhz-iv-filmstrip-thumb-wrap">
                  <img
                    src={thumbSrc}
                    alt={item.file_name}
                    className="mhz-iv-filmstrip-img"
                    loading="lazy"
                    draggable={false}
                  />
                </div>
                <span className="mhz-iv-filmstrip-label">{item.file_name}</span>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
};

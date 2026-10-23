import React, { useState } from 'react';
import { VideoFileInfo } from './types';
import { ListVideo, Search, Film, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface PlaylistProps {
  items: VideoFileInfo[];
  currentIndex: number;
  isOpen: boolean;
  onSelectVideo: (index: number) => void;
  onClose: () => void;
}

export const Playlist: React.FC<PlaylistProps> = ({
  items,
  currentIndex,
  isOpen,
  onSelectVideo,
  onClose,
}) => {
  const { t } = useTranslation();
  const [filterText, setFilterText] = useState('');

  const formatSize = (bytes: number) => {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const filteredItems = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) =>
      item.file_name.toLowerCase().includes(filterText.toLowerCase())
    );

  return (
    <aside className={`playlist-panel ${isOpen ? '' : 'collapsed'}`} onClick={(e) => e.stopPropagation()}>
      <div className="playlist-header">
        <div className="playlist-title">
          <ListVideo size={18} color="#38bdf8" />
          <span>{t('viewer.playlist', { defaultValue: 'Playlist' })}</span>
          <span className="playlist-count">{items.length}</span>
        </div>
        <button
          className="btn-icon-only"
          title={`${t('viewer.close', { defaultValue: 'Close' })} ${t('viewer.playlist', { defaultValue: 'Playlist' })} (L)`}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      <div className="playlist-search-box">
        <Search size={14} className="search-icon-pos" />
        <input
          type="text"
          className="search-input"
          placeholder={t('viewer.searchVideos', { defaultValue: 'Search videos...' })}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        {filterText && (
          <button
            className="search-clear-btn"
            onClick={() => setFilterText('')}
            title={t('viewer.close', { defaultValue: 'Clear' })}
          >
            ×
          </button>
        )}
      </div>

      <div className="playlist-items">
        {filteredItems.length === 0 ? (
          <div className="playlist-empty">
            <span>{t('viewer.noVideosFound', { defaultValue: 'No videos found' })}</span>
          </div>
        ) : (
          filteredItems.map(({ item, index }) => {
            const isActive = index === currentIndex;
            const ext = item.file_name.split('.').pop()?.toUpperCase() || 'VIDEO';

            return (
              <div
                key={item.path}
                className={`playlist-item ${isActive ? 'active' : ''}`}
                onClick={() => onSelectVideo(index)}
                title={item.path}
              >
                <div className="track-icon">
                  <Film size={15} />
                </div>
                <div className="track-info">
                  <span className="track-name">{item.file_name}</span>
                  <div className="track-sub">
                    <span className="tag-badge-sm">{ext}</span>
                    {item.file_size > 0 && (
                      <span className="track-size">{formatSize(item.file_size)}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};

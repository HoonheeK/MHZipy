import React, { useRef, useState, useEffect, useCallback } from 'react';
import { VideoFileInfo, RepeatMode } from './types';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
  RotateCw,
  Repeat,
  Repeat1,
  Volume2,
  Volume1,
  VolumeX,
  Maximize2,
  Minimize2,
  ListVideo,
  Film,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface PlayerControlsProps {
  currentVideo: VideoFileInfo | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  playbackRate: number;
  repeatMode: RepeatMode;
  isPlaylistOpen: boolean;
  isFullscreen: boolean;
  videoWidth?: number;
  videoHeight?: number;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onSkipTime: (offset: number) => void;
  onChangeVolume: (vol: number) => void;
  onToggleMute: () => void;
  onChangeRate: () => void;
  onToggleRepeat: () => void;
  onToggleFullscreen: () => void;
  onTogglePlaylist: () => void;
}

export const PlayerControls: React.FC<PlayerControlsProps> = ({
  currentVideo,
  isPlaying,
  currentTime,
  duration,
  volume,
  isMuted,
  playbackRate,
  repeatMode,
  isPlaylistOpen,
  isFullscreen,
  videoWidth,
  videoHeight,
  onTogglePlay,
  onSeek,
  onPrev,
  onNext,
  onSkipTime,
  onChangeVolume,
  onToggleMute,
  onChangeRate,
  onToggleRepeat,
  onToggleFullscreen,
  onTogglePlaylist,
}) => {
  const { t } = useTranslation();
  const seekbarRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragProgress, setDragProgress] = useState(0);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number>(0);

  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) return '00:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
      return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getSeekTimeFromEvent = useCallback(
    (clientX: number): number | null => {
      if (!seekbarRef.current) return null;
      const rect = seekbarRef.current.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const validDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
      return pos * validDuration;
    },
    [duration]
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!seekbarRef.current || duration <= 0) return;
    setIsDragging(true);
    const rect = seekbarRef.current.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setDragProgress(pos);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !seekbarRef.current || duration <= 0) return;
      const rect = seekbarRef.current.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setDragProgress(pos);
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (!isDragging) return;
      setIsDragging(false);
      const targetTime = getSeekTimeFromEvent(e.clientX);
      if (targetTime !== null) {
        onSeek(targetTime);
      }
    };

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, duration, onSeek, getSeekTimeFromEvent]);

  const handleSeekbarHover = (e: React.MouseEvent) => {
    if (!seekbarRef.current || duration <= 0) return;
    const rect = seekbarRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pos = Math.max(0, Math.min(1, x / rect.width));
    setHoverTime(pos * duration);
    setHoverX(x);
  };

  const handleSeekbarLeave = () => {
    setHoverTime(null);
  };

  const validDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const progressPercent = isDragging
    ? dragProgress * 100
    : validDuration > 0
    ? Math.min(100, (currentTime / validDuration) * 100)
    : 0;

  const currentVol = isMuted ? 0 : volume;

  return (
    <div className="player-bar" onClick={(e) => e.stopPropagation()}>
      {/* 1. Timeline & Seekbar */}
      <div className="timeline-container">
        <span className="time-label current">
          {formatTime(isDragging ? dragProgress * validDuration : currentTime)}
        </span>

        <div
          ref={seekbarRef}
          className="seekbar-wrapper"
          onMouseDown={handleMouseDown}
          onMouseMove={handleSeekbarHover}
          onMouseLeave={handleSeekbarLeave}
        >
          <div className="seekbar">
            <div
              className="seekbar-progress"
              style={{ width: `${progressPercent}%` }}
            >
              <div className="seekbar-handle" />
            </div>
            {hoverTime !== null && (
              <div
                className="seekbar-tooltip"
                style={{ left: `${hoverX}px` }}
              >
                {formatTime(hoverTime)}
              </div>
            )}
          </div>
        </div>

        <span className="time-label">{formatTime(validDuration)}</span>
      </div>

      {/* 2. Controls Row */}
      <div className="controls-row">
        {/* Left: Video Metadata */}
        <div className="left-info">
          {currentVideo ? (
            <>
              <div className="info-thumb">
                <Film size={18} color="#38bdf8" />
              </div>
              <div className="info-meta">
                <span className="info-title" title={currentVideo.file_name}>
                  {currentVideo.file_name}
                </span>
                <span className="info-type">
                  {videoWidth && videoHeight ? `${videoWidth}×${videoHeight} • ` : ''}
                  <strong className="info-time-highlight">
                    {formatTime(currentTime)} / {formatTime(validDuration)}
                  </strong>
                </span>
              </div>
            </>
          ) : (
            <div className="info-meta">
              <span className="info-title" style={{ color: 'var(--text-muted, #94a3b8)' }}>
                {t('viewer.noVideoSelected', { defaultValue: 'No video selected' })}
              </span>
            </div>
          )}
        </div>

        {/* Center: Playback Controls */}
        <div className="center-buttons">
          <button
            className="btn-icon-only"
            title={`${t('viewer.prevVideo', { defaultValue: 'Previous Video' })} (P)`}
            onClick={onPrev}
          >
            <SkipBack size={18} />
          </button>

          <button
            className="btn-icon-only"
            title={`${t('viewer.rewind5', { defaultValue: 'Rewind 5s' })} (←)`}
            onClick={() => onSkipTime(-5)}
          >
            <RotateCcw size={18} />
          </button>

          <button
            className="btn-play-pause"
            title={isPlaying ? `${t('viewer.pause', { defaultValue: 'Pause' })} (Space)` : `${t('viewer.play', { defaultValue: 'Play' })} (Space)`}
            onClick={onTogglePlay}
          >
            {isPlaying ? <Pause size={22} /> : <Play size={22} className="play-icon-offset" />}
          </button>

          <button
            className="btn-icon-only"
            title={`${t('viewer.forward5', { defaultValue: 'Forward 5s' })} (→)`}
            onClick={() => onSkipTime(5)}
          >
            <RotateCw size={18} />
          </button>

          <button
            className="btn-icon-only"
            title={`${t('viewer.nextVideo', { defaultValue: 'Next Video' })} (N)`}
            onClick={onNext}
          >
            <SkipForward size={18} />
          </button>

          <button
            className={`btn-icon-only ${repeatMode !== 'off' ? 'active' : ''}`}
            title={
              repeatMode === 'all'
                ? t('viewer.repeatAll', { defaultValue: 'Repeat: All' })
                : repeatMode === 'one'
                ? t('viewer.repeatOne', { defaultValue: 'Repeat: Current' })
                : t('viewer.repeatOff', { defaultValue: 'Repeat: Off' })
            }
            onClick={onToggleRepeat}
          >
            {repeatMode === 'one' ? <Repeat1 size={17} /> : <Repeat size={17} />}
          </button>
        </div>

        {/* Right: Auxiliary Controls */}
        <div className="right-features">
          <button
            className="speed-badge"
            title={`${t('viewer.speed', { defaultValue: 'Playback Speed' })} (${playbackRate}x)`}
            onClick={onChangeRate}
          >
            {playbackRate}x
          </button>

          <div className="volume-control">
            <button
              className="btn-icon-only"
              title={isMuted ? `${t('viewer.unmute', { defaultValue: 'Unmute' })} (M)` : `${t('viewer.mute', { defaultValue: 'Mute' })} (M)`}
              onClick={onToggleMute}
            >
              {currentVol === 0 ? (
                <VolumeX size={18} />
              ) : currentVol < 0.5 ? (
                <Volume1 size={18} />
              ) : (
                <Volume2 size={18} />
              )}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.02"
              value={currentVol}
              onChange={(e) => onChangeVolume(parseFloat(e.target.value))}
              className="volume-slider"
              title={`${t('viewer.volume', { defaultValue: 'Volume' })}: ${Math.round(currentVol * 100)}%`}
            />
          </div>

          <button
            className={`btn-icon-only ${isPlaylistOpen ? 'active' : ''}`}
            title={`${t('viewer.playlist', { defaultValue: 'Playlist' })} (L)`}
            onClick={onTogglePlaylist}
          >
            <ListVideo size={18} />
          </button>

          <button
            className="btn-icon-only"
            title={isFullscreen ? `${t('viewer.exitFullscreen', { defaultValue: 'Exit Fullscreen' })} (F / Esc)` : `${t('viewer.fullscreen', { defaultValue: 'Fullscreen' })} (F)`}
            onClick={onToggleFullscreen}
          >
            {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
};

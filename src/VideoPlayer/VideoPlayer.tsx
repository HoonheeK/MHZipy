import React, { useState, useRef, useEffect, useCallback } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { VideoFileInfo, RepeatMode, OsdState } from './types';
import { PlayerControls } from './PlayerControls';
import { Playlist } from './Playlist';
import {
  Film,
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Sparkles,
  Minus,
  Square,
  X,
  Maximize2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './VideoPlayer.css';

interface VideoPlayerProps {
  initialFilePath?: string;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ initialFilePath }) => {
  const { t } = useTranslation();
  const [playlist, setPlaylist] = useState<VideoFileInfo[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [volume, setVolume] = useState<number>(0.8);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');
  const [isPlaylistOpen, setIsPlaylistOpen] = useState<boolean>(false);

  // 윈도우 상태
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [hideControls, setHideControls] = useState<boolean>(false);

  // 비디오 해상도
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // OSD 상태
  const [osd, setOsd] = useState<OsdState | null>(null);
  const osdTimerRef = useRef<number | null>(null);

  // Refs
  const appContainerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);

  const showOsd = useCallback((icon: React.ReactNode, text: string) => {
    if (osdTimerRef.current) {
      window.clearTimeout(osdTimerRef.current);
      osdTimerRef.current = null;
    }
    setOsd({ icon, text });
    osdTimerRef.current = window.setTimeout(() => {
      setOsd(null);
      osdTimerRef.current = null;
    }, 700);
  }, []);

  useEffect(() => {
    return () => {
      if (osdTimerRef.current) {
        window.clearTimeout(osdTimerRef.current);
      }
    };
  }, []);

  // 창 최대화/전체화면 상태 감지
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
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      if (!active) {
        setHideControls(false);
      }
    };
    document.addEventListener('fullscreenchange', handleFsChange);

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
      document.removeEventListener('fullscreenchange', handleFsChange);
    };
  }, []);

  // 창 드래그 핸들러 (Windows WebView2 창 이동)
  const handleTitlebarMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0 && !(e.target as HTMLElement).closest('button, input, select, a, .win-btn')) {
      try {
        getCurrentWindow().startDragging();
      } catch (err) {
        console.warn('startDragging error:', err);
      }
    }
  };

  // 윈도우 컨트롤
  const handleMinimize = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await invoke('minimize_window');
    } catch {
      getCurrentWindow().minimize();
    }
  };

  const handleToggleMaximize = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
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
    e?.stopPropagation();
    try {
      await invoke('close_window');
    } catch {
      getCurrentWindow().close();
    }
  };

  // 초기 파일 및 폴더 비디오 로드
  useEffect(() => {
    if (!initialFilePath) return;

    const loadInitialVideo = async () => {
      const normalized = initialFilePath.replace(/\\/g, '/');
      const lastSlash = normalized.lastIndexOf('/');
      const fileName = lastSlash !== -1 ? normalized.substring(lastSlash + 1) : normalized;
      const folderPath = lastSlash !== -1 ? initialFilePath.substring(0, lastSlash) : '';

      try {
        if (folderPath) {
          const videos = await invoke<VideoFileInfo[]>('get_folder_videos', { folderPath });
          if (videos && videos.length > 0) {
            setPlaylist(videos);
            const idx = videos.findIndex((v) => v.path.toLowerCase() === initialFilePath.toLowerCase());
            if (idx !== -1) {
              setCurrentIndex(idx);
            } else {
              setPlaylist([
                {
                  path: initialFilePath,
                  file_name: fileName,
                  file_size: 0,
                  modified_millis: Date.now(),
                },
                ...videos,
              ]);
              setCurrentIndex(0);
            }
          } else {
            setPlaylist([
              {
                path: initialFilePath,
                file_name: fileName,
                file_size: 0,
                modified_millis: Date.now(),
              },
            ]);
            setCurrentIndex(0);
          }
        } else {
          setPlaylist([
            {
              path: initialFilePath,
              file_name: fileName,
              file_size: 0,
              modified_millis: Date.now(),
            },
          ]);
          setCurrentIndex(0);
        }
      } catch (err) {
        console.error('Failed to load folder videos:', err);
        setPlaylist([
          {
            path: initialFilePath,
            file_name: fileName,
            file_size: 0,
            modified_millis: Date.now(),
          },
        ]);
        setCurrentIndex(0);
      }
    };

    loadInitialVideo();
  }, [initialFilePath]);

  const currentVideo = currentIndex >= 0 && currentIndex < playlist.length ? playlist[currentIndex] : null;

  // 창 제목 업데이트
  useEffect(() => {
    if (currentVideo) {
      const title = `${currentVideo.file_name} - MHZipy Video Player`;
      getCurrentWindow().setTitle(title).catch(() => {});
    }
  }, [currentVideo]);

  // 볼륨 및 재생 속도 동기화
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = isMuted ? 0 : volume;
      videoRef.current.playbackRate = playbackRate;
    }
  }, [volume, isMuted, playbackRate]);

  // 전체화면 토글
  const toggleFullscreen = useCallback(() => {
    if (!appContainerRef.current) return;
    if (!document.fullscreenElement) {
      appContainerRef.current.requestFullscreen().catch(console.error);
    } else {
      document.exitFullscreen().catch(console.error);
    }
  }, []);

  // 전체화면 마우스 유휴(Idle) 자동 숨김
  const resetIdleTimer = useCallback(() => {
    setHideControls(false);
    if (idleTimerRef.current) {
      window.clearTimeout(idleTimerRef.current);
    }
    if (isFullscreen) {
      idleTimerRef.current = window.setTimeout(() => {
        setHideControls(true);
      }, 2500);
    }
  }, [isFullscreen]);

  const handleMouseMove = () => {
    resetIdleTimer();
  };

  // 재생 / 일시정지 토글
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || !currentVideo) return;

    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
      showOsd(<Pause size={36} className="osd-icon" />, 'Pause');
    } else {
      video
        .play()
        .then(() => {
          setIsPlaying(true);
          showOsd(<Play size={36} className="osd-icon" />, 'Play');
        })
        .catch((err) => console.error('Play error:', err));
    }
  }, [isPlaying, currentVideo, showOsd]);

  // 다음 비디오
  const playNext = useCallback(() => {
    if (playlist.length === 0) return;

    if (repeatMode === 'one') {
      const video = videoRef.current;
      if (video) {
        video.currentTime = 0;
        video.play().catch(console.error);
        setIsPlaying(true);
      }
      return;
    }

    if (currentIndex + 1 < playlist.length) {
      setCurrentIndex(currentIndex + 1);
      setIsPlaying(true);
    } else if (repeatMode === 'all') {
      setCurrentIndex(0);
      setIsPlaying(true);
    } else {
      setIsPlaying(false);
    }
  }, [playlist.length, repeatMode, currentIndex]);

  // 이전 비디오
  const playPrev = useCallback(() => {
    if (playlist.length === 0) return;
    const video = videoRef.current;
    if (video && video.currentTime > 3) {
      video.currentTime = 0;
      return;
    }

    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
      setIsPlaying(true);
    } else if (repeatMode === 'all') {
      setCurrentIndex(playlist.length - 1);
      setIsPlaying(true);
    }
  }, [playlist.length, currentIndex, repeatMode]);

  // 시간 탐색
  const handleSeek = useCallback((newTime: number) => {
    const video = videoRef.current;
    if (video && Number.isFinite(newTime)) {
      try {
        const clamped = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : newTime, newTime));
        video.currentTime = clamped;
        setCurrentTime(clamped);
      } catch (err) {
        console.warn('Seek error:', err);
      }
    }
  }, []);

  // 5초 건너뛰기
  const handleSkipTime = useCallback(
    (offset: number) => {
      const video = videoRef.current;
      if (video) {
        const nextTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + offset));
        video.currentTime = nextTime;
        if (offset < 0) {
          showOsd(
            <RotateCcw size={36} className="osd-icon" />,
            t('viewer.secBackward', { s: Math.abs(offset), defaultValue: `${Math.abs(offset)}s Backward` })
          );
        } else {
          showOsd(
            <RotateCw size={36} className="osd-icon" />,
            t('viewer.secForward', { s: offset, defaultValue: `${offset}s Forward` })
          );
        }
      }
    },
    [showOsd, t]
  );

  // 음소거 토글
  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      if (next) {
        showOsd(<VolumeX size={36} className="osd-icon" />, t('viewer.muted', { defaultValue: 'Muted' }));
      } else {
        showOsd(<Volume2 size={36} className="osd-icon" />, `${Math.round(volume * 100)}%`);
      }
      return next;
    });
  }, [showOsd, volume, t]);

  // 볼륨 조절
  const adjustVolume = useCallback(
    (delta: number) => {
      setIsMuted(false);
      setVolume((prev) => {
        const next = Math.max(0, Math.min(1, parseFloat((prev + delta).toFixed(2))));
        showOsd(<Volume2 size={36} className="osd-icon" />, `${Math.round(next * 100)}%`);
        return next;
      });
    },
    [showOsd]
  );

  // 배속 순환
  const cyclePlaybackRate = () => {
    const rates = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const nextIndex = (rates.indexOf(playbackRate) + 1) % rates.length;
    const nextRate = rates[nextIndex];
    setPlaybackRate(nextRate);
    showOsd(<Sparkles size={36} className="osd-icon" />, `${t('viewer.speed', { defaultValue: 'Speed' })}: ${nextRate}x`);
  };

  // 반복 모드 순환
  const cycleRepeatMode = useCallback(() => {
    setRepeatMode((prev) => {
      const next = prev === 'off' ? 'all' : prev === 'all' ? 'one' : 'off';
      const label =
        next === 'all'
          ? t('viewer.repeatAll', { defaultValue: 'Repeat: All' })
          : next === 'one'
          ? t('viewer.repeatOne', { defaultValue: 'Repeat: Current' })
          : t('viewer.repeatOff', { defaultValue: 'Repeat: Off' });
      showOsd(<Sparkles size={36} className="osd-icon" />, label);
      return next;
    });
  }, [showOsd, t]);

  // WebM 등 duration이 Infinity/NaN/0으로 로드되는 미디어의 전체 시간 복원 처리
  const isFixingDurationRef = useRef(false);

  const updateMediaDuration = useCallback((target: HTMLVideoElement) => {
    if (Number.isFinite(target.duration) && target.duration > 0) {
      setDuration(target.duration);
      return;
    }

    // WebM infinity duration workaround: 1e101로 일시 이동 후 복귀하여 duration 계산 유도
    if ((target.duration === Infinity || target.duration === 0) && !isFixingDurationRef.current) {
      isFixingDurationRef.current = true;
      const initialTime = target.currentTime;
      const onTempTimeUpdate = () => {
        target.removeEventListener('timeupdate', onTempTimeUpdate);
        if (Number.isFinite(target.duration) && target.duration > 0) {
          setDuration(target.duration);
        }
        target.currentTime = initialTime;
        isFixingDurationRef.current = false;
      };
      target.addEventListener('timeupdate', onTempTimeUpdate);
      target.currentTime = 1e101;
    }
  }, []);

  // 새 비디오 선택 시 상태 초기화
  useEffect(() => {
    setDuration(0);
    setCurrentTime(0);
    isFixingDurationRef.current = false;
  }, [currentVideo?.path]);

  // 미디어 이벤트 핸들러
  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const target = e.currentTarget;
    setCurrentTime(target.currentTime);
    if (!Number.isFinite(duration) || duration <= 0) {
      updateMediaDuration(target);
    }
  };

  const handleLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const target = e.currentTarget;
    updateMediaDuration(target);
    if (target.videoWidth && target.videoHeight) {
      setVideoDimensions({ width: target.videoWidth, height: target.videoHeight });
    }
    if (isPlaying) {
      target.play().catch(console.error);
    }
  };

  // 마우스 휠 볼륨 조절
  const handleViewerWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) {
      adjustVolume(0.05);
    } else {
      adjustVolume(-0.05);
    }
    resetIdleTimer();
  };

  // 비디오 화면 클릭 / 더블클릭 핸들링
  const handleVideoClick = () => {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      // Double click => Toggle fullscreen
      toggleFullscreen();
    } else {
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
        // Single click => Toggle play/pause
        togglePlay();
      }, 250);
    }
    resetIdleTimer();
  };

  // 키보드 단축키
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          resetIdleTimer();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          handleSkipTime(-5);
          resetIdleTimer();
          break;
        case 'ArrowRight':
          e.preventDefault();
          handleSkipTime(5);
          resetIdleTimer();
          break;
        case 'ArrowUp':
          e.preventDefault();
          adjustVolume(0.05);
          resetIdleTimer();
          break;
        case 'ArrowDown':
          e.preventDefault();
          adjustVolume(-0.05);
          resetIdleTimer();
          break;
        case 'KeyM':
          toggleMute();
          resetIdleTimer();
          break;
        case 'KeyF':
          toggleFullscreen();
          break;
        case 'KeyL':
          if (!isFullscreen) {
            setIsPlaylistOpen((prev) => !prev);
          }
          break;
        case 'KeyN':
          playNext();
          resetIdleTimer();
          break;
        case 'KeyP':
          playPrev();
          resetIdleTimer();
          break;
        case 'KeyR':
          cycleRepeatMode();
          resetIdleTimer();
          break;
        case 'Escape':
          if (isFullscreen) {
            toggleFullscreen();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    togglePlay,
    handleSkipTime,
    adjustVolume,
    toggleMute,
    toggleFullscreen,
    playNext,
    playPrev,
    cycleRepeatMode,
    isFullscreen,
    resetIdleTimer,
  ]);

  // Tauri 드래그 앤 드롭 지원
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    const setupDragDrop = async () => {
      try {
        const appWindow = getCurrentWebviewWindow();
        unlistenFn = await appWindow.onDragDropEvent(async (event) => {
          if (event.payload.type === 'drop') {
            const droppedPaths = event.payload.paths;
            if (droppedPaths && droppedPaths.length > 0) {
              const firstFile = droppedPaths[0];
              const normalized = firstFile.replace(/\\/g, '/');
              const fileName = normalized.split('/').pop() || firstFile;
              const newVideo: VideoFileInfo = {
                path: firstFile,
                file_name: fileName,
                file_size: 0,
                modified_millis: Date.now(),
              };

              setPlaylist((prev) => {
                const idx = prev.findIndex((v) => v.path.toLowerCase() === firstFile.toLowerCase());
                if (idx !== -1) {
                  setCurrentIndex(idx);
                  return prev;
                }
                const updated = [newVideo, ...prev];
                setCurrentIndex(0);
                return updated;
              });
              setIsPlaying(true);
            }
          }
        });
      } catch (err) {
        console.warn('Failed to attach drag-drop listener:', err);
      }
    };

    setupDragDrop();
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  const mediaSrc = currentVideo ? convertFileSrc(currentVideo.path) : '';

  return (
    <div
      ref={appContainerRef}
      className={`video-player-container ${isFullscreen ? 'is-fullscreen' : ''} ${
        hideControls ? 'hide-controls' : ''
      }`}
      onMouseMove={handleMouseMove}
    >
      {/* 1. Custom Title Bar */}
      {!isFullscreen && (
        <header
          className="video-player-header"
          data-tauri-drag-region
          onMouseDown={handleTitlebarMouseDown}
          onDoubleClick={handleToggleMaximize}
        >
          <div className="titlebar-brand" data-tauri-drag-region>
            <Film size={16} color="#38bdf8" />
            <span className="titlebar-text" data-tauri-drag-region>
              {currentVideo ? currentVideo.file_name : 'MHZipy Video Player'}
            </span>
            <span className="titlebar-badge">Player</span>
          </div>

          <div className="window-controls">
            <button
              className="win-btn"
              title={t('viewer.minimize', { defaultValue: 'Minimize' })}
              onClick={handleMinimize}
            >
              <Minus size={14} />
            </button>
            <button
              className="win-btn"
              title={isMaximized ? t('viewer.restore', { defaultValue: 'Restore' }) : t('viewer.maximize', { defaultValue: 'Maximize' })}
              onClick={handleToggleMaximize}
            >
              {isMaximized ? <Maximize2 size={13} /> : <Square size={13} />}
            </button>
            <button
              className="win-btn win-close"
              title={t('viewer.close', { defaultValue: 'Close' })}
              onClick={handleClose}
            >
              <X size={15} />
            </button>
          </div>
        </header>
      )}

      {/* 2. Main Workspace (Video Viewer + Playlist) */}
      <main className="video-workspace">
        <section className="viewer-area" onWheel={handleViewerWheel}>
          {!currentVideo ? (
            <div className="empty-video-state">
              <Film size={48} color="#64748b" />
              <p>{t('viewer.noVideoSelected', { defaultValue: 'No video selected' })}</p>
            </div>
          ) : (
            <div className="video-wrapper" onClick={handleVideoClick}>
              <video
                ref={videoRef}
                key={currentVideo.path}
                src={mediaSrc}
                className="video-element"
                autoPlay={isPlaying}
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoadedMetadata}
                onDurationChange={(e) => updateMediaDuration(e.currentTarget)}
                onCanPlay={(e) => updateMediaDuration(e.currentTarget)}
                onEnded={playNext}
              />
            </div>
          )}

          {/* OSD Notification */}
          {osd && (
            <div className="osd-overlay">
              <div className="osd-icon-wrap">{osd.icon}</div>
              <span className="osd-text">{osd.text}</span>
            </div>
          )}
        </section>

        {/* Playlist Panel */}
        <Playlist
          items={playlist}
          currentIndex={currentIndex}
          isOpen={isPlaylistOpen && !isFullscreen}
          onSelectVideo={(idx) => {
            setCurrentIndex(idx);
            setIsPlaying(true);
          }}
          onClose={() => setIsPlaylistOpen(false)}
        />
      </main>

      {/* 3. Bottom Player Controls */}
      <PlayerControls
        currentVideo={currentVideo}
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        volume={volume}
        isMuted={isMuted}
        playbackRate={playbackRate}
        repeatMode={repeatMode}
        isPlaylistOpen={isPlaylistOpen}
        isFullscreen={isFullscreen}
        videoWidth={videoDimensions.width}
        videoHeight={videoDimensions.height}
        onTogglePlay={togglePlay}
        onSeek={handleSeek}
        onPrev={playPrev}
        onNext={playNext}
        onSkipTime={handleSkipTime}
        onChangeVolume={(vol) => {
          setIsMuted(false);
          setVolume(vol);
        }}
        onToggleMute={toggleMute}
        onChangeRate={cyclePlaybackRate}
        onToggleRepeat={cycleRepeatMode}
        onToggleFullscreen={toggleFullscreen}
        onTogglePlaylist={() => setIsPlaylistOpen((prev) => !prev)}
      />
    </div>
  );
};

export default VideoPlayer;

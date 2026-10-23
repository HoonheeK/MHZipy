export interface VideoFileInfo {
  path: string;
  file_name: string;
  file_size: number;
  modified_millis: number;
}

export type RepeatMode = 'off' | 'all' | 'one';

export interface OsdState {
  icon: React.ReactNode;
  text: string;
}

export interface ImageFileInfo {
  path: string;
  file_name: string;
  file_size: number;
  modified_millis: number;
}

export type ZoomMode = 'fit' | 'actual' | 'fit_width' | 'free';

export interface ImageDimensions {
  width: number;
  height: number;
}

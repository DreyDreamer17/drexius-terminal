import {
  Folder,
  FileText,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileImage,
  FileAudio,
  FileVideo,
} from 'lucide-react';
import type { FileEntry } from '../../lib/types';

export interface SftpContextMenuState {
  x: number;
  y: number;
  side: 'left' | 'right';
  targetEntry: FileEntry | null;
  selectedEntries: FileEntry[];
}

export interface SftpPromptDialogState {
  type: 'newFile' | 'newFolder' | 'rename';
  side: 'left' | 'right';
  title: string;
  currentVal: string;
  targetPath?: string;
}

export interface SftpDeleteConfirmState {
  entries: FileEntry[];
  side: 'left' | 'right';
  deleting?: boolean;
}

export interface SftpTransferStatus {
  type: 'upload' | 'download';
  filename: string;
  progress: number;
}

export function fmtSize(n: number): string {
  if (n === 0) return '0 Bytes';
  if (n < 1024) return `${n}.00 Bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} kB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function fmtDate(sec?: number | null): string {
  if (!sec) return '- -';
  const d = new Date(sec * 1000);
  return d.toLocaleString('en-US', {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function fmtPerm(m?: number | null, isDir?: boolean): string {
  if (m == null) return isDir ? 'drwxr-xr-x' : '-rw-r--r--';
  const d = isDir ? 'd' : '-';
  return (
    d +
    [6, 3, 0]
      .map((s) => ((m >> s) & 4 ? 'r' : '-') + ((m >> s) & 2 ? 'w' : '-') + ((m >> s) & 1 ? 'x' : '-'))
      .join('')
  );
}

export function fmtKind(e: FileEntry): string {
  if (e.isDir) return 'folder';
  const parts = e.name.split('.');
  if (parts.length > 1 && parts[parts.length - 1]) {
    return parts[parts.length - 1].toLowerCase();
  }
  return 'file';
}

export function fileIcon(e: FileEntry) {
  if (e.isDir) return Folder;
  const ext = e.name.split('.').pop()?.toLowerCase();
  if (['zip', 'tar', 'gz', 'tgz', 'xz', 'bz2', '7z', 'rar'].includes(ext || '')) return FileArchive;
  if (
    [
      'sh',
      'bash',
      'zsh',
      'py',
      'js',
      'ts',
      'tsx',
      'jsx',
      'rs',
      'go',
      'c',
      'cpp',
      'h',
      'json',
      'yaml',
      'yml',
      'toml',
      'html',
      'css',
      'sql',
    ].includes(ext || '')
  )
    return FileCode;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext || '')) return FileImage;
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext || '')) return FileAudio;
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext || '')) return FileVideo;
  if (['csv', 'tsv', 'xlsx', 'xls'].includes(ext || '')) return FileSpreadsheet;
  return FileText;
}

export function buildSftpCrumbs(path: string, hostId: string | null): { name: string; fullPath: string }[] {
  if (!path) return [];
  if (!hostId && path.startsWith('/storage/emulated/0')) {
    const rel = path.slice('/storage/emulated/0'.length);
    const parts = rel.split('/').filter(Boolean);
    return parts.map((part, index) => ({
      name: part,
      fullPath: '/storage/emulated/0/' + parts.slice(0, index + 1).join('/'),
    }));
  }
  const parts = path.split('/').filter(Boolean);
  return parts.map((part, index) => ({
    name: part,
    fullPath: '/' + parts.slice(0, index + 1).join('/'),
  }));
}

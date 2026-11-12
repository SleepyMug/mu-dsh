/** The browser half's copy, in dsh's two UI languages. */

export const NS = 'mu-dsh-files'

export const en = {
  'type.label': 'Files',
  'guide.title': 'Workspace files',
  'guide.description': 'Browse this session\'s workspace, and download files and folders',
  opening: 'Opening…',
  loading: 'Reading…',
  empty: 'Empty folder',
  truncated: 'This folder holds too many entries; only the first are shown.',
  'entry.other': 'Neither a file nor a folder; it cannot be opened.',
  noWorkspace: 'This session has no workspace folder.',
  reload: 'Reload',
  'reload.stale': 'Reload. Changes on disk are not showing up by themselves right now.',
  up: 'Open the enclosing folder',
  download: 'Download',
  'download.zip': 'Download as ZIP',
  'download.failed': 'Download refused: {message}',
  unviewable: 'Nothing in this workspace can show this file.',
  'error.not-found': 'This no longer exists; it may have been moved or deleted.',
  'error.not-permitted': 'dsh may not read this.',
  'error.not-regular': 'This is neither a file nor a folder.',
  'error.too-large': 'Too large to download as one archive.',
  'error.bad-request': 'This path cannot be read.',
  'error.unavailable': 'Could not read this: {message}',
}

export type Key = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'mu-dsh-files': Key
  }
}

export const zh: Record<Key, string> = {
  'type.label': '文件',
  'guide.title': '工作区文件',
  'guide.description': '浏览会话的工作区，下载文件和文件夹',
  opening: '正在打开…',
  loading: '正在读取…',
  empty: '空文件夹',
  truncated: '条目太多，只显示了前面一部分。',
  'entry.other': '这不是文件或文件夹，没法打开。',
  noWorkspace: '这个会话没有工作区文件夹。',
  reload: '重新读取',
  'reload.stale': '重新读取。磁盘上的改动暂时不会自动显示。',
  up: '打开上一级文件夹',
  download: '下载',
  'download.zip': '下载为 ZIP',
  'download.failed': '无法下载：{message}',
  unviewable: '没有可以显示这个文件的查看器。',
  'error.not-found': '它已经不在了，可能被移动或删除。',
  'error.not-permitted': 'dsh 无权读取它。',
  'error.not-regular': '这不是文件或文件夹。',
  'error.too-large': '太大了，无法打包成一个压缩包下载。',
  'error.bad-request': '无法读取这个路径。',
  'error.unavailable': '读取失败：{message}',
}

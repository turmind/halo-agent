/**
 * Shared file tree node type used by the /files/tree API.
 * The backend returns these; the frontend stores them in the editor store
 * and lazily fills in `children` as directories are expanded.
 */
export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  /** Directory contains visible entries. Unknown/absent for files. */
  hasChildren?: boolean
  /** Loaded children (directories only, frontend-side). Undefined = not yet loaded. */
  children?: FileTreeNode[]
}

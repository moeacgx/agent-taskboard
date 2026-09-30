import { useRef, useState } from "react";

import { useTaskboardI18n } from "../i18n";
import type { PaseoCreatedWorktree } from "../paseo-bridge";
import { PaseoWorktreePicker, type PaseoWorktreePickerHandle } from "./PaseoWorktreePicker";
import type { PaseoWorkspaceOption } from "./PaseoWorkspacePicker";

interface PaseoWorktreeDialogProps {
  open: boolean;
  workspaces: PaseoWorkspaceOption[];
  initialWorkspacePath: string | null;
  defaultWorkspacePath?: string | null;
  taskId?: string;
  onClose: () => void;
  onCreated: (result: PaseoCreatedWorktree) => void | Promise<void>;
  onSaveDirectory: (path: string | null) => Promise<void>;
}

/** 任务详情内就地编辑目录，不再嵌套打开模态窗口。 */
export function PaseoWorktreeDialog(props: PaseoWorktreeDialogProps) {
  return props.open ? <InlineWorktreeEditor {...props} /> : null;
}

function InlineWorktreeEditor({ workspaces, initialWorkspacePath, defaultWorkspacePath, taskId, onClose, onCreated, onSaveDirectory }: PaseoWorktreeDialogProps) {
  const { text } = useTaskboardI18n();
  const pickerRef = useRef<PaseoWorktreePickerHandle>(null);
  const [workspacePath, setWorkspacePath] = useState(initialWorkspacePath);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const created = await pickerRef.current?.prepare();
      if (created) await onCreated(created);
      else await onSaveDirectory(workspacePath);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }
  return <div className="paseo-inline-directory-editor">
    <PaseoWorktreePicker ref={pickerRef} workspaces={workspaces} workspacePath={workspacePath} defaultWorkspacePath={defaultWorkspacePath} initialMode="worktree" taskId={taskId} disabled={saving} onWorkspaceChange={setWorkspacePath} />
    {error && <p className="paseo-source-error" role="alert">{error}</p>}
    <div className="paseo-inline-directory-actions">
      <button type="button" className="button secondary" disabled={saving} onClick={onClose}>{text("取消", "Cancel")}</button>
      <button type="button" className="button primary" disabled={saving} onClick={() => void save()}>{saving ? text("保存中…", "Saving…") : text("保存目录", "Save directory")}</button>
    </div>
  </div>;
}

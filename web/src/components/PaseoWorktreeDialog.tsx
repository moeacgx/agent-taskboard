import { useEffect, useMemo, useState } from "react";

import { createPaseoWorktree, inspectPaseoWorktree } from "../api";
import { useTaskboardI18n } from "../i18n";
import type { PaseoCreatedWorktree, PaseoWorktreeScan } from "../paseo-bridge";
import { LinearIcon } from "./LinearIcon";
import { PaseoWorkspacePicker, type PaseoWorkspaceOption } from "./PaseoWorkspacePicker";

interface PaseoWorktreeDialogProps {
  open: boolean;
  workspaces: PaseoWorkspaceOption[];
  initialWorkspacePath: string | null;
  taskId?: string;
  onClose: () => void;
  onCreated: (result: PaseoCreatedWorktree) => void | Promise<void>;
}

const INITIAL_WORKSPACE_ID = "paseo:worktree-source";

function folderName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

/**
 * 只在 Paseo iframe 中创建 daemon 管理的 worktree。浏览器不运行 git，
 * 返回的 `workspaceDirectory` 是后续 Agent 计划唯一可用的 cwd。
 */
export function PaseoWorktreeDialog({
  open,
  workspaces,
  initialWorkspacePath,
  taskId,
  onClose,
  onCreated,
}: PaseoWorktreeDialogProps) {
  const { text } = useTaskboardI18n();
  const [scan, setScan] = useState<PaseoWorktreeScan | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createdResult, setCreatedResult] = useState<PaseoCreatedWorktree | null>(null);
  const dialogWorkspaces = useMemo(() => {
    if (!initialWorkspacePath) return workspaces;
    return [{
      id: INITIAL_WORKSPACE_ID,
      name: text("当前任务目录", "Current task directory"),
      path: initialWorkspacePath,
      projectWorkspace: false,
      kind: "workspace" as const,
    }, ...workspaces.filter((workspace) => workspace.path !== initialWorkspacePath)];
  }, [initialWorkspacePath, text, workspaces]);
  const [workspaceId, setWorkspaceId] = useState("");
  const selectedWorkspace = dialogWorkspaces.find((workspace) => workspace.id === workspaceId) ?? null;

  useEffect(() => {
    if (!open) return;
    setWorkspaceId(initialWorkspacePath ? INITIAL_WORKSPACE_ID : "");
    setScan(null);
    setError(null);
    setBranch("");
    setMode("new");
    setCreatedResult(null);
  }, [initialWorkspacePath, open]);

  useEffect(() => {
    if (!open) return;
    const workspacePath = selectedWorkspace?.path ?? null;
    setScan(null);
    setError(null);
    setBranch("");
    setMode("new");
    setCreatedResult(null);
    setLoading(false);
    if (!workspacePath) return;
    let active = true;
    setLoading(true);
    void inspectPaseoWorktree(workspacePath).then(
      (next) => {
        if (!active) return;
        setScan(next);
        setError(next.error);
      },
      (reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      },
    ).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [open, selectedWorkspace?.path]);

  const worktreeByBranch = useMemo(() => new Map(
    (scan?.worktrees ?? []).flatMap((worktree) => worktree.branch ? [[worktree.branch, worktree.path] as const] : []),
  ), [scan?.worktrees]);
  const availableBranches = (scan?.branches ?? []).filter((candidate) => !worktreeByBranch.has(candidate));

  if (!open) return null;

  async function submit() {
    if (!scan?.gitRoot || !scan.isGitRoot || !branch.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const result = createdResult ?? await createPaseoWorktree({
        workspacePath: scan.gitRoot,
        branch: branch.trim(),
        branchMode: mode,
        ...(taskId ? { taskId } : {}),
      });
      // 后续写 task developmentContext 失败时保留这份 daemon 返回值；重试只关联任务，
      // 绝不再创建第二个同名 Worktree。
      if (!createdResult) setCreatedResult(result);
      await onCreated(result);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="paseo-worktree-dialog-backdrop" role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !creating) onClose();
    }}>
      <section className="paseo-worktree-dialog" role="dialog" aria-modal="true" aria-labelledby="paseo-worktree-title">
        <header>
          <div>
            <h2 id="paseo-worktree-title">{text("创建 Worktree", "Create worktree")}</h2>
            <p>{selectedWorkspace?.path ?? text("先选择源项目或工作区", "Select a source project or workspace")}</p>
          </div>
          <button type="button" className="icon-button" aria-label={text("关闭创建 Worktree", "Close create worktree")} disabled={creating} onClick={onClose}>
            <LinearIcon name="close" />
          </button>
        </header>

        <label className="paseo-worktree-source">
          <span>{text("源项目 / 工作区", "Source project / workspace")}</span>
          <PaseoWorkspacePicker
            options={dialogWorkspaces}
            value={workspaceId}
            disabled={creating || Boolean(createdResult)}
            ariaLabel={text("选择 Worktree 源项目或工作区", "Select worktree source project or workspace")}
            placeholder={text("选择源项目或工作区", "Select source project or workspace")}
            onChange={setWorkspaceId}
          />
        </label>

        {!selectedWorkspace && !loading && (
          <p className="paseo-worktree-loading">{text(
            "请选择一个真实项目或工作区作为 Worktree 来源。",
            "Select a real project or workspace as the worktree source.",
          )}</p>
        )}
        {loading && <p className="paseo-worktree-loading">{text("正在检查 Git 仓库…", "Checking Git repository…")}</p>}
        {!loading && error && <p className="paseo-worktree-error" role="alert">{error}</p>}
        {!loading && scan?.gitRoot && !scan.isGitRoot && (
          <p className="paseo-worktree-error" role="alert">{text("只能在 Git 根目录创建 Worktree。", "A worktree can only be created from the Git root.")}</p>
        )}
        {!loading && scan?.gitRoot && scan.isGitRoot && (
          <div className="paseo-worktree-form">
            <p className="paseo-worktree-root">{text("Git 根目录", "Git root")}：{scan.gitRoot}</p>
            <div className="paseo-worktree-mode" role="group" aria-label={text("分支来源", "Branch source")}>
              <button type="button" disabled={creating || Boolean(createdResult)} className={mode === "new" ? "active" : ""} onClick={() => { setMode("new"); setBranch(""); }}>
                {text("新分支", "New branch")}
              </button>
              <button type="button" disabled={creating || Boolean(createdResult)} className={mode === "existing" ? "active" : ""} onClick={() => { setMode("existing"); setBranch(availableBranches[0] ?? ""); }}>
                {text("已有分支", "Existing branch")}
              </button>
            </div>
            {createdResult && <p className="paseo-worktree-created-path">{text("已创建 Worktree", "Created worktree")}：{createdResult.workspace.path}</p>}
            {mode === "new" ? (
              <label>
                <span>{text("新分支名称", "New branch name")}</span>
                <input autoFocus disabled={creating || Boolean(createdResult)} value={branch} placeholder={text(`基于 ${scan.head ?? "HEAD"}`, `From ${scan.head ?? "HEAD"}`)} onChange={(event) => setBranch(event.target.value)} />
                <small>{text(`基于当前 HEAD：${scan.head ?? "分离 HEAD"}`, `Based on current HEAD: ${scan.head ?? "detached"}`)}</small>
              </label>
            ) : (
              <label>
                <span>{text("已有分支", "Existing branch")}</span>
                <select disabled={creating || Boolean(createdResult)} value={branch} onChange={(event) => setBranch(event.target.value)}>
                  <option value="">{text("选择分支", "Select a branch")}</option>
                  {availableBranches.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
                  {[...worktreeByBranch.entries()].map(([candidate, worktreePath]) => (
                    <option key={candidate} value={candidate} disabled>{candidate} · {text(`已在 ${folderName(worktreePath)} 中检出`, `Already checked out in ${folderName(worktreePath)}`)}</option>
                  ))}
                </select>
                {availableBranches.length === 0 && <small>{text("所有本地分支都已在 Worktree 中检出，可直接从上方列表选择。", "Every local branch is already checked out in a worktree; select one from the list above.")}</small>}
              </label>
            )}
          </div>
        )}

        <footer>
          <button type="button" className="button secondary" disabled={creating} onClick={onClose}>{text("取消", "Cancel")}</button>
          <button
            type="button"
            className="button primary"
            disabled={creating || !scan?.gitRoot || !scan.isGitRoot || !branch.trim()}
            onClick={() => void submit()}
          >
            {creating
              ? text("保存中…", "Saving…")
              : createdResult
                ? text("重试关联任务", "Retry task link")
                : text("创建 Worktree", "Create worktree")}
          </button>
        </footer>
      </section>
    </div>
  );
}

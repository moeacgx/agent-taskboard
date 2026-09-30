import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { createPaseoWorktree, inspectPaseoWorktree } from "../api";
import { useTaskboardI18n } from "../i18n";
import { listenForOutsidePointerDown, listenForMenuViewportChange } from "../menuEvents";
import type { PaseoCreatedWorktree, PaseoWorktreeScan } from "../paseo-bridge";
import { BranchIcon } from "./SemanticIcons";
import { LinearIcon } from "./LinearIcon";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { PaseoWorkspacePicker, type PaseoWorkspaceOption } from "./PaseoWorkspacePicker";

export interface PaseoWorktreePickerHandle {
  prepare: () => Promise<PaseoCreatedWorktree | null>;
  reset: () => void;
}

interface Props {
  workspaces: PaseoWorkspaceOption[];
  workspacePath: string | null;
  defaultWorkspacePath?: string | null;
  initialMode?: "local" | "worktree";
  disabled?: boolean;
  taskId?: string;
  onWorkspaceChange: (path: string | null) => void;
}

/** 选择只修改草稿；调用 prepare 时才请求宿主创建 Worktree。 */
export const PaseoWorktreePicker = forwardRef<PaseoWorktreePickerHandle, Props>(function PaseoWorktreePicker({
  workspaces, workspacePath, defaultWorkspacePath = null, initialMode = "local", disabled = false, taskId, onWorkspaceChange,
}, ref) {
  const { text } = useTaskboardI18n();
  const [mode, setMode] = useState(initialMode);
  const [modeOpen, setModeOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scan, setScan] = useState<PaseoWorktreeScan | null>(null);
  const [scanPath, setScanPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState("");
  const [created, setCreated] = useState<PaseoCreatedWorktree | null>(null);
  const preparedRef = useRef<PaseoCreatedWorktree | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const sourcePath = workspacePath ?? defaultWorkspacePath;
  const locked = disabled || Boolean(created);
  const workspaceOptions = useMemo(() => {
    if (!sourcePath || workspaces.some((workspace) => workspace.path === sourcePath)) return workspaces;
    return [{ id: "paseo:worktree-current-source", name: sourcePath.split(/[\\/]/).filter(Boolean).at(-1) ?? sourcePath,
      path: sourcePath, kind: "workspace" as const, projectWorkspace: false }, ...workspaces];
  }, [sourcePath, workspaces]);
  const workspaceId = workspaceOptions.find((workspace) => workspace.path === sourcePath)?.id ?? "";

  useEffect(() => {
    setBranchOpen(false);
    setScan(null);
    setScanPath(null);
    setBaseBranch("");
    setError(null);
    setLoading(false);
    if (mode !== "worktree" || !sourcePath) return;
    let active = true;
    setLoading(true);
    void inspectPaseoWorktree(sourcePath).then((result) => {
      if (!active) return;
      setScan(result);
      setScanPath(sourcePath);
      setError(result.error);
      setBaseBranch(result.defaultBranch ?? (result.head ? `refs/heads/${result.head}` : ""));
    }, (caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sourcePath, mode]);

  const branches = useMemo(() => {
    if (!scan) return [];
    const options = scan.remoteBranches.flatMap((branch) => {
      const remote = branch.name.slice(0, -branch.branch.length - 1);
      return [{ ref: branch.ref, label: remote === "origin" ? branch.branch : branch.name, local: false }];
    });
    for (const branch of scan.branches) {
      if (scan.remoteBranches.some((remote) => remote.branch === branch && remote.localMatches)) continue;
      const option = { ref: `refs/heads/${branch}`, label: `${branch} (local)`, local: true };
      const remoteIndex = options.findIndex((candidate) => candidate.label === branch);
      if (remoteIndex >= 0) options.splice(remoteIndex + 1, 0, option);
      else options.push(option);
    }
    const defaultIndex = options.findIndex((option) => option.ref === scan.defaultBranch);
    if (defaultIndex > 0) options.unshift(options.splice(defaultIndex, 1)[0]);
    return options;
  }, [scan]);
  const selectedBranch = branches.find((branch) => branch.ref === baseBranch);
  const visibleBranches = branches.filter((branch) => `${branch.label} ${branch.ref}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  useImperativeHandle(ref, () => ({
    async prepare() {
      if (preparedRef.current) return preparedRef.current;
      if (mode === "local") return null;
      if (!sourcePath) throw new Error(text("请选择代码项目。", "Select a code project."));
      if (loading || scanPath !== sourcePath) throw new Error(text("正在读取分支，请稍后重试。", "Branches are still loading. Try again shortly."));
      if (!scan?.gitRoot || !scan.isGitRoot || !selectedBranch) throw new Error(error ?? text("请选择可用的起始分支。", "Select an available base branch."));
      const result = await createPaseoWorktree({ workspacePath: scan.gitRoot, branchMode: "new", baseBranch: selectedBranch.ref, ...(taskId ? { taskId } : {}) });
      // 保存任务失败后重试复用已创建目录，避免再创建一个 Worktree。
      preparedRef.current = result;
      setCreated(result);
      return result;
    },
    reset() { preparedRef.current = null; setCreated(null); },
  }), [mode, sourcePath, loading, scanPath, scan, selectedBranch, error, taskId, text]);

  useLayoutEffect(() => {
    if (!branchOpen || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const above = trigger.bottom + 4 + menu.height > window.innerHeight - 8 && trigger.top - menu.height - 4 >= 8;
    setPosition({
      left: Math.max(8, Math.min(trigger.left, window.innerWidth - menu.width - 8)),
      top: Math.max(8, Math.min(above ? trigger.top - menu.height - 4 : trigger.bottom + 4, window.innerHeight - menu.height - 8)),
    });
  }, [branchOpen, visibleBranches.length]);

  useEffect(() => {
    if (!branchOpen) return;
    searchRef.current?.focus({ preventScroll: true });
    const stopOutside = listenForOutsidePointerDown([triggerRef, menuRef], () => setBranchOpen(false));
    const stopViewport = listenForMenuViewportChange(menuRef, () => setBranchOpen(false));
    return () => { stopOutside(); stopViewport(); };
  }, [branchOpen]);

  const branchMenu = branchOpen ? createPortal(
    <div ref={menuRef} className="paseo-source-branch-menu" style={{ left: position.left, top: position.top }} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setBranchOpen(false); triggerRef.current?.focus(); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='option']") ?? []);
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        options[Math.max(0, Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
      }
    }}>
      <label className="paseo-source-branch-search"><LinearIcon name="search" /><input ref={searchRef} type="search" aria-label={text("搜索分支", "Search branches")} placeholder={text("搜索分支", "Search branches")} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="paseo-source-branch-options" role="listbox" aria-label={text("起始分支", "Base branch")}>
        {visibleBranches.map((branch) => <button key={branch.ref} type="button" role="option" aria-selected={baseBranch === branch.ref} title={branch.ref} onClick={() => { setBaseBranch(branch.ref); setBranchOpen(false); triggerRef.current?.focus(); }}>
          <BranchIcon size={14} color="currentColor" /><span>{branch.label}</span>{baseBranch === branch.ref && <LinearIcon name="check" />}
        </button>)}
        {visibleBranches.length === 0 && <p>{text("没有匹配的分支", "No matching branches")}</p>}
      </div>
    </div>, triggerRef.current?.closest("dialog, [role='dialog']") ?? document.body,
  ) : null;

  return <div className="paseo-source-controls">
    <div className="paseo-source-toolbar">
      <PaseoWorkspacePicker options={workspaceOptions} value={workspaceId} allowEmpty disabled={locked} ariaLabel={text("代码项目", "Code project")} placeholder={text("选择代码项目", "Select code project")} emptyLabel={text("使用项目默认目录", "Use project default directory")} onChange={(id) => onWorkspaceChange(workspaceOptions.find((workspace) => workspace.id === id)?.path ?? null)} />
      <TaskPropertyPicker value={mode} options={[
        { value: "local", label: text("本地", "Local"), icon: <LinearIcon name="folder" /> },
        { value: "worktree", label: text("新建 worktree", "New worktree"), icon: <BranchIcon size={14} color="currentColor" /> },
      ]} open={modeOpen} disabled={locked} triggerClassName="property-control paseo-source-mode" ariaLabel={text("工作目录方式", "Working directory mode")} onOpenChange={setModeOpen} onChange={(next) => { setMode(next); setBranchOpen(false); }} />
      {mode === "worktree" && <button ref={triggerRef} type="button" className="property-control paseo-source-branch" aria-haspopup="listbox" aria-expanded={branchOpen} aria-label={text("选择起始分支", "Select base branch")} disabled={locked || loading || !branches.length} onClick={() => { setQuery(""); setBranchOpen((current) => !current); }}>
        <BranchIcon size={14} color="currentColor" /><span>{loading ? text("读取分支…", "Loading branches…") : selectedBranch?.label ?? text("选择分支", "Select branch")}</span><LinearIcon name="chevronDown" />
      </button>}
      {branchMenu}
    </div>
    {mode === "worktree" && !sourcePath && <small>{text("先选择代码项目，再选择起始分支。", "Select a code project, then a base branch.")}</small>}
    {error && <p role="alert" className="paseo-source-error">{error}</p>}
    {created && <small>{text(`已创建 ${created.workspace.branch}，重试会使用同一目录。`, `Created ${created.workspace.branch}; retries use the same directory.`)}</small>}
  </div>;
});

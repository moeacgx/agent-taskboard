import { useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useTaskboardI18n } from "../i18n";
import type {
  PaseoAgentProfile,
  PaseoConfigurationOptions,
  PaseoConfigurationOptionsRequest,
} from "../paseo-bridge";
import { LinearIcon } from "./LinearIcon";
import { PaseoAssigneePicker, type PaseoAssigneeOption } from "./PaseoAssigneePicker";
import { PaseoConfigurationFields, type PaseoConfigurationSelection } from "./PaseoConfigurationFields";
import { PaseoWorkspacePicker, type PaseoWorkspaceOption } from "./PaseoWorkspacePicker";

export interface PaseoProjectDefaultsValue {
  profile: PaseoAgentProfile | null;
  workspacePath: string | null;
}

export interface PaseoProjectDefaultsCatalog {
  options: PaseoAssigneeOption[];
  profiles: ReadonlyMap<string, PaseoAgentProfile>;
  workspaces: PaseoWorkspaceOption[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  loadConfigurationOptions: (target: PaseoConfigurationOptionsRequest) => Promise<PaseoConfigurationOptions>;
}

interface PaseoProjectDefaultsDialogProps {
  title: string;
  description: string;
  projectName?: string;
  onProjectNameChange?: (name: string) => void;
  onDelete?: () => void;
  value: PaseoProjectDefaultsValue;
  catalog: PaseoProjectDefaultsCatalog;
  onClose: () => void;
  onSave: (value: PaseoProjectDefaultsValue) => Promise<boolean | void> | boolean | void;
}

const NO_DEFAULT_AGENT_ID = "paseo:no-default-agent";
const SAVED_DEFAULT_AGENT_ID = "paseo:saved-project-default-agent";
const SAVED_DEFAULT_WORKSPACE_ID = "paseo:saved-project-default-workspace";

export function PaseoProjectDefaultsDialog({
  title,
  description,
  projectName,
  onProjectNameChange,
  onDelete,
  value,
  catalog,
  onClose,
  onSave,
}: PaseoProjectDefaultsDialogProps) {
  const { text } = useTaskboardI18n();
  const [choiceId, setChoiceId] = useState(() => (
    value.profile ? SAVED_DEFAULT_AGENT_ID : NO_DEFAULT_AGENT_ID
  ));
  const [workspaceId, setWorkspaceId] = useState(() => (
    value.workspacePath ? SAVED_DEFAULT_WORKSPACE_ID : ""
  ));
  const [configuration, setConfiguration] = useState<PaseoConfigurationSelection>({
    ...(value.profile?.modeId ? { modeId: value.profile.modeId } : {}),
    ...(value.profile?.thinkingOptionId ? { thinkingOptionId: value.profile.thinkingOptionId } : {}),
  });
  const [configurationReady, setConfigurationReady] = useState(!value.profile?.model);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const options = useMemo(() => [
    {
      id: NO_DEFAULT_AGENT_ID,
      label: text("不指定默认 Agent", "No default Agent"),
      detail: text("任务开始时再选择", "Choose when starting a task"),
      group: "self" as const,
    },
    ...(value.profile ? [{
      id: SAVED_DEFAULT_AGENT_ID,
      label: value.profile.name,
      detail: text("当前已保存的默认 Agent", "Currently saved default Agent"),
      group: "profile" as const,
      provider: value.profile.provider,
      model: value.profile.model,
      modeId: value.profile.modeId,
      thinkingOptionId: value.profile.thinkingOptionId,
    }] : []),
    ...catalog.options,
  ], [catalog.options, choiceId, text, value.profile]);
  const profiles = useMemo(() => new Map([
    ...(value.profile ? [[SAVED_DEFAULT_AGENT_ID, value.profile] as const] : []),
    ...catalog.profiles,
  ]), [catalog.profiles, value.profile]);
  const workspaces = useMemo(() => [
    ...(value.workspacePath ? [{
      id: SAVED_DEFAULT_WORKSPACE_ID,
      name: text("当前已保存工作区", "Saved workspace"),
      path: value.workspacePath,
      projectWorkspace: false,
      kind: "workspace" as const,
    }] : []),
    ...catalog.workspaces.filter((workspace) => workspace.path !== value.workspacePath),
  ], [catalog.workspaces, text, value.workspacePath]);
  const profile = choiceId === NO_DEFAULT_AGENT_ID ? null : profiles.get(choiceId) ?? null;
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const target = profile?.model ? {
    provider: profile.provider,
    model: profile.model,
    workspacePath: workspace?.path ?? null,
    ...(configuration.modeId ?? profile.modeId ? { modeId: configuration.modeId ?? profile.modeId } : {}),
    ...(configuration.thinkingOptionId ?? profile.thinkingOptionId
      ? { thinkingOptionId: configuration.thinkingOptionId ?? profile.thinkingOptionId }
      : {}),
  } : null;

  async function submit() {
    if (saving || (target && !configurationReady)) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await onSave({
        workspacePath: workspace?.path ?? null,
        profile: profile ? {
          ...profile,
          modeId: configuration.modeId,
          thinkingOptionId: configuration.thinkingOptionId,
        } : null,
      });
      if (result === false) {
        setSaveError(text("默认执行配置未保存，请重试。", "Default execution settings were not saved. Try again."));
      } else {
        onClose();
      }
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div className="delete-backdrop automation-defaults-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <div
        className="delete-dialog automation-defaults-dialog project-automation-defaults-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-defaults-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose();
        }}
      >
        <header>
          <div>
            <h2 id="project-defaults-title">{title}</h2>
            <p>{description}</p>
          </div>
          <button type="button" className="icon-button" disabled={saving} aria-label={text("关闭", "Close")} onClick={onClose}>
            <LinearIcon name="close" />
          </button>
        </header>
        <div className="automation-defaults-fields project-automation-defaults-form">
          {projectName !== undefined && onProjectNameChange && (
            <label className="project-automation-defaults-name">
              <span className="project-automation-defaults-label">{text("项目名称", "Project name")}</span>
              <input
                maxLength={120}
                required
                value={projectName}
                onChange={(event) => onProjectNameChange(event.target.value)}
              />
            </label>
          )}
          <div className="project-automation-defaults-field">
            <span className="project-automation-defaults-label">Agent</span>
            <div className="project-automation-defaults-control">
              <PaseoAssigneePicker
                options={options}
                value={choiceId}
                loading={catalog.loading}
                error={catalog.error}
                onRefresh={catalog.onRefresh}
                onChange={(id) => {
                  setChoiceId(id);
                  setConfiguration({});
                  setConfigurationReady(id === NO_DEFAULT_AGENT_ID);
                  setSaveError(null);
                }}
              />
            </div>
          </div>
          <div className="project-automation-defaults-field">
            <span className="project-automation-defaults-label">{text("工作区（可选）", "Workspace (optional)")}</span>
            <div className="project-automation-defaults-control">
              <PaseoWorkspacePicker
                options={workspaces}
                value={workspaceId}
                allowEmpty
                emptyLabel={text("不指定默认工作区", "No default workspace")}
                placeholder={text("选择工作区", "Select workspace")}
                onChange={(id) => {
                  setWorkspaceId(id);
                  setConfiguration({});
                  setConfigurationReady(!profile?.model);
                  setSaveError(null);
                }}
              />
            </div>
          </div>
          {!workspace && (
            <p className="automation-defaults-workspace-note">{text(
              "未指定时，执行任务使用任务或所属项目目录；缺少目录时等待配置。",
              "Without a default, execution uses the task or project directory; if none is available, it waits for configuration.",
            )}</p>
          )}
          {target && (
            <PaseoConfigurationFields
              target={target}
              loadOptions={catalog.loadConfigurationOptions}
              onSelectionChange={setConfiguration}
              onReadyChange={setConfigurationReady}
              variant="editor"
            />
          )}
        </div>
        {saveError && <p className="project-automation-error" role="alert">{saveError}</p>}
        <div className="automation-defaults-actions project-automation-defaults-footer">
          <div className="project-defaults-leading-actions">
            {onDelete && (
              <button type="button" className="button danger" disabled={saving} onClick={onDelete}>
                {text("删除项目", "Delete project")}
              </button>
            )}
            {(value.profile || value.workspacePath) && (
              <button
                type="button"
                className="button secondary automation-defaults-clear"
                disabled={saving}
                onClick={() => {
                  setChoiceId(NO_DEFAULT_AGENT_ID);
                  setWorkspaceId("");
                  setConfiguration({});
                  setConfigurationReady(true);
                  setSaveError(null);
                }}
              >
                {text("清除默认配置", "Clear defaults")}
              </button>
            )}
          </div>
          <span />
          <button type="button" className="button secondary" disabled={saving} onClick={onClose}>{text("取消", "Cancel")}</button>
          <button
            type="button"
            className="button primary"
            disabled={saving || Boolean(target && !configurationReady) || (projectName !== undefined && !projectName.trim())}
            onClick={() => void submit()}
          >
            {saving
              ? text("保存中…", "Saving…")
              : projectName !== undefined
                ? text("保存项目设置", "Save project settings")
                : text("保存默认配置", "Save defaults")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

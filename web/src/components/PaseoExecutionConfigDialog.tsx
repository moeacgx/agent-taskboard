import { useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useTaskboardI18n } from "../i18n";
import type {
  PaseoConfigurationOptions,
  PaseoConfigurationOptionsRequest,
} from "../paseo-bridge";
import { LinearIcon } from "./LinearIcon";
import {
  PaseoAssigneePicker,
  type PaseoAssigneeOption,
} from "./PaseoAssigneePicker";
import {
  PaseoConfigurationFields,
  type PaseoConfigurationSelection,
} from "./PaseoConfigurationFields";
import {
  PaseoWorkspacePicker,
  type PaseoWorkspaceOption,
} from "./PaseoWorkspacePicker";

interface PaseoExecutionConfigDialogProps {
  taskIdentifier: string;
  options: PaseoAssigneeOption[];
  workspaces: PaseoWorkspaceOption[];
  loading: boolean;
  error: string | null;
  initialChoiceId: string;
  initialWorkspacePath: string | null;
  initialModeId?: string;
  initialThinkingOptionId?: string;
  onRefresh: () => void;
  loadOptions: (target: PaseoConfigurationOptionsRequest) => Promise<PaseoConfigurationOptions>;
  onCancel: () => void;
  onSave: (
    choiceId: string,
    workspacePath: string | null,
    selection: PaseoConfigurationSelection,
  ) => Promise<void>;
}

const SAVED_WORKSPACE_ID = "paseo:saved-task-workspace";

export function PaseoExecutionConfigDialog({
  taskIdentifier,
  options,
  workspaces,
  loading,
  error,
  initialChoiceId,
  initialWorkspacePath,
  initialModeId,
  initialThinkingOptionId,
  onRefresh,
  loadOptions,
  onCancel,
  onSave,
}: PaseoExecutionConfigDialogProps) {
  const { text } = useTaskboardI18n();
  const dialogWorkspaces = useMemo(() => {
    if (!initialWorkspacePath) return workspaces;
    return [{
      id: SAVED_WORKSPACE_ID,
      name: text("当前已保存目录", "Currently saved directory"),
      path: initialWorkspacePath,
      projectWorkspace: false,
      kind: "workspace" as const,
    }, ...workspaces.filter((workspace) => workspace.path !== initialWorkspacePath)];
  }, [initialWorkspacePath, text, workspaces]);
  const [choiceId, setChoiceId] = useState(initialChoiceId);
  const [workspaceId, setWorkspaceId] = useState(() => (
    initialWorkspacePath
      ? dialogWorkspaces.find((workspace) => workspace.path === initialWorkspacePath)?.id ?? ""
      : ""
  ));
  const [configuration, setConfiguration] = useState<PaseoConfigurationSelection>({});
  const [configurationSeed, setConfigurationSeed] = useState<PaseoConfigurationSelection>({
    ...(initialModeId ? { modeId: initialModeId } : {}),
    ...(initialThinkingOptionId ? { thinkingOptionId: initialThinkingOptionId } : {}),
  });
  const [configurationReady, setConfigurationReady] = useState(() => {
    const initial = options.find((option) => option.id === initialChoiceId);
    return !initial?.model;
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const selectedOption = options.find((option) => option.id === choiceId) ?? null;
  const selectedWorkspace = dialogWorkspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const target = selectedOption?.provider && selectedOption.model
    ? {
        provider: selectedOption.provider,
        model: selectedOption.model,
        workspacePath: selectedWorkspace?.path ?? null,
        ...(configurationSeed.modeId ? { modeId: configurationSeed.modeId } : {}),
        ...(configurationSeed.thinkingOptionId
          ? { thinkingOptionId: configurationSeed.thinkingOptionId }
          : {}),
      }
    : null;

  function resetConfiguration(option: PaseoAssigneeOption | null) {
    setConfiguration({});
    setConfigurationSeed({
      ...(option?.modeId ? { modeId: option.modeId } : {}),
      ...(option?.thinkingOptionId ? { thinkingOptionId: option.thinkingOptionId } : {}),
    });
    setConfigurationReady(!option?.model);
    setSaveError(null);
  }

  async function submit() {
    if (saving) return;
    if (!selectedOption) {
      setSaveError(text("请选择 Agent 配置。", "Select an Agent configuration."));
      return;
    }
    if (!configurationReady) {
      setSaveError(text(
        "正在读取 Thinking/Mode 选项，请稍后。",
        "Thinking/Mode options are still loading.",
      ));
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(choiceId, selectedWorkspace?.path ?? null, configuration);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className="delete-backdrop automation-defaults-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onCancel();
      }}
    >
      <div
        className="delete-dialog automation-defaults-dialog paseo-execution-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="paseo-execution-config-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onCancel();
        }}
      >
        <header>
          <div>
            <h2 id="paseo-execution-config-title">
              {initialChoiceId
                ? text("编辑执行配置", "Edit execution configuration")
                : text("配置执行", "Configure execution")}
            </h2>
            <p>{text(
              `${taskIdentifier} 仅保存 Agent 计划，不会启动任务。`,
              `This only saves the Agent plan for ${taskIdentifier}; it does not start the task.`,
            )}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={saving}
            aria-label={text("关闭", "Close")}
            onClick={onCancel}
          >
            <LinearIcon name="close" />
          </button>
        </header>
        <div className="automation-defaults-fields paseo-execution-fields">
          <div className="paseo-execution-field">
            <span>{text("Agent", "Agent")}</span>
            <PaseoAssigneePicker
              options={options}
              value={choiceId || null}
              loading={loading}
              error={error}
              onRefresh={onRefresh}
              onChange={(id) => {
                setChoiceId(id);
                resetConfiguration(options.find((option) => option.id === id) ?? null);
              }}
            />
          </div>
          <div className="paseo-execution-field">
            <span>{text("代码工作目录", "Code working directory")}</span>
            <PaseoWorkspacePicker
              options={dialogWorkspaces}
              value={workspaceId}
              allowEmpty
              emptyLabel={text("使用项目默认目录", "Use project default directory")}
              placeholder={text("使用项目默认目录", "Use project default directory")}
              onChange={(id) => {
                setWorkspaceId(id);
                resetConfiguration(selectedOption);
              }}
            />
          </div>
          {target && (
            <PaseoConfigurationFields
              key={`${choiceId}\u0000${workspaceId}`}
              target={target}
              loadOptions={loadOptions}
              onSelectionChange={setConfiguration}
              onReadyChange={setConfigurationReady}
              variant="editor"
            />
          )}
        </div>
        {saveError && <p className="project-automation-error" role="alert">{saveError}</p>}
        <div className="automation-defaults-actions paseo-execution-actions">
          <span />
          <button type="button" className="button secondary" disabled={saving} onClick={onCancel}>
            {text("取消", "Cancel")}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={saving || !selectedOption || !configurationReady}
            onClick={() => void submit()}
          >
            {saving ? text("保存中…", "Saving…") : text("保存执行配置", "Save execution configuration")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

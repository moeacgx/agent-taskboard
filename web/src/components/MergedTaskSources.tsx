import type { MouseEvent } from "react";
import type { Attachment, Task, TaskRelationSummary } from "../types";
import { useTaskboardI18n } from "../i18n";
import { DescriptionDocument } from "./DescriptionDocument";
import { RelationIcon } from "./SemanticIcons";
import type { MergedTaskPresentation } from "../mergeTaskPresentation";

export function MergedTaskSources({
  presentation,
  referenceTasks,
  attachments,
  onOpenTask,
  onOpenAttachment,
}: {
  presentation: MergedTaskPresentation;
  referenceTasks: Task[];
  attachments: Attachment[];
  onOpenTask: (task: TaskRelationSummary) => void;
  onOpenAttachment?: (event: MouseEvent<HTMLAnchorElement>, attachment: Attachment) => void;
}) {
  const { text } = useTaskboardI18n();
  return (
    <section
      className="merged-task-sources"
      aria-label={text("合并来源", "Merged sources")}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="merged-task-sources-heading">
        <div>
          <span className="merged-task-sources-kicker">
            <RelationIcon color="currentColor" />
            {text("来源想法", "Source ideas")}
          </span>
          <strong>{presentation.sources.length}</strong>
        </div>
        <span>{text("已保留原记录并建立关联", "Original records are preserved and linked")}</span>
      </header>
      <div className="merged-task-source-list">
        {presentation.sources.map((source) => (
          <details className="merged-task-source" key={`${source.identifier}:${source.title}`}>
            <summary>
              <span className="merged-task-source-summary">
                <span className="merged-task-source-id">{source.identifier}</span>
                <strong>{source.title}</strong>
              </span>
              <span className="merged-task-source-chevron" aria-hidden="true">⌄</span>
            </summary>
            <div className="merged-task-source-content">
              {source.description && (
                <DescriptionDocument
                  value={source.description}
                  referenceTasks={referenceTasks}
                  onOpenTask={onOpenTask}
                  attachments={attachments}
                  onOpenAttachment={onOpenAttachment}
                />
              )}
              {source.comments.length > 0 && (
                <div className="merged-task-source-comments">
                  <span className="merged-task-source-section-label">{text("人工补充", "Human notes")}</span>
                  {source.comments.map((comment) => (
                    <div className="merged-task-source-comment" key={`${comment.author}:${comment.body}`}>
                      <span>{comment.author}</span>
                      <DescriptionDocument
                        value={comment.body}
                        referenceTasks={referenceTasks}
                        onOpenTask={onOpenTask}
                        attachments={attachments}
                        onOpenAttachment={onOpenAttachment}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

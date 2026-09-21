export interface MergedTaskComment {
  author: string;
  body: string;
}

export interface MergedTaskSource {
  identifier: string;
  title: string;
  description: string;
  comments: MergedTaskComment[];
}

export interface MergedTaskPresentation {
  summary: string;
  sources: MergedTaskSource[];
}

const MERGE_SOURCE_HEADING = /^##\s+合并来源\s*$/m;
const SOURCE_HEADING = /^###\s+(.+?)\s*$/gm;
const COMMENT_HEADING = /^\*\*(.+?)\*\*\s*$/gm;

function parseSourceHeader(value: string) {
  const separator = value.indexOf(" · ");
  if (separator < 0) return { identifier: "", title: value.trim() };
  return {
    identifier: value.slice(0, separator).trim(),
    title: value.slice(separator + 3).trim(),
  };
}

function parseComments(value: string): MergedTaskComment[] {
  const headings = [...value.matchAll(COMMENT_HEADING)];
  return headings.map((heading, index) => ({
    author: heading[1].replace(/\s+·\s+\d{4}-\d{2}-\d{2}T[^·]+$/i, "").trim(),
    body: value.slice(
      (heading.index ?? 0) + heading[0].length,
      headings[index + 1]?.index ?? value.length,
    ).trim(),
  })).filter((comment) => comment.body.length > 0);
}

export function parseMergedTaskDescription(value: string): MergedTaskPresentation | null {
  const heading = value.match(MERGE_SOURCE_HEADING);
  if (!heading || heading.index === undefined) return null;

  const summary = value.slice(0, heading.index)
    .replace(/<!--\s*dashi-merge-operation:[^>]+-->\s*/gi, "")
    .trim();
  const sourceText = value.slice(heading.index + heading[0].length).trim();
  const sourceMatches = [...sourceText.matchAll(SOURCE_HEADING)];
  if (sourceMatches.length === 0) return null;

  const sources = sourceMatches.map((match, index) => {
    const block = sourceText.slice(
      (match.index ?? 0) + match[0].length,
      sourceMatches[index + 1]?.index ?? sourceText.length,
    ).trim();
    const commentHeading = block.search(/^####\s+人工评论\s*$/m);
    const attachmentHeading = block.search(/^####\s+任务附件\s*$/m);
    const contentEnd = [commentHeading, attachmentHeading]
      .filter((position) => position >= 0)
      .sort((left, right) => left - right)[0] ?? block.length;
    const comments = commentHeading >= 0
      ? parseComments(block.slice(commentHeading).replace(/^####\s+人工评论\s*\n?/, ""))
      : [];
    return {
      ...parseSourceHeader(match[1]),
      description: block.slice(0, contentEnd).trim(),
      comments,
    };
  });

  return { summary, sources };
}

export function taskCardDescription(value: string) {
  const merged = parseMergedTaskDescription(value);
  return merged ? merged.summary : value;
}

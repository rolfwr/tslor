/**
 * Detect files marked as generated using the @generated convention.
 *
 * This follows the de facto standard originating from Facebook/Phabricator,
 * widely adopted by tools like Apollo, Flatbuffers, Diesel, and others.
 * The @generated tag must appear inside a comment (block or line comment).
 */

const GENERATED_IN_LINE_COMMENT = /\/\/[ \t]*@generated\b/;

function isGeneratedInBlockComment(content: string): boolean {
  const blockComments = content.match(/\/\*[\s\S]*?\*\//g) ?? [];
  for (const comment of blockComments) {
    const withoutOpen = comment.replace(/^\/\*[*]?/, '');
    for (const line of withoutOpen.split('\n')) {
      const trimmed = line.replace(/^[ \t]*\*?[ \t]*/, '');
      if (/^@generated\b/.test(trimmed)) {
        return true;
      }
    }
  }
  return false;
}

export function isGeneratedFile(content: string): boolean {
  return (
    isGeneratedInBlockComment(content) ||
    GENERATED_IN_LINE_COMMENT.test(content)
  );
}

/**
 * Detect files marked as generated using the @generated convention.
 *
 * This follows the de facto standard originating from Facebook/Phabricator,
 * widely adopted by tools like Apollo, Flatbuffers, Diesel, and others.
 * The @generated tag must appear inside a comment (block or line comment).
 */

const GENERATED_IN_BLOCK_COMMENT = /\/\*[\s\S]*?@generated[\s\S]*?\*\//;
const GENERATED_IN_LINE_COMMENT = /\/\/.*@generated/;

export function isGeneratedFile(content: string): boolean {
  return GENERATED_IN_BLOCK_COMMENT.test(content) || GENERATED_IN_LINE_COMMENT.test(content);
}

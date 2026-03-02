/** Inverse of formatCommentary: converts contentEditable HTML back to plain text with markdown. */
export function htmlToCommentaryMarkdown(html: string): string {
  return html
    // Normalize <b> to <strong>, <i> to <em> (browsers vary)
    .replace(/<b\b[^>]*>/gi, "<strong>").replace(/<\/b>/gi, "</strong>")
    .replace(/<i\b[^>]*>/gi, "<em>").replace(/<\/i>/gi, "</em>")
    // Convert bold/italic to markdown
    .replace(/<strong>(.*?)<\/strong>/gi, "**$1**")
    .replace(/<em>(.*?)<\/em>/gi, "*$1*")
    // <br> → newline
    .replace(/<br\s*\/?>/gi, "\n")
    // </p> and </div> → paragraph break
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n\n")
    // Strip all remaining HTML tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Collapse 3+ newlines to 2, trim
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

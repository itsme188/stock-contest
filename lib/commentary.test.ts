import { describe, it, expect } from "vitest";
import { htmlToCommentaryMarkdown } from "./commentary";

describe("htmlToCommentaryMarkdown", () => {
  it("converts <strong> to markdown bold", () => {
    expect(htmlToCommentaryMarkdown("<strong>bold</strong>")).toBe("**bold**");
  });

  it("converts <b> to markdown bold", () => {
    expect(htmlToCommentaryMarkdown("<b>bold</b>")).toBe("**bold**");
  });

  it("converts <em> to markdown italic", () => {
    expect(htmlToCommentaryMarkdown("<em>italic</em>")).toBe("*italic*");
  });

  it("converts <i> to markdown italic", () => {
    expect(htmlToCommentaryMarkdown("<i>italic</i>")).toBe("*italic*");
  });

  it("converts <br> to newline", () => {
    expect(htmlToCommentaryMarkdown("line one<br>line two")).toBe("line one\nline two");
    expect(htmlToCommentaryMarkdown("line one<br/>line two")).toBe("line one\nline two");
    expect(htmlToCommentaryMarkdown("line one<br />line two")).toBe("line one\nline two");
  });

  it("converts </p> to paragraph break", () => {
    expect(htmlToCommentaryMarkdown("<p>first</p><p>second</p>")).toBe("first\n\nsecond");
  });

  it("converts </div> to paragraph break", () => {
    expect(htmlToCommentaryMarkdown("<div>first</div><div>second</div>")).toBe("first\n\nsecond");
  });

  it("strips remaining HTML tags", () => {
    expect(htmlToCommentaryMarkdown('<span class="foo">text</span>')).toBe("text");
  });

  it("decodes HTML entities", () => {
    expect(htmlToCommentaryMarkdown("&amp; &lt; &gt; &quot; &#39; &nbsp;")).toBe('& < > " \'');
  });

  it("collapses excessive newlines", () => {
    expect(htmlToCommentaryMarkdown("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims whitespace", () => {
    expect(htmlToCommentaryMarkdown("  <p>hello</p>  ")).toBe("hello");
  });

  it("returns empty string for empty input", () => {
    expect(htmlToCommentaryMarkdown("")).toBe("");
  });

  it("handles a realistic email commentary paragraph", () => {
    const html = `<p style="margin: 0 0 12px 0; color: #1f2937; font-size: 15px; line-height: 1.6;"><strong>Weekly Letter</strong></p><p style="margin: 0 0 12px 0;">Eli leads with $100,037 &amp; Yitzi trails.</p>`;
    const result = htmlToCommentaryMarkdown(html);
    expect(result).toContain("**Weekly Letter**");
    expect(result).toContain("Eli leads with $100,037 & Yitzi trails.");
  });
});

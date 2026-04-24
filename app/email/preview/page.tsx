"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { htmlToCommentaryMarkdown } from "@/lib/commentary";

type VkStatus = { chars: number; credsConfigured: boolean; preview: string };

export default function EmailPreview() {
  const [html, setHtml] = useState("");
  const [commentary, setCommentary] = useState("");
  const [originalCommentary, setOriginalCommentary] = useState("");
  const [originalHtml, setOriginalHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [vk, setVk] = useState<VkStatus | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const edited = commentary !== originalCommentary && originalCommentary !== "";

  const generatePreview = useCallback(async () => {
    setLoading(true);
    setError("");
    setStatus("");
    try {
      const res = await fetch("/api/email/preview", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setHtml(data.html);
      setCommentary(data.commentary);
      setOriginalHtml(data.html);
      setOriginalCommentary(data.commentary);
      setVk(data.vk ?? null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate preview"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const sendEmail = async () => {
    // Read commentary from iframe DOM to guarantee what-you-see-is-what-you-send
    let commentaryToSend = commentary;
    const doc = iframeRef.current?.contentDocument;
    const commentaryDiv = doc?.getElementById("commentary");
    if (commentaryDiv) {
      const clone = commentaryDiv.cloneNode(true) as HTMLElement;
      const iconEl = clone.querySelector("[data-edit-icon]");
      if (iconEl) iconEl.remove();
      commentaryToSend = htmlToCommentaryMarkdown(clone.innerHTML);
    }

    setSending(true);
    setStatus("");
    setError("");
    try {
      const res = await fetch("/api/email/weekly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commentary: commentaryToSend }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStatus(`Email sent to ${data.recipients} recipient(s)!`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send email");
    } finally {
      setSending(false);
    }
  };

  const resetCommentary = () => {
    setHtml(originalHtml);
    setCommentary(originalCommentary);
  };

  const handleIframeLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;

    const commentaryDiv = doc.getElementById("commentary");
    if (!commentaryDiv) return;

    // Make editable
    commentaryDiv.contentEditable = "true";
    commentaryDiv.style.cursor = "text";
    commentaryDiv.style.outline = "none";
    commentaryDiv.style.position = "relative";
    commentaryDiv.style.transition = "box-shadow 0.2s ease";

    // Pencil icon (always visible)
    const icon = doc.createElement("div");
    icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M11.5 1.5L14.5 4.5L5 14H2V11L11.5 1.5Z" stroke="#9CA3AF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M9.5 3.5L12.5 6.5" stroke="#9CA3AF" stroke-width="1.5"/>
    </svg>`;
    icon.style.cssText = "position: absolute; top: 8px; right: 8px; opacity: 0.5; pointer-events: none;";
    icon.setAttribute("data-edit-icon", "true");
    commentaryDiv.appendChild(icon);

    // Hover effect
    commentaryDiv.addEventListener("mouseenter", () => {
      if (doc.activeElement !== commentaryDiv) {
        commentaryDiv.style.boxShadow = "inset 0 0 0 2px rgba(37, 99, 235, 0.15)";
      }
    });
    commentaryDiv.addEventListener("mouseleave", () => {
      if (doc.activeElement !== commentaryDiv) {
        commentaryDiv.style.boxShadow = "";
      }
    });

    // Focus/blur styling
    commentaryDiv.addEventListener("focus", () => {
      commentaryDiv.style.boxShadow = "inset 0 0 0 2px rgba(37, 99, 235, 0.4)";
    });
    commentaryDiv.addEventListener("blur", () => {
      commentaryDiv.style.boxShadow = "";
    });

    // Sync edits back to React state
    commentaryDiv.addEventListener("input", () => {
      // Remove the icon from innerHTML before converting
      const iconEl = commentaryDiv.querySelector("[data-edit-icon]");
      if (iconEl) iconEl.remove();
      const md = htmlToCommentaryMarkdown(commentaryDiv.innerHTML);
      setCommentary(md);
      // Re-add the icon
      commentaryDiv.appendChild(icon);
    });
  }, []);

  useEffect(() => {
    generatePreview();
  }, [generatePreview]);

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/dashboard"
              className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
            >
              &larr; Back to Dashboard
            </Link>
            <h1 className="text-lg font-semibold text-gray-900">
              Email Preview
            </h1>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={generatePreview}
              disabled={loading}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
            >
              {loading ? "Generating..." : "Regenerate"}
            </button>
            {edited && (
              <button
                onClick={resetCommentary}
                className="px-4 py-2 bg-amber-50 text-amber-700 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors text-sm font-medium"
              >
                Reset
              </button>
            )}
            <button
              onClick={sendEmail}
              disabled={sending || loading || !html}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
            >
              {sending ? "Sending..." : "Send Email"}
            </button>
          </div>
        </div>

        {/* Status bar */}
        {(status || error) && (
          <div className="max-w-4xl mx-auto px-4 pb-3">
            <p
              className={`text-sm ${error ? "text-red-600" : "text-green-600"}`}
            >
              {error || status}
            </p>
          </div>
        )}

        {/* VK market-context diagnostic */}
        {vk && (
          <div className="max-w-4xl mx-auto px-4 pb-3">
            <div
              className={`text-xs px-3 py-2 rounded-lg inline-block ${
                vk.chars > 0
                  ? "bg-green-50 text-green-800 border border-green-200"
                  : vk.credsConfigured
                  ? "bg-amber-50 text-amber-800 border border-amber-200"
                  : "bg-gray-50 text-gray-600 border border-gray-200"
              }`}
              title={vk.preview || undefined}
            >
              <span className="font-semibold">Vital Knowledge:</span>{" "}
              {vk.chars > 0
                ? `${vk.chars.toLocaleString()} chars of market context attached`
                : vk.credsConfigured
                ? "fetch returned empty (IMAP error or no matching emails)"
                : "not configured (Gmail creds missing in Settings)"}
            </div>
          </div>
        )}
      </div>

      {/* Preview area */}
      <div className="max-w-4xl mx-auto p-4">
        {loading && !html ? (
          <div className="bg-white rounded-xl border border-gray-200 p-16 text-center">
            <div className="inline-block w-8 h-8 border-4 border-gray-200 border-t-blue-600 rounded-full animate-spin mb-4" />
            <p className="text-gray-500 text-sm">
              Generating AI commentary and building preview...
            </p>
          </div>
        ) : html ? (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-red-400" />
              <span className="w-3 h-3 rounded-full bg-yellow-400" />
              <span className="w-3 h-3 rounded-full bg-green-400" />
              <span className="ml-2 text-xs text-gray-400">
                Email Preview
              </span>
            </div>
            <iframe
              ref={iframeRef}
              srcDoc={html}
              title="Email preview"
              className="w-full border-0"
              style={{ minHeight: "900px" }}
              sandbox="allow-same-origin"
              onLoad={handleIframeLoad}
            />
          </div>
        ) : error ? (
          <div className="bg-white rounded-xl border border-red-200 p-8 text-center">
            <p className="text-red-600 font-medium mb-2">
              Failed to generate preview
            </p>
            <p className="text-gray-500 text-sm">{error}</p>
            <button
              onClick={generatePreview}
              className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
            >
              Try Again
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

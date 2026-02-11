"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";

export default function EmailPreview() {
  const [html, setHtml] = useState("");
  const [commentary, setCommentary] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

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
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate preview"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const sendEmail = async () => {
    setSending(true);
    setStatus("");
    setError("");
    try {
      const res = await fetch("/api/email/weekly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commentary }),
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
              srcDoc={html}
              title="Email preview"
              className="w-full border-0"
              style={{ minHeight: "900px" }}
              sandbox=""
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

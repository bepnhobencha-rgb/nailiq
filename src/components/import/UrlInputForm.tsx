"use client";

import { useState } from "react";

type Props = {
  slug: string;
  onJobCreated: (jobId: string) => void;
};

export function UrlInputForm({ slug, onJobCreated }: Props) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/import-website", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, url }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 429) {
          setError("You've already imported a website in the last 24 hours. Please wait.");
        } else {
          setError(data.message ?? data.error ?? "Something went wrong. Please try again.");
        }
        return;
      }

      onJobCreated(data.jobId as string);
    } catch {
      setError("Network error. Please check your connection.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="import-url" className="block text-sm font-medium text-[#a1a1aa] mb-2">
          Your existing salon website URL
        </label>
        <div className="flex gap-3">
          <input
            id="import-url"
            type="url"
            placeholder="https://www.yoursalon.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            className="flex-1 bg-[#18181b] border border-[#3f3f46] rounded-lg px-4 py-2.5 text-sm text-white placeholder-[#52525b] focus:outline-none focus:ring-2 focus:ring-[#D4AF37]/50 focus:border-[#D4AF37]"
          />
          <button
            type="submit"
            disabled={loading || !url}
            className="px-5 py-2.5 bg-[#D4AF37] hover:bg-[#c09b2e] disabled:opacity-50 disabled:cursor-not-allowed text-black text-sm font-semibold rounded-lg transition-colors"
          >
            {loading ? "Starting…" : "Import"}
          </button>
        </div>
        {error && (
          <p className="mt-2 text-sm text-red-400">{error}</p>
        )}
      </div>
      <p className="text-xs text-[#71717a]">
        We'll scrape your existing website and use AI to extract your services, photos, and salon
        details — then automatically populate your NailIQ page.
      </p>
    </form>
  );
}

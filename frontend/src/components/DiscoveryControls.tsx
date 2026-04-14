"use client";

import type { DiscoverySort } from "@/lib/discovery";

interface DiscoveryControlsProps {
  query: string;
  onQueryChange: (value: string) => void;
  sortBy: DiscoverySort;
  onSortChange: (value: DiscoverySort) => void;
  categories: string[];
  selectedCategory: string;
  onCategoryChange: (value: string) => void;
  tags: string[];
  selectedTag: string;
  onTagChange: (value: string) => void;
  onClear: () => void;
  hasFilters: boolean;
  showPrimaryRow?: boolean;
}

export default function DiscoveryControls({
  query, onQueryChange, sortBy, onSortChange,
  categories, selectedCategory, onCategoryChange,
  tags, selectedTag, onTagChange, onClear, hasFilters,
  showPrimaryRow = true,
}: DiscoveryControlsProps) {
  return (
    <div className="mb-4 border border-border bg-surface/40 p-3 md:p-4 space-y-3">
      {showPrimaryRow && (
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
          <label className="flex items-center border border-border bg-surface px-3 py-2 focus-within:border-border-bright">
            <svg className="w-3.5 h-3.5 text-muted mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="m21 21-4.3-4.3m1.8-5.2a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" />
            </svg>
            <input
              value={query} onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search events, markets, tags..."
              className="w-full bg-transparent text-[13px] text-text placeholder:text-muted-dim focus:outline-none"
            />
          </label>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted tracking-widest uppercase">Sort</span>
            <select value={sortBy} onChange={(e) => onSortChange(e.target.value as DiscoverySort)}
              className="bg-surface border border-border text-[11px] text-text px-2.5 py-2 focus:outline-none focus:border-border-bright">
              <option value="volume_desc">Highest Volume</option>
              <option value="volume_asc">Lowest Volume</option>
              <option value="ending_soon">Ending Soon</option>
              <option value="newest">Latest Ending</option>
            </select>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-muted tracking-widest uppercase">Category</span>
        {categories.map((c) => (
          <button key={c} type="button" onClick={() => onCategoryChange(c)}
            className={`px-2.5 py-1 text-[10px] tracking-widest uppercase border transition-colors ${
              selectedCategory === c ? "border-accent/45 text-accent bg-accent/10" : "border-border text-muted hover:text-text hover:border-border-bright"
            }`}>{c}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-muted tracking-widest uppercase">Tag</span>
        {tags.slice(0, 18).map((t) => (
          <button key={t} type="button" onClick={() => onTagChange(t)}
            className={`px-2.5 py-1 text-[10px] tracking-widest uppercase border transition-colors ${
              selectedTag === t ? "border-blue/45 text-blue bg-blue/10" : "border-border text-muted hover:text-text hover:border-border-bright"
            }`}>{t}</button>
        ))}
        {hasFilters && (
          <button type="button" onClick={onClear}
            className="ml-auto px-2.5 py-1 text-[10px] tracking-widest uppercase border border-danger/45 text-danger hover:bg-danger/10 transition-colors">
            Clear Filters
          </button>
        )}
      </div>
    </div>
  );
}

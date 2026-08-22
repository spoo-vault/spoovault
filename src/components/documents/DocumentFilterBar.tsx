import React from "react";
import { FiSearch, FiX, FiFilter, FiLayers } from "react-icons/fi";

export type DocumentCategory =
  | "ALL"
  | "LEGAL"
  | "FINANCIAL"
  | "IDENTITY"
  | "SECRETS"
  | "MEDICAL";
export type ChainFilter = "ALL" | "AVALANCHE" | "STELLAR";
export type SortOption = "NEWEST" | "OLDEST" | "NAME_ASC" | "NAME_DESC";

export interface DocumentFilterBarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  selectedCategory: DocumentCategory;
  onCategoryChange: (category: DocumentCategory) => void;
  selectedChain: ChainFilter;
  onChainChange: (chain: ChainFilter) => void;
  sortBy: SortOption;
  onSortChange: (sort: SortOption) => void;
  totalResults: number;
}

const CATEGORIES: { id: DocumentCategory; label: string }[] = [
  { id: "ALL", label: "All Items" },
  { id: "LEGAL", label: "Legal" },
  { id: "FINANCIAL", label: "Financial" },
  { id: "IDENTITY", label: "Identity" },
  { id: "SECRETS", label: "Secrets & Keys" },
  { id: "MEDICAL", label: "Medical" },
];

export const DocumentFilterBar: React.FC<DocumentFilterBarProps> = ({
  searchQuery,
  onSearchChange,
  selectedCategory,
  onCategoryChange,
  selectedChain,
  onChainChange,
  sortBy,
  onSortChange,
  totalResults,
}) => {
  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 mb-6 shadow-lg backdrop-blur-md">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        {/* Search Input */}
        <div className="relative flex-1 min-w-[240px]">
          <FiSearch className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search documents by title, CID hash, or tag..."
            className="w-full pl-10 pr-9 py-2.5 bg-slate-800/80 border border-slate-700/80 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
            >
              <FiX className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Chain & Sort Selectors */}
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2 bg-slate-800/80 border border-slate-700/80 rounded-lg px-3 py-1.5">
            <FiLayers className="w-4 h-4 text-slate-400" />
            <select
              value={selectedChain}
              onChange={(e) => onChainChange(e.target.value as ChainFilter)}
              className="bg-transparent text-xs text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value="ALL" className="bg-slate-900 text-white">
                All Networks
              </option>
              <option value="AVALANCHE" className="bg-slate-900 text-white">
                Avalanche Fuji (EVM)
              </option>
              <option value="STELLAR" className="bg-slate-900 text-white">
                Stellar Soroban
              </option>
            </select>
          </div>

          <div className="flex items-center space-x-2 bg-slate-800/80 border border-slate-700/80 rounded-lg px-3 py-1.5">
            <FiFilter className="w-4 h-4 text-slate-400" />
            <select
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value as SortOption)}
              className="bg-transparent text-xs text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value="NEWEST" className="bg-slate-900 text-white">
                Newest First
              </option>
              <option value="OLDEST" className="bg-slate-900 text-white">
                Oldest First
              </option>
              <option value="NAME_ASC" className="bg-slate-900 text-white">
                Name A-Z
              </option>
              <option value="NAME_DESC" className="bg-slate-900 text-white">
                Name Z-A
              </option>
            </select>
          </div>
        </div>
      </div>

      {/* Category Pills */}
      <div className="flex flex-wrap items-center justify-between gap-2 mt-4 pt-3 border-t border-slate-800/80">
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((cat) => {
            const isActive = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => onCategoryChange(cat.id)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 ${
                  isActive
                    ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                    : "bg-slate-800/60 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                }`}
              >
                {cat.label}
              </button>
            );
          })}
        </div>

        <span className="text-xs text-slate-400 font-mono">
          Showing{" "}
          <span className="text-white font-semibold">{totalResults}</span>{" "}
          documents
        </span>
      </div>
    </div>
  );
};

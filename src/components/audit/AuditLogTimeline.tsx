import React from "react";
import {
  FiClock,
  FiFileText,
  FiShield,
  FiCheckCircle,
  FiDownload,
  FiShare2,
  FiPlusCircle,
  FiKey,
  FiArrowUpRight,
} from "react-icons/fi";
import { formatDistanceToNow } from "date-fns";
import { VaultData, DocumentData, ActivityEvent } from "../../services/contract.service";
import { auditService } from "../../services/audit.service";
import { getExplorerTxUrl } from "../../utils/explorer";
import { toast } from "react-hot-toast";

export interface AuditLogTimelineProps {
  vault?: VaultData;
  documents?: DocumentData[];
  activities: ActivityEvent[];
}

export const AuditLogTimeline: React.FC<AuditLogTimelineProps> = ({
  vault,
  documents = [],
  activities,
}) => {
  const handleExportJSON = () => {
    if (!vault) {
      toast.error("Select a vault to export certificate");
      return;
    }
    const cert = auditService.generateCertificate(vault, documents, activities);
    auditService.downloadCertificateJSON(cert);
    toast.success("Audit certificate downloaded successfully");
  };

  const handleExportCSV = () => {
    const vaultId = vault ? vault.id : 0;
    auditService.downloadActivityCSV(vaultId, activities);
    toast.success("Activity log CSV downloaded");
  };

  const getEventIcon = (action: string) => {
    const act = action.toUpperCase();
    if (act.includes("VAULT")) return <FiPlusCircle className="w-4 h-4 text-indigo-400" />;
    if (act.includes("DOC") || act.includes("FILE")) return <FiFileText className="w-4 h-4 text-cyan-400" />;
    if (act.includes("GUARDIAN") || act.includes("APPROV")) return <FiShield className="w-4 h-4 text-emerald-400" />;
    if (act.includes("KEY") || act.includes("SHARE")) return <FiKey className="w-4 h-4 text-amber-400" />;
    return <FiClock className="w-4 h-4 text-slate-400" />;
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-6 shadow-xl backdrop-blur-md">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 pb-4 border-b border-slate-800">
        <div>
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <FiShield className="w-5 h-5 text-indigo-400" />
            Audit & Compliance Log
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Cryptographically verifiable history for Vault #{vault ? vault.id : "Global"}
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleExportCSV}
            className="inline-flex items-center px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition-colors"
          >
            <FiDownload className="w-3.5 h-3.5 mr-1.5" /> Export CSV
          </button>
          {vault && (
            <button
              onClick={handleExportJSON}
              className="inline-flex items-center px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium shadow-md shadow-indigo-600/30 transition-all"
            >
              <FiShare2 className="w-3.5 h-3.5 mr-1.5" /> Certificate (.JSON)
            </button>
          )}
        </div>
      </div>

      {activities.length === 0 ? (
        <div className="text-center py-8 text-slate-500 text-sm">
          No activity logs recorded yet.
        </div>
      ) : (
        <div className="relative pl-6 space-y-6 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-800">
          {activities.map((act, idx) => (
            <div key={idx} className="relative group">
              <div className="absolute -left-6 top-0.5 w-5 h-5 rounded-full bg-slate-900 border border-slate-700 flex items-center justify-center shadow-md">
                {getEventIcon(act.action)}
              </div>

              <div className="bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/50 rounded-lg p-3.5 transition-all">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-200">
                    {act.action}
                  </span>
                  <span className="text-xs text-slate-400 font-mono">
                    {formatDistanceToNow(act.timestamp * 1000, { addSuffix: true })}
                  </span>
                </div>

                <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-800/80 text-xs">
                  <span className="text-slate-400 font-mono">
                    Actor: <span className="text-slate-300 font-sans">{act.actor}</span>
                  </span>
                  <div className="flex items-center gap-3">
                    {act.txHash && (
                      <a
                        href={getExplorerTxUrl(act.txHash, act.network)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center text-blue-400 hover:text-blue-300 font-medium"
                      >
                        Tx <FiArrowUpRight className="w-3 h-3 ml-0.5" />
                      </a>
                    )}
                    <span className="inline-flex items-center text-emerald-400 font-medium">
                      <FiCheckCircle className="w-3 h-3 mr-1" /> {act.status}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

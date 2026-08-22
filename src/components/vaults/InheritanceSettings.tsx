import React, { useState } from "react";
import {
  FiHeart,
  FiShield,
  FiAlertTriangle,
  FiClock,
  FiCheckCircle,
} from "react-icons/fi";
import { toast } from "react-hot-toast";

export interface InheritanceSettingsProps {
  vaultId: number;
  vaultName: string;
  isOwner: boolean;
  lastProofOfLife?: number;
  inactivityPeriodDays?: number;
  emergencyMode?: boolean;
  onRecordProofOfLife?: (vaultId: number) => Promise<void>;
  onToggleEmergencyMode?: (vaultId: number, enabled: boolean) => Promise<void>;
}

export const InheritanceSettings: React.FC<InheritanceSettingsProps> = ({
  vaultId,
  vaultName,
  isOwner,
  lastProofOfLife = Math.floor(Date.now() / 1000),
  inactivityPeriodDays = 180,
  emergencyMode = false,
  onRecordProofOfLife,
  onToggleEmergencyMode,
}) => {
  const [loadingProof, setLoadingProof] = useState(false);
  const [loadingEmergency, setLoadingEmergency] = useState(false);

  const daysSinceHeartbeat = Math.floor(
    (Math.floor(Date.now() / 1000) - lastProofOfLife) / (24 * 3600)
  );
  const daysRemaining = Math.max(0, inactivityPeriodDays - daysSinceHeartbeat);
  const isDead = daysSinceHeartbeat >= inactivityPeriodDays;

  const handleHeartbeat = async () => {
    if (!onRecordProofOfLife) return;
    try {
      setLoadingProof(true);
      await onRecordProofOfLife(vaultId);
      toast.success("Proof of life heartbeat recorded successfully!");
    } catch (err: any) {
      toast.error(err?.message || "Failed to record proof of life");
    } finally {
      setLoadingProof(false);
    }
  };

  const handleEmergencyToggle = async () => {
    if (!onToggleEmergencyMode) return;
    try {
      setLoadingEmergency(true);
      await onToggleEmergencyMode(vaultId, !emergencyMode);
      toast.success(
        `Emergency mode ${
          !emergencyMode ? "ENABLED" : "DISABLED"
        } for ${vaultName}`
      );
    } catch (err: any) {
      toast.error(err?.message || "Failed to update emergency mode");
    } finally {
      setLoadingEmergency(false);
    }
  };

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-6 shadow-xl backdrop-blur-md">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <div className="p-2.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <FiHeart className="w-5 h-5 animate-pulse text-emerald-400" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">
              Inheritance & Dead-Man Switch
            </h3>
            <p className="text-xs text-slate-400">
              Vault #{vaultId} • {vaultName}
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          {emergencyMode ? (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-rose-500/20 text-rose-300 border border-rose-500/30">
              <FiAlertTriangle className="w-3.5 h-3.5 mr-1 text-rose-400" />{" "}
              Emergency Active
            </span>
          ) : isDead ? (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30">
              <FiClock className="w-3.5 h-3.5 mr-1 text-amber-400" /> Switch
              Triggered
            </span>
          ) : (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              <FiCheckCircle className="w-3.5 h-3.5 mr-1 text-emerald-400" />{" "}
              Heartbeat Active
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-slate-800/50 p-4 rounded-lg border border-slate-700/50">
          <span className="text-xs text-slate-400 uppercase tracking-wider font-semibold">
            Last Heartbeat
          </span>
          <p className="text-base font-medium text-slate-200 mt-1">
            {new Date(lastProofOfLife * 1000).toLocaleDateString()}
          </p>
          <span className="text-xs text-slate-500">
            {daysSinceHeartbeat} days ago
          </span>
        </div>

        <div className="bg-slate-800/50 p-4 rounded-lg border border-slate-700/50">
          <span className="text-xs text-slate-400 uppercase tracking-wider font-semibold">
            Inactivity Period
          </span>
          <p className="text-base font-medium text-slate-200 mt-1">
            {inactivityPeriodDays} Days
          </p>
          <span className="text-xs text-slate-500">Auto-release threshold</span>
        </div>

        <div className="bg-slate-800/50 p-4 rounded-lg border border-slate-700/50">
          <span className="text-xs text-slate-400 uppercase tracking-wider font-semibold">
            Time Remaining
          </span>
          <p className="text-base font-medium text-slate-200 mt-1">
            {daysRemaining} Days
          </p>
          <span className="text-xs text-slate-500">
            Before inheritance unlock
          </span>
        </div>
      </div>

      {isOwner && (
        <div className="flex flex-wrap gap-3 pt-2 border-t border-slate-800">
          <button
            onClick={handleHeartbeat}
            disabled={loadingProof}
            className="flex-1 min-w-[200px] inline-flex items-center justify-center px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm transition-all duration-200 disabled:opacity-50 shadow-lg shadow-emerald-900/30"
          >
            <FiHeart className="w-4 h-4 mr-2" />
            {loadingProof ? "Recording Heartbeat..." : "Record Proof of Life"}
          </button>

          <button
            onClick={handleEmergencyToggle}
            disabled={loadingEmergency}
            className={`px-4 py-2.5 rounded-lg font-medium text-sm transition-all duration-200 disabled:opacity-50 border ${
              emergencyMode
                ? "bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
                : "bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border-rose-500/40"
            }`}
          >
            <FiShield className="w-4 h-4 inline mr-2" />
            {loadingEmergency
              ? "Updating..."
              : emergencyMode
              ? "Disable Emergency Mode"
              : "Enable Emergency Mode"}
          </button>
        </div>
      )}
    </div>
  );
};

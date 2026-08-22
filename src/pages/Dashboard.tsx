import { useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  CardBody,
  CardHeader,
  Button,
  Progress,
  Skeleton,
  Chip,
} from "@heroui/react";
import {
  FiShield,
  FiFile,
  FiUsers,
  FiKey,
  FiActivity,
  FiTrendingUp,
  FiArrowUpRight,
  FiAlertCircle,
  FiZap,
  FiClock,
  FiCheckCircle,
  FiCircle,
} from "react-icons/fi";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useWeb3 } from "../context/Web3Context";
import {
  contractService,
  VaultData,
  DocumentData,
  ActivityEvent,
  PendingApprovalData,
} from "../services/contract.service";
import { toast } from "react-hot-toast";
import { formatDistanceToNow } from "date-fns";
import { buttonClasses } from "../utils/buttonClasses";
import { shortenAddress } from "../utils/helpers";
import { captureError } from "../services/telemetry.service";
import { encryptWithPublicKey, decryptWithPrivateKey } from "../utils/crypto";
import { clientKeyringService } from "../services/clientKeyring.service";
import {
  verifyShare,
  parseEncryptedMetadataPayload,
} from "../services/secrets.service";

import { AuditLogTimeline } from "../components/audit/AuditLogTimeline";
import { getExplorerTxUrl } from "../utils/explorer";
import { InheritanceSettings } from "../components/vaults/InheritanceSettings";

const DASHBOARD_CACHE_PREFIX = "spoovault-dashboard-cache";
const DASHBOARD_CACHE_MAX_AGE_MS = 2 * 60 * 1000;

interface DashboardCachePayload {
  account: string;
  cachedAt: number;
  vaults: VaultData[];
  stats: {
    totalVaults: number;
    totalDocuments: number;
    totalGuardians: number;
    totalNFTs: number;
  };
  issuedPassesForVisibleVaults: number;
  pendingApprovals: PendingApprovalData[];
}

interface DashboardStats {
  totalVaults: number;
  totalDocuments: number;
  totalGuardians: number;
  totalNFTs: number;
}

const Dashboard = () => {
  const { account, isConnected, connect, provider, signer, isFujiNetwork } =
    useWeb3();
  const navigate = useNavigate();
  const location = useLocation();
  const loadVersionRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(false);
  const [vaults, setVaults] = useState<VaultData[]>([]);
  const [documents, setDocuments] = useState<DocumentData[]>([]);
  const [stats, setStats] = useState<DashboardStats>({
    totalVaults: 0,
    totalDocuments: 0,
    totalGuardians: 0,
    totalNFTs: 0,
  });
  const [recentActivity, setRecentActivity] = useState<ActivityEvent[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<
    PendingApprovalData[]
  >([]);
  const [issuedPassesForVisibleVaults, setIssuedPassesForVisibleVaults] =
    useState(0);
  const [approvingRequestId, setApprovingRequestId] = useState<number | null>(
    null
  );
  const [packageExported, setPackageExported] = useState(false);

  useEffect(() => {
    if (isConnected && provider && isFujiNetwork) {
      contractService.initialize(provider, signer ?? undefined);
      const hydrated = hydrateDashboardCache(account || "");
      if (hydrated) {
        void loadDashboardData({ silent: true });
      } else {
        void loadDashboardData();
      }
    } else {
      loadVersionRef.current += 1;
      setVaults([]);
      setDocuments([]);
      setRecentActivity([]);
      setPendingApprovals([]);
      setIssuedPassesForVisibleVaults(0);
      setStats({
        totalVaults: 0,
        totalDocuments: 0,
        totalGuardians: 0,
        totalNFTs: 0,
      });
      setActivityLoading(false);
      setLoading(false);
    }
  }, [account, isConnected, provider, signer, isFujiNetwork]);

  useEffect(() => {
    const readPackageFlag = () => {
      if (!account) {
        setPackageExported(false);
        return;
      }

      try {
        const key = `spoovault-beneficiary-package-exported-${account.toLowerCase()}`;
        const value = localStorage.getItem(key);
        setPackageExported(value === "1");
      } catch {
        setPackageExported(false);
      }
    };

    readPackageFlag();
    window.addEventListener(
      "spoovault-beneficiary-package-exported",
      readPackageFlag as EventListener
    );
    return () => {
      window.removeEventListener(
        "spoovault-beneficiary-package-exported",
        readPackageFlag as EventListener
      );
    };
  }, [account]);

  useEffect(() => {
    if (location.hash !== "#approval-queue") {
      return;
    }
    const timer = window.setTimeout(() => {
      const element = document.getElementById("approval-queue");
      element?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [location.hash, pendingApprovals.length, loading]);

  const getDashboardCacheKey = (wallet: string): string =>
    `${DASHBOARD_CACHE_PREFIX}-${wallet.toLowerCase()}`;

  const readDashboardCache = (
    wallet: string
  ): Omit<DashboardCachePayload, "account" | "cachedAt"> | null => {
    if (!wallet) return null;
    try {
      const raw = localStorage.getItem(getDashboardCacheKey(wallet));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as DashboardCachePayload;
      if (!parsed || parsed.account.toLowerCase() !== wallet.toLowerCase()) {
        return null;
      }
      return {
        vaults: parsed.vaults,
        stats: parsed.stats,
        issuedPassesForVisibleVaults: parsed.issuedPassesForVisibleVaults ?? 0,
        pendingApprovals: parsed.pendingApprovals,
      };
    } catch {
      return null;
    }
  };

  const hydrateDashboardCache = (wallet: string): boolean => {
    if (!wallet) return false;
    try {
      const raw = localStorage.getItem(getDashboardCacheKey(wallet));
      if (!raw) return false;
      const parsed = JSON.parse(raw) as DashboardCachePayload;
      if (
        !parsed ||
        parsed.account.toLowerCase() !== wallet.toLowerCase() ||
        Date.now() - parsed.cachedAt > DASHBOARD_CACHE_MAX_AGE_MS
      ) {
        return false;
      }
      setVaults(parsed.vaults);
      setStats(parsed.stats);
      setIssuedPassesForVisibleVaults(parsed.issuedPassesForVisibleVaults ?? 0);
      setPendingApprovals(parsed.pendingApprovals);
      setLoading(false);
      return true;
    } catch {
      return false;
    }
  };

  const writeDashboardCache = (
    wallet: string,
    payload: Omit<DashboardCachePayload, "account" | "cachedAt">
  ) => {
    if (!wallet) return;
    try {
      const value: DashboardCachePayload = {
        account: wallet,
        cachedAt: Date.now(),
        ...payload,
      };
      localStorage.setItem(getDashboardCacheKey(wallet), JSON.stringify(value));
    } catch {
      // ignore cache write errors
    }
  };

  const loadPendingApprovals = async (
    wallet: string,
    userVaults: VaultData[],
    fallbackStats: DashboardStats,
    fallbackIssuedPasses: number,
    loadVersion: number
  ) => {
    if (!wallet) {
      if (loadVersionRef.current === loadVersion) {
        setPendingApprovals([]);
      }
      return;
    }

    const walletLower = wallet.toLowerCase();
    const canActAsGuardian = userVaults.some((vault) =>
      vault.guardians.some((guardian) => guardian.toLowerCase() === walletLower)
    );
    if (!canActAsGuardian) {
      if (loadVersionRef.current === loadVersion) {
        setPendingApprovals([]);
      }
      return;
    }

    try {
      const approvals = await contractService.fetchPendingApprovalsForGuardian(
        wallet,
        5
      );
      if (loadVersionRef.current !== loadVersion) {
        return;
      }
      const visibleVaultIds = new Set<number>(
        userVaults.map((vault) => vault.id)
      );
      const scopedApprovals = approvals.filter((approval) =>
        visibleVaultIds.has(approval.vaultId)
      );
      setPendingApprovals(scopedApprovals);

      const cached = readDashboardCache(wallet);
      writeDashboardCache(wallet, {
        vaults: cached?.vaults ?? userVaults,
        stats: cached?.stats ?? fallbackStats,
        issuedPassesForVisibleVaults:
          cached?.issuedPassesForVisibleVaults ?? fallbackIssuedPasses,
        pendingApprovals: scopedApprovals,
      });
    } catch (error) {
      captureError("dashboard.loadPendingApprovals", error, {
        account: wallet,
      });
      if (loadVersionRef.current === loadVersion) {
        setPendingApprovals([]);
      }
    }
  };

  const loadRecentActivity = async (wallet: string, loadVersion: number) => {
    if (!wallet) {
      if (loadVersionRef.current === loadVersion) {
        setRecentActivity([]);
      }
      return;
    }

    if (loadVersionRef.current === loadVersion) {
      setActivityLoading(true);
    }
    try {
      const activity = await contractService.getRecentActivity(10);
      if (loadVersionRef.current !== loadVersion) {
        return;
      }
      const accountLower = wallet.toLowerCase();
      const userActivity = activity
        .filter((item) => item.actor.toLowerCase() === accountLower)
        .slice(0, 5);
      setRecentActivity(userActivity);
    } catch (error) {
      captureError("dashboard.loadRecentActivity", error, { account: wallet });
      if (loadVersionRef.current === loadVersion) {
        setRecentActivity([]);
      }
    } finally {
      if (loadVersionRef.current === loadVersion) {
        setActivityLoading(false);
      }
    }
  };

  const loadDocumentsForUserVaults = async (
    wallet: string,
    userVaults: VaultData[],
    fallbackStats: DashboardStats,
    fallbackIssuedPasses: number,
    fallbackApprovals: PendingApprovalData[],
    loadVersion: number
  ) => {
    try {
      const docsData = await contractService.fetchDocumentsForVaults(
        userVaults.map((vault) => vault.id)
      );
      if (loadVersionRef.current !== loadVersion) {
        return;
      }
      setDocuments(docsData);
      setStats((prev) => ({
        ...prev,
        totalDocuments: docsData.length,
      }));
      const cached = readDashboardCache(wallet);
      writeDashboardCache(wallet, {
        vaults: userVaults,
        stats: {
          ...(cached?.stats ?? fallbackStats),
          totalDocuments: docsData.length,
        },
        issuedPassesForVisibleVaults:
          cached?.issuedPassesForVisibleVaults ?? fallbackIssuedPasses,
        pendingApprovals: cached?.pendingApprovals ?? fallbackApprovals,
      });
    } catch (error) {
      captureError("dashboard.loadDocuments", error, { account: wallet });
      if (loadVersionRef.current === loadVersion) {
        setDocuments([]);
      }
    }
  };

  const loadPassSupplyForVisibleVaults = async (
    wallet: string,
    userVaults: VaultData[],
    fallbackStats: DashboardStats,
    fallbackApprovals: PendingApprovalData[],
    loadVersion: number
  ) => {
    try {
      const passSupplyByVault = await contractService.getActivePassCountByVault(
        userVaults.map((vault) => vault.id)
      );
      if (loadVersionRef.current !== loadVersion) {
        return;
      }

      const issuedPasses = Object.values(passSupplyByVault).reduce(
        (sum, count) => sum + count,
        0
      );
      setIssuedPassesForVisibleVaults(issuedPasses);

      const cached = readDashboardCache(wallet);
      writeDashboardCache(wallet, {
        vaults: cached?.vaults ?? userVaults,
        stats: cached?.stats ?? fallbackStats,
        issuedPassesForVisibleVaults: issuedPasses,
        pendingApprovals: cached?.pendingApprovals ?? fallbackApprovals,
      });
    } catch (error) {
      captureError("dashboard.loadPassSupply", error, { account: wallet });
    }
  };

  const loadDashboardData = async (options?: { silent?: boolean }) => {
    if (!account) {
      setLoading(false);
      return;
    }

    if (!options?.silent) {
      setLoading(true);
    }
    const loadVersion = ++loadVersionRef.current;
    try {
      const [vaultsData, userTokens] = await Promise.all([
        contractService.fetchVaultsForAccount(account),
        contractService.fetchUserTokens(account),
      ]);
      if (loadVersionRef.current !== loadVersion) {
        return;
      }

      const userVaults = vaultsData;

      const guardianSet = new Set<string>();
      userVaults.forEach((vault) => {
        vault.guardians.forEach((guardian) => {
          guardianSet.add(guardian.toLowerCase());
        });
      });
      const issuedPasses = 0;

      const baseStats: DashboardStats = {
        totalVaults: userVaults.length,
        totalDocuments: 0,
        totalGuardians: guardianSet.size,
        totalNFTs: userTokens.length,
      };

      setVaults(userVaults);
      setDocuments([]);
      setRecentActivity([]);
      setPendingApprovals([]);
      setIssuedPassesForVisibleVaults(issuedPasses);
      setStats(baseStats);

      writeDashboardCache(account, {
        vaults: userVaults,
        stats: baseStats,
        issuedPassesForVisibleVaults: issuedPasses,
        pendingApprovals: [],
      });

      void loadDocumentsForUserVaults(
        account,
        userVaults,
        baseStats,
        issuedPasses,
        [],
        loadVersion
      );
      window.setTimeout(() => {
        void loadPendingApprovals(
          account,
          userVaults,
          baseStats,
          issuedPasses,
          loadVersion
        );
      }, 160);
      window.setTimeout(() => {
        void loadRecentActivity(account, loadVersion);
      }, 320);
      window.setTimeout(() => {
        void loadPassSupplyForVisibleVaults(
          account,
          userVaults,
          baseStats,
          [],
          loadVersion
        );
      }, 80);
    } catch (error) {
      console.error("Error loading dashboard data:", error);
      captureError("dashboard.loadData", error, { account: account || "" });
      const message =
        error instanceof Error
          ? error.message
          : "Failed to load dashboard data";
      toast.error(message);
    } finally {
      if (!options?.silent && loadVersionRef.current === loadVersion) {
        setLoading(false);
      }
    }
  };

  const handleApproveRequest = async (requestId: number) => {
    setApprovingRequestId(requestId);
    try {
      const approvalInfo = pendingApprovals.find(
        (a) => a.requestId === requestId
      );
      if (!approvalInfo) {
        throw new Error("Approval request info not found");
      }

      // Check if there is an encrypted share for this guardian
      const encryptedShare = await contractService.getEncryptedGuardianShare(
        approvalInfo.documentId,
        account || ""
      );

      let encryptedShareForBeneficiary = "";
      if (encryptedShare && encryptedShare.trim()) {
        if (!account) {
          throw new Error("Wallet not connected");
        }

        toast("Decrypting key share from secure keyring...");
        const guardianPrivateKey =
          await clientKeyringService.getDecryptedPrivateKey(account);
        const decryptedShare = await decryptWithPrivateKey(
          encryptedShare,
          guardianPrivateKey
        );

        if (!decryptedShare) {
          throw new Error("Failed to decrypt share with keyring private key");
        }

        // VSS share verification
        let doc = documents.find((d) => d.id === approvalInfo.documentId);
        if (!doc) {
          const docs = await contractService.fetchDocumentsForVaults([
            approvalInfo.vaultId,
          ]);
          doc = docs.find((d) => d.id === approvalInfo.documentId);
        }

        if (doc) {
          const { commitments } = parseEncryptedMetadataPayload(
            doc.encryptedMetadata
          );
          if (commitments && commitments.length > 0) {
            const isValid = verifyShare(decryptedShare, commitments);
            if (!isValid) {
              throw new Error(
                "Verifiable Secret Sharing (VSS) verification failed: invalid share point received"
              );
            }
          }
        }

        // Fetch beneficiary's public key
        const beneficiaryPubKey = await contractService.getUserPublicKey(
          approvalInfo.requester
        );
        if (!beneficiaryPubKey) {
          throw new Error(
            "The beneficiary has not registered their encryption public key. They must register it in their Profile page first."
          );
        }

        // Re-encrypt the share for the beneficiary
        encryptedShareForBeneficiary = await encryptWithPublicKey(
          decryptedShare,
          beneficiaryPubKey
        );
      }

      if (encryptedShareForBeneficiary) {
        await contractService.approveAccess(
          requestId,
          encryptedShareForBeneficiary
        );
      } else {
        await contractService.approveAccess(requestId);
      }

      toast.success(`Approved request #${requestId}`);
      await loadDashboardData();
    } catch (error: any) {
      captureError("dashboard.approveAccess", error, { requestId });
      toast.error(error.message || "Failed to approve request");
    } finally {
      setApprovingRequestId(null);
    }
  };

  const docCountByVault = useMemo(() => {
    const counts: Record<number, number> = {};
    documents.forEach((doc) => {
      counts[doc.vaultId] = (counts[doc.vaultId] || 0) + 1;
    });
    return counts;
  }, [documents]);

  const maxDocCount = useMemo(() => {
    const values = Object.values(docCountByVault);
    return values.length > 0 ? Math.max(...values) : 0;
  }, [docCountByVault]);

  const handoverChecklist = useMemo(
    () => [
      {
        key: "vault",
        done: stats.totalVaults > 0,
        title: "Create access vault",
        route: "/vaults",
      },
      {
        key: "document",
        done: stats.totalDocuments > 0,
        title: "Upload encrypted document",
        route: "/documents",
      },
      {
        key: "pass",
        done: issuedPassesForVisibleVaults > 0,
        title: "Issue beneficiary access pass",
        route: "/nfts",
      },
      {
        key: "package",
        done: packageExported,
        title: "Share beneficiary key package",
        route: "/documents",
      },
    ],
    [
      stats.totalVaults,
      stats.totalDocuments,
      issuedPassesForVisibleVaults,
      packageExported,
    ]
  );

  const vaultLabel = stats.totalVaults === 1 ? "vault" : "vaults";
  const docLabel = stats.totalDocuments === 1 ? "document" : "documents";
  const guardianLabel = stats.totalGuardians === 1 ? "guardian" : "guardians";
  const welcomeMessage =
    stats.totalVaults === 0
      ? "You have 0 access vaults. Start by creating one to protect your family documents."
      : `You have ${stats.totalVaults} ${vaultLabel}, ${stats.totalDocuments} ${docLabel}, and ${stats.totalGuardians} ${guardianLabel} in your access workspace.`;

  const statCards: Array<{
    key: string;
    value: number;
    label: string;
    icon: JSX.Element;
    iconBg: string;
  }> = [
    {
      key: "vaults",
      value: stats.totalVaults,
      label: "Access Vaults",
      icon: <FiShield className="text-white text-xl" />,
      iconBg: "bg-gradient-to-br from-brand-700 to-brand-900",
    },
    {
      key: "documents",
      value: stats.totalDocuments,
      label: "Legacy Documents",
      icon: <FiFile className="text-white text-xl" />,
      iconBg: "bg-gradient-to-br from-blue-500 to-cyan-500",
    },
    {
      key: "guardians",
      value: stats.totalGuardians,
      label: "Guardians",
      icon: <FiUsers className="text-white text-xl" />,
      iconBg: "bg-gradient-to-br from-green-500 to-emerald-500",
    },
    {
      key: "passes",
      value: stats.totalNFTs,
      label: "My Access Passes",
      icon: <FiKey className="text-white text-xl" />,
      iconBg: "bg-gradient-to-br from-purple-500 to-violet-500",
    },
  ];

  if (!isConnected) {
    return (
      <div className="min-h-[calc(100vh-11rem)] flex items-center justify-center">
        <div className="w-full max-w-4xl rounded-2xl bg-gradient-to-r from-gray-900/50 to-[#040306] border border-gray-800 p-8 text-center">
          <div className="w-20 h-20 bg-gradient-to-br from-brand-700 to-brand-900 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <FiZap className="text-white text-3xl" />
          </div>
          <h1 className="text-3xl font-bold mb-4">Welcome to SpooVault</h1>
          <p className="text-gray-400 mb-8 max-w-2xl mx-auto">
            Connect your wallet to manage secure access vaults and family
            documents on Avalanche Fuji.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button
              size="lg"
              className={buttonClasses.primaryLg}
              onPress={connect}
              startContent={<FiKey />}
            >
              Connect Wallet
            </Button>
            <Button
              size="lg"
              className={buttonClasses.ghostLg}
              onPress={() => navigate("/")}
            >
              Learn More
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!isFujiNetwork) {
    return (
      <div className="min-h-[calc(100vh-11rem)] flex items-center justify-center">
        <div className="w-full max-w-4xl rounded-2xl bg-gradient-to-r from-yellow-500/10 to-orange-500/10 border border-yellow-500/30 p-8 text-center">
          <div className="w-20 h-20 bg-gradient-to-br from-yellow-500 to-orange-500 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <FiAlertCircle className="text-white text-3xl" />
          </div>
          <h1 className="text-3xl font-bold mb-4">Wrong Network</h1>
          <p className="text-gray-400 mb-8 max-w-2xl mx-auto">
            Please switch to Avalanche Fuji Testnet to use SpooVault.
          </p>
          <Button
            size="lg"
            className={buttonClasses.warningLg}
            onPress={() =>
              window.ethereum &&
              window.ethereum.request({
                method: "wallet_switchEthereumChain",
                params: [{ chainId: "0xA869" }],
              })
            }
          >
            Switch to Fuji Network
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="rounded-2xl bg-gradient-to-r from-gray-900/50 to-[#040306] border border-gray-800 p-6 lg:p-8">
        <div className="flex flex-col gap-6">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-12 h-12 bg-gradient-to-br from-brand-700 to-brand-900 rounded-xl flex items-center justify-center">
                <FiShield className="text-white text-xl" />
              </div>
              <div>
                <h1 className="text-2xl lg:text-3xl font-bold">Welcome back</h1>
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  <span>
                    Connected to {account?.slice(0, 6)}...{account?.slice(-4)}
                  </span>
                </div>
              </div>
            </div>
            <p className="text-gray-400">{welcomeMessage}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {loading ? (
          <>
            {[...Array(4)].map((_, i) => (
              <Card key={i} className="border border-gray-800 bg-gray-900/30">
                <CardBody className="p-6">
                  <Skeleton className="rounded-lg">
                    <div className="h-24 rounded-lg bg-default-300" />
                  </Skeleton>
                </CardBody>
              </Card>
            ))}
          </>
        ) : (
          <>
            {statCards.map((card) => (
              <Card
                key={card.key}
                className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm"
              >
                <CardBody className="p-6">
                  <div className="mb-4">
                    <div
                      className={`inline-flex p-3 rounded-xl ${card.iconBg}`}
                    >
                      {card.icon}
                    </div>
                  </div>
                  <h3 className="text-2xl font-bold mb-1">{card.value}</h3>
                  <p className="text-gray-400 text-sm">{card.label}</p>
                </CardBody>
              </Card>
            ))}
          </>
        )}
      </div>

      <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
        <CardHeader className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FiCheckCircle />
            <h2 className="text-xl font-semibold">Handover Checklist</h2>
          </div>
          <Chip size="sm" variant="flat" color="primary">
            {handoverChecklist.filter((step) => step.done).length}/
            {handoverChecklist.length} done
          </Chip>
        </CardHeader>
        <CardBody className="space-y-3">
          {handoverChecklist.map((step) => (
            <button
              key={step.key}
              type="button"
              className={`w-full rounded-xl border px-4 py-3 flex items-center justify-between gap-3 transition-colors ${
                step.done
                  ? "border-green-800/40 bg-green-500/5 hover:border-green-700/50"
                  : "border-gray-800/80 bg-gray-900/50 hover:border-gray-700/80"
              }`}
              onClick={() => navigate(step.route)}
            >
              <div className="flex items-center gap-3 text-left">
                {step.done ? (
                  <FiCheckCircle className="text-green-400 flex-shrink-0" />
                ) : (
                  <FiCircle className="text-gray-500 flex-shrink-0" />
                )}
                <span
                  className={`text-sm ${
                    step.done ? "line-through text-gray-400 opacity-70" : ""
                  }`}
                >
                  {step.title}
                </span>
              </div>
              <span
                className={`text-xs ${
                  step.done ? "text-green-400/90" : "text-gray-500"
                }`}
              >
                {step.done ? "Done" : "Open"}
              </span>
            </button>
          ))}
          <p className="text-xs text-gray-500">
            Final step is marked done after you export at least one beneficiary
            key package.
          </p>
        </CardBody>
      </Card>

      <div className="grid lg:grid-cols-3 gap-8">
        <Card className="lg:col-span-2 border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
          <CardHeader className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FiActivity />
              <h2 className="text-xl font-semibold">Recent Activity</h2>
            </div>
            <Button
              className={buttonClasses.ghostSm}
              onPress={() => navigate("/vaults")}
            >
              View Access Vaults
            </Button>
          </CardHeader>
          <CardBody className="p-0">
            {loading || activityLoading ? (
              <div className="p-6 space-y-4">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="rounded-lg">
                    <div className="h-16 rounded-lg bg-default-300" />
                  </Skeleton>
                ))}
              </div>
            ) : recentActivity.length === 0 ? (
              <div className="p-8 md:p-10 min-h-[20rem] flex items-center justify-center">
                <div className="max-w-md text-center">
                  <div className="mx-auto mb-4 w-14 h-14 rounded-2xl border border-gray-700/80 bg-gray-900/70 flex items-center justify-center">
                    <FiActivity className="text-gray-300 text-xl" />
                  </div>
                  <h3 className="text-xl font-semibold mb-2">
                    No recent activity yet
                  </h3>
                  <p className="text-sm text-gray-400">
                    Activity will appear after you create a vault, upload a
                    document, mint a pass, or approve a request.
                  </p>
                  <div className="mt-5 flex flex-col sm:flex-row items-center justify-center gap-3">
                    <Button
                      className={buttonClasses.primarySm}
                      startContent={<FiShield />}
                      onPress={() => navigate("/vaults?create=true")}
                    >
                      Create First Vault
                    </Button>
                    <Button
                      className={buttonClasses.ghostSm}
                      startContent={<FiFile />}
                      onPress={() => navigate("/documents")}
                    >
                      Upload Legacy File
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="divide-y divide-gray-800">
                {recentActivity.map((activity, index) => (
                  <div
                    key={index}
                    className="p-4 hover:bg-gray-800/20 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                            activity.status === "success"
                              ? "bg-green-500/20"
                              : "bg-yellow-500/20"
                          }`}
                        >
                          {activity.status === "success" ? (
                            <FiCheckCircle className="text-green-400" />
                          ) : (
                            <FiClock className="text-yellow-400" />
                          )}
                        </div>
                        <div>
                          <p className="font-medium">{activity.action}</p>
                          <p className="text-sm text-gray-400">
                            {activity.actor}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm">
                          {activity.timestamp
                            ? formatDistanceToNow(
                                new Date(activity.timestamp * 1000),
                                { addSuffix: true }
                              )
                            : "-"}
                        </p>
                        <div className="flex items-center justify-end gap-2 mt-1">
                          <Chip
                            color={
                              activity.status === "success"
                                ? "success"
                                : "warning"
                            }
                            variant="flat"
                            size="sm"
                          >
                            {activity.status}
                          </Chip>
                          {activity.txHash && (
                            <a
                              href={getExplorerTxUrl(
                                activity.txHash,
                                activity.network
                              )}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
                            >
                              Tx <FiArrowUpRight className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <div className="space-y-6">
          <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
            <CardHeader>
              <h2 className="text-xl font-semibold">Quick Actions</h2>
            </CardHeader>
            <CardBody className="space-y-3">
              <Link to="/vaults?create=true">
                <Button
                  fullWidth
                  className={`${buttonClasses.primaryMd} !h-12 justify-between`}
                >
                  <span className="flex items-center gap-3">
                    <FiShield />
                    Create Access Vault
                  </span>
                  <FiArrowUpRight className="text-base" />
                </Button>
              </Link>
              <Link to="/documents">
                <Button
                  fullWidth
                  className={`${buttonClasses.ghostMd} !h-11 justify-between`}
                >
                  <span className="flex items-center gap-3">
                    <FiFile />
                    Upload Legacy File
                  </span>
                  <FiArrowUpRight className="text-sm text-gray-500" />
                </Button>
              </Link>
              <Link to="/nfts">
                <Button
                  fullWidth
                  className={`${buttonClasses.ghostMd} !h-11 justify-between`}
                >
                  <span className="flex items-center gap-3">
                    <FiKey />
                    Mint Beneficiary Pass
                  </span>
                  <FiArrowUpRight className="text-sm text-gray-500" />
                </Button>
              </Link>
              <Link to="/access">
                <Button
                  fullWidth
                  className={`${buttonClasses.ghostMd} !h-11 justify-between`}
                >
                  <span className="flex items-center gap-3">
                    <FiUsers />
                    Open My Access View
                  </span>
                  <FiArrowUpRight className="text-sm text-gray-500" />
                </Button>
              </Link>
              <Link to="/vaults">
                <Button
                  fullWidth
                  className={`${buttonClasses.ghostMd} !h-11 justify-between`}
                >
                  <span className="flex items-center gap-3">
                    <FiUsers />
                    Manage Vaults
                  </span>
                  <FiArrowUpRight className="text-sm text-gray-500" />
                </Button>
              </Link>
              <p className="text-xs text-gray-500 px-1">
                Start with vault creation, then upload files and assign
                guardians from vault setup.
              </p>
            </CardBody>
          </Card>

          <Card
            id="approval-queue"
            className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm scroll-mt-24"
          >
            <CardHeader className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <FiCheckCircle className="mt-0.5 flex-shrink-0" />
                <h2 className="text-lg font-semibold leading-tight whitespace-nowrap">
                  Approval Queue
                </h2>
              </div>
              <Chip
                size="sm"
                variant="flat"
                color="warning"
                className="whitespace-nowrap flex-shrink-0"
              >
                {pendingApprovals.length} Pending
              </Chip>
            </CardHeader>
            <CardBody className="space-y-3">
              {loading ? (
                <>
                  {[...Array(3)].map((_, i) => (
                    <Skeleton key={i} className="rounded-lg">
                      <div className="h-16 rounded-lg bg-default-300" />
                    </Skeleton>
                  ))}
                </>
              ) : pendingApprovals.length === 0 ? (
                <div className="rounded-xl border border-gray-800/80 bg-gray-900/45 p-4">
                  <p className="text-sm text-gray-400">
                    No pending approvals assigned to your guardian account.
                  </p>
                </div>
              ) : (
                pendingApprovals.map((item) => (
                  <div
                    key={item.requestId}
                    className="rounded-xl border border-gray-800 bg-gray-900/45 p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{item.vaultName}</p>
                        <p className="text-xs text-gray-400">
                          Request #{item.requestId} - Doc #{item.documentId}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        className={buttonClasses.primarySm}
                        onPress={() => handleApproveRequest(item.requestId)}
                        isLoading={approvingRequestId === item.requestId}
                        isDisabled={approvingRequestId !== null}
                      >
                        Approve
                      </Button>
                    </div>
                    <div className="flex items-center justify-between text-xs text-gray-400">
                      <span>{shortenAddress(item.requester)}</span>
                      <span>
                        Expires{" "}
                        {formatDistanceToNow(new Date(item.expiresAt * 1000), {
                          addSuffix: true,
                        })}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
        <CardHeader className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FiTrendingUp />
            <h2 className="text-xl font-semibold">Vault Activity</h2>
          </div>
          <Button
            className={buttonClasses.outlineSm}
            startContent={<FiArrowUpRight />}
            onPress={() => navigate("/vaults")}
          >
            View All Vaults
          </Button>
        </CardHeader>
        <CardBody className="space-y-6">
          {loading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i}>
                  <Skeleton className="w-3/4 rounded-lg mb-2">
                    <div className="h-4 rounded-lg bg-default-300" />
                  </Skeleton>
                  <Skeleton className="w-full rounded-lg">
                    <div className="h-2 rounded-lg bg-default-300" />
                  </Skeleton>
                </div>
              ))}
            </div>
          ) : vaults.length === 0 ? (
            <div className="rounded-2xl border border-gray-800/80 bg-gray-900/45 p-6 md:p-8">
              <div className="max-w-xl">
                <h3 className="text-lg font-semibold mb-2">
                  No access vaults yet
                </h3>
                <p className="text-sm text-gray-400 mb-4">
                  Create your first vault to unlock activity tracking,
                  approvals, and document release history.
                </p>
                <div className="flex flex-col sm:flex-row gap-3">
                  <Button
                    className={buttonClasses.primarySm}
                    startContent={<FiShield />}
                    onPress={() => navigate("/vaults?create=true")}
                  >
                    Create Access Vault
                  </Button>
                  <Button
                    className={buttonClasses.ghostSm}
                    startContent={<FiUsers />}
                    onPress={() => navigate("/vaults")}
                  >
                    Manage Vaults
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            vaults.map((vault) => {
              const docCount = docCountByVault[vault.id] || 0;
              const progress =
                maxDocCount > 0
                  ? Math.round((docCount / maxDocCount) * 100)
                  : 0;

              return (
                <div key={vault.id}>
                  <div className="flex justify-between mb-2">
                    <div>
                      <span className="font-medium">{vault.name}</span>
                      <span className="text-sm text-gray-400 ml-3">
                        {docCount} docs
                      </span>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold leading-none">{progress}%</p>
                      <p className="text-[11px] text-gray-500 mt-1">
                        Relative share
                      </p>
                    </div>
                  </div>
                  <Progress
                    value={progress}
                    className="max-w-full"
                    classNames={{
                      indicator: "bg-gradient-to-r from-brand-700 to-brand-900",
                    }}
                  />
                </div>
              );
            })
          )}
        </CardBody>
      </Card>

      {/* Vault Inheritance & Dead-Man Switch Section */}
      {vaults.length > 0 && (
        <div className="mt-8">
          <InheritanceSettings
            vaultId={vaults[0].id}
            vaultName={vaults[0].name}
            isOwner={true}
            onRecordProofOfLife={async (id) => {
              await contractService.recordProofOfLife(id);
            }}
            onToggleEmergencyMode={async (id, enabled) => {
              await contractService.setEmergencyMode(id, enabled);
            }}
          />
        </div>
      )}

      {/* Compliance & Audit Log Timeline */}
      <div className="mt-8">
        <AuditLogTimeline
          vault={vaults[0]}
          activities={vaults.map((v) => ({
            action: `Vault #${v.id} Active`,
            actor: shortenAddress(v.creator),
            timestamp: v.createdAt || Math.floor(Date.now() / 1000) - 3600,
            status: "success" as const,
          }))}
        />
      </div>
    </div>
  );
};

export default Dashboard;

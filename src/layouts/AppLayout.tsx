import { useEffect, useMemo, useRef, useState } from "react";
import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import {
  Button,
  Avatar,
  Tooltip,
} from "@heroui/react";
import {
  FiHome,
  FiShield,
  FiFile,
  FiKey,
  FiUser,
  FiPlus,
  FiZap,
  FiMoreHorizontal,
  FiChevronLeft,
  FiChevronRight,
  FiUnlock,
  FiBell,
  FiBook,
  FiActivity,
} from "react-icons/fi";
import { useWeb3 } from "../context/Web3Context";
import { contractService } from "../services/contract.service";
import { shortenAddress } from "../utils/helpers";
import { toast } from "react-hot-toast";
import { buttonClasses } from "../utils/buttonClasses";
import BrandLogo from "../components/BrandLogo";

const AppLayout = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { account, isConnected, disconnect, isFujiNetwork, switchToFuji, provider, signer, ecosystem, setEcosystem } = useWeb3();
  const [nickname, setNickname] = useState("");
  const [desktopMenuOpen, setDesktopMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [desktopSidebarExpanded, setDesktopSidebarExpanded] = useState(true);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const desktopMenuRef = useRef<HTMLDivElement | null>(null);
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const readProfile = () => {
      try {
        const stored = localStorage.getItem("spoovault-profile");
        if (stored) {
          const parsed = JSON.parse(stored) as { nickname?: string };
          setNickname(parsed.nickname ?? "");
        } else {
          setNickname("");
        }
      } catch {
        setNickname("");
      }
    };

    readProfile();

    const handleProfileUpdate = () => readProfile();
    const handleStorage = (event: StorageEvent) => {
      if (event.key === "spoovault-profile") {
        readProfile();
      }
    };

    window.addEventListener("spoovault-profile-updated", handleProfileUpdate as EventListener);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("spoovault-profile-updated", handleProfileUpdate as EventListener);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const navItems = [
    { path: "/dashboard", label: "Dashboard", icon: FiHome },
    { path: "/analytics", label: "Analytics", icon: FiActivity },
    { path: "/vaults", label: "Access Vaults", icon: FiShield },
    { path: "/documents", label: "Documents", icon: FiFile },
    { path: "/access", label: "My Access", icon: FiUnlock },
    { path: "/nfts", label: "Access Passes", icon: FiKey },
    { path: "/docs", label: "Docs & Guides", icon: FiBook },
    { path: "/profile", label: "Profile", icon: FiUser },
  ];

  const mobileNavItems = [
    { path: "/dashboard", label: "Home", icon: FiHome },
    { path: "/analytics", label: "Stats", icon: FiActivity },
    { path: "/vaults", label: "Vaults", icon: FiShield },
    { path: "/documents", label: "Docs", icon: FiFile },
    { path: "/access", label: "Access", icon: FiUnlock },
    { path: "/docs", label: "Guide", icon: FiBook },
  ];

  const desktopRailItems = navItems.filter((item) => item.path !== "/profile");
  const desktopProfileItem = navItems.find((item) => item.path === "/profile");

  const isActive = (path: string) => location.pathname === path;

  const handleCreateVault = () => {
    if (!isConnected) {
      toast.error("Please connect your wallet first");
      return;
    }
    if (!isFujiNetwork) {
      toast.error("Please switch to Avalanche Fuji network");
      return;
    }
    navigate("/vaults?create=true");
  };

  const displayName = nickname || (account ? shortenAddress(account, 4) : "Guest");

  type ProfileMenuTone = "default" | "warning" | "danger";
  type ProfileMenuItem = {
    key: string;
    label: string;
    tone: ProfileMenuTone;
    onClick: () => void;
  };

  const profileMenuItems = useMemo(
    (): ProfileMenuItem[] => [
      {
        key: "profile",
        label: "Profile",
        tone: "default",
        onClick: () => navigate("/profile"),
      },
      {
        key: "access",
        label: "My Access",
        tone: "default",
        onClick: () => navigate("/access"),
      },
      {
        key: "copy",
        label: "Copy Address",
        tone: "default",
        onClick: () => {
          navigator.clipboard.writeText(account || "");
          toast.success("Address copied");
        },
      },
      {
        key: "ecosystem",
        label: `Switch to ${ecosystem === "avalanche" ? "Stellar" : "Avalanche"}`,
        tone: "default",
        onClick: () => {
          const next = ecosystem === "avalanche" ? "stellar" : "avalanche";
          setEcosystem(next);
          toast.success(`Switched to ${next === "avalanche" ? "Avalanche" : "Stellar"} ecosystem`);
        },
      },
      ...(ecosystem === "stellar" || isFujiNetwork
        ? []
        : [
            {
              key: "switch",
              label: "Switch to Fuji",
              tone: "warning" as const,
              onClick: switchToFuji,
            },
          ]),
      {
        key: "disconnect",
        label: "Disconnect",
        tone: "danger",
        onClick: disconnect,
      },
    ],
    [account, disconnect, isFujiNetwork, navigate, switchToFuji, ecosystem, setEcosystem]
  );

  useEffect(() => {
    try {
      const stored = localStorage.getItem("spoovault-desktop-sidebar-expanded");
      if (stored !== null) {
        setDesktopSidebarExpanded(stored === "1");
      }
    } catch {
      setDesktopSidebarExpanded(true);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("spoovault-desktop-sidebar-expanded", desktopSidebarExpanded ? "1" : "0");
    } catch {
      // ignore storage errors
    }
  }, [desktopSidebarExpanded]);

  useEffect(() => {
    setDesktopMenuOpen(false);
    setMobileMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    let cancelled = false;
    const loadPendingApprovalCount = async () => {
      if (!account || !isConnected) {
        setPendingApprovalCount(0);
        return;
      }
      if (ecosystem === "avalanche" && (!provider || !isFujiNetwork)) {
        setPendingApprovalCount(0);
        return;
      }
      try {
        if (ecosystem === "avalanche") {
          contractService.initialize(provider!, signer ?? undefined);
        }
        const approvals = await contractService.fetchPendingApprovalsForGuardian(account, 20);
        if (!cancelled) {
          setPendingApprovalCount(approvals.length);
        }
      } catch {
        if (!cancelled) {
          setPendingApprovalCount(0);
        }
      }
    };

    void loadPendingApprovalCount();
    const interval = window.setInterval(loadPendingApprovalCount, 30000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [account, isConnected, provider, signer, isFujiNetwork, ecosystem, location.pathname]);

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (desktopMenuRef.current && !desktopMenuRef.current.contains(target)) {
        setDesktopMenuOpen(false);
      }
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(target)) {
        setMobileMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDesktopMenuOpen(false);
        setMobileMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  const profileMenuItemClass = (tone: ProfileMenuTone) =>
    `w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
      tone === "danger"
        ? "text-red-300 hover:bg-red-500/15"
        : tone === "warning"
        ? "text-yellow-300 hover:bg-yellow-500/15"
        : "text-gray-200 hover:bg-gray-800/80"
    }`;

  const toggleDesktopSidebar = () => {
    setDesktopMenuOpen(false);
    setDesktopSidebarExpanded((prev) => !prev);
  };

  const openApprovalQueue = () => {
    navigate("/dashboard#approval-queue");
  };

  const canCreateVault = isConnected && isFujiNetwork;

  return (
    <div className="app-shell-bg min-h-screen">
      <aside
        className={`hidden lg:flex fixed left-0 top-0 h-screen border-r border-gray-800/80 bg-gray-950/90 backdrop-blur-2xl z-50 shadow-[18px_0_40px_-34px_rgba(0,0,0,0.95)] transition-[width] duration-300 overflow-visible ${
          desktopSidebarExpanded ? "w-[20rem]" : "w-[4.5rem]"
        }`}
      >
        <div className="w-[4.5rem] border-r border-gray-800/80 px-2 py-4 flex flex-col items-center">
          <div className="flex items-center gap-1.5 pb-4">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/90" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/90" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/90" />
          </div>

          <Tooltip content="Open dashboard" placement="right" delay={150}>
            <Link to="/dashboard" className="mb-4 group">
              <div className="w-11 h-11 rounded-xl bg-white/5 border border-gray-700/70 flex items-center justify-center shadow-lg shadow-brand-900/25 group-hover:border-brand-700/45 transition-colors">
                <BrandLogo className="w-6 h-6" />
              </div>
            </Link>
          </Tooltip>

          <nav className="w-full space-y-2">
            {desktopRailItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);
              return (
                <Tooltip key={`rail-tooltip-${item.path}`} content={item.label} placement="right" delay={120}>
                  <Link
                    key={`rail-${item.path}`}
                    to={item.path}
                    className={`mx-auto flex h-11 w-11 items-center justify-center rounded-xl border transition-all ${
                      active
                        ? "bg-brand-700/22 border-brand-700/55 text-brand-300 shadow-[0_6px_18px_-10px_rgba(220,38,38,0.8)]"
                        : "border-transparent text-gray-500 hover:text-gray-200 hover:border-gray-700/70 hover:bg-gray-900/80"
                    }`}
                  >
                    <Icon className="text-[17px]" />
                  </Link>
                </Tooltip>
              );
            })}
          </nav>

          <div className="mt-3 w-full space-y-2 border-t border-gray-800/70 pt-3">
            <Tooltip content="Create access vault" placement="right" delay={120}>
              <Button
                isIconOnly
                onPress={handleCreateVault}
                isDisabled={!canCreateVault}
                className={`mx-auto w-11 h-11 min-w-11 rounded-xl border ${
                  canCreateVault
                    ? "border-brand-700/45 bg-brand-700/15 text-brand-300 hover:bg-brand-700/25"
                    : "border-gray-800/80 bg-gray-900/55 text-gray-600"
                }`}
                aria-label="Create access vault"
              >
                <FiPlus className="text-[17px]" />
              </Button>
            </Tooltip>

            {desktopProfileItem && (
              <Tooltip content={desktopProfileItem.label} placement="right" delay={120}>
                <Link
                  to={desktopProfileItem.path}
                  className={`mx-auto flex h-11 w-11 items-center justify-center rounded-xl border transition-all ${
                    isActive(desktopProfileItem.path)
                      ? "bg-brand-700/22 border-brand-700/55 text-brand-300"
                      : "border-transparent text-gray-500 hover:text-gray-200 hover:border-gray-700/70 hover:bg-gray-900/80"
                  }`}
                >
                  <desktopProfileItem.icon className="text-[17px]" />
                </Link>
              </Tooltip>
            )}
          </div>
        </div>

        {desktopSidebarExpanded && (
        <div className="flex-1 min-w-0 p-3 flex flex-col">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex-1 min-w-0 rounded-2xl border border-gray-800/80 bg-gray-900/60 px-3 py-3">
              <p className="text-sm font-semibold truncate">SpooVault</p>
              <p className="text-xs text-gray-400 truncate">spoovault.web.app</p>
            </div>
            <button
              type="button"
              onClick={toggleDesktopSidebar}
              className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-gray-700/80 bg-gray-900/85 text-gray-300 hover:border-gray-500 hover:text-white transition-colors"
              aria-label="Collapse sidebar"
            >
              <FiChevronLeft className="text-[15px]" />
            </button>
          </div>

          <div className="mt-3 rounded-xl border border-gray-800/80 bg-gray-900/65 px-2 py-2 flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-1 bg-black/45 p-1 rounded-xl">
              <button
                type="button"
                onClick={() => setEcosystem("avalanche")}
                className={`flex-1 py-1.5 text-center text-xs rounded-lg font-semibold transition-all duration-200 ${
                  ecosystem === "avalanche"
                    ? "bg-brand-700/80 text-white shadow-md border border-brand-600/30"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                Avalanche
              </button>
              <button
                type="button"
                onClick={() => setEcosystem("stellar")}
                className={`flex-1 py-1.5 text-center text-xs rounded-lg font-semibold transition-all duration-200 ${
                  ecosystem === "stellar"
                    ? "bg-purple-800/80 text-white shadow-md border border-purple-600/30"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                Stellar
              </button>
            </div>
            
            <div className="flex items-center justify-between px-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    !isConnected
                      ? "bg-gray-500"
                      : ecosystem === "stellar"
                      ? "bg-purple-500 shadow-[0_0_10px_rgba(168,85,247,0.6)]"
                      : isFujiNetwork
                      ? "bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.6)]"
                      : "bg-yellow-400"
                  }`}
                />
                <p
                  className={`text-[11px] font-semibold truncate ${
                    !isConnected
                      ? "text-gray-400"
                      : ecosystem === "stellar"
                      ? "text-purple-300"
                      : isFujiNetwork
                      ? "text-green-300"
                      : "text-yellow-300"
                  }`}
                >
                  {!isConnected
                    ? "Wallet Disconnected"
                    : ecosystem === "stellar"
                    ? "Stellar Soroban Online"
                    : isFujiNetwork
                    ? "Avalanche Fuji Online"
                    : "Wrong Network"}
                </p>
              </div>
              {isConnected && ecosystem === "avalanche" && !isFujiNetwork && (
                <button
                  type="button"
                  onClick={switchToFuji}
                  className="text-[10px] font-semibold text-yellow-300 hover:text-yellow-200"
                >
                  Switch
                </button>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={openApprovalQueue}
            className={`mt-2 w-full rounded-xl border px-3 py-2.5 flex items-center justify-between transition-colors ${
              pendingApprovalCount > 0
                ? "border-brand-700/55 bg-brand-700/12 text-brand-200"
                : "border-gray-800/80 bg-gray-900/65 text-gray-300 hover:bg-gray-900/85"
            }`}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <FiBell className={pendingApprovalCount > 0 ? "text-brand-300" : "text-gray-500"} />
              <span>Approval Queue</span>
            </span>
            <span
              className={`min-w-[1.6rem] h-6 px-2 rounded-full text-xs font-semibold inline-flex items-center justify-center ${
                pendingApprovalCount > 0
                  ? "bg-brand-700/35 text-brand-200"
                  : "bg-gray-800 text-gray-400"
              }`}
            >
              {pendingApprovalCount}
            </span>
          </button>

          <nav className="mt-3 space-y-1.5">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);
              return (
                <Link
                  key={`panel-${item.path}`}
                  to={item.path}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-all ${
                    active
                      ? "border-gray-700/90 bg-white/10 text-white"
                      : "border-transparent text-gray-400 hover:text-gray-100 hover:border-gray-800/80 hover:bg-gray-900/70"
                  }`}
                >
                  <Icon className={`text-base ${active ? "text-brand-300" : "text-gray-500"}`} />
                  <span className="text-sm font-medium">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="mt-3 pt-3 space-y-3 border-t border-gray-800/70">
            <Button
              onPress={handleCreateVault}
              isDisabled={!canCreateVault}
              className={
                canCreateVault
                  ? `w-full ${buttonClasses.outlineSm}`
                  : "w-full h-12 rounded-full border border-gray-800/80 bg-gray-900/70 text-gray-500"
              }
              startContent={<FiPlus className="text-base" />}
            >
              Create Access Vault
            </Button>

            {isConnected ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-gray-800/80 bg-gray-900/70 p-2.5">
                <Avatar
                  className="bg-gradient-to-br from-brand-700 to-brand-900 flex-shrink-0"
                  name={nickname || account?.substring(2, 6)}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{displayName}</p>
                  <p className="text-[11px] text-gray-500 truncate">{shortenAddress(account || "", 4)}</p>
                </div>
                <div className="relative" ref={desktopMenuRef}>
                  <Button
                    isIconOnly
                    variant="light"
                    size="sm"
                    className="text-gray-400 hover:text-white"
                    onPress={() => {
                      setDesktopMenuOpen((open) => !open);
                      setMobileMenuOpen(false);
                    }}
                  >
                    <FiMoreHorizontal />
                  </Button>
                  {desktopMenuOpen && (
                    <div className="absolute right-0 bottom-10 z-40 w-44 rounded-xl border border-gray-700/80 bg-gray-950/95 p-1 shadow-2xl">
                      {profileMenuItems.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          className={profileMenuItemClass(item.tone)}
                          onClick={() => {
                            item.onClick();
                            setDesktopMenuOpen(false);
                          }}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
        )}

        {!desktopSidebarExpanded && (
          <button
            type="button"
            onClick={toggleDesktopSidebar}
            aria-label="Expand sidebar"
            className="group absolute -right-5 top-1/2 -translate-y-1/2 h-10 w-10 rounded-xl border border-gray-700/80 bg-gray-900/95 text-gray-300 shadow-[0_18px_30px_-20px_rgba(0,0,0,0.95)] hover:border-gray-500 hover:text-white transition-all"
          >
            <FiChevronRight className="mx-auto text-[16px]" />
          </button>
        )}
      </aside>

      <header className="lg:hidden fixed top-0 inset-x-0 z-40 border-b border-gray-800/80 bg-gray-950/92 backdrop-blur-2xl">
        <div className="h-16 px-3.5 flex items-center gap-2">
          <Link to="/dashboard" className="min-w-0 flex-1 flex items-center gap-2.5 overflow-hidden">
            <div className="w-9 h-9 rounded-xl bg-white/5 border border-gray-700/60 flex items-center justify-center shadow-lg shadow-brand-900/30">
              <BrandLogo className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[15px] font-semibold leading-none truncate">SpooVault</p>
              <p className="text-[11px] text-gray-400 mt-1 truncate">Family Access App</p>
            </div>
          </Link>

          <div className="flex items-center gap-1.5 flex-shrink-0">
            {isConnected && (
              <button
                type="button"
                aria-label="Open approval queue"
                onClick={openApprovalQueue}
                className={`relative w-9 h-9 rounded-xl border text-gray-300 flex items-center justify-center transition-colors ${
                  pendingApprovalCount > 0
                    ? "border-brand-700/60 bg-brand-700/12 text-brand-300 shadow-[0_10px_20px_-16px_rgba(185,28,28,0.9)]"
                    : "border-gray-700/75 bg-gray-900/75 hover:border-gray-600 hover:text-gray-100"
                }`}
              >
                <FiBell className={`text-[14px] ${pendingApprovalCount > 0 ? "text-brand-300" : ""}`} />
                {pendingApprovalCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[1rem] h-4 px-1 rounded-full bg-brand-700 text-[10px] font-semibold text-white leading-none inline-flex items-center justify-center">
                    {pendingApprovalCount > 9 ? "9+" : pendingApprovalCount}
                  </span>
                )}
                {pendingApprovalCount > 0 && (
                  <span className="pointer-events-none absolute inset-0 rounded-xl border border-brand-500/45 animate-pulse" />
                )}
              </button>
            )}
            {!isConnected && (
              <Link
                to="/profile"
                aria-label="Open profile"
                className="w-9 h-9 rounded-xl border border-gray-700/75 bg-gray-900/75 text-gray-300 flex items-center justify-center hover:border-gray-600 hover:text-gray-100 transition-colors"
              >
                <FiUser className="text-[14px]" />
              </Link>
            )}
            {!isConnected ? (
              <Tooltip content="Wallet not connected" placement="bottom" delay={120}>
                <span className="inline-flex w-2.5 h-2.5 rounded-full bg-gray-500 ring-2 ring-gray-500/20" />
              </Tooltip>
            ) : ecosystem === "stellar" ? (
              <Tooltip content="Stellar Soroban" placement="bottom" delay={120}>
                <span className="inline-flex w-2.5 h-2.5 rounded-full bg-purple-500 ring-2 ring-purple-500/25" />
              </Tooltip>
            ) : isFujiNetwork ? (
              <Tooltip content="Avalanche Fuji" placement="bottom" delay={120}>
                <span className="inline-flex w-2.5 h-2.5 rounded-full bg-green-500 ring-2 ring-green-500/25" />
              </Tooltip>
            ) : (
              <Button
                isIconOnly
                size="sm"
                onPress={switchToFuji}
                className="w-8 h-8 min-w-8 rounded-xl border border-yellow-500/40 bg-yellow-500/10 text-yellow-300"
              >
                <FiZap className="text-[14px]" />
              </Button>
            )}
            {isConnected ? (
              <div className="relative" ref={mobileMenuRef}>
                <button
                  type="button"
                  className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/70"
                  aria-label="Open account menu"
                  onClick={() => {
                    setMobileMenuOpen((open) => !open);
                    setDesktopMenuOpen(false);
                  }}
                >
                  <Avatar
                    className="w-8 h-8 bg-gradient-to-br from-brand-700 to-brand-900"
                    name={nickname || account?.substring(2, 6)}
                  />
                </button>
                {mobileMenuOpen && (
                  <div className="absolute right-0 top-11 z-50 w-44 rounded-xl border border-gray-700/80 bg-gray-950/95 p-1 shadow-2xl">
                    {profileMenuItems.map((item) => (
                      <button
                        key={`mobile-${item.key}`}
                        type="button"
                        className={profileMenuItemClass(item.tone)}
                        onClick={() => {
                          item.onClick();
                          setMobileMenuOpen(false);
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <main
        className={`min-h-screen pt-20 pb-24 lg:pt-0 lg:pb-0 transition-[margin] duration-300 ${
          desktopSidebarExpanded ? "lg:ml-[20rem]" : "lg:ml-[4.5rem]"
        }`}
      >
        <div className="p-4 lg:p-8">
          <div className="max-w-7xl mx-auto">
            <Outlet />
          </div>
        </div>
      </main>

      <nav className="lg:hidden fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-md rounded-2xl border border-gray-800/80 bg-gray-900/92 backdrop-blur-2xl shadow-[0_16px_30px_-22px_rgba(0,0,0,0.95)]">
          <div className="grid grid-cols-6 gap-1 p-1.5">
            {mobileNavItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);

              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`flex flex-col items-center justify-center gap-1 rounded-xl py-1.5 transition-all ${
                    active
                      ? "bg-brand-700/18 border border-brand-700/35 text-brand-300"
                      : "border border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-800/55"
                  }`}
                >
                  <Icon className={`text-[16px] ${active ? "text-brand-300" : "text-gray-500"}`} />
                  <span className={`text-[10px] leading-none ${active ? "text-brand-300" : "text-gray-500"}`}>
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>
    </div>
  );
};

export default AppLayout;

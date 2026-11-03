import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { Button, Avatar, Tooltip } from "@heroui/react";
import {
  FiHome,
  FiShield,
  FiFile,
  FiKey,
  FiUser,
  FiPlus,
  FiMoreHorizontal,
  FiChevronLeft,
  FiChevronRight,
  FiUnlock,
  FiBell,
  FiBook,
  FiActivity,
  FiMenu,
  FiX,
  FiLogOut,
} from "react-icons/fi";
import { useWeb3 } from "../context/Web3Context";
import { contractService } from "../services/contract.service";
import { shortenAddress } from "../utils/helpers";
import { buttonClasses } from "../utils/buttonClasses";
import BrandLogo from "../components/BrandLogo";
import OfflineBanner from "../components/offline/OfflineBanner";
import { useRelayNotifications } from "../context/RelayNotificationContext";
import { notifyCenter } from "../services/relayNotification.service";
import RelayNotificationDrawer from "../components/notifications/RelayNotificationDrawer";

const AppLayout = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    account,
    isConnected,
    disconnect,
    openConnectModal,
    walletType,
  } = useWeb3();
  const [nickname, setNickname] = useState("");
  const [desktopMenuOpen, setDesktopMenuOpen] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [desktopSidebarExpanded, setDesktopSidebarExpanded] = useState(true);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const desktopMenuRef = useRef<HTMLDivElement | null>(null);
  const lastBellTriggerRef = useRef<HTMLElement | null>(null);
  const {
    items: notificationItems,
    drawerOpen: notificationDrawerOpen,
    setDrawerOpen: setNotificationDrawerOpen,
  } = useRelayNotifications();

  const activeRelayCount = useMemo(
    () =>
      notificationItems.filter(
        (item) => item.status === "pending" || item.status === "submitted"
      ).length,
    [notificationItems]
  );

  const unreadNotificationCount = useMemo(
    () => notificationItems.filter((item) => !item.read).length,
    [notificationItems]
  );

  const notificationBadgeCount =
    Math.max(unreadNotificationCount, activeRelayCount) + pendingApprovalCount;

  const handleOpenNotificationCenter = (
    event: ReactMouseEvent<HTMLButtonElement>
  ) => {
    lastBellTriggerRef.current = event.currentTarget;
    setNotificationDrawerOpen(true);
  };

  useEffect(() => {
    setMobileDrawerOpen(false);
  }, [location.pathname]);

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

    window.addEventListener(
      "spoovault-profile-updated",
      handleProfileUpdate as EventListener
    );
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(
        "spoovault-profile-updated",
        handleProfileUpdate as EventListener
      );
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

  const isActive = (path: string) => location.pathname === path;

  const handleCreateVault = () => {
    if (!isConnected) {
      notifyCenter.error("Please connect your Freighter wallet first");
      return;
    }
    navigate("/vaults?create=true");
  };

  const displayName =
    nickname || (account ? shortenAddress(account, 4) : "Guest");

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
          notifyCenter.success("Address copied", { category: "system" });
        },
      },
      {
        key: "disconnect",
        label: "Disconnect",
        tone: "danger",
        onClick: disconnect,
      },
    ],
    [account, disconnect, navigate]
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
      localStorage.setItem(
        "spoovault-desktop-sidebar-expanded",
        desktopSidebarExpanded ? "1" : "0"
      );
    } catch {
      // ignore storage errors
    }
  }, [desktopSidebarExpanded]);

  useEffect(() => {
    setDesktopMenuOpen(false);
    setMobileDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    let cancelled = false;
    const loadPendingApprovalCount = async () => {
      if (!account || !isConnected) {
        setPendingApprovalCount(0);
        return;
      }
      try {
        const approvals =
          await contractService.fetchPendingApprovalsForGuardian(account, 20);
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
  }, [
    account,
    isConnected,
    location.pathname,
  ]);

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (desktopMenuRef.current && !desktopMenuRef.current.contains(target)) {
        setDesktopMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDesktopMenuOpen(false);
        setMobileDrawerOpen(false);
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

  const canCreateVault = isConnected;

  return (
    <div className="app-shell-bg min-h-screen">
      <OfflineBanner />
      <aside
        className={`hidden lg:flex fixed left-0 top-0 h-screen border-r border-gray-800/80 bg-gray-950/95 backdrop-blur-2xl z-50 shadow-[18px_0_40px_-34px_rgba(0,0,0,0.95)] transition-[width] duration-300 overflow-visible ${
          desktopSidebarExpanded ? "w-[20rem]" : "w-[4.5rem]"
        }`}
      >
        {/* Left Icon Rail */}
        <div className="w-[4.5rem] border-r border-gray-800/80 px-2 py-4 flex flex-col items-center justify-between h-full flex-shrink-0">
          <div className="w-full flex flex-col items-center">
            {/* Traffic Dots */}
            <div className="flex items-center gap-1.5 pb-3">
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/90" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/90" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/90" />
            </div>

            {/* Row 0: Logo (Height matches Header card: 48px) */}
            <Tooltip content="Open dashboard" placement="right" delay={150}>
              <Link to="/dashboard" className="mb-2 group">
                <div className="w-11 h-12 rounded-xl bg-white/5 border border-gray-700/70 flex items-center justify-center shadow-lg shadow-purple-950/40 group-hover:border-purple-600/60 transition-colors">
                  <BrandLogo className="w-7 h-7" />
                </div>
              </Link>
            </Tooltip>

            {/* Row 1: Status & Notification Center Icon (Height matches Status chip: 38px) */}
            <Tooltip
              content={
                activeRelayCount > 0
                  ? `${activeRelayCount} async relay(s) in progress`
                  : notificationBadgeCount > 0
                  ? `Notifications (${notificationBadgeCount})`
                  : !isConnected
                  ? "Notification Center (Disconnected)"
                  : "Notification Center"
              }
              placement="right"
              delay={150}
            >
              <button
                type="button"
                aria-label="Open notifications"
                aria-haspopup="dialog"
                aria-expanded={notificationDrawerOpen}
                onClick={handleOpenNotificationCenter}
                className="mb-3 w-11 h-[38px] rounded-xl border border-purple-900/40 bg-purple-950/20 flex items-center justify-center text-purple-300 transition-colors hover:border-purple-600/50"
              >
                <div className="relative flex items-center justify-center">
                  <FiBell
                    className={`text-[15px] ${
                      notificationBadgeCount > 0
                        ? "text-brand-300"
                        : isConnected
                        ? "text-purple-300"
                        : "text-gray-400"
                    }`}
                  />
                  {notificationBadgeCount > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 w-2 h-2 rounded-full bg-brand-500 animate-pulse" />
                  )}
                </div>
              </button>
            </Tooltip>

            {/* Rows 2-9: Navigation Icons (Aligned pixel-for-pixel with right panel items) */}
            <nav className="w-full space-y-1.5">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.path);
                return (
                  <Tooltip
                    key={`rail-tooltip-${item.path}`}
                    content={item.label}
                    placement="right"
                    delay={120}
                  >
                    <Link
                      key={`rail-${item.path}`}
                      to={item.path}
                      className={`mx-auto flex h-11 w-11 items-center justify-center rounded-xl border transition-all ${
                        active
                          ? "bg-gradient-to-r from-purple-700/25 to-indigo-600/25 border-purple-500/60 text-purple-300 shadow-[0_4px_16px_-6px_rgba(147,51,234,0.7)]"
                          : "border-transparent text-gray-500 hover:text-gray-200 hover:border-gray-700/70 hover:bg-gray-900/80"
                      }`}
                    >
                      <Icon className="text-[17px]" />
                    </Link>
                  </Tooltip>
                );
              })}
            </nav>
          </div>

          {/* Bottom Actions: Create Vault & Profile Avatar */}
          <div className="w-full space-y-2 border-t border-gray-800/70 pt-2 flex flex-col items-center">
            <Tooltip content="Create access vault" placement="right" delay={120}>
              <Button
                isIconOnly
                onPress={handleCreateVault}
                isDisabled={!canCreateVault}
                className={`mx-auto w-11 h-11 min-w-11 rounded-xl border ${
                  canCreateVault
                    ? "border-purple-600/50 bg-purple-700/20 text-purple-300 hover:bg-purple-700/30 shadow-[0_4px_14px_-6px_rgba(147,51,234,0.6)]"
                    : "border-gray-800/80 bg-gray-900/55 text-gray-600"
                }`}
                aria-label="Create access vault"
              >
                <FiPlus className="text-[17px]" />
              </Button>
            </Tooltip>

            <Tooltip
              content={isConnected ? displayName : "Connect Wallet"}
              placement="right"
              delay={120}
            >
              <Link
                to="/profile"
                className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-700 to-indigo-900 flex items-center justify-center text-white text-xs font-bold border border-purple-500/40 shadow-md"
              >
                {account ? account.substring(0, 2).toUpperCase() : <FiUser className="text-[16px]" />}
              </Link>
            </Tooltip>
          </div>
        </div>

        {/* Right Expanded Panel (aligned row-for-row with the Left Rail) */}
        {desktopSidebarExpanded && (
          <div className="flex-1 min-w-0 p-3 flex flex-col justify-between h-full">
            <div>
              {/* Row 0: App Title Header & Collapse Button (Height: 48px) */}
              <div className="h-12 mb-2 flex items-center gap-2">
                <div className="flex-1 min-w-0 h-12 rounded-xl border border-gray-800/80 bg-gray-900/60 px-3 flex flex-col justify-center">
                  <p className="text-sm font-bold truncate text-white">SpooVault</p>
                  <p className="text-[11px] text-purple-300/80 font-medium truncate">
                    Stellar Soroban Custody
                  </p>
                </div>
                <button
                  type="button"
                  onClick={toggleDesktopSidebar}
                  className="h-12 w-10 flex-shrink-0 inline-flex items-center justify-center rounded-xl border border-gray-700/80 bg-gray-900/85 text-gray-300 hover:border-gray-500 hover:text-white transition-colors"
                  aria-label="Collapse sidebar"
                >
                  <FiChevronLeft className="text-[16px]" />
                </button>
              </div>

              {/* Row 1: Network Badge & Approval Queue (Height: 38px) */}
              <div className="h-[38px] mb-3 flex items-center gap-2">
                <div className="flex-1 min-w-0 h-full rounded-xl border border-purple-900/40 bg-purple-950/20 px-2.5 flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      !isConnected
                        ? "bg-gray-500"
                        : "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                    }`}
                  />
                  <p className="text-[11px] font-semibold truncate text-purple-200">
                    {!isConnected ? "Freighter Disconnected" : "Stellar Testnet"}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Open notifications"
                  aria-haspopup="dialog"
                  aria-expanded={notificationDrawerOpen}
                  onClick={handleOpenNotificationCenter}
                  className={`h-full px-2.5 rounded-xl border flex items-center gap-1.5 transition-colors text-xs font-medium flex-shrink-0 ${
                    notificationBadgeCount > 0
                      ? "border-purple-600/50 bg-purple-700/20 text-purple-200"
                      : "border-gray-800/80 bg-gray-900/65 text-gray-400 hover:bg-gray-900/85"
                  }`}
                >
                  <FiBell className="text-[13px]" />
                  <span>{notificationBadgeCount}</span>
                </button>
              </div>

              {/* Rows 2-9: Navigation Links (Height: 44px each, space-y-1.5, matching left rail) */}
              <nav className="space-y-1.5">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.path);
                  return (
                    <Link
                      key={`panel-${item.path}`}
                      to={item.path}
                      className={`h-11 flex items-center gap-3 rounded-xl border px-3 transition-all ${
                        active
                          ? "border-purple-500/50 bg-gradient-to-r from-purple-700/20 to-indigo-600/15 text-white font-semibold shadow-[0_2px_10px_-4px_rgba(147,51,234,0.5)]"
                          : "border-transparent text-gray-400 hover:text-gray-100 hover:border-gray-800/80 hover:bg-gray-900/70"
                      }`}
                    >
                      <Icon
                        className={`text-base ${
                          active ? "text-purple-300" : "text-gray-500"
                        }`}
                      />
                      <span className="text-sm font-medium">{item.label}</span>
                    </Link>
                  );
                })}
              </nav>
            </div>

            {/* Bottom Actions: Create Vault & User Profile Card */}
            <div className="pt-2 border-t border-gray-800/70 space-y-2">
              <Button
                onPress={handleCreateVault}
                isDisabled={!canCreateVault}
                className={
                  canCreateVault
                    ? `w-full h-11 ${buttonClasses.primarySm} shadow-md`
                    : "w-full h-11 rounded-xl border border-gray-800/80 bg-gray-900/70 text-gray-500 text-xs font-medium"
                }
                startContent={<FiPlus className="text-base" />}
              >
                Create Access Vault
              </Button>

              {isConnected ? (
                <div className="flex items-center gap-2.5 rounded-xl border border-gray-800/80 bg-gray-900/70 p-2">
                  <Avatar
                    className="bg-gradient-to-br from-purple-700 to-indigo-900 flex-shrink-0 text-xs font-bold"
                    name={nickname || account?.substring(2, 6)}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold truncate text-gray-200">
                      {displayName}
                    </p>
                    <p className="text-[10px] text-gray-500 font-mono truncate">
                      {shortenAddress(account || "", 4)}
                    </p>
                  </div>
                  <div className="relative" ref={desktopMenuRef}>
                    <Button
                      isIconOnly
                      variant="light"
                      size="sm"
                      className="text-gray-400 hover:text-white"
                      onPress={() => {
                        setDesktopMenuOpen((open) => !open);
                      }}
                      aria-label="Open profile menu"
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

      {/* Mobile Top Header */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-40 border-b border-gray-800/80 bg-gray-950/92 backdrop-blur-2xl">
        <div className="h-16 px-3.5 flex items-center justify-between gap-2">
          {/* Left: Hamburger menu toggle + Brand Logo */}
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              aria-label="Open navigation menu"
              onClick={() => setMobileDrawerOpen(true)}
              className="w-10 h-10 rounded-xl border border-gray-800 bg-gray-900/80 flex items-center justify-center text-gray-300 hover:text-white hover:border-gray-700 transition-colors flex-shrink-0"
            >
              <FiMenu className="text-[18px]" />
            </button>
            <Link
              to="/dashboard"
              className="min-w-0 flex items-center gap-2 overflow-hidden"
            >
              <div className="w-8 h-8 rounded-xl bg-white/5 border border-purple-500/30 flex items-center justify-center shadow-lg shadow-purple-900/30 flex-shrink-0">
                <BrandLogo className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-bold leading-none text-white truncate">
                  SpooVault
                </p>
                <p className="text-[10px] text-purple-400 font-mono mt-0.5 truncate">
                  SOROBAN CUSTODY
                </p>
              </div>
            </Link>
          </div>

          {/* Right: Notifications + Wallet Pill */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              aria-label="Open notifications"
              aria-haspopup="dialog"
              aria-expanded={notificationDrawerOpen}
              onClick={handleOpenNotificationCenter}
              className={`relative w-9 h-9 rounded-xl border text-gray-300 flex items-center justify-center transition-colors ${
                notificationBadgeCount > 0
                  ? "border-brand-700/60 bg-brand-700/12 text-brand-300 shadow-[0_10px_20px_-16px_rgba(185,28,28,0.9)]"
                  : "border-gray-700/75 bg-gray-900/75 hover:border-gray-600 hover:text-gray-100"
              }`}
            >
              <FiBell
                className={`text-[14px] ${
                  notificationBadgeCount > 0 ? "text-brand-300" : ""
                }`}
              />
              {notificationBadgeCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[1rem] h-4 px-1 rounded-full bg-brand-700 text-[10px] font-semibold text-white leading-none inline-flex items-center justify-center">
                  {notificationBadgeCount > 9 ? "9+" : notificationBadgeCount}
                </span>
              )}
            </button>

            {!isConnected ? (
              <Button
                size="sm"
                onClick={openConnectModal}
                className="h-9 px-3 rounded-xl font-bold text-xs bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md shadow-purple-900/40"
              >
                Connect
              </Button>
            ) : (
              <button
                type="button"
                onClick={() => setMobileDrawerOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-gray-700/80 bg-gray-900/80 text-xs text-gray-200 hover:border-purple-500/60 transition-colors"
              >
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                <span className="font-mono text-[11px]">
                  {account ? shortenAddress(account) : "Connected"}
                </span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Mobile Off-Canvas Sliding Drawer Backdrop */}
      {mobileDrawerOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-black/80 backdrop-blur-sm transition-opacity"
          onClick={() => setMobileDrawerOpen(false)}
        />
      )}

      {/* Mobile Off-Canvas Sliding Drawer */}
      <aside
        className={`lg:hidden fixed inset-y-0 left-0 z-50 w-[84vw] max-w-[320px] bg-gray-950 border-r border-gray-800 p-5 flex flex-col justify-between shadow-2xl transition-transform duration-300 ease-in-out ${
          mobileDrawerOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Mobile navigation drawer"
      >
        <div className="flex flex-col h-full overflow-y-auto">
          {/* Drawer Header */}
          <div className="flex items-center justify-between pb-4 border-b border-gray-800/80">
            <Link
              to="/dashboard"
              onClick={() => setMobileDrawerOpen(false)}
              className="flex items-center gap-2.5"
            >
              <div className="w-9 h-9 rounded-xl bg-white/5 border border-purple-500/40 flex items-center justify-center shadow-lg shadow-purple-950/50">
                <BrandLogo className="w-5 h-5" />
              </div>
              <div>
                <p className="text-base font-bold text-white leading-none">SpooVault</p>
                <p className="text-[10px] text-purple-400 font-mono mt-1">
                  STELLAR // SOROBAN
                </p>
              </div>
            </Link>
            <button
              type="button"
              aria-label="Close navigation drawer"
              onClick={() => setMobileDrawerOpen(false)}
              className="w-9 h-9 rounded-xl border border-gray-800 bg-gray-900/60 flex items-center justify-center text-gray-400 hover:text-white transition-colors"
            >
              <FiX className="text-lg" />
            </button>
          </div>

          {/* Connected User / Account Badge */}
          <div className="mt-4 p-3 rounded-2xl border border-gray-800/90 bg-gray-900/40">
            {isConnected ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <Avatar
                      className="w-7 h-7 bg-gradient-to-br from-brand-700 to-brand-900 text-xs"
                      name={nickname || account?.substring(2, 6)}
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-white truncate">
                        {nickname || (account ? shortenAddress(account) : "Connected")}
                      </p>
                      <p className="text-[10px] text-gray-400 font-mono truncate">
                        {account ? `${account.slice(0, 10)}...` : ""}
                      </p>
                    </div>
                  </div>
                  <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-500/30">
                    {walletType === "demo" ? "DEMO" : walletType === "albedo" ? "ALBEDO" : "FREIGHTER"}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-center py-1">
                <p className="text-xs text-gray-400 mb-2">No wallet connected</p>
                <Button
                  size="sm"
                  onClick={() => {
                    setMobileDrawerOpen(false);
                    openConnectModal();
                  }}
                  className="w-full h-8 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs"
                >
                  Connect Wallet
                </Button>
              </div>
            )}
          </div>

          {/* Navigation Links */}
          <nav className="mt-4 space-y-1 flex-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);
              return (
                <Link
                  key={`drawer-${item.path}`}
                  to={item.path}
                  onClick={() => setMobileDrawerOpen(false)}
                  className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    active
                      ? "bg-purple-600/15 border border-purple-500/40 text-purple-200 shadow-sm"
                      : "text-gray-400 hover:text-gray-100 hover:bg-gray-900/60"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Icon className={`text-base ${active ? "text-purple-400" : "text-gray-400"}`} />
                    <span>{item.label}</span>
                  </div>
                  {active && (
                    <span className="w-1.5 h-1.5 rounded-full bg-purple-400 shadow-[0_0_8px_rgba(168,85,247,0.8)]" />
                  )}
                </Link>
              );
            })}
          </nav>

          {/* Drawer Footer Actions */}
          <div className="pt-4 mt-4 border-t border-gray-800/80 space-y-2">
            {isConnected && (
              <button
                type="button"
                onClick={() => {
                  disconnect({ notify: true });
                  setMobileDrawerOpen(false);
                }}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-xl border border-red-900/40 bg-red-950/20 text-red-300 text-xs font-semibold hover:bg-red-950/40 transition-colors"
              >
                <FiLogOut className="text-sm" />
                <span>Disconnect Wallet</span>
              </button>
            )}

            <div className="flex items-center justify-between text-[11px] text-gray-500 px-1 pt-1 font-mono">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>Testnet Live</span>
              </span>
              <span>v1.0.0</span>
            </div>
          </div>
        </div>
      </aside>

      <main
        className={`min-h-screen pt-20 pb-8 lg:pt-0 lg:pb-0 transition-[margin] duration-300 ${
          desktopSidebarExpanded ? "lg:ml-[20rem]" : "lg:ml-[4.5rem]"
        }`}
      >
        <div className="p-4 lg:p-8">
          <div className="max-w-7xl mx-auto">
            <Outlet />
          </div>
        </div>
      </main>

      <RelayNotificationDrawer
        triggerRef={lastBellTriggerRef}
        pendingApprovalCount={pendingApprovalCount}
        onOpenApprovalQueue={openApprovalQueue}
      />
    </div>
  );
};

export default AppLayout;

import { UIEvent, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import {
  FiArrowRight,
  FiShield,
  FiLock,
  FiMenu,
  FiX,
  FiCheckCircle,
  FiFileText,
  FiKey,
  FiPlay,
} from "react-icons/fi";
import { Link } from "react-router-dom";
import { getCurrentYear } from "../utils/helpers";
import { buttonClasses } from "../utils/buttonClasses";
import BrandLogo from "../components/BrandLogo";

const HEADLINE_TYPING_TEXT = "Live and Beyond";
type MobileSliderKey = "kpi" | "workflow" | "features";

const ecosystemCards = [
  {
    id: "avalanche",
    name: "Avalanche",
    badge: "VERIFIED ON AVALANCHE",
    badgeColor: "text-rose-400 border-rose-500/40 bg-rose-500/20",
    title: "SpooVault",
    cardNumber: "#AVAX-43114",
    subtitle: "AVALANCHE C-CHAIN VAULT",
    detailsTag: "AVALANCHE // MULTI-SIG KEY SHARE",
    serial: "43114 of 50,000",
    passName: "C-Chain Access Pass",
    gradient: "from-purple-950 via-rose-900/60 to-black/95",
    glowColor: "rgba(225, 29, 72, 0.4)",
    iconSymbol: "🔺",
  },
  {
    id: "stellar",
    name: "Stellar",
    badge: "VERIFIED ON STELLAR",
    badgeColor: "text-cyan-300 border-cyan-400/40 bg-cyan-500/20",
    title: "SpooVault",
    cardNumber: "#XLM-1001",
    subtitle: "STELLAR SECRET KEY VAULT",
    detailsTag: "STELLAR // ED25519 ENCRYPTED",
    serial: "1001 of 50,000",
    passName: "Stellar Key Pass",
    gradient: "from-blue-950 via-indigo-900/60 to-black/95",
    glowColor: "rgba(56, 189, 248, 0.4)",
    iconSymbol: "🚀",
  },
  {
    id: "soroban",
    name: "Soroban",
    badge: "POWERED BY SOROBAN",
    badgeColor: "text-emerald-300 border-emerald-400/40 bg-emerald-500/20",
    title: "SpooVault",
    cardNumber: "#SOROBAN-302",
    subtitle: "SOROBAN SMART CONTRACT VAULT",
    detailsTag: "SOROBAN // WASM AUTO-INHERIT",
    serial: "302 of 50,000",
    passName: "Soroban Contract Pass",
    gradient: "from-emerald-950 via-teal-900/60 to-black/95",
    glowColor: "rgba(52, 211, 153, 0.4)",
    iconSymbol: "⚡",
  },
];

const LandingPage = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [activeNav, setActiveNav] = useState("#hero");
  const [showSplash, setShowSplash] = useState(true);
  const [isHeaderElevated, setIsHeaderElevated] = useState(false);
  const [activeCardIdx, setActiveCardIdx] = useState(0);
  const [activeMobileSlide, setActiveMobileSlide] = useState<
    Record<MobileSliderKey, number>
  >({
    kpi: 0,
    workflow: 0,
    features: 0,
  });

  useEffect(() => {
    if (showSplash) return;
    const timer = window.setInterval(() => {
      setActiveCardIdx((prev) => (prev + 1) % ecosystemCards.length);
    }, 3800);
    return () => window.clearInterval(timer);
  }, [showSplash]);
  const landingVariantClass = (() => {
    const param = new URLSearchParams(window.location.search).get("lp");
    if (param === "1") return "landing-variant-01";
    if (param === "3") return "landing-variant-03";
    return "landing-variant-02";
  })();
  const [typedHeadline, setTypedHeadline] = useState("");
  const [isTypingComplete, setIsTypingComplete] = useState(false);
  const sliderRafRef = useRef<Partial<Record<MobileSliderKey, number>>>({});
  const lastKpiInteractionRef = useRef(0);
  const kpiSliderRef = useRef<HTMLDivElement | null>(null);
  const workflowSliderRef = useRef<HTMLDivElement | null>(null);
  const featureSliderRef = useRef<HTMLDivElement | null>(null);

  const navItems = [
    { label: "Overview", href: "#hero" },
    { label: "Features", href: "#features" },
    { label: "Workflow", href: "#workflow" },
    { label: "Security", href: "#security" },
  ];

  const featureCards = [
    {
      icon: <FiShield className="text-xl" />,
      title: "Access Guardians",
      description:
        "Assign trusted guardians and executors for each access vault.",
      points: [
        "Flexible approval thresholds",
        "On-chain audit events",
        "Emergency fallback coverage",
      ],
    },
    {
      icon: <FiLock className="text-xl" />,
      title: "Encrypted Vault Storage",
      description:
        "Sensitive family records are encrypted in-browser before upload.",
      points: [
        "Client-side AES encryption",
        "No plaintext exposure",
        "IPFS-backed retrieval",
      ],
    },
    {
      icon: <FiKey className="text-xl" />,
      title: "Access Passes",
      description:
        "ERC-721 passes define who can request or receive protected documents.",
      points: [
        "Mint to family or delegates",
        "Burn to revoke",
        "Wallet-native ownership",
      ],
    },
  ];

  const kpiCards = [
    { title: "AES-256", subtitle: "Client-side encryption" },
    { title: "Multi-Sig", subtitle: "Guardian approvals" },
    { title: "ERC-721", subtitle: "Beneficiary access passes" },
  ];

  const securityItems = [
    {
      icon: <FiCheckCircle className="text-brand-400" />,
      title: "No Plaintext Leakage",
      description:
        "Only encrypted metadata and content references are placed on-chain.",
    },
    {
      icon: <FiCheckCircle className="text-brand-400" />,
      title: "Theft-Resistant Control",
      description:
        "No single actor can unilaterally release protected documents.",
    },
    {
      icon: <FiCheckCircle className="text-brand-400" />,
      title: "Verifiable Release Trail",
      description:
        "Approval actions are recorded for legal and family-level accountability.",
    },
  ];

  const navButtonClass = `button-curve group ${buttonClasses.primarySm}`;
  const solidButtonClass = `button-curve group ${buttonClasses.primaryMd}`;

  const headerTabClass =
    "h-9 px-4 rounded-full text-[13px] sm:text-[14px] font-semibold transition-all duration-300 inline-flex items-center";

  const refreshSliderIndex = useCallback(
    (key: MobileSliderKey, track: HTMLDivElement | null) => {
      if (!track || window.innerWidth >= 768) return;

      const slides = Array.from(
        track.querySelectorAll<HTMLElement>("[data-slider-item]")
      );
      if (slides.length === 0) return;

      let nearestIndex = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;

      slides.forEach((slide, idx) => {
        const distance = Math.abs(slide.offsetLeft - track.scrollLeft);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = idx;
        }
      });

      setActiveMobileSlide((previous) =>
        previous[key] === nearestIndex
          ? previous
          : { ...previous, [key]: nearestIndex }
      );
    },
    []
  );

  const handleSliderScroll = useCallback(
    (key: MobileSliderKey) => (event: UIEvent<HTMLDivElement>) => {
      if (window.innerWidth >= 768) return;
      if (key === "kpi") {
        lastKpiInteractionRef.current = Date.now();
      }

      const existingRaf = sliderRafRef.current[key];
      if (typeof existingRaf === "number") {
        window.cancelAnimationFrame(existingRaf);
      }

      const track = event.currentTarget;
      sliderRafRef.current[key] = window.requestAnimationFrame(() => {
        refreshSliderIndex(key, track);
      });
    },
    [refreshSliderIndex]
  );

  const scrollSliderToIndex = useCallback(
    (key: MobileSliderKey, index: number) => {
      const track =
        key === "kpi"
          ? kpiSliderRef.current
          : key === "workflow"
          ? workflowSliderRef.current
          : featureSliderRef.current;
      if (!track) return;
      const slides = Array.from(
        track.querySelectorAll<HTMLElement>("[data-slider-item]")
      );
      const target = slides[index];
      if (!target) return;
      track.scrollTo({ left: target.offsetLeft, behavior: "smooth" });
      setActiveMobileSlide((previous) => ({ ...previous, [key]: index }));
      if (key === "kpi") {
        lastKpiInteractionRef.current = Date.now();
      }
    },
    []
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShowSplash(false);
    }, 1500);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const sectionIds = ["hero", "features", "workflow", "security"];
    const sections = sectionIds
      .map((id) => document.getElementById(id))
      .filter((section): section is HTMLElement => section !== null);

    const setFromHash = () => {
      if (window.location.hash) {
        setActiveNav(window.location.hash);
      }
    };

    setFromHash();

    if (sections.length === 0) {
      window.addEventListener("hashchange", setFromHash);
      return () => window.removeEventListener("hashchange", setFromHash);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

        if (visible?.target?.id) {
          setActiveNav(`#${visible.target.id}`);
        }
      },
      {
        threshold: [0.2, 0.35, 0.5, 0.7],
        rootMargin: "-28% 0px -46% 0px",
      }
    );

    sections.forEach((section) => observer.observe(section));
    window.addEventListener("hashchange", setFromHash);

    return () => {
      observer.disconnect();
      window.removeEventListener("hashchange", setFromHash);
    };
  }, []);

  useEffect(() => {
    if (showSplash) return;

    const revealTargets = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]")
    );

    if (revealTargets.length === 0) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    if (reducedMotion) {
      revealTargets.forEach((el) => el.classList.add("is-visible"));
      return;
    }

    revealTargets.forEach((el) => {
      const delay = Number(el.dataset.revealDelay || "0");
      el.style.setProperty("--reveal-delay", `${Math.max(delay, 0)}ms`);
    });

    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        });
      },
      {
        threshold: 0.16,
        rootMargin: "0px 0px -8% 0px",
      }
    );

    revealTargets.forEach((el) => revealObserver.observe(el));

    return () => revealObserver.disconnect();
  }, [showSplash]);

  useEffect(() => {
    if (showSplash) return;
    setTypedHeadline("");
    setIsTypingComplete(false);
  }, [showSplash]);

  useEffect(() => {
    if (showSplash) return;

    if (window.innerWidth < 768) {
      kpiSliderRef.current?.scrollTo({ left: 0, behavior: "auto" });
      workflowSliderRef.current?.scrollTo({ left: 0, behavior: "auto" });
      featureSliderRef.current?.scrollTo({ left: 0, behavior: "auto" });
      setActiveMobileSlide({ kpi: 0, workflow: 0, features: 0 });
    }

    const syncSliderState = () => {
      refreshSliderIndex("kpi", kpiSliderRef.current);
      refreshSliderIndex("workflow", workflowSliderRef.current);
      refreshSliderIndex("features", featureSliderRef.current);
    };

    syncSliderState();
    window.addEventListener("resize", syncSliderState);

    return () => {
      window.removeEventListener("resize", syncSliderState);
    };
  }, [showSplash, refreshSliderIndex]);

  useEffect(() => {
    return () => {
      Object.values(sliderRafRef.current).forEach((rafId) => {
        if (typeof rafId === "number") {
          window.cancelAnimationFrame(rafId);
        }
      });
    };
  }, []);

  useEffect(() => {
    if (showSplash || isTypingComplete) return;
    const isComplete = typedHeadline === HEADLINE_TYPING_TEXT;

    const timer = window.setTimeout(
      () => {
        if (isComplete) {
          setTypedHeadline(HEADLINE_TYPING_TEXT);
          setIsTypingComplete(true);
          return;
        }

        setTypedHeadline(
          HEADLINE_TYPING_TEXT.slice(0, typedHeadline.length + 1)
        );
      },
      isComplete ? 120 : 18
    );

    return () => window.clearTimeout(timer);
  }, [showSplash, isTypingComplete, typedHeadline]);

  useEffect(() => {
    if (showSplash) return;

    const interval = window.setInterval(() => {
      if (window.innerWidth >= 768) return;
      if (Date.now() - lastKpiInteractionRef.current < 2200) return;

      setActiveMobileSlide((previous) => {
        const nextKpi = (previous.kpi + 1) % kpiCards.length;
        scrollSliderToIndex("kpi", nextKpi);
        return { ...previous, kpi: nextKpi };
      });
    }, 3200);

    return () => window.clearInterval(interval);
  }, [showSplash, kpiCards.length, scrollSliderToIndex]);

  useEffect(() => {
    if (showSplash) return;

    const onScroll = () => {
      setIsHeaderElevated(window.scrollY > 10);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => window.removeEventListener("scroll", onScroll);
  }, [showSplash]);

  if (showSplash) {
    return (
      <div
        className={`landing-splash ${landingVariantClass} min-h-screen w-full max-w-[100vw] overflow-hidden bg-gradient-to-b from-[#040306] via-gray-950 to-[#040306] text-gray-100`}
      >
        <div className="landing-splash__bg">
          <div className="landing-splash__blur landing-splash__blur--top" />
          <div className="landing-splash__blur landing-splash__blur--left" />
          <div className="landing-splash__blur landing-splash__blur--right" />
        </div>

        <div className="landing-splash__content">
          <div className="landing-splash__orbit">
            <div className="landing-splash__ring landing-splash__ring--outer" />
            <div className="landing-splash__ring landing-splash__ring--mid" />
            <div className="landing-splash__ring landing-splash__ring--inner" />
            <div className="landing-splash__logo-shell">
              <BrandLogo className="landing-splash__logo" />
            </div>
          </div>
          <h1 className="landing-splash__title">SpooVault</h1>
          <p className="landing-splash__subtitle">
            Loading secure access on Avalanche
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`landing-page landing-web3 ${landingVariantClass} flex min-h-screen flex-col w-full max-w-[100vw] overflow-x-hidden bg-gradient-to-b from-[#040306] via-gray-950 to-[#040306] text-gray-100`}
    >
      <div className="absolute inset-0 -z-10 pointer-events-none overflow-hidden">
        <div className="landing-grid-overlay" />
        <div className="landing-scanline-overlay" />
        <div className="landing-web3-aurora landing-web3-aurora--top" />
        <div className="landing-web3-aurora landing-web3-aurora--mid" />
        <div className="landing-web3-aurora landing-web3-aurora--bottom" />
      </div>

      {isMenuOpen && (
        <button
          type="button"
          aria-label="Close navigation menu"
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px] md:hidden"
          onClick={() => setIsMenuOpen(false)}
        />
      )}

      <div
        className={`landing-fixed-top md:hidden fixed inset-x-3 top-4 z-50 mx-auto max-w-[30rem]${
          isHeaderElevated ? " is-elevated" : ""
        }`}
      >
        <div className="relative">
          <div
            className={`landing-mobile-header-bar w-full h-[4.5rem] rounded-2xl transition-all duration-300 px-4 flex items-center gap-3 ${
              isHeaderElevated
                ? "border border-white/15 bg-gray-950/92 backdrop-blur-2xl shadow-2xl shadow-black/90"
                : "bg-transparent border-none"
            }`}
          >
            <Link
              to="/"
              className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden"
              onClick={() => setIsMenuOpen(false)}
            >
              <div className="w-9 h-9 rounded-xl bg-white/5 flex items-center justify-center flex-shrink-0">
                <BrandLogo className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h1 className="text-[15px] font-bold leading-none truncate">
                  SpooVault
                </h1>
              </div>
            </Link>
            <button
              type="button"
              aria-label="Toggle navigation menu"
              className="w-10 h-10 rounded-xl bg-white/5 text-gray-200 flex items-center justify-center flex-shrink-0"
              onClick={() => setIsMenuOpen((prev) => !prev)}
            >
              {isMenuOpen ? <FiX size={22} /> : <FiMenu size={22} />}
            </button>
          </div>

          <div
            className={`overflow-hidden transition-all duration-300 ${
              isMenuOpen
                ? "max-h-[420px] opacity-100 mt-2"
                : "max-h-0 opacity-0 mt-0"
            }`}
          >
            <div className="landing-mobile-menu-panel w-full rounded-2xl border border-white/10 bg-gray-950/95 backdrop-blur-2xl p-2 shadow-2xl">
              <nav className="space-y-1">
                {navItems.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    onClick={() => {
                      setActiveNav(item.href);
                      setIsMenuOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-xl px-3 py-3 text-sm font-medium transition-colors ${
                      activeNav === item.href
                        ? "bg-white/15 text-white font-bold"
                        : "text-gray-300 hover:bg-gray-800/60 hover:text-white"
                    }`}
                  >
                    <span>{item.label}</span>
                  </a>
                ))}
              </nav>
              <div className="pt-2">
                <Link
                  to="/dashboard"
                  className="block w-full"
                  onClick={() => setIsMenuOpen(false)}
                >
                  <Button
                    className={`w-full ${navButtonClass}`}
                    endContent={
                      <FiArrowRight className="text-[18px] transition-transform duration-300 group-hover:translate-x-1" />
                    }
                  >
                    Launch App
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Floating Shoot-Out Desktop Header Navbar */}
      <header
        className={`hidden md:block fixed inset-x-0 top-0 z-50 transition-all duration-300 pointer-events-none ${
          isHeaderElevated ? "pt-3 px-4 sm:px-6 lg:px-8" : "pt-5 px-6 lg:px-8"
        }`}
      >
        <div
          className={`mx-auto pointer-events-auto transition-all duration-300 ${
            isHeaderElevated
              ? "max-w-6xl rounded-2xl border border-white/15 bg-gray-950/92 backdrop-blur-2xl shadow-2xl shadow-black/90 px-6 py-2.5"
              : "max-w-7xl bg-transparent border-none px-2 py-2"
          }`}
        >
          <div className="flex items-center justify-between gap-4 h-12">
            <Link to="/" className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center shadow-lg shadow-brand-900/20">
                <BrandLogo className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
                  SpooVault
                </h1>
                <p className="text-[11px] text-gray-400">
                  Stellar & Avalanche Access Vault
                </p>
              </div>
            </Link>

            <nav className="hidden lg:flex items-center gap-1 rounded-full bg-white/5 p-1.5 backdrop-blur-xl">
              {navItems.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  onClick={() => setActiveNav(item.href)}
                  className={`${headerTabClass} ${
                    activeNav === item.href
                      ? "bg-white/15 text-white font-bold rounded-full"
                      : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
                  }`}
                >
                  {item.label}
                </a>
              ))}
            </nav>

            <div className="flex items-center gap-3">
              <Link to="/dashboard">
                <Button
                  className={navButtonClass}
                  endContent={
                    <FiArrowRight className="text-[16px] transition-transform duration-300 group-hover:translate-x-1" />
                  }
                >
                  Launch App
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <div className="landing-main-fade flex-1">
        <div className="h-[96px] sm:h-[104px]" aria-hidden="true" />

        <section
          id="hero"
          className="landing-section relative px-4 sm:px-6 lg:px-8 pt-8 sm:pt-12 pb-16 sm:pb-24 overflow-hidden"
        >
          <div className="landing-hero-stage">
            <div className="landing-hero-world-globe" />
            <div className="landing-hero-beam" />

            <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-10 lg:gap-14 items-center">
              {/* Left Copy & Actions */}
              <div
                className="landing-hero-copy reveal-on-scroll"
                data-reveal
                data-reveal-delay="40"
              >
                <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black leading-[1.1] tracking-tight text-white">
                  Decentralized
                  <br />
                  <span className="text-transparent bg-clip-text bg-gradient-to-r from-rose-400 via-purple-300 to-pink-500">
                    Key Share Vault
                  </span>
                  <br />& Inheritance Protocol
                </h1>

                <p className="landing-hero-description mt-6 text-base sm:text-lg text-gray-300 max-w-xl leading-relaxed">
                  Encrypt and store private keys, seed phrases, and confidential
                  family records across Avalanche, Stellar, and Soroban with
                  multi-guardian dead man's switch security.
                </p>

                <div className="landing-hero-actions mt-8 flex flex-wrap items-center gap-4">
                  <Link to="/dashboard">
                    <button className="h-12 px-8 rounded-full bg-white text-gray-950 font-bold text-sm tracking-wide transition-all duration-300 hover:bg-gray-200 hover:scale-105 shadow-lg shadow-white/10 flex items-center gap-2">
                      <span>Explore</span>
                      <FiArrowRight className="text-base" />
                    </button>
                  </Link>

                  <a href="#video">
                    <button className="h-12 px-7 rounded-full border border-gray-700 bg-gray-900/60 text-gray-200 font-semibold text-sm tracking-wide transition-all duration-300 hover:border-gray-500 hover:bg-gray-800 flex items-center gap-2.5">
                      <div className="w-6 h-6 rounded-full border border-gray-400/80 flex items-center justify-center text-[10px] pl-0.5">
                        ▶
                      </div>
                      <span>Learn More</span>
                    </button>
                  </a>
                </div>

                {/* Product Metrics Row (Borderless) */}
                <div className="mt-14 pt-8 grid grid-cols-3 gap-6">
                  <div>
                    <p className="text-2xl sm:text-3xl font-black text-white tracking-tight">
                      35K+
                    </p>
                    <p className="text-xs sm:text-sm text-gray-400 font-medium mt-1">
                      Key Shares Encrypted
                    </p>
                  </div>
                  <div>
                    <p className="text-2xl sm:text-3xl font-black text-white tracking-tight">
                      17K+
                    </p>
                    <p className="text-xs sm:text-sm text-gray-400 font-medium mt-1">
                      Active Access Vaults
                    </p>
                  </div>
                  <div>
                    <p className="text-2xl sm:text-3xl font-black text-white tracking-tight">
                      2.4K+
                    </p>
                    <p className="text-xs sm:text-sm text-gray-400 font-medium mt-1">
                      Multi-Sig Guardians
                    </p>
                  </div>
                </div>
              </div>

              {/* Right Side: Animated Dynamic Ecosystem 3D Glass Cards Stack */}
              <div className="slab-stage hidden sm:block">
                <div className="slab-card-stack">
                  {/* Background Backing Slab Left */}
                  <div className="slab-glass-card slab-glass-card--back-left">
                    <div className="p-3">
                      <div className="w-full h-56 rounded-xl bg-gradient-to-br from-purple-900/60 via-rose-950/40 to-black overflow-hidden flex items-center justify-center">
                        <BrandLogo className="w-24 h-24 opacity-40 blur-[1px]" />
                      </div>
                      <div className="mt-4 px-2">
                        <p className="text-[10px] text-gray-400 font-mono">
                          STELLAR // ED25519 PASS
                        </p>
                        <p className="text-lg font-bold text-white mt-1">
                          SpooVault XLM //
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Background Backing Slab Right */}
                  <div className="slab-glass-card slab-glass-card--back-right">
                    <div className="p-3">
                      <div className="w-full h-56 rounded-xl bg-gradient-to-br from-emerald-900/60 via-teal-950/40 to-black overflow-hidden flex items-center justify-center">
                        <BrandLogo className="w-24 h-24 opacity-40 blur-[1px]" />
                      </div>
                      <div className="mt-4 px-2">
                        <p className="text-[10px] text-gray-400 font-mono">
                          SOROBAN // WASM PASS
                        </p>
                        <p className="text-lg font-bold text-white mt-1">
                          SpooVault Soroban //
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Main Dynamic Foreground Hero Slab */}
                  {(() => {
                    const currentCard = ecosystemCards[activeCardIdx];
                    return (
                      <div
                        key={currentCard.id}
                        className="slab-glass-card slab-glass-card--front transition-all duration-700 ease-out transform"
                        style={{
                          boxShadow: `0 40px 80px -20px rgba(0,0,0,0.95), 0 0 45px ${currentCard.glowColor}`,
                        }}
                      >
                        <div className="slab-card-inner">
                          <div className="slab-card-art">
                            <div
                              className={`absolute inset-0 bg-gradient-to-b ${currentCard.gradient} flex flex-col items-center justify-center p-6 text-center transition-all duration-700`}
                            >
                              <div className="w-20 h-20 rounded-2xl bg-white/10 backdrop-blur-md border border-white/20 flex items-center justify-center shadow-xl mb-3 relative">
                                <BrandLogo className="w-12 h-12" />
                                <span className="absolute -top-1 -right-1 text-sm">
                                  {currentCard.iconSymbol}
                                </span>
                              </div>
                              <span
                                className={`px-3 py-1 rounded-full border text-[11px] font-bold uppercase tracking-wider transition-all duration-500 ${currentCard.badgeColor}`}
                              >
                                {currentCard.passName}
                              </span>
                            </div>
                          </div>

                          <div className="slab-card-details">
                            <p className="text-[10px] font-mono text-gray-400 tracking-wider transition-all duration-300">
                              {currentCard.detailsTag}
                            </p>

                            <div className="mt-2 flex items-center justify-between">
                              <div>
                                <h3 className="text-2xl font-black text-white tracking-tight">
                                  {currentCard.title}
                                </h3>
                                <p className="text-xl font-bold text-gray-200">
                                  {currentCard.cardNumber}
                                </p>
                              </div>

                              <div className="flex items-center gap-3">
                                <span className="text-2xl font-mono text-gray-400 font-bold">
                                  //
                                </span>
                                <div className="w-12 h-12 rounded-lg bg-white p-1 flex items-center justify-center shadow-md">
                                  <svg
                                    viewBox="0 0 24 24"
                                    className="w-full h-full text-gray-950 fill-current"
                                  >
                                    <path d="M2 2h8v8H2V2zm2 2v4h4V4H4zm11-2h7v7h-7V2zm2 2v3h3V4h-3zM2 15h7v7H2v-7zm2 2v3h3v-3H4zm13-2h3v3h-3v-3zm0 4h5v3h-5v-3zm-4-4h2v7h-2v-7zm0-4h4v2h-4v-2z" />
                                  </svg>
                                </div>
                              </div>
                            </div>

                            <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between text-[10px] text-gray-400 font-mono">
                              <span>{currentCard.serial}</span>
                              <span
                                className={`font-bold ${
                                  currentCard.badgeColor.split(" ")[0]
                                }`}
                              >
                                {currentCard.badge}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Ecosystem Selector Buttons */}
                <div className="mt-5 flex items-center justify-center gap-2 relative z-20">
                  {ecosystemCards.map((card, idx) => (
                    <button
                      key={card.id}
                      type="button"
                      onClick={() => setActiveCardIdx(idx)}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all duration-300 flex items-center gap-1.5 ${
                        activeCardIdx === idx
                          ? "bg-white/15 text-white border border-white/30 shadow-lg scale-105"
                          : "bg-white/5 text-gray-400 border border-transparent hover:text-white hover:bg-white/10"
                      }`}
                    >
                      <span>{card.iconSymbol}</span>
                      <span>{card.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Video Overview Showcase Section */}
        <section
          id="video"
          className="landing-section px-4 sm:px-6 lg:px-8 py-16 sm:py-24 relative overflow-hidden border-t border-gray-800/40 bg-gray-950/20"
        >
          <div
            className="max-w-5xl mx-auto text-center reveal-on-scroll"
            data-reveal
            data-reveal-delay="30"
          >
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-purple-500/30 bg-purple-950/40 text-purple-300 text-xs font-semibold tracking-wide uppercase mb-4">
              <FiPlay className="text-xs text-rose-400" />
              <span>Product Overview & Walkthrough</span>
            </div>

            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-white tracking-tight">
              See How SpooVault Protects Your Digital Legacy
            </h2>
            <p className="mt-4 text-base sm:text-lg text-gray-300 max-w-2xl mx-auto leading-relaxed">
              Watch our step-by-step preview on how encrypted secret shares,
              multi-guardian consensus, and automated inheritance work
              seamlessly across Stellar and Avalanche.
            </p>

            {/* Video Player Showcase Container */}
            <div className="mt-10 relative rounded-3xl border border-gray-800/80 bg-gradient-to-b from-gray-900/90 via-gray-950 to-black/95 p-3 sm:p-5 shadow-2xl shadow-purple-950/30 overflow-hidden group">
              <div className="relative aspect-video w-full rounded-2xl overflow-hidden bg-gray-950 flex items-center justify-center border border-white/5">
                {/* Placeholder Ambient Background */}
                <div className="absolute inset-0 bg-gradient-to-tr from-purple-950/80 via-rose-950/40 to-gray-950 flex items-center justify-center">
                  <BrandLogo className="w-36 h-36 opacity-15 blur-sm" />
                </div>

                {/* Video Player Overlay Elements */}
                <div className="relative z-10 flex flex-col items-center justify-center p-6 text-center">
                  <div className="relative cursor-pointer group/btn">
                    <div className="absolute -inset-4 rounded-full bg-rose-500/30 blur-xl group-hover/btn:bg-rose-500/50 transition-all duration-300 animate-pulse" />
                    <button
                      type="button"
                      aria-label="Play SpooVault protocol overview video"
                      className="relative w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-gradient-to-r from-rose-500 to-purple-600 text-white flex items-center justify-center shadow-2xl transition-all duration-300 group-hover/btn:scale-110"
                    >
                      <FiPlay className="w-8 h-8 sm:w-10 sm:h-10 ml-1 fill-current" />
                    </button>
                  </div>

                  <h3 className="mt-6 text-lg sm:text-xl font-bold text-white">
                    SpooVault Protocol Video Walkthrough
                  </h3>
                  <p className="mt-1 text-xs sm:text-sm text-gray-400 font-mono">
                    [ Official Video Demo • Coming Soon ]
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section
          id="features"
          className="landing-section landing-feature-section px-4 sm:px-6 lg:px-8 py-12 sm:py-16 border-y border-gray-800/50 bg-gray-950/25"
        >
          <div className="max-w-7xl mx-auto">
            <div
              className="max-w-3xl reveal-on-scroll"
              data-reveal
              data-reveal-delay="20"
            >
              <p className="text-sm text-brand-400 font-medium tracking-wide">
                CORE CAPABILITIES
              </p>
              <h2 className="text-3xl sm:text-4xl font-bold mt-2">
                Infrastructure for Living and Inheritance Access
              </h2>
              <p className="text-gray-400 mt-4">
                Built to protect sensitive files, enforce approval policies, and
                provide a verifiable release history.
              </p>
            </div>

            <div
              ref={featureSliderRef}
              onScroll={handleSliderScroll("features")}
              className="mt-8 feature-card-track"
            >
              {featureCards.map((feature, idx) => (
                <div
                  key={feature.title}
                  data-slider-item
                  className={`feature-card-item landing-feature-card landing-card reveal-on-scroll rounded-3xl border border-gray-800 bg-gray-900/40 p-6 ${
                    activeMobileSlide.features === idx
                      ? "is-active-mobile-slide"
                      : ""
                  }`}
                  data-reveal
                  data-reveal-delay={String(70 + idx * 70)}
                >
                  <div className="w-11 h-11 rounded-xl bg-brand-700/20 border border-brand-700/30 flex items-center justify-center text-brand-300 mb-4">
                    {feature.icon}
                  </div>
                  <h3 className="text-xl font-semibold">{feature.title}</h3>
                  <p className="text-sm text-gray-400 mt-2">
                    {feature.description}
                  </p>
                  <div className="mt-4 space-y-2">
                    {feature.points.map((point) => (
                      <div
                        key={point}
                        className="flex items-center gap-2 text-sm text-gray-300"
                      >
                        <FiCheckCircle className="text-brand-500" />
                        <span>{point}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div
              className="mobile-slider-dots"
              aria-label="Feature slider progress"
            >
              {featureCards.map((feature, idx) => (
                <button
                  key={feature.title}
                  type="button"
                  aria-label={`Show ${feature.title} feature`}
                  onClick={() => scrollSliderToIndex("features", idx)}
                  className={`mobile-slider-dot${
                    activeMobileSlide.features === idx ? " is-active" : ""
                  }`}
                />
              ))}
            </div>
          </div>
        </section>

        <section
          id="workflow"
          className="landing-section px-4 sm:px-6 lg:px-8 py-12 sm:py-16"
        >
          <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-6 sm:gap-8 items-start">
            <div
              className="landing-card landing-workflow-card reveal-on-scroll rounded-3xl border border-gray-800 bg-gray-900/35 p-6 sm:p-8"
              data-reveal
              data-reveal-delay="30"
            >
              <p className="text-sm text-brand-400 font-medium">WORKFLOW</p>
              <h2 className="text-3xl font-bold mt-2">
                Built for Real Family Continuity
              </h2>
              <p className="text-gray-400 mt-3">
                Control access today, set emergency rules, and ensure the right
                people can retrieve files later.
              </p>

              <div className="mt-6 space-y-4">
                {[
                  "Create an access vault and assign trusted guardians/executors",
                  "Encrypt and upload sensitive family documents",
                  "Issue access passes for family or delegates",
                  "Approve release requests with threshold consensus when policy conditions are met",
                ].map((item, idx) => (
                  <div key={item} className="flex items-start gap-3">
                    <div className="w-7 h-7 mt-0.5 rounded-lg bg-brand-700/20 border border-brand-700/40 text-brand-300 text-xs font-semibold flex items-center justify-center">
                      {idx + 1}
                    </div>
                    <p className="text-sm sm:text-base text-gray-300">{item}</p>
                  </div>
                ))}
              </div>
            </div>

            <div
              id="security"
              className="landing-card landing-security-card reveal-on-scroll rounded-3xl border border-gray-800 bg-gray-900/35 p-6 sm:p-8"
              data-reveal
              data-reveal-delay="80"
            >
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-brand-700/20 border border-brand-700/30 flex items-center justify-center text-brand-300">
                  <FiFileText className="text-xl" />
                </div>
                <div>
                  <p className="text-sm text-brand-400 font-medium">
                    SECURITY MODEL
                  </p>
                  <h3 className="text-2xl font-semibold">
                    Protection by Design
                  </h3>
                </div>
              </div>
              <div className="space-y-4">
                {securityItems.map((item, idx) => (
                  <div
                    key={item.title}
                    className="landing-card reveal-on-scroll rounded-2xl border border-gray-800 bg-gray-900/55 p-4"
                    data-reveal
                    data-reveal-delay={String(130 + idx * 60)}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5">{item.icon}</div>
                      <div>
                        <p className="font-medium">{item.title}</p>
                        <p className="text-sm text-gray-400 mt-1">
                          {item.description}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="landing-section px-4 sm:px-6 lg:px-8 pb-16 sm:pb-20">
          <div
            className="landing-card landing-cta-panel reveal-on-scroll max-w-5xl mx-auto rounded-3xl border border-gray-800 bg-gradient-to-r from-gray-900/80 to-gray-900/45 p-8 sm:p-10 text-center"
            data-reveal
            data-reveal-delay="20"
          >
            <p className="text-sm text-brand-400 font-medium">
              READY FOR REAL-WORLD USE
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold mt-2">
              Deploy a Theft-Resistant Access Platform
            </h2>
            <p className="text-gray-400 mt-3 max-w-2xl mx-auto">
              Start with access vault creation, encrypted storage, and
              policy-based release for both living and inheritance scenarios.
            </p>
            <div className="mt-7 flex flex-col sm:flex-row gap-3 justify-center">
              <span className="golden-button-orbit inline-flex w-full max-w-full sm:w-auto">
                <Link to="/dashboard" className="block w-full sm:w-auto">
                  <Button
                    className={`w-full sm:w-auto ${solidButtonClass}`}
                    endContent={
                      <FiArrowRight className="text-[16px] transition-transform duration-300 group-hover:translate-x-1" />
                    }
                  >
                    Open Access Dashboard
                  </Button>
                </Link>
              </span>
              <a href="#features" className="w-full sm:w-auto">
                <Button
                  className={`w-full sm:w-auto ${solidButtonClass}`}
                  endContent={
                    <FiArrowRight className="text-[16px] transition-transform duration-300 group-hover:translate-x-1" />
                  }
                >
                  Explore Capabilities
                </Button>
              </a>
            </div>
          </div>
        </section>
      </div>

      <footer className="landing-footer shrink-0 border-t border-gray-800/60 px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white/5 border border-gray-700/60 flex items-center justify-center">
              <BrandLogo className="w-4 h-4" />
            </div>
            <div>
              <p className="text-sm font-semibold">SpooVault</p>
              <p className="text-[11px] text-gray-500">
                Secure access vault on Avalanche
              </p>
            </div>
          </div>
          <p className="text-xs text-gray-500">
            {getCurrentYear()} SpooVault. Secure by default.
          </p>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;

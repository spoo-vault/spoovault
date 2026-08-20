import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import { ethers } from "ethers";
import { toast } from "react-hot-toast";
import { contractService } from "../services/contract.service";
import {
  stellarService,
  type StellarWalletChangeEvent,
} from "../services/stellar.service";

const CONTRACT_ABI = [
  "function createVault(string name, string description, address[] guardians, uint256 approvalThreshold) external returns (uint256)",
  "function acceptGuardianInvite(uint256 vaultId) external",
  "function addDocument(uint256 vaultId, string encryptedMetadata, string ipfsHash, uint8 requiredAccess) external returns (uint256)",
  "function requestAccess(uint256 documentId) external returns (uint256)",
  "function approveAccess(uint256 requestId) external",
  "function revokeAccess(uint256 documentId, address user) external",
  "function mintAccessToken(uint256 vaultId, address to, string tokenURI) external returns (uint256)",
  "function burnAccessToken(uint256 tokenId) external",
  "function getVault(uint256 vaultId) external view returns (uint256, address, string, string, address[], uint256, bool, uint256)",
  "function getPendingInvites(address user) external view returns (tuple(address guardian, uint256 vaultId, bool accepted, uint256 expiresAt)[])",
  "function balanceOf(address owner) external view returns (uint256)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "event VaultCreated(uint256 indexed vaultId, address indexed creator, string name)",
  "event GuardianAdded(uint256 indexed vaultId, address indexed guardian)",
  "event DocumentAdded(uint256 indexed documentId, uint256 indexed vaultId, string ipfsHash)",
  "event AccessRequested(uint256 indexed requestId, uint256 indexed documentId, address indexed requester)",
];

interface Web3ContextType {
  provider: ethers.BrowserProvider | null;
  signer: ethers.Signer | null;
  account: string | null;
  chainId: number | null;
  isConnected: boolean;
  isConnecting: boolean;
  contract: ethers.Contract | null;
  connect: () => Promise<void>;
  disconnect: (options?: { notify?: boolean }) => void;
  switchToFuji: () => Promise<void>;
  isFujiNetwork: boolean;
  ecosystem: "avalanche" | "stellar";
  setEcosystem: (eco: "avalanche" | "stellar") => void;
  stellarNetwork: string | null;
}

const Web3Context = createContext<Web3ContextType | undefined>(undefined);

export const Web3Provider = ({ children }: { children: ReactNode }) => {
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [contract, setContract] = useState<ethers.Contract | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [stellarNetwork, setStellarNetwork] = useState<string | null>(null);

  const [ecosystem, setEcosystemState] = useState<"avalanche" | "stellar">(() => {
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem("spoovault-ecosystem");
      if (stored === "stellar") return "stellar";
    }
    return "avalanche";
  });

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-ecosystem", ecosystem);
    }
  }, [ecosystem]);

  const setEcosystem = (eco: "avalanche" | "stellar") => {
    setEcosystemState(eco);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("spoovault-ecosystem", eco);
      document.documentElement.setAttribute("data-ecosystem", eco);
    }
    disconnect({ notify: false });
  };

  const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS;
  const FUJI_CHAIN_ID = 43113;
  const EXPECTED_STELLAR_NETWORK = "TESTNET";
  const validateStellarNetwork = useCallback((network?: string | null) => {
    if (!network) return;
    const normalized = String(network).toUpperCase();
    if (normalized !== EXPECTED_STELLAR_NETWORK) {
      toast.error(
        `Freighter is on the wrong network (${network}). Switch to Stellar Testnet to continue.`
      );
    }
  }, []);
  const isMobileDevice = (): boolean => {
    if (typeof navigator === "undefined") return false;
    return /Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(
      navigator.userAgent
    );
  };

  const getMetaMaskDeepLink = (): string => {
    if (typeof window === "undefined") return "https://metamask.app.link/";
    const dappUrl = `${window.location.host}${window.location.pathname}${window.location.search}${window.location.hash}`;
    return `https://metamask.app.link/dapp/${dappUrl}`;
  };

  const openWalletAppOrInstall = () => {
    if (isMobileDevice()) {
      const deepLink = getMetaMaskDeepLink();
      toast("Opening wallet app...");
      window.location.href = deepLink;
      return;
    }
    window.open("https://metamask.io/download/", "_blank");
  };

  const initContract = useCallback((signerOrProvider: ethers.Signer | ethers.Provider) => {
    if (!CONTRACT_ADDRESS) {
      toast.error("Contract address not configured");
      return null;
    }

    try {
      return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signerOrProvider);
    } catch (error) {
      console.error("Failed to initialize contract:", error);
      toast.error("Failed to initialize contract");
      return null;
    }
  }, [CONTRACT_ADDRESS]);

  const checkConnection = useCallback(async () => {
    if (ecosystem === "stellar") {
      try {
        const address = await stellarService.initialize();
        if (address) {
          setAccount(address);
          const network = await stellarService.getNetwork();
          if (network) {
            setStellarNetwork(network);
            validateStellarNetwork(network);
          }
        }
      } catch (error) {
        console.error("Stellar connection check failed:", error);
      }
      return;
    }

    if (typeof window.ethereum === "undefined") {
      return;
    }

    try {
      const accounts = await window.ethereum.request({ method: "eth_accounts" });

      if (accounts.length > 0) {
        const ethersProvider = new ethers.BrowserProvider(window.ethereum);
        const network = await ethersProvider.getNetwork();
        const signer = await ethersProvider.getSigner();
        const contract = initContract(signer);

        setProvider(ethersProvider);
        setSigner(signer);
        setAccount(accounts[0]);
        setChainId(Number(network.chainId));
        setContract(contract);

        contractService.initialize(ethersProvider, signer);

        if (Number(network.chainId) !== FUJI_CHAIN_ID) {
          toast.error("Please switch to Avalanche Fuji network");
        }
      }
    } catch (error) {
      console.error("Error checking connection:", error);
    }
  }, [initContract, ecosystem, validateStellarNetwork]);

  useEffect(() => {
    checkConnection();

    if (window.ethereum) {
      const handleAccountsChanged = (accounts: string[]) => {
        if (ecosystem === "stellar") return;
        if (accounts.length === 0) {
          setProvider(null);
          setSigner(null);
          setAccount(null);
          setChainId(null);
          setContract(null);
          contractService.clear();
        } else {
          checkConnection();
        }
      };

      const handleChainChanged = () => {
        if (ecosystem === "stellar") return;
        checkConnection();
      };

      window.ethereum.on("accountsChanged", handleAccountsChanged);
      window.ethereum.on("chainChanged", handleChainChanged);

      return () => {
        if (window.ethereum) {
          window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
          window.ethereum.removeListener("chainChanged", handleChainChanged);
        }
      };
    }
  }, [checkConnection, ecosystem]);

  useEffect(() => {
    if (ecosystem !== "stellar") {
      setStellarNetwork(null);
      return;
    }

    let cancelled = false;

    const handleWalletChange = (event: StellarWalletChangeEvent) => {
      if (cancelled) return;
      if (event.account) {
        setAccount(event.account);
        toast.success(
          `Connected Freighter: ${event.account.slice(0, 6)}...${event.account.slice(-4)}`
        );
      }
      if (event.network) {
        setStellarNetwork(event.network);
        validateStellarNetwork(event.network);
      }
    };

    const unsubscribe = stellarService.subscribeToWalletChanges(handleWalletChange);

    // Validate the currently active network on subscription (environment check).
    void stellarService
      .getNetwork()
      .then((network) => {
        if (cancelled || !network) return;
        setStellarNetwork(network);
        validateStellarNetwork(network);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [ecosystem, validateStellarNetwork]);

  const connect = async () => {
    if (ecosystem === "stellar") {
      setIsConnecting(true);
      try {
        const address = await stellarService.connectWallet();
        setAccount(address);
        sorobanEventWatcher.start(stellarService.getRpcUrl(), stellarService.getContractId());
        setProvider(null);
        setSigner(null);
        setChainId(null);
        setContract(null);
        const network = await stellarService.getNetwork().catch(() => "");
        if (network) {
          setStellarNetwork(network);
          validateStellarNetwork(network);
        }
        toast.success(`Connected Freighter: ${address.slice(0, 6)}...${address.slice(-4)}`);
      } catch (error: any) {
        toast.error(error.message || "Failed to connect Freighter wallet");
      } finally {
        setIsConnecting(false);
      }
      return;
    }

    if (typeof window.ethereum === "undefined") {
      toast.error("Wallet not detected in browser");
      openWalletAppOrInstall();
      return;
    }

    setIsConnecting(true);
    try {
      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts",
      });

      const ethersProvider = new ethers.BrowserProvider(window.ethereum);
      const network = await ethersProvider.getNetwork();
      const signer = await ethersProvider.getSigner();
      const contract = initContract(signer);

      setProvider(ethersProvider);
      setSigner(signer);
      setAccount(accounts[0]);
      setChainId(Number(network.chainId));
      setContract(contract);

      contractService.initialize(ethersProvider, signer);

      if (Number(network.chainId) !== FUJI_CHAIN_ID) {
        toast.error("Connected to wrong network. Please switch to Avalanche Fuji.");
      } else {
        toast.success(`Connected to ${accounts[0].slice(0, 6)}...${accounts[0].slice(-4)}`);
      }
    } catch (error: any) {
      if (error.code === 4001) {
        toast.error("Connection rejected by user");
      } else {
        toast.error(error.message || "Failed to connect wallet");
      }
    } finally {
      setIsConnecting(false);
    }
  };

  const disconnect = useCallback((options?: { notify?: boolean }) => {
    if (isDisconnecting) return;
    const notify = options?.notify ?? true;
    const hadSession = Boolean(provider || signer || account || contract);
    if (!hadSession) return;

    setIsDisconnecting(true);
    if (ecosystem === "stellar") {
      stellarService.clear();
      sorobanEventWatcher.stop();
    }
    setProvider(null);
    setSigner(null);
    setAccount(null);
    setChainId(null);
    setContract(null);
    setStellarNetwork(null);
    contractService.clear();
    if (notify) {
      toast.success("Disconnected");
    }
    window.setTimeout(() => setIsDisconnecting(false), 300);
  }, [account, contract, isDisconnecting, provider, signer, ecosystem]);

  const switchToFuji = async () => {
    if (ecosystem === "stellar") return;
    if (!window.ethereum) {
      toast.error("Wallet not detected in browser");
      openWalletAppOrInstall();
      return;
    }

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0xA869" }],
      });
      toast.success("Switched to Avalanche Fuji");
      checkConnection();
    } catch (error: any) {
      if (error.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: "0xA869",
                chainName: "Avalanche Fuji Testnet",
                nativeCurrency: {
                  name: "AVAX",
                  symbol: "AVAX",
                  decimals: 18,
                },
                rpcUrls: ["https://api.avax-test.network/ext/bc/C/rpc"],
                blockExplorerUrls: ["https://testnet.snowtrace.io/"],
              },
            ],
          });
          toast.success("Added and switched to Avalanche Fuji");
          checkConnection();
        } catch (addError) {
          toast.error("Failed to add Fuji network");
        }
      } else {
        toast.error("Failed to switch network");
      }
    }
  };

  const value = {
    provider,
    signer,
    account,
    chainId,
    isConnected: !!account,
    isConnecting,
    contract,
    connect,
    disconnect,
    switchToFuji,
    isFujiNetwork: ecosystem === "stellar" ? true : chainId === FUJI_CHAIN_ID,
    ecosystem,
    setEcosystem,
    stellarNetwork,
  };

  return <Web3Context.Provider value={value}>{children}</Web3Context.Provider>;
};

export const useWeb3 = () => {
  const context = useContext(Web3Context);
  if (context === undefined) {
    throw new Error("useWeb3 must be used within a Web3Provider");
  }
  return context;
};

declare global {
  interface Window {
    ethereum: any;
  }
}


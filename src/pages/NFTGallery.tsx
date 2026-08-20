import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardBody,
  Button,
  Chip,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
  Input,
} from "@heroui/react";
import {
  FiKey,
  FiPlus,
  FiChevronDown,
  FiEye,
  FiFile,
  FiTrash,
  FiShield,
  FiDownload,
  FiExternalLink,
  FiAlertCircle,
} from "react-icons/fi";
import { useNavigate } from "react-router-dom";
import { useWeb3 } from "../context/Web3Context";
import {
  contractService,
  TokenData,
  VaultData,
} from "../services/contract.service";
import { toast } from "react-hot-toast";
import { formatDate, getIPFSURL, isValidAddress, shortenAddress } from "../utils/helpers";
import { buttonClasses } from "../utils/buttonClasses";
import { captureError } from "../services/telemetry.service";
import { getExplorerBaseUrl as getSharedExplorerBaseUrl, getExplorerTokenUrl as getSharedExplorerTokenUrl } from "../utils/explorer";

const buildDefaultTokenURI = (vaultId: number, recipient: string): string => {
  const metadata = {
    name: `SpooVault Access Pass - Vault #${vaultId}`,
    description:
      "Guardian-issued access pass for protected SpooVault documents.",
    attributes: [
      { trait_type: "Vault ID", value: vaultId },
      { trait_type: "Recipient", value: recipient.toLowerCase() },
      { trait_type: "Network", value: "Avalanche" },
    ],
  };

  const encoded = btoa(JSON.stringify(metadata));
  return `data:application/json;base64,${encoded}`;
};

type TokenMetadata = Record<string, unknown>;

const getExplorerTokenUrl = (tokenId: number): string => {
  const contractAddress = import.meta.env.VITE_CONTRACT_ADDRESS as string | undefined;
  if (!contractAddress) {
    return getSharedExplorerBaseUrl("avalanche");
  }
  return getSharedExplorerTokenUrl(tokenId, contractAddress, "avalanche");
};

const decodeInlineJsonTokenURI = (tokenURI: string): TokenMetadata | null => {
  try {
    if (tokenURI.startsWith("data:application/json;base64,")) {
      const encoded = tokenURI.split(",", 2)[1] || "";
      return JSON.parse(atob(encoded));
    }
    if (tokenURI.startsWith("data:application/json,")) {
      const encoded = tokenURI.split(",", 2)[1] || "";
      return JSON.parse(decodeURIComponent(encoded));
    }
  } catch {
    return null;
  }
  return null;
};

const buildFallbackMetadata = (token: TokenData): TokenMetadata => ({
  name: `SpooVault Access Pass #${token.tokenId}`,
  description: "Vault access pass metadata fallback",
  tokenId: token.tokenId,
  owner: token.owner,
  vaultId: token.vaultId,
  tokenURI: token.tokenURI || "",
});

const getPassArtGradient = (token: TokenData): string => {
  const seed = ((token.vaultId ?? token.tokenId) * 47) % 360;
  const accent = (seed + 46) % 360;
  return `radial-gradient(120% 120% at 16% 14%, hsla(${seed}, 74%, 56%, 0.38) 0%, transparent 55%), radial-gradient(110% 120% at 84% 88%, hsla(${accent}, 70%, 48%, 0.32) 0%, transparent 62%), linear-gradient(145deg, hsla(${seed}, 46%, 15%, 0.98), hsla(${accent}, 52%, 9%, 0.98))`;
};

const isWalletAuthorizationError = (error: any): boolean => {
  const code =
    error?.code ??
    error?.error?.code ??
    error?.info?.error?.code ??
    error?.data?.originalError?.code ??
    null;
  const message = `${error?.shortMessage || ""} ${error?.message || ""}`.toLowerCase();
  return (
    code === 4100 ||
    message.includes("not been authorized") ||
    message.includes("has not been authorized") ||
    message.includes("unauthorized")
  );
};

const NFTGallery = () => {
  const navigate = useNavigate();
  const { isOpen, onOpen, onClose } = useDisclosure();
  const {
    isOpen: isViewModalOpen,
    onOpen: onViewModalOpen,
    onClose: onViewModalClose,
  } = useDisclosure();
  const { account, isConnected, connect, provider, signer, isFujiNetwork } = useWeb3();

  const [tokens, setTokens] = useState<TokenData[]>([]);
  const [vaults, setVaults] = useState<VaultData[]>([]);
  const [mintableVaults, setMintableVaults] = useState<VaultData[]>([]);
  const [loading, setLoading] = useState(true);
  const [minting, setMinting] = useState(false);
  const [burningTokenId, setBurningTokenId] = useState<number | null>(null);
  const [totalSupply, setTotalSupply] = useState(0);
  const [viewingToken, setViewingToken] = useState<TokenData | null>(null);
  const [viewMetadata, setViewMetadata] = useState<TokenMetadata | null>(null);
  const [viewMetadataSource, setViewMetadataSource] = useState("");
  const [viewLoading, setViewLoading] = useState(false);
  const [viewNotice, setViewNotice] = useState("");

  const [form, setForm] = useState({
    vaultId: "",
    recipient: "",
    tokenURI: "",
  });
  const modalInputClassNames = {
    inputWrapper: "bg-gray-900/75 border border-gray-700/80 shadow-none data-[hover=true]:border-gray-600",
    input: "text-sm text-gray-100",
  };
  const modalSelectClassName =
    "h-11 w-full rounded-full border border-gray-700/80 bg-gray-900/75 px-4 pr-10 text-sm text-gray-100 outline-none transition-colors hover:border-gray-600 focus:border-brand-700/70";

  useEffect(() => {
    if (isConnected && provider && signer && isFujiNetwork) {
      contractService.initialize(provider, signer);
      loadTokens();
    } else {
      setTokens([]);
      setVaults([]);
      setMintableVaults([]);
      setTotalSupply(0);
      setLoading(false);
    }
  }, [account, isConnected, provider, signer, isFujiNetwork]);

  const loadTokens = async () => {
    if (!account) {
      setTokens([]);
      setVaults([]);
      setMintableVaults([]);
      setTotalSupply(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [tokenData, vaultData, supply] = await Promise.all([
        contractService.fetchUserTokens(account),
        contractService.fetchVaultsForAccount(account),
        contractService.getTotalSupply(),
      ]);

      const accountLower = account.toLowerCase();
      const visibleVaults = vaultData;
      const guardianVaults = visibleVaults.filter((vault) =>
        vault.guardians.some((guardian) => guardian.toLowerCase() === accountLower)
      );

      setTokens(tokenData);
      setVaults(visibleVaults);
      setMintableVaults(guardianVaults);
      setTotalSupply(supply);
    } catch (error) {
      console.error("Error loading tokens:", error);
      captureError("nftGallery.loadTokens", error, { account: account || "" });
      const message = error instanceof Error ? error.message : "Failed to load tokens";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const vaultNameById = useMemo(() => {
    const map: Record<number, string> = {};
    vaults.forEach((vault) => {
      map[vault.id] = vault.name || `Vault #${vault.id}`;
    });
    return map;
  }, [vaults]);

  const handleMint = async () => {
    if (!isConnected) {
      toast.error("Please connect your wallet first");
      await connect();
      return;
    }

    if (!isFujiNetwork) {
      toast.error("Please switch to Avalanche Fuji network");
      return;
    }

    const vaultId = Number(form.vaultId);
    if (!vaultId) {
      toast.error("Vault ID is required");
      return;
    }
    const canMintForVault = mintableVaults.some((vault) => vault.id === vaultId);
    if (!canMintForVault) {
      toast.error("You can only mint for vaults where your wallet is an active guardian.");
      return;
    }

    if (!isValidAddress(form.recipient)) {
      toast.error("Invalid recipient address");
      return;
    }

    setMinting(true);
    try {
      const tokenURIValue = form.tokenURI.trim() || buildDefaultTokenURI(vaultId, form.recipient);
      const tokenId = await contractService.mintAccessToken(
        vaultId,
        form.recipient,
        tokenURIValue
      );

      if (!tokenId) {
        toast.error("Token minted but ID was not returned");
      } else {
        toast.success(`Token #${tokenId} minted`);
      }

      setForm({ vaultId: "", recipient: "", tokenURI: "" });
      onClose();
      loadTokens();
    } catch (error: any) {
      captureError("nftGallery.mint", error, { vaultId: form.vaultId, recipient: form.recipient });
      if (isWalletAuthorizationError(error)) {
        toast.custom((t) => (
          <div className="rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 shadow-xl">
            <p className="font-medium">Wallet authorization required.</p>
            <p className="text-xs text-gray-400 mt-0.5">Reconnect wallet, then retry mint.</p>
            <Button
              size="sm"
              className={`${buttonClasses.primarySm} mt-2`}
              onPress={async () => {
                toast.dismiss(t.id);
                await connect();
              }}
            >
              Reconnect Wallet
            </Button>
          </div>
        ));
        return;
      }
      toast.error(error.message || "Failed to mint token");
    } finally {
      setMinting(false);
    }
  };

  const handleViewToken = async (token: TokenData) => {
    setViewingToken(token);
    setViewMetadata(null);
    setViewMetadataSource("");
    setViewNotice("");
    setViewLoading(true);
    onViewModalOpen();

    const rawUri = token.tokenURI?.trim() || "";
    if (!rawUri) {
      setViewMetadata(buildFallbackMetadata(token));
      setViewMetadataSource(getExplorerTokenUrl(token.tokenId));
      setViewNotice("No token URI was set for this token. Showing fallback details.");
      setViewLoading(false);
      return;
    }

    const inlineMetadata = decodeInlineJsonTokenURI(rawUri);
    if (inlineMetadata) {
      setViewMetadata(inlineMetadata);
      setViewMetadataSource(rawUri);
      setViewNotice("Inline token metadata decoded successfully.");
      setViewLoading(false);
      return;
    }

    const resolvedUri = rawUri.startsWith("ipfs://") ? getIPFSURL(rawUri) : rawUri;
    setViewMetadataSource(resolvedUri);

    try {
      const response = await fetch(resolvedUri, { method: "GET" });
      if (!response.ok) {
        throw new Error(`Metadata fetch failed (${response.status})`);
      }
      const text = await response.text();
      const parsed = JSON.parse(text) as TokenMetadata;
      setViewMetadata(parsed);
      setViewNotice("Token metadata loaded from URI.");
    } catch {
      setViewMetadata({
        ...buildFallbackMetadata(token),
        tokenURI: rawUri,
      });
      setViewNotice("Could not parse metadata from URI. Showing fallback details.");
    } finally {
      setViewLoading(false);
    }
  };

  const handleDownloadViewMetadata = () => {
    if (!viewingToken) return;
    const payload = viewMetadata ?? buildFallbackMetadata(viewingToken);
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `spoovault-pass-${viewingToken.tokenId}-metadata.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded metadata for token #${viewingToken.tokenId}`);
  };

  const handleOpenMetadataSource = () => {
    if (!viewingToken) return;
    const target = viewMetadataSource || getExplorerTokenUrl(viewingToken.tokenId);
    window.open(target, "_blank", "noopener,noreferrer");
  };

  const handleBurn = async (tokenId: number) => {
    const confirmed = window.confirm(
      `Burn Pass #${tokenId}? This cannot be undone.`
    );
    if (!confirmed) {
      return;
    }

    setBurningTokenId(tokenId);
    try {
      await contractService.burnAccessToken(tokenId);
      toast.success(`Token #${tokenId} burned`);
      loadTokens();
    } catch (error: any) {
      captureError("nftGallery.burn", error, { tokenId });
      if (isWalletAuthorizationError(error)) {
        toast.custom((t) => (
          <div className="rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 shadow-xl">
            <p className="font-medium">Wallet authorization expired.</p>
            <p className="text-xs text-gray-400 mt-0.5">Reconnect wallet to continue burning passes.</p>
            <Button
              size="sm"
              className={`${buttonClasses.primarySm} mt-2`}
              onPress={async () => {
                toast.dismiss(t.id);
                await connect();
              }}
            >
              Reconnect Wallet
            </Button>
          </div>
        ));
        return;
      }
      toast.error(error.message || "Failed to burn token");
    } finally {
      setBurningTokenId(null);
    }
  };

  const handleOpenVaultDocuments = (token: TokenData) => {
    if (token.vaultId === null) {
      toast.error("No vault is linked to this pass.");
      return;
    }
    navigate(`/access?vault=${token.vaultId}&scope=accessible`);
  };

  const ownedVaultCount = useMemo(() => {
    const vaultIds = new Set<number>();
    tokens.forEach((token) => {
      if (token.vaultId !== null) {
        vaultIds.add(token.vaultId);
      }
    });
    return vaultIds.size;
  }, [tokens]);

  if (!isConnected) {
    return (
      <div className="space-y-8">
        <div className="rounded-2xl bg-gradient-to-r from-gray-900/50 to-[#040306] border border-gray-800 p-8 text-center">
          <div className="w-20 h-20 bg-gradient-to-br from-brand-700 to-brand-900 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <FiKey className="text-white text-3xl" />
          </div>
          <h1 className="text-3xl font-bold mb-4">Connect Your Wallet</h1>
          <p className="text-gray-400 mb-8 max-w-2xl mx-auto">
            Connect your wallet to view and manage vault access passes.
          </p>
          <Button
            size="lg"
            className={buttonClasses.primaryLg}
            onPress={connect}
            startContent={<FiKey />}
          >
            Connect Wallet
          </Button>
        </div>
      </div>
    );
  }

  if (!isFujiNetwork) {
    return (
      <div className="space-y-8">
        <div className="rounded-2xl bg-gradient-to-r from-yellow-500/10 to-orange-500/10 border border-yellow-500/30 p-8 text-center">
          <div className="w-20 h-20 bg-gradient-to-br from-yellow-500 to-orange-500 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <FiAlertCircle className="text-white text-3xl" />
          </div>
          <h1 className="text-3xl font-bold mb-4">Wrong Network</h1>
          <p className="text-gray-400 mb-8 max-w-2xl mx-auto">
            Please switch to Avalanche Fuji Testnet to manage access passes.
          </p>
          <Button
            size="lg"
            className={buttonClasses.warningLg}
            onPress={() => window.ethereum && window.ethereum.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: "0xA869" }]
            })}
          >
            Switch to Fuji Network
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-2">Access Passes</h1>
          <p className="text-gray-400">
            Manage ERC-721 passes for vault permissions and controlled release
          </p>
        </div>
        <Button
          className={buttonClasses.primaryMd}
          startContent={<FiPlus />}
          onPress={onOpen}
        >
          Mint Pass
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
          <CardBody className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Issued Passes</p>
                <p className="text-2xl font-bold">{tokens.length}</p>
              </div>
              <div className="p-3 rounded-lg bg-purple-500/20">
                <FiKey className="text-purple-400 text-xl" />
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
          <CardBody className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Network Pass Supply</p>
                <p className="text-2xl font-bold">{totalSupply}</p>
              </div>
              <div className="p-3 rounded-lg bg-green-500/20">
                <FiShield className="text-green-400 text-xl" />
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
          <CardBody className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Access Vaults</p>
                <p className="text-2xl font-bold">{ownedVaultCount}</p>
              </div>
              <div className="p-3 rounded-lg bg-brand-700/20">
                <FiShield className="text-brand-400 text-xl" />
              </div>
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {loading ? (
          <div className="text-gray-400">Loading passes...</div>
        ) : tokens.length === 0 ? (
          <div className="text-center py-12 col-span-full">
            <div className="w-20 h-20 bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl flex items-center justify-center mx-auto mb-6">
              <FiKey className="text-gray-600 text-3xl" />
            </div>
            <h3 className="text-xl font-bold mb-2">No passes found</h3>
            <p className="text-gray-400 mb-6">
              Mint your first access pass to define who can request or receive protected files.
            </p>
            <Button
              className={buttonClasses.primaryMd}
              onPress={onOpen}
              startContent={<FiPlus />}
            >
              Mint Pass
            </Button>
          </div>
        ) : (
          tokens.map((token) => (
            <Card
              key={token.tokenId}
              className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm hover:border-brand-700/30 transition-colors"
            >
              <CardBody className="p-0">
                <div className="relative h-48 overflow-hidden rounded-t-lg">
                  <div
                    className="w-full h-full flex items-center justify-center"
                    style={{ background: getPassArtGradient(token) }}
                  >
                    <FiKey className="text-white/85 text-4xl" />
                  </div>
                  <div className="absolute top-3 left-3">
                    <Chip size="sm" variant="flat" className="bg-black/35 text-gray-100 border border-white/15">
                      {token.vaultId !== null ? `Vault #${token.vaultId}` : "Vault Unlinked"}
                    </Chip>
                  </div>
                  <div className="absolute top-3 right-3">
                    <Chip color="success" variant="flat" size="sm">
                      active
                    </Chip>
                  </div>
                </div>

                <div className="p-6">
                  <h3 className="font-bold text-lg mb-3">Access Pass #{token.tokenId}</h3>

                  <div className="space-y-2 mb-4">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-400">Vault</span>
                      <span className="font-medium">
                        {token.vaultId !== null
                          ? vaultNameById[token.vaultId] || `Vault #${token.vaultId}`
                          : "Unknown"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-400">Owner</span>
                      <span className="font-mono text-xs">{shortenAddress(token.owner)}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-400">Issued</span>
                      <span>{token.mintedAt ? formatDate(token.mintedAt) : "-"}</span>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      fullWidth
                      variant="flat"
                      startContent={<FiEye />}
                      onPress={() => {
                        void handleViewToken(token);
                      }}
                    >
                      View
                    </Button>
                    <Button
                      fullWidth
                      color="danger"
                      variant="flat"
                      startContent={<FiTrash />}
                      isLoading={burningTokenId === token.tokenId}
                      onPress={() => handleBurn(token.tokenId)}
                    >
                      Burn
                    </Button>
                  </div>
                  <Button
                    fullWidth
                    variant="flat"
                    className="mt-2"
                    startContent={<FiFile />}
                    isDisabled={token.vaultId === null}
                    onPress={() => handleOpenVaultDocuments(token)}
                  >
                    Vault Documents
                  </Button>
                </div>
              </CardBody>
            </Card>
          ))
        )}
      </div>

      <Modal
        isOpen={isViewModalOpen}
        onClose={onViewModalClose}
        size="lg"
        backdrop="blur"
        classNames={{
          wrapper: "z-[130]",
          backdrop: "bg-black/70",
        }}
        scrollBehavior="inside"
        placement="center"
      >
        <ModalContent className="bg-gray-950 w-[94vw] max-w-2xl max-h-[82vh] overflow-hidden border border-gray-800/90 shadow-2xl">
          <ModalHeader className="border-b border-gray-800/80 px-4 sm:px-6 py-4">
            Pass Details
          </ModalHeader>
          <ModalBody className="modal-scroll max-h-[66vh] overflow-y-auto px-4 sm:px-6 py-4 space-y-4">
            {!viewingToken ? (
              <p className="text-sm text-gray-400">No token selected.</p>
            ) : (
              <>
                <div className="rounded-xl border border-gray-800/80 bg-gray-900/60 p-3 space-y-1">
                  <p className="text-sm font-semibold">Access Pass #{viewingToken.tokenId}</p>
                  <p className="text-xs text-gray-400">
                    Vault:{" "}
                    {viewingToken.vaultId !== null
                      ? vaultNameById[viewingToken.vaultId] || `Vault #${viewingToken.vaultId}`
                      : "Unknown"}
                  </p>
                  <p className="text-xs text-gray-500">Owner: {shortenAddress(viewingToken.owner)}</p>
                </div>

                {viewNotice && (
                  <div className="rounded-xl border border-gray-700/70 bg-gray-900/60 px-3 py-2 text-xs text-gray-300">
                    {viewNotice}
                  </div>
                )}

                {viewLoading ? (
                  <p className="text-sm text-gray-400">Loading metadata...</p>
                ) : (
                  <pre className="rounded-xl border border-gray-800/85 bg-black/35 p-3 text-xs text-gray-200 overflow-auto whitespace-pre-wrap break-all">
{JSON.stringify(viewMetadata ?? {}, null, 2)}
                  </pre>
                )}
              </>
            )}
          </ModalBody>
          <ModalFooter className="border-t border-gray-800/80 px-4 sm:px-6 py-3 flex-col-reverse sm:flex-row gap-2">
            <Button className={`${buttonClasses.ghostMd} w-full sm:w-auto`} onPress={onViewModalClose}>
              Close
            </Button>
            <Button
              className={`${buttonClasses.outlineMd} w-full sm:w-auto`}
              startContent={<FiExternalLink />}
              onPress={handleOpenMetadataSource}
              isDisabled={!viewingToken}
            >
              Open Source
            </Button>
            <Button
              className={`${buttonClasses.primaryMd} w-full sm:w-auto`}
              startContent={<FiDownload />}
              onPress={handleDownloadViewMetadata}
              isDisabled={!viewingToken}
            >
              Download Metadata
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="lg"
        backdrop="blur"
        classNames={{
          wrapper: "z-[120]",
          backdrop: "bg-black/70",
        }}
        scrollBehavior="inside"
        placement="center"
      >
        <ModalContent className="bg-gray-950 w-[94vw] max-w-xl max-h-[82vh] overflow-hidden border border-gray-800/90 shadow-2xl">
          <ModalHeader className="border-b border-gray-800/80 px-4 sm:px-6 py-4">Mint Access Pass</ModalHeader>
          <ModalBody className="modal-scroll max-h-[70vh] overflow-y-auto px-4 sm:px-6 py-4">
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="text-xs text-gray-300 font-medium">Recipient Address</p>
                <Input
                  placeholder="0x..."
                  value={form.recipient}
                  onValueChange={(value) => setForm({ ...form, recipient: value })}
                  classNames={modalInputClassNames}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-gray-300 font-medium">Token URI (optional)</p>
                <Input
                  placeholder="https://..."
                  value={form.tokenURI}
                  onValueChange={(value) => setForm({ ...form, tokenURI: value })}
                  classNames={modalInputClassNames}
                />
              </div>

              <div className="space-y-1">
                <p className="text-xs text-gray-300 font-medium">Select Vault</p>
                <div className="relative">
                  <select
                    value={form.vaultId}
                    onChange={(event) => setForm({ ...form, vaultId: event.target.value })}
                    className={modalSelectClassName}
                  >
                    <option value="">Select Vault</option>
                    {mintableVaults.map((vault) => (
                      <option key={vault.id} value={vault.id}>
                        {vault.name || `Vault #${vault.id}`}
                      </option>
                    ))}
                  </select>
                  <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-500" />
                </div>
                {mintableVaults.length === 0 && (
                  <p className="text-sm text-yellow-400">
                    No guardian vaults available for this wallet. Accept invite first.
                  </p>
                )}
              </div>

              <div className="p-4 bg-brand-700/10 border border-brand-700/20 rounded-lg">
                <p className="text-sm">
                  <span className="font-medium">Note:</span> Only vault guardians can mint access passes.
                </p>
              </div>
            </div>
          </ModalBody>
          <ModalFooter className="border-t border-gray-800/80 px-4 sm:px-6 py-3 flex-col-reverse sm:flex-row gap-2">
            <Button className={`${buttonClasses.ghostMd} w-full sm:w-auto`} onPress={onClose} isDisabled={minting}>
              Cancel
            </Button>
            <Button
              className={`${buttonClasses.primaryMd} w-full sm:w-auto`}
              onPress={handleMint}
              isLoading={minting}
              isDisabled={mintableVaults.length === 0 || minting}
            >
              Mint Pass
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
};

export default NFTGallery;


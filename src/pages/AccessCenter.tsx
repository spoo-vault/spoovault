import { useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  CardBody,
  Input,
  Button,
  Chip,
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
} from "@heroui/react";
import {
  FiSearch,
  FiShield,
  FiKey,
  FiClock,
  FiAlertCircle,
  FiDownload,
  FiEye,
  FiUpload,
} from "react-icons/fi";
import { useSearchParams } from "react-router-dom";
import CryptoJS from "crypto-js";
import { useWeb3 } from "../context/Web3Context";
import {
  contractService,
  AccessRequestData,
  DocumentData,
  TokenData,
  VaultData,
} from "../services/contract.service";
import { buttonClasses } from "../utils/buttonClasses";
import {
  decryptData,
  fetchFromIPFS,
  formatDate,
  isValidAddress,
  shortenAddress,
} from "../utils/helpers";
import { toast } from "react-hot-toast";
import { captureError } from "../services/telemetry.service";
import { keyInboxService } from "../services/keyInbox.service";
import { keyStoreService } from "../services/keyStore.service";
import { decryptWithPrivateKey } from "../utils/crypto";
import { clientKeyringService } from "../services/clientKeyring.service";
import {
  collectStream,
  decryptStream,
  detectStreamingCiphertext,
  importStreamingKey,
} from "../services/streamingCrypto.service";
// reconstructSecret is available for on-chain SSS share reconstruction when needed
// import { reconstructSecret } from "../services/secrets.service";

type WordArray = { words: number[]; sigBytes: number };
type ImportedKeyPayload = {
  documentId?: number | string;
  key?: string;
  beneficiary?: string;
  contract?: string;
  chainId?: number | string;
};

const wordArrayToUint8Array = (wordArray: WordArray): Uint8Array => {
  const { words, sigBytes } = wordArray;
  const buffer = new ArrayBuffer(sigBytes);
  const u8 = new Uint8Array(buffer);
  for (let i = 0; i < sigBytes; i++) {
    u8[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return u8;
};

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
  }) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array> & { close: () => Promise<void> }> }>;
};

type AccessState =
  | "ready"
  | "approved_key_missing"
  | "request_pending"
  | "request_rejected"
  | "request_expired"
  | "no_pass"
  | "can_request";

type InboxKeyStatus =
  | "ready"
  | "awaiting_approval"
  | "wrong_contract"
  | "wrong_network";

interface InboxKeyPreviewItem {
  documentId: number;
  vaultId: number;
  vaultName: string;
  issuedAt: string;
  status: InboxKeyStatus;
}

const AccessCenter = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { account, isConnected, connect, provider, signer, isFujiNetwork, ecosystem } = useWeb3();

  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [fetchingInboxKeys, setFetchingInboxKeys] = useState(false);
  const [requestingDocId, setRequestingDocId] = useState<number | null>(null);
  const [inboxEnvelopeCount, setInboxEnvelopeCount] = useState(0);
  const [inboxPreviewItems, setInboxPreviewItems] = useState<InboxKeyPreviewItem[]>([]);
  const [documents, setDocuments] = useState<DocumentData[]>([]);
  const [vaults, setVaults] = useState<VaultData[]>([]);
  const [tokens, setTokens] = useState<TokenData[]>([]);
  const [activeAccessByDoc, setActiveAccessByDoc] = useState<Record<number, boolean>>({});
  const [latestRequestByDoc, setLatestRequestByDoc] = useState<Record<number, AccessRequestData | null>>({});
  const keyImportInputRef = useRef<HTMLInputElement | null>(null);
  const selectedVaultFromQuery = Number(searchParams.get("vault") || "");
  const hasVaultFilter =
    Number.isFinite(selectedVaultFromQuery) && selectedVaultFromQuery > 0;
  const accessibleOnly = searchParams.get("scope") === "accessible";

  useEffect(() => {
    if (isConnected && (ecosystem === "stellar" || (provider && signer && isFujiNetwork))) {
      if (ecosystem !== "stellar" && provider && signer) {
        contractService.initialize(provider, signer);
      }
      loadData();
    } else {
      setLoading(false);
    }
  }, [account, isConnected, provider, signer, isFujiNetwork, ecosystem]);

  const loadData = async () => {
    if (!account) {
      setVaults([]);
      setDocuments([]);
      setTokens([]);
      setActiveAccessByDoc({});
      setLatestRequestByDoc({});
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const [tokenData, visibleVaults] = await Promise.all([
        contractService.fetchUserTokens(account),
        contractService.fetchVaultsForAccount(account),
      ]);
      const scopedDocs = await contractService.fetchDocumentsForVaults(
        visibleVaults.map((vault) => vault.id),
        account
      );
      const docIds = scopedDocs.map((doc) => doc.id);
      const [accessMap, requestMap] = await Promise.all([
        contractService.getActiveAccessMap(account, docIds),
        contractService.getLatestRequestsForUser(account, docIds),
      ]);

      setVaults(visibleVaults);
      setDocuments(scopedDocs);
      setTokens(tokenData);
      setActiveAccessByDoc(accessMap);
      setLatestRequestByDoc(requestMap);
    } catch (error) {
      console.error("Error loading beneficiary access data:", error);
      captureError("accessCenter.loadData", error, { account: account || "" });
      const message = error instanceof Error ? error.message : "Failed to load access data";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleImportKeyBackup = async (file: File | null) => {
    if (!file) {
      return;
    }

    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as ImportedKeyPayload;
      const documentId = Number(parsed.documentId);
      const key = (parsed.key || "").trim();
      const beneficiary = (parsed.beneficiary || "").trim();
      const fileContract = (parsed.contract || "").toLowerCase();
      const expectedContract = (
        (import.meta.env.VITE_CONTRACT_ADDRESS as string | undefined) || ""
      ).toLowerCase();
      const fileChainId = Number(parsed.chainId);
      const expectedChainId = Number(import.meta.env.VITE_CHAIN_ID);

      if (!documentId || !Number.isFinite(documentId)) {
        throw new Error("Invalid key package: missing documentId");
      }

      let decryptedKey = key;
      const isEncryptedPayload =
        (key.includes("ciphertext") && (key.includes("ephemPublicKey") || key.includes("version"))) ||
        key.trim().startsWith("{");

      if (isEncryptedPayload) {
        if (!account) {
          throw new Error("Connect your wallet before importing this key package");
        }
        toast("Decrypting key package from secure keyring...");
        const beneficiaryPrivateKey = await clientKeyringService.getDecryptedPrivateKey(account);
        decryptedKey = await decryptWithPrivateKey(key, beneficiaryPrivateKey);
        if (!decryptedKey) {
          throw new Error("Failed to decrypt key package with keyring private key");
        }
      }

      if (!/^[a-fA-F0-9]{64}$/.test(decryptedKey)) {
        throw new Error("Invalid key package: key format is not recognized");
      }
      if (beneficiary) {
        if (!isValidAddress(beneficiary)) {
          throw new Error("Invalid key package: beneficiary wallet address is invalid");
        }
        if (!account) {
          throw new Error("Connect your wallet before importing this key package");
        }
        if (beneficiary.toLowerCase() !== account.toLowerCase()) {
          throw new Error("This key package is issued for a different wallet");
        }
      }
      if (fileContract && expectedContract && fileContract !== expectedContract) {
        throw new Error("This key package is for a different SpooVault contract");
      }
      if (
        Number.isFinite(fileChainId) &&
        Number.isFinite(expectedChainId) &&
        fileChainId > 0 &&
        expectedChainId > 0 &&
        fileChainId !== expectedChainId
      ) {
        throw new Error("This key package is for a different blockchain network");
      }

      keyStoreService.set(documentId, decryptedKey);
      toast.success(`Key imported for Document #${documentId}`);
      await loadData();
    } catch (error: any) {
      captureError("accessCenter.importKeyPackage", error);
      toast.error(error.message || "Failed to import key package");
    }
  };

  const handleFetchInboxKeys = async () => {
    if (!account) {
      toast.error("Connect wallet first");
      return;
    }
    if (!keyInboxService.isConfigured()) {
      toast.error("IPFS is not configured");
      return;
    }

    setFetchingInboxKeys(true);
    let imported = 0;
    let skippedNotApproved = 0;
    let skippedWrongChain = 0;
    let skippedWrongContract = 0;

    try {
      const expectedContract = (
        (import.meta.env.VITE_CONTRACT_ADDRESS as string | undefined) || ""
      ).toLowerCase();
      const expectedChainId = Number(import.meta.env.VITE_CHAIN_ID);
      const envelopes = await keyInboxService.fetchBeneficiaryInbox(account, {
        limit: 40,
      });
      setInboxEnvelopeCount(envelopes.length);
      setInboxPreviewItems([]);

      if (envelopes.length === 0) {
        toast("No inbox keys found for this wallet.");
        return;
      }

      const latestByDoc = new Map<number, (typeof envelopes)[number]>();
      for (const envelope of envelopes) {
        const docId = Number(envelope.documentId);
        if (!docId || !Number.isFinite(docId)) {
          continue;
        }
        const current = latestByDoc.get(docId);
        if (!current) {
          latestByDoc.set(docId, envelope);
          continue;
        }
        const currentTs = Date.parse(current.issuedAt || "");
        const nextTs = Date.parse(envelope.issuedAt || "");
        if ((Number.isNaN(currentTs) ? 0 : currentTs) <= (Number.isNaN(nextTs) ? 0 : nextTs)) {
          latestByDoc.set(docId, envelope);
        }
      }

      const previews: InboxKeyPreviewItem[] = [];
      for (const envelope of latestByDoc.values()) {
        const documentId = Number(envelope.documentId);
        const vaultId = Number(envelope.vaultId);
        const key = (envelope.key || "").trim();
        if (!documentId || !key) {
          continue;
        }

        const isEncrypted =
          (key.includes("ciphertext") && (key.includes("ephemPublicKey") || key.includes("version"))) ||
          key.trim().startsWith("{");
        if (!isEncrypted && !/^[a-fA-F0-9]{64}$/.test(key)) {
          continue;
        }

        const vaultName = vaultNameById[vaultId] || `Vault #${vaultId || "?"}`;
        const envelopeContract = (envelope.contract || "").toLowerCase();
        const envelopeChainId = Number(envelope.chainId);
        if (expectedContract && envelopeContract && envelopeContract !== expectedContract) {
          skippedWrongContract += 1;
          previews.push({
            documentId,
            vaultId,
            vaultName,
            issuedAt: envelope.issuedAt || "",
            status: "wrong_contract",
          });
          continue;
        }
        if (
          Number.isFinite(expectedChainId) &&
          expectedChainId > 0 &&
          Number.isFinite(envelopeChainId) &&
          envelopeChainId > 0 &&
          envelopeChainId !== expectedChainId
        ) {
          skippedWrongChain += 1;
          previews.push({
            documentId,
            vaultId,
            vaultName,
            issuedAt: envelope.issuedAt || "",
            status: "wrong_network",
          });
          continue;
        }

        const hasAccess = await contractService.hasActiveAccess(documentId, account);
        if (!hasAccess) {
          skippedNotApproved += 1;
          previews.push({
            documentId,
            vaultId,
            vaultName,
            issuedAt: envelope.issuedAt || "",
            status: "awaiting_approval",
          });
          continue;
        }

        let decryptedKey = key;
        if (isEncrypted) {
          try {
            const beneficiaryPrivateKey = await clientKeyringService.getDecryptedPrivateKey(account);
            decryptedKey = await decryptWithPrivateKey(key, beneficiaryPrivateKey);
            if (!decryptedKey || !/^[a-fA-F0-9]{64}$/.test(decryptedKey)) {
              continue;
            }
          } catch {
            continue;
          }
        }

        keyStoreService.set(documentId, decryptedKey);
        previews.push({
          documentId,
          vaultId,
          vaultName,
          issuedAt: envelope.issuedAt || "",
          status: "ready",
        });
        imported += 1;
      }
      setInboxPreviewItems(previews);

      if (imported > 0) {
        await loadData();
        toast.success(`Imported ${imported} key${imported > 1 ? "s" : ""} from inbox`);
      } else {
        const parts: string[] = [];
        if (skippedNotApproved > 0) parts.push(`${skippedNotApproved} not approved yet`);
        if (skippedWrongContract > 0) parts.push(`${skippedWrongContract} wrong contract`);
        if (skippedWrongChain > 0) parts.push(`${skippedWrongChain} wrong network`);
        toast(parts.length > 0 ? `No keys imported (${parts.join(", ")})` : "No valid keys found");
      }
    } catch (error: any) {
      captureError("accessCenter.fetchInboxKeys", error, { account });
      toast.error(error?.message || "Failed to fetch inbox keys");
    } finally {
      setFetchingInboxKeys(false);
    }
  };

  const vaultNameById = useMemo(() => {
    const map: Record<number, string> = {};
    vaults.forEach((vault) => {
      map[vault.id] = vault.name || `Vault #${vault.id}`;
    });
    return map;
  }, [vaults]);

  const vaultPassSet = useMemo(() => {
    const set = new Set<number>();
    tokens.forEach((token) => {
      if (token.vaultId !== null) {
        set.add(token.vaultId);
      }
    });
    return set;
  }, [tokens]);

  const getStoredKey = (docId: number): string | null => {
    return keyStoreService.get(docId);
  };

  const decryptMetadata = (doc: DocumentData): { name?: string; type?: string } | null => {
    const key = getStoredKey(doc.id);
    if (!key) return null;
    try {
      const raw = decryptData(doc.encryptedMetadata, key);
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const resolveAccessState = (
    hasChainAccess: boolean,
    hasLocalKey: boolean,
    hasVaultPass: boolean,
    latestRequest: AccessRequestData | null,
    isVaultCreator: boolean
  ): AccessState => {
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const isPending =
      !!latestRequest &&
      latestRequest.status === 0 &&
      latestRequest.expiresAt > nowInSeconds;

    if (isVaultCreator) {
      if (hasLocalKey) return "ready";
      return "approved_key_missing";
    }
    if (!hasVaultPass) return "no_pass";
    if (hasChainAccess && hasLocalKey) return "ready";
    if (hasChainAccess && !hasLocalKey) return "approved_key_missing";
    if (isPending) return "request_pending";
    if (latestRequest?.status === 2) return "request_rejected";
    if (
      latestRequest?.status === 3 ||
      (latestRequest?.status === 0 && latestRequest.expiresAt <= nowInSeconds)
    ) {
      return "request_expired";
    }
    return "can_request";
  };

  const rows = useMemo(() => {
    return documents.map((doc) => {
      const metadata = decryptMetadata(doc);
      const hasLocalKey = !!getStoredKey(doc.id);
      const hasChainAccess = !!activeAccessByDoc[doc.id];
      const hasVaultPass = vaultPassSet.has(doc.vaultId);
      const latestRequest = latestRequestByDoc[doc.id] ?? null;
      const vault = vaults.find((item) => item.id === doc.vaultId);
      const isVaultCreator =
        !!account &&
        !!vault &&
        vault.creator.toLowerCase() === account.toLowerCase();
      const state = resolveAccessState(
        hasChainAccess,
        hasLocalKey,
        hasVaultPass,
        latestRequest,
        isVaultCreator
      );
      return {
        doc,
        name: metadata?.name || `Document #${doc.id}`,
        type: metadata?.type || "Encrypted File",
        hasLocalKey,
        hasChainAccess,
        hasVaultPass,
        isVaultCreator,
        latestRequest,
        state,
      };
    });
  }, [documents, activeAccessByDoc, latestRequestByDoc, vaultPassSet, vaults, account]);

  const filteredRows = useMemo(() => {
    const term = search.toLowerCase().trim();
    return rows.filter((item) => {
      if (hasVaultFilter && item.doc.vaultId !== selectedVaultFromQuery) {
        return false;
      }
      if (accessibleOnly && (!item.hasChainAccess || (!item.hasVaultPass && !item.isVaultCreator))) {
        return false;
      }
      if (!term) {
        return true;
      }
      const vaultName = vaultNameById[item.doc.vaultId] || `Vault #${item.doc.vaultId}`;
      return (
        item.name.toLowerCase().includes(term) ||
        vaultName.toLowerCase().includes(term) ||
        item.doc.ipfsHash.toLowerCase().includes(term)
      );
    });
  }, [rows, search, vaultNameById, hasVaultFilter, selectedVaultFromQuery, accessibleOnly]);

  const handleRequestAccess = async (docId: number) => {
    if (!isConnected || !account) {
      toast.error("Please connect your wallet first");
      await connect();
      return;
    }

    const targetDoc = documents.find((d) => d.id === docId);
    const targetVault = targetDoc ? vaults.find((v) => v.id === targetDoc.vaultId) : null;
    const vaultNetwork: "avalanche" | "stellar" = targetVault?.network || ecosystem;

    if (vaultNetwork === "avalanche" && !isFujiNetwork) {
      toast.error("Please switch to Avalanche Fuji network");
      return;
    }

    setRequestingDocId(docId);
    try {
      const hasPass = await contractService.hasVaultToken(
        account,
        targetDoc?.vaultId || 0,
        vaultNetwork
      );
      if (!hasPass) {
        throw new Error(`Access pass token verification failed for ${vaultNetwork} network vault.`);
      }

      const requestId = await contractService.requestAccess(docId);
      if (!requestId) {
        toast.error("Request submitted but ID was not returned");
      } else {
        toast.success(`Access request #${requestId} submitted`);
      }
      await loadData();
    } catch (error: any) {
      captureError("accessCenter.requestAccess", error, { documentId: docId });
      toast.error(error.message || "Failed to request access");
    } finally {
      setRequestingDocId(null);
    }
  };

  const decryptFileFromIPFS = async (doc: DocumentData) => {
    if (!account) {
      throw new Error("Please connect your wallet");
    }

    const hasAccess = await contractService.hasActiveAccess(doc.id, account);
    if (!hasAccess) {
      throw new Error("No active on-chain access for this document");
    }

    const key = getStoredKey(doc.id);
    if (!key) {
      throw new Error("Encryption key not found. Import the key package first.");
    }

    const response = await fetchFromIPFS(doc.ipfsHash);

    const { isStreaming, stream } = await detectStreamingCiphertext(response.body);
    const metadata = decryptMetadata(doc);
    const name = metadata?.name || `document-${doc.id}`;
    const type = metadata?.type || "application/octet-stream";

    if (isStreaming) {
      const cryptoKey = await importStreamingKey(key);
      const decrypted = decryptStream(stream, cryptoKey);
      return { mode: "streaming" as const, decrypted, name, type };
    }

    const encryptedBytes = await collectStream(stream);
    const encryptedText = new TextDecoder().decode(encryptedBytes);
    const decryptedWordArray = CryptoJS.AES.decrypt(encryptedText, key);
    const bytes = wordArrayToUint8Array(decryptedWordArray);
    return { mode: "legacy" as const, bytes, name, type };
  };

  const handleDownload = async (doc: DocumentData) => {
    try {
      const result = await decryptFileFromIPFS(doc);

      if (result.mode === "streaming") {
        const pickerWindow = window as SaveFilePickerWindow;
        if (typeof pickerWindow.showSaveFilePicker === "function") {
          const handle = await pickerWindow.showSaveFilePicker({
            suggestedName: result.name,
          });
          const writable = await handle.createWritable();
          try {
            await result.decrypted.pipeTo(writable);
          } catch (error) {
            try {
              await writable.close();
            } catch {
              // ignore close errors after failed pipe
            }
            throw error;
          }
          toast.success("Document saved");
          return;
        }

        const bytes = await collectStream(result.decrypted);
        const arrayBuffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(arrayBuffer).set(bytes);
        const blob = new Blob([arrayBuffer], { type: result.type });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = result.name;
        link.click();
        URL.revokeObjectURL(url);
        return;
      }

      const arrayBuffer = new ArrayBuffer(result.bytes.byteLength);
      new Uint8Array(arrayBuffer).set(result.bytes);
      const blob = new Blob([arrayBuffer], { type: result.type });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error: any) {
      captureError("accessCenter.download", error, { documentId: doc.id });
      toast.error(error.message || "Failed to download document");
    }
  };

  const handleView = async (doc: DocumentData) => {
    try {
      const result = await decryptFileFromIPFS(doc);
      const bytes =
        result.mode === "streaming"
          ? await collectStream(result.decrypted)
          : result.bytes;
      const arrayBuffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(arrayBuffer).set(bytes);
      const blob = new Blob([arrayBuffer], { type: result.type });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error: any) {
      captureError("accessCenter.view", error, { documentId: doc.id });
      toast.error(error.message || "Failed to open document");
    }
  };

  const stateChip = (state: AccessState) => {
    if (state === "ready") return <Chip color="success" variant="flat" size="sm">Ready</Chip>;
    if (state === "approved_key_missing") return <Chip color="warning" variant="flat" size="sm">Key Needed</Chip>;
    if (state === "request_pending") return <Chip color="warning" variant="flat" size="sm">Pending</Chip>;
    if (state === "request_rejected") return <Chip color="danger" variant="flat" size="sm">Rejected</Chip>;
    if (state === "request_expired") return <Chip color="danger" variant="flat" size="sm">Expired</Chip>;
    if (state === "no_pass") return <Chip color="default" variant="flat" size="sm">No Pass</Chip>;
    return <Chip color="primary" variant="flat" size="sm">Can Request</Chip>;
  };

  const inboxStatusChip = (status: InboxKeyStatus) => {
    if (status === "ready") {
      return <Chip color="success" variant="flat" size="sm">Ready</Chip>;
    }
    if (status === "awaiting_approval") {
      return <Chip color="warning" variant="flat" size="sm">Awaiting Approval</Chip>;
    }
    if (status === "wrong_contract") {
      return <Chip color="danger" variant="flat" size="sm">Wrong Contract</Chip>;
    }
    return <Chip color="danger" variant="flat" size="sm">Wrong Network</Chip>;
  };

  if (!isConnected) {
    return (
      <div className="space-y-8">
        <div className="rounded-2xl bg-gradient-to-r from-gray-900/50 to-[#040306] border border-gray-800 p-8 text-center">
          <div className="w-20 h-20 bg-gradient-to-br from-brand-700 to-brand-900 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <FiShield className="text-white text-3xl" />
          </div>
          <h1 className="text-3xl font-bold mb-4">Connect Your Wallet</h1>
          <p className="text-gray-400 mb-8 max-w-2xl mx-auto">
            Connect beneficiary wallet to request and decrypt approved documents.
          </p>
          <Button size="lg" className={buttonClasses.primaryLg} onPress={connect} startContent={<FiKey />}>
            Connect Wallet
          </Button>
        </div>
      </div>
    );
  }

  if (ecosystem !== "stellar" && !isFujiNetwork) {
    return (
      <div className="space-y-8">
        <div className="rounded-2xl bg-gradient-to-r from-yellow-500/10 to-orange-500/10 border border-yellow-500/30 p-8 text-center">
          <div className="w-20 h-20 bg-gradient-to-br from-yellow-500 to-orange-500 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <FiAlertCircle className="text-white text-3xl" />
          </div>
          <h1 className="text-3xl font-bold mb-4">Wrong Network</h1>
          <p className="text-gray-400 mb-8 max-w-2xl mx-auto">
            Please switch to Avalanche Fuji Testnet to use beneficiary access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-2">My Access</h1>
          <p className="text-gray-400">
            Beneficiary dashboard for access requests, approvals, and decryption readiness
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <input
            ref={keyImportInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0] ?? null;
              await handleImportKeyBackup(file);
              event.target.value = "";
            }}
          />
          <Button
            className={`${buttonClasses.primaryMd} w-full sm:w-auto`}
            startContent={<FiUpload />}
            onPress={() => keyImportInputRef.current?.click()}
          >
            Import Beneficiary Package
          </Button>
          <Button
            className={`${buttonClasses.outlineMd} w-full sm:w-auto`}
            startContent={<FiDownload />}
            isLoading={fetchingInboxKeys}
            onPress={handleFetchInboxKeys}
          >
            Fetch Inbox Keys
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
          <CardBody className="p-6">
            <p className="text-gray-400 text-sm">Vault Passes</p>
            <p className="text-2xl font-bold mt-1">{tokens.length}</p>
          </CardBody>
        </Card>
        <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
          <CardBody className="p-6">
            <p className="text-gray-400 text-sm">Approved + Key Missing</p>
            <p className="text-2xl font-bold mt-1">
              {rows.filter((r) => r.state === "approved_key_missing").length}
            </p>
          </CardBody>
        </Card>
        <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
          <CardBody className="p-6">
            <p className="text-gray-400 text-sm">Ready to Open</p>
            <p className="text-2xl font-bold mt-1">{rows.filter((r) => r.state === "ready").length}</p>
          </CardBody>
        </Card>
      </div>

      <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
        <CardBody className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-400">Inbox Keys</p>
              <p className="text-lg font-semibold">{inboxEnvelopeCount} envelope{inboxEnvelopeCount === 1 ? "" : "s"} found</p>
            </div>
            <Button
              className={buttonClasses.outlineSm}
              isLoading={fetchingInboxKeys}
              onPress={handleFetchInboxKeys}
            >
              Refresh Inbox
            </Button>
          </div>
          {inboxPreviewItems.length > 0 ? (
            <div className="space-y-2">
              {inboxPreviewItems.map((item) => (
                <div
                  key={`${item.documentId}-${item.issuedAt}-${item.status}`}
                  className="rounded-xl border border-gray-800/80 bg-gray-900/55 px-3 py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
                >
                  <div className="text-sm">
                    <p className="font-medium">Document #{item.documentId}</p>
                    <p className="text-xs text-gray-400">{item.vaultName}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.issuedAt ? (
                      <span className="text-xs text-gray-500">{new Date(item.issuedAt).toLocaleString()}</span>
                    ) : null}
                    {inboxStatusChip(item.status)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-500">
              Click "Fetch Inbox Keys" to see which documents have shared keys.
            </p>
          )}
        </CardBody>
      </Card>

      <div className="flex flex-col sm:flex-row gap-4">
        <Input
          placeholder="Search by name, vault, or hash..."
          startContent={<FiSearch className="text-gray-400" />}
          value={search}
          onValueChange={setSearch}
          className="flex-1"
        />
        {(hasVaultFilter || accessibleOnly) && (
          <Button
            className={buttonClasses.ghostMd}
            onPress={() => {
              setSearchParams({});
            }}
          >
            Clear Filter
          </Button>
        )}
      </div>

      <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
        <CardBody className="p-0">
          <Table aria-label="Beneficiary access table" removeWrapper>
            <TableHeader>
              <TableColumn>DOCUMENT</TableColumn>
              <TableColumn>VAULT</TableColumn>
              <TableColumn>STATE</TableColumn>
              <TableColumn>REQUEST</TableColumn>
              <TableColumn>ACTIONS</TableColumn>
            </TableHeader>
            <TableBody emptyContent={loading ? "Loading access records..." : "No documents found"}>
              {filteredRows.map((item) => {
                const latest = item.latestRequest;
                const requestText = latest
                  ? `#${latest.requestId} • ${formatDate(latest.createdAt)}`
                  : "-";
                const canRequest = item.state === "can_request" || item.state === "request_expired" || item.state === "request_rejected";
                const canDecrypt = item.state === "ready";
                const isApprovedState = item.state === "ready" || item.state === "approved_key_missing";
                const needsKeyImport = item.state === "approved_key_missing";
                const requestActionLabel =
                  item.state === "request_pending"
                    ? "Pending"
                    : item.state === "no_pass"
                        ? "Need Pass"
                        : "Request Access";
                const vaultName = vaultNameById[item.doc.vaultId] || `Vault #${item.doc.vaultId}`;

                return (
                  <TableRow key={item.doc.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{item.name}</p>
                        <p className="text-xs text-gray-400">
                          {item.type} • uploader {shortenAddress(item.doc.uploadedBy)}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>{vaultName}</TableCell>
                    <TableCell>{stateChip(item.state)}</TableCell>
                    <TableCell>{requestText}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 flex-wrap">
                        {!isApprovedState && (
                          <Button
                            size="sm"
                            className={buttonClasses.outlineSm}
                            isDisabled={!canRequest || requestingDocId === item.doc.id}
                            isLoading={requestingDocId === item.doc.id}
                            onPress={() => handleRequestAccess(item.doc.id)}
                          >
                            {requestActionLabel}
                          </Button>
                        )}
                        {needsKeyImport && (
                          <Button
                            size="sm"
                            className={buttonClasses.outlineSm}
                            onPress={() => keyImportInputRef.current?.click()}
                          >
                            Import Key
                          </Button>
                        )}
                        <Button
                          isIconOnly
                          variant="light"
                          size="sm"
                          isDisabled={!canDecrypt}
                          onPress={() => handleView(item.doc)}
                        >
                          <FiEye />
                        </Button>
                        <Button
                          isIconOnly
                          variant="light"
                          size="sm"
                          isDisabled={!canDecrypt}
                          onPress={() => handleDownload(item.doc)}
                        >
                          <FiDownload />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardBody>
      </Card>

      <div className="rounded-xl border border-gray-800/80 bg-gray-900/60 p-4 text-sm text-gray-300 flex items-start gap-2">
        <FiClock className="mt-0.5 text-gray-500" />
        <div>
          <p className="font-medium text-gray-200">Flow reminder</p>
          <p className="text-gray-400">
            Beneficiary needs vault pass NFT + guardian-approved request + key (Fetch Inbox Keys or import package).
          </p>
          <p className="text-gray-500 mt-1">
            Security mode: imported keys are cached for this browser session and cleared when the session ends.
          </p>
        </div>
      </div>
    </div>
  );
};

export default AccessCenter;

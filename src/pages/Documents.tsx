import { useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  CardBody,
  Input,
  Button,
  Chip,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from "@heroui/react";
import {
  FiSearch,
  FiFilter,
  FiChevronDown,
  FiUpload,
  FiFile,
  FiShield,
  FiKey,
  FiAlertCircle,
  FiLoader,
  FiFileText,
} from "react-icons/fi";
import CryptoJS from "crypto-js";
import { useWeb3 } from "../context/Web3Context";
import {
  contractService,
  VaultData,
  DocumentData,
  AccessRequestData,
} from "../services/contract.service";
import {
  decryptData,
  encryptData,
  fetchFromIPFS,
  generateEncryptionKey,
  isIPFSConfigured,
  shortenAddress,
  formatFileSize,
  isValidAddress,
} from "../utils/helpers";
import { toast } from "react-hot-toast";
import { buttonClasses } from "../utils/buttonClasses";
import { captureError } from "../services/telemetry.service";
import { keyInboxService } from "../services/keyInbox.service";
import { keyStoreService } from "../services/keyStore.service";
import {
  splitSecretVSS,
  parseEncryptedMetadataPayload,
} from "../services/secrets.service";
import { encryptWithPublicKey } from "../utils/crypto";
import { VirtualizedDocumentsList } from "../components/documents/VirtualizedDocumentsList";
import {
  collectStream,
  decryptStream,
  detectStreamingCiphertext,
  encryptAndUploadFile,
  importStreamingKey,
} from "../services/streamingCrypto.service";

type WordArray = { words: number[]; sigBytes: number };
type ImportedKeyPayload = {
  documentId?: number | string;
  key?: string;
  beneficiary?: string;
  contract?: string;
  chainId?: number | string;
  type?: string;
};
type UploadStage =
  | "idle"
  | "encrypting"
  | "uploading_ipfs"
  | "submitting_tx"
  | "confirming_tx"
  | "finalizing";

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

const decryptLegacyCiphertext = async (
  encryptedText: string,
  key: string
): Promise<Uint8Array> => {
  const decryptedWordArray = CryptoJS.AES.decrypt(encryptedText, key);
  return wordArrayToUint8Array(decryptedWordArray);
};

const Documents = () => {
  const { isOpen, onOpen, onClose } = useDisclosure();
  const {
    isOpen: isShareModalOpen,
    onOpen: onShareModalOpen,
    onClose: onShareModalClose,
  } = useDisclosure();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "accessible" | "encrypted">(
    "all"
  );
  const {
    account,
    isConnected,
    connect,
    provider,
    signer,
    isFujiNetwork,
    ecosystem,
  } = useWeb3();

  const [documents, setDocuments] = useState<DocumentData[]>([]);
  const [vaults, setVaults] = useState<VaultData[]>([]);
  const [uploadableVaults, setUploadableVaults] = useState<VaultData[]>([]);
  const [activeAccessByDoc, setActiveAccessByDoc] = useState<
    Record<number, boolean>
  >({});
  const [latestRequestByDoc, setLatestRequestByDoc] = useState<
    Record<number, AccessRequestData | null>
  >({});
  const [releaseConditionByDoc, setReleaseConditionByDoc] = useState<
    Record<number, number>
  >({});
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadStage, setUploadStage] = useState<UploadStage>("idle");
  const [uploadAbortController, setUploadAbortController] =
    useState<AbortController | null>(null);
  const [requestingDocId, setRequestingDocId] = useState<number | null>(null);

  const [selectedVaultId, setSelectedVaultId] = useState<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [accessLevel, setAccessLevel] = useState<number>(0);
  const [releaseCondition, setReleaseCondition] = useState<number>(0);

  const [showKeyModal, setShowKeyModal] = useState(false);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [lastDocumentId, setLastDocumentId] = useState<number | null>(null);
  const [keyBackupConfirmed, setKeyBackupConfirmed] = useState(false);
  const [shareTargetDocId, setShareTargetDocId] = useState<number | null>(null);
  const [shareRecipient, setShareRecipient] = useState("");
  const [sendingInboxKey, setSendingInboxKey] = useState(false);
  const keyImportInputRef = useRef<HTMLInputElement | null>(null);
  const stepChipClass =
    "bg-brand-700/12 text-brand-300 border border-brand-700/35";
  const selectFieldWithIconClass =
    "h-11 w-full rounded-full border border-gray-700/80 bg-gray-900/75 pl-10 pr-10 text-sm text-gray-100 outline-none transition-colors hover:border-gray-600 focus:border-brand-700/70";
  const selectFieldClass =
    "h-11 w-full rounded-full border border-gray-700/80 bg-gray-900/75 px-4 pr-10 text-sm text-gray-100 outline-none transition-colors hover:border-gray-600 focus:border-brand-700/70";

  useEffect(() => {
    setUploadableVaults([]);
    setActiveAccessByDoc({});
    setLatestRequestByDoc({});
    setReleaseConditionByDoc({});
    setDocuments([]);
    setVaults([]);
    setLoading(true);
  }, [ecosystem]);

  useEffect(() => {
    if (
      isConnected &&
      ((provider && signer && isFujiNetwork) || ecosystem === "stellar")
    ) {
      if (provider && signer) {
        contractService.initialize(provider, signer);
      }
      loadData();
    } else {
      setUploadableVaults([]);
      setActiveAccessByDoc({});
      setLatestRequestByDoc({});
      setReleaseConditionByDoc({});
      setLoading(false);
    }
  }, [account, isConnected, provider, signer, isFujiNetwork, ecosystem]);

  const loadData = async () => {
    if (!account) {
      setVaults([]);
      setUploadableVaults([]);
      setDocuments([]);
      setActiveAccessByDoc({});
      setLatestRequestByDoc({});
      setReleaseConditionByDoc({});
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const vaultsData = await contractService.fetchVaultsForAccount(account);
      const docsData = await contractService.fetchDocumentsForVaults(
        vaultsData.map((vault) => vault.id)
      );

      const accountLower = account.toLowerCase();
      const visibleVaults = vaultsData;
      const guardianVaults = visibleVaults.filter((vault) =>
        vault.guardians.some(
          (guardian) => guardian.toLowerCase() === accountLower
        )
      );
      const guardianVaultIds = new Set<number>(
        guardianVaults.map((vault) => vault.id)
      );

      const visibleVaultIds = new Set<number>(
        visibleVaults.map((vault) => vault.id)
      );
      const scopedDocs = docsData.filter((doc) =>
        visibleVaultIds.has(doc.vaultId)
      );
      const docIds = scopedDocs.map((doc) => doc.id);

      const accessMap = await contractService.getActiveAccessMap(
        account,
        docIds
      );
      const requestMap = await contractService.getLatestRequestsForUser(
        account,
        docIds
      );
      const releaseMap = await contractService.getDocumentReleaseConditionMap(
        docIds
      );

      setVaults(visibleVaults);
      setUploadableVaults(guardianVaults);
      setDocuments(scopedDocs);
      setSelectedVaultId((previous) =>
        previous !== null && guardianVaultIds.has(previous) ? previous : null
      );
      setActiveAccessByDoc(accessMap);
      setLatestRequestByDoc(requestMap);
      setReleaseConditionByDoc(releaseMap);
    } catch (error) {
      console.error("Error loading documents:", error);
      captureError("documents.loadData", error, { account: account || "" });
      const message =
        error instanceof Error ? error.message : "Failed to load documents";
      toast.error(message);
      setUploadableVaults([]);
      setActiveAccessByDoc({});
      setLatestRequestByDoc({});
      setReleaseConditionByDoc({});
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

  const getStoredKey = (docId: number): string | null => {
    return keyStoreService.get(docId);
  };

  const decryptMetadata = (
    doc: DocumentData
  ): { name?: string; size?: number; type?: string } | null => {
    const key = getStoredKey(doc.id);
    if (!key) return null;
    try {
      const { ciphertext } = parseEncryptedMetadataPayload(
        doc.encryptedMetadata
      );
      const raw = decryptData(ciphertext, key);
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const downloadKeyBackupFile = (docId: number, key: string) => {
    const payload = {
      version: 1,
      app: "SpooVault",
      contract: import.meta.env.VITE_CONTRACT_ADDRESS || "",
      documentId: docId,
      key,
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `spoovault-doc-${docId}-key-backup.json`;
    link.click();
    URL.revokeObjectURL(url);
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
        throw new Error("Invalid backup file: missing documentId");
      }
      if (!/^[a-fA-F0-9]{64}$/.test(key)) {
        throw new Error("Invalid backup file: key format is not recognized");
      }
      if (beneficiary) {
        if (!isValidAddress(beneficiary)) {
          throw new Error(
            "Invalid key package: beneficiary wallet address is invalid"
          );
        }
        if (!account) {
          throw new Error(
            "Connect the beneficiary wallet before importing this key package"
          );
        }
        if (beneficiary.toLowerCase() !== account.toLowerCase()) {
          throw new Error("This key package is issued for a different wallet");
        }
      }
      if (
        fileContract &&
        expectedContract &&
        fileContract !== expectedContract
      ) {
        throw new Error(
          "This key package is for a different SpooVault contract"
        );
      }
      if (
        Number.isFinite(fileChainId) &&
        Number.isFinite(expectedChainId) &&
        fileChainId > 0 &&
        expectedChainId > 0 &&
        fileChainId !== expectedChainId
      ) {
        throw new Error(
          "This key package is for a different blockchain network"
        );
      }

      keyStoreService.set(documentId, key);
      toast.success(`Key imported for Document #${documentId}`);
      await loadData();
    } catch (error: any) {
      captureError("documents.importKeyBackup", error);
      toast.error(error.message || "Failed to import key backup");
    }
  };

  const handleCloseKeyModal = () => {
    if (!keyBackupConfirmed) {
      toast.error("Back up the key before closing this dialog.");
      return;
    }

    setShowKeyModal(false);
    setLastKey(null);
    setLastDocumentId(null);
    setKeyBackupConfirmed(false);
  };

  const resetShareModal = () => {
    setShareTargetDocId(null);
    setShareRecipient("");
    onShareModalClose();
  };

  const openShareModalForDocument = (documentId: number) => {
    const key = getStoredKey(documentId);
    if (!key) {
      toast.error("Key not found locally for this document");
      return;
    }
    setShareTargetDocId(documentId);
    setShareRecipient("");
    onShareModalOpen();
  };

  const downloadBeneficiaryKeyPackage = async () => {
    if (!shareTargetDocId) {
      toast.error("Select a document first");
      return;
    }

    const recipient = shareRecipient.trim();
    if (!isValidAddress(recipient)) {
      toast.error("Enter a valid beneficiary wallet address");
      return;
    }

    const key = getStoredKey(shareTargetDocId);
    if (!key) {
      toast.error("Encryption key is missing for this document");
      return;
    }

    const selectedDoc = documents.find((doc) => doc.id === shareTargetDocId);
    if (!selectedDoc) {
      toast.error("Document details not found");
      return;
    }

    try {
      const beneficiaryPubKey = await contractService.getUserPublicKey(
        recipient
      );
      if (!beneficiaryPubKey) {
        toast.error(
          "The beneficiary has not registered their encryption public key. Ask them to register it in their Profile page first."
        );
        return;
      }

      const encryptedKey = await encryptWithPublicKey(key, beneficiaryPubKey);

      const payload = {
        version: 1,
        type: "beneficiary_key_package",
        app: "SpooVault",
        contract: import.meta.env.VITE_CONTRACT_ADDRESS || "",
        chainId: Number(import.meta.env.VITE_CHAIN_ID) || 0,
        vaultId: selectedDoc.vaultId,
        documentId: shareTargetDocId,
        beneficiary: recipient.toLowerCase(),
        issuedBy: account || "",
        issuedAt: new Date().toISOString(),
        key: encryptedKey,
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `spoovault-doc-${shareTargetDocId}-beneficiary-key.json`;
      link.click();
      URL.revokeObjectURL(url);

      if (account) {
        try {
          const flagKey = `spoovault-beneficiary-package-exported-${account.toLowerCase()}`;
          localStorage.setItem(flagKey, "1");
          window.dispatchEvent(
            new Event("spoovault-beneficiary-package-exported")
          );
        } catch {
          // ignore localStorage errors
        }
      }

      toast.success("Beneficiary key package downloaded");
      resetShareModal();
    } catch (error: any) {
      captureError("documents.downloadKeyPackage", error);
      toast.error(error.message || "Failed to generate key package");
    }
  };

  const sendBeneficiaryKeyToInbox = async () => {
    if (!shareTargetDocId) {
      toast.error("Select a document first");
      return;
    }
    if (!account) {
      toast.error("Connect wallet first");
      return;
    }

    const recipient = shareRecipient.trim();
    if (!isValidAddress(recipient)) {
      toast.error("Enter a valid beneficiary wallet address");
      return;
    }

    const key = getStoredKey(shareTargetDocId);
    if (!key) {
      toast.error("Encryption key is missing for this document");
      return;
    }

    const selectedDoc = documents.find((doc) => doc.id === shareTargetDocId);
    if (!selectedDoc) {
      toast.error("Document details not found");
      return;
    }

    if (!keyInboxService.isConfigured()) {
      toast.error("IPFS is not configured");
      return;
    }

    setSendingInboxKey(true);
    try {
      const beneficiaryPubKey = await contractService.getUserPublicKey(
        recipient
      );
      if (!beneficiaryPubKey) {
        toast.error(
          "The beneficiary has not registered their encryption public key. Ask them to register it in their Profile page first."
        );
        return;
      }

      const encryptedKey = await encryptWithPublicKey(key, beneficiaryPubKey);

      await keyInboxService.sendKeyEnvelope({
        version: 1,
        type: "beneficiary_key_envelope",
        app: "SpooVault",
        contract: import.meta.env.VITE_CONTRACT_ADDRESS || "",
        chainId: Number(import.meta.env.VITE_CHAIN_ID) || 0,
        vaultId: selectedDoc.vaultId,
        documentId: shareTargetDocId,
        beneficiary: recipient.toLowerCase(),
        issuedBy: account.toLowerCase(),
        issuedAt: new Date().toISOString(),
        key: encryptedKey,
      });

      try {
        const flagKey = `spoovault-beneficiary-package-exported-${account.toLowerCase()}`;
        localStorage.setItem(flagKey, "1");
        window.dispatchEvent(
          new Event("spoovault-beneficiary-package-exported")
        );
      } catch {
        // ignore localStorage errors
      }

      toast.success("Key sent to beneficiary in-app inbox");
      resetShareModal();
    } catch (error: any) {
      captureError("documents.sendBeneficiaryKeyToInbox", error, {
        documentId: shareTargetDocId,
      });
      toast.error(error?.message || "Failed to send key to beneficiary inbox");
    } finally {
      setSendingInboxKey(false);
    }
  };

  const documentsWithMetadata = useMemo(() => {
    const nowInSeconds = Math.floor(Date.now() / 1000);

    return documents.map((doc) => {
      const metadata = decryptMetadata(doc);
      const hasChainAccess = !!activeAccessByDoc[doc.id];
      const hasLocalKey = !!metadata;
      const latestRequest = latestRequestByDoc[doc.id] ?? null;
      const isRequestPending =
        !!latestRequest &&
        latestRequest.status === 0 &&
        latestRequest.expiresAt > nowInSeconds;

      return {
        doc,
        metadata,
        name: metadata?.name || `Document #${doc.id}`,
        vaultName: vaultNameById[doc.vaultId] || `Vault #${doc.vaultId}`,
        hasChainAccess,
        hasLocalKey,
        canDecrypt: hasChainAccess && hasLocalKey,
        latestRequest,
        isRequestPending,
        releaseCondition: releaseConditionByDoc[doc.id] ?? 0,
      };
    });
  }, [
    documents,
    vaultNameById,
    activeAccessByDoc,
    latestRequestByDoc,
    releaseConditionByDoc,
  ]);

  const filteredDocuments = documentsWithMetadata
    .filter((item) => {
      const term = search.toLowerCase();
      return (
        item.name.toLowerCase().includes(term) ||
        item.vaultName.toLowerCase().includes(term) ||
        item.doc.ipfsHash.toLowerCase().includes(term) ||
        item.doc.uploadedBy.toLowerCase().includes(term)
      );
    })
    .filter((item) => {
      if (filter === "accessible") return item.hasChainAccess;
      if (filter === "encrypted") return !item.hasChainAccess;
      return true;
    });

  const selectedShareDocument = useMemo(() => {
    if (!shareTargetDocId) {
      return null;
    }
    return (
      documentsWithMetadata.find((item) => item.doc.id === shareTargetDocId) ||
      null
    );
  }, [documentsWithMetadata, shareTargetDocId]);

  const accessLabel = (level: number) => {
    if (level === 2) return "admin";
    if (level === 1) return "read_write";
    return "read";
  };

  const releaseConditionLabel = (condition: number) => {
    if (condition === 1) return "live_only";
    if (condition === 2) return "emergency_only";
    if (condition === 3) return "post_death_only";
    return "anytime";
  };

  const uploadStageLabel = (stage: UploadStage): string => {
    if (stage === "encrypting") return "Encrypting file locally";
    if (stage === "uploading_ipfs") return "Uploading encrypted file to IPFS";
    if (stage === "submitting_tx") return "Submitting blockchain transaction";
    if (stage === "confirming_tx")
      return "Waiting for transaction confirmation";
    if (stage === "finalizing") return "Finalizing and refreshing data";
    return "Idle";
  };

  const isUploadAbortable =
    uploading &&
    (uploadStage === "encrypting" || uploadStage === "uploading_ipfs");

  const handleAbortUpload = () => {
    if (!isUploadAbortable || !uploadAbortController) {
      toast.error("Upload can only be aborted before blockchain submission.");
      return;
    }
    uploadAbortController.abort();
    setUploadAbortController(null);
  };

  const handleUpload = async () => {
    if (!isConnected) {
      toast.error("Please connect your wallet first");
      await connect();
      return;
    }

    if (!isFujiNetwork) {
      toast.error("Please switch to Avalanche Fuji network");
      return;
    }

    if (!selectedFile) {
      toast.error("Please select a file to upload");
      return;
    }

    if (!selectedVaultId) {
      toast.error("Please select a vault");
      return;
    }
    const vault = uploadableVaults.find((v) => v.id === selectedVaultId);
    if (!vault) {
      toast.error(
        "You can only upload into vaults where your wallet is an active guardian."
      );
      return;
    }

    if (!isIPFSConfigured()) {
      toast.error("IPFS is not configured");
      return;
    }

    const abortController = new AbortController();
    setUploading(true);
    setUploadAbortController(abortController);
    try {
      setUploadStage("encrypting");

      // Fetch public keys for all guardians of this vault
      const missingKeys: string[] = [];
      const guardianPubKeys: Record<string, string> = {};
      for (const guardian of vault.guardians) {
        const pubKey = await contractService.getUserPublicKey(guardian);
        if (pubKey) {
          guardianPubKeys[guardian] = pubKey;
        } else {
          missingKeys.push(guardian);
        }
      }

      if (missingKeys.length > 0) {
        const short = missingKeys
          .map((addr) => shortenAddress(addr, 4))
          .join(", ");
        throw new Error(
          `Cannot upload. Guardians missing encryption public keys: ${short}. They must register their keys in their Profile page first.`
        );
      }

      const key = generateEncryptionKey();
      const metadata = {
        name: selectedFile.name,
        size: selectedFile.size,
        type: selectedFile.type,
        lastModified: selectedFile.lastModified,
      };

      // Split symmetric key using Feldmann Verifiable Secret Sharing (VSS)
      const { shares: keyShares, commitments } = splitSecretVSS(
        key,
        vault.guardians.length,
        vault.approvalThreshold
      );

      const ciphertext = encryptData(JSON.stringify(metadata), key);
      const encryptedMetadata = JSON.stringify({
        ciphertext,
        commitments,
      });


      // Encrypt each share for each guardian using their public key
      const encryptedShares: string[] = [];
      for (let i = 0; i < vault.guardians.length; i++) {
        const guardian = vault.guardians[i];
        const pubKey = guardianPubKeys[guardian];
        const share = keyShares[i];
        const encrypted = await encryptWithPublicKey(share, pubKey);
        encryptedShares.push(encrypted);
      }

      setUploadStage("uploading_ipfs");
      // Stream AES-GCM chunked ciphertext directly to Pinata/IPFS (O(chunk) RAM).
      const ipfsResult = await encryptAndUploadFile(selectedFile, key, {
        filename: `${selectedFile.name}.svsc`,
        metadata: { name: selectedFile.name },
        signal: abortController.signal,
      });

      setUploadStage("submitting_tx");
      const documentId = await contractService.addDocument(
        selectedVaultId,
        encryptedMetadata,
        ipfsResult.hash,
        accessLevel,
        releaseCondition,
        vault.guardians,
        encryptedShares
      );
      setUploadStage("confirming_tx");

      if (!documentId) {
        toast.error("Document uploaded but ID was not returned");
      } else {
        keyStoreService.set(documentId, key);
        setLastKey(key);
        setLastDocumentId(documentId);
        setKeyBackupConfirmed(false);
        setShowKeyModal(true);
        toast.success("Document uploaded successfully");
      }

      setUploadStage("finalizing");
      setSelectedFile(null);
      setSelectedVaultId(null);
      setAccessLevel(0);
      setReleaseCondition(0);
      onClose();
      loadData();
    } catch (error: any) {
      captureError("documents.handleUpload", error, {
        vaultId: selectedVaultId || 0,
        releaseCondition,
      });
      const message = error?.message || "Failed to upload document";
      const isCanceled =
        message.toLowerCase().includes("canceled") ||
        message.toLowerCase().includes("cancelled");
      toast.error(isCanceled ? "Upload canceled." : message);
    } finally {
      setUploading(false);
      setUploadStage("idle");
      setUploadAbortController(null);
    }
  };

  const decryptFileFromIPFS = async (doc: DocumentData) => {
    if (!account) {
      throw new Error("Please connect your wallet");
    }

    const hasAccess = await contractService.hasActiveAccess(doc.id, account);
    setActiveAccessByDoc((prev) => ({ ...prev, [doc.id]: hasAccess }));
    if (!hasAccess) {
      throw new Error("No active on-chain access for this document");
    }

    const key = getStoredKey(doc.id);
    if (!key) {
      throw new Error("Encryption key not found for this document");
    }

    const response = await fetchFromIPFS(doc.ipfsHash);
    if (!response.body) {
      throw new Error("Empty response received from IPFS");
    }

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
    const bytes = await decryptLegacyCiphertext(encryptedText, key);
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

        // Browsers without File System Access API: collect decrypted bytes.
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
      captureError("documents.handleDownload", error, { documentId: doc.id });
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
      captureError("documents.handleView", error, { documentId: doc.id });
      toast.error(error.message || "Failed to open document");
    }
  };

  const handleRequestAccess = async (docId: number) => {
    if (!isConnected) {
      toast.error("Please connect your wallet first");
      await connect();
      return;
    }

    if (!isFujiNetwork) {
      toast.error("Please switch to Avalanche Fuji network");
      return;
    }

    setRequestingDocId(docId);
    try {
      const requestId = await contractService.requestAccess(docId);
      if (!requestId) {
        toast.error("Request submitted but ID was not returned");
      } else {
        toast.success(`Access request #${requestId} submitted`);
      }
      await loadData();
    } catch (error: any) {
      captureError("documents.handleRequestAccess", error, {
        documentId: docId,
      });
      toast.error(error.message || "Failed to request access");
    } finally {
      setRequestingDocId(null);
    }
  };

  const handleCopyIpfsHash = async (ipfsHash: string) => {
    try {
      await navigator.clipboard.writeText(ipfsHash);
      toast.success("IPFS hash copied");
    } catch {
      toast.error("Failed to copy IPFS hash");
    }
  };

  const accessibleCount = documentsWithMetadata.filter(
    (item) => item.hasChainAccess
  ).length;

  if (!isConnected) {
    return (
      <div className="space-y-8">
        <div className="rounded-2xl bg-gradient-to-r from-gray-900/50 to-[#040306] border border-gray-800 p-8 text-center">
          <div className="w-20 h-20 bg-gradient-to-br from-brand-700 to-brand-900 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <FiFileText className="text-white text-3xl" />
          </div>
          <h1 className="text-3xl font-bold mb-4">Connect Your Wallet</h1>
          <p className="text-gray-400 mb-8 max-w-2xl mx-auto">
            Connect your wallet to upload and manage encrypted family documents
            on Avalanche.
          </p>
          <Button
            size="lg"
            className={buttonClasses.primaryLg}
            onPress={connect}
            startContent={<FiUpload />}
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
            Please switch to Avalanche Fuji Testnet to manage documents.
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
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-2">Secure Documents</h1>
          <p className="text-gray-400">
            Manage encrypted files for daily sharing, emergency access, and
            inheritance plans
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
            className={`${buttonClasses.ghostMd} w-full sm:w-auto`}
            startContent={<FiKey />}
            onPress={() => keyImportInputRef.current?.click()}
          >
            Import Key Backup
          </Button>
          <Button
            className={`${buttonClasses.primaryMd} w-full sm:w-auto`}
            startContent={<FiUpload />}
            onPress={onOpen}
          >
            Upload Document
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
          <CardBody className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Total Files</p>
                <p className="text-2xl font-bold">{documents.length}</p>
              </div>
              <div className="p-3 rounded-lg bg-blue-500/20">
                <FiFile className="text-blue-400 text-xl" />
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
          <CardBody className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Access Allowed</p>
                <p className="text-2xl font-bold">{accessibleCount}</p>
              </div>
              <div className="p-3 rounded-lg bg-green-500/20">
                <FiKey className="text-green-400 text-xl" />
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
          <CardBody className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Access Vaults</p>
                <p className="text-2xl font-bold">{vaults.length}</p>
              </div>
              <div className="p-3 rounded-lg bg-purple-500/20">
                <FiShield className="text-purple-400 text-xl" />
              </div>
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <Input
          placeholder="Search documents..."
          startContent={<FiSearch className="text-gray-400" />}
          value={search}
          onValueChange={setSearch}
          className="flex-1"
        />
        <div className="relative w-full sm:w-52">
          <FiFilter className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as typeof filter)}
            className={selectFieldWithIconClass}
          >
            <option value="all">All Files</option>
            <option value="accessible">Access Allowed</option>
            <option value="encrypted">Locked</option>
          </select>
          <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-500" />
        </div>
      </div>

      <Card className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm">
        <CardBody className="p-0">
          <VirtualizedDocumentsList
            items={filteredDocuments}
            loading={loading}
            requestingDocId={requestingDocId}
            accessLabel={accessLabel}
            releaseConditionLabel={releaseConditionLabel}
            onView={handleView}
            onDownload={handleDownload}
            onRequestAccess={handleRequestAccess}
            onShareKey={openShareModalForDocument}
            onCopyIpfsHash={handleCopyIpfsHash}
          />
        </CardBody>
      </Card>

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
        <ModalContent className="bg-gray-950 w-[94vw] max-w-2xl max-h-[86vh] overflow-hidden border border-gray-800/90 shadow-2xl">
          <ModalHeader className="flex items-center gap-3 border-b border-gray-800/80 px-4 sm:px-6 py-4">
            <div className="w-10 h-10 bg-gradient-to-br from-brand-700 to-brand-900 rounded-xl flex items-center justify-center">
              <FiUpload className="text-white" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Upload Document</h2>
              <p className="text-sm text-gray-400">
                Encrypt locally, then pin to IPFS for controlled access and
                future release
              </p>
            </div>
          </ModalHeader>
          <ModalBody className="modal-scroll max-h-[70vh] overflow-y-auto px-4 sm:px-6 py-4">
            <div className="space-y-5">
              <div className="rounded-2xl border border-gray-800/85 bg-gray-900/78 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">Document</p>
                    <p className="text-xs text-gray-400">
                      Select the document to encrypt
                    </p>
                  </div>
                  <Chip size="sm" variant="flat" className={stepChipClass}>
                    Step 1
                  </Chip>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-gray-300 font-medium">
                    Select File
                  </p>
                  <input
                    type="file"
                    onChange={(event) =>
                      setSelectedFile(event.target.files?.[0] ?? null)
                    }
                    className="block w-full rounded-xl border border-gray-700/80 bg-gray-900/75 px-3 py-2 text-sm text-gray-100 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-200 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-900 hover:file:bg-gray-100"
                  />
                </div>
                {selectedFile && (
                  <div className="flex items-center justify-between text-xs text-gray-400">
                    <span>{selectedFile.name}</span>
                    <span>{formatFileSize(selectedFile.size)}</span>
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-gray-800/85 bg-gray-900/78 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">Access Vault</p>
                    <p className="text-xs text-gray-400">
                      Choose where to store this file
                    </p>
                  </div>
                  <Chip size="sm" variant="flat" className={stepChipClass}>
                    Step 2
                  </Chip>
                </div>
                <div className="relative">
                  <select
                    value={selectedVaultId ? String(selectedVaultId) : ""}
                    onChange={(event) =>
                      setSelectedVaultId(
                        event.target.value ? Number(event.target.value) : null
                      )
                    }
                    className={selectFieldClass}
                  >
                    <option value="" disabled>
                      Select Vault
                    </option>
                    {uploadableVaults.map((vault) => (
                      <option key={vault.id} value={vault.id}>
                        {vault.name || `Vault #${vault.id}`}
                      </option>
                    ))}
                  </select>
                  <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-500" />
                </div>
                {uploadableVaults.length === 0 && (
                  <p className="text-sm text-yellow-400">
                    No guardian vaults available. Accept guardian invite or
                    create a vault first.
                  </p>
                )}
              </div>

              <div className="rounded-2xl border border-gray-800/85 bg-gray-900/78 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">Access Level</p>
                    <p className="text-xs text-gray-400">
                      Required access for this document
                    </p>
                  </div>
                  <Chip size="sm" variant="flat" className={stepChipClass}>
                    Step 3
                  </Chip>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Button
                    className={
                      accessLevel === 0
                        ? buttonClasses.primarySm
                        : buttonClasses.ghostSm
                    }
                    onPress={() => setAccessLevel(0)}
                  >
                    read
                  </Button>
                  <Button
                    className={
                      accessLevel === 1
                        ? buttonClasses.primarySm
                        : buttonClasses.ghostSm
                    }
                    onPress={() => setAccessLevel(1)}
                  >
                    read_write
                  </Button>
                  <Button
                    className={
                      accessLevel === 2
                        ? buttonClasses.primarySm
                        : buttonClasses.ghostSm
                    }
                    onPress={() => setAccessLevel(2)}
                  >
                    admin
                  </Button>
                </div>
                <p className="text-xs text-gray-500">
                  Selected: {accessLabel(accessLevel)}
                </p>
              </div>

              <div className="rounded-2xl border border-gray-800/85 bg-gray-900/78 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">Release Condition</p>
                    <p className="text-xs text-gray-400">
                      Define when this document can be requested
                    </p>
                  </div>
                  <Chip size="sm" variant="flat" className={stepChipClass}>
                    Step 4
                  </Chip>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Button
                    className={
                      releaseCondition === 0
                        ? buttonClasses.primarySm
                        : buttonClasses.ghostSm
                    }
                    onPress={() => setReleaseCondition(0)}
                  >
                    anytime
                  </Button>
                  <Button
                    className={
                      releaseCondition === 1
                        ? buttonClasses.primarySm
                        : buttonClasses.ghostSm
                    }
                    onPress={() => setReleaseCondition(1)}
                  >
                    live_only
                  </Button>
                  <Button
                    className={
                      releaseCondition === 2
                        ? buttonClasses.primarySm
                        : buttonClasses.ghostSm
                    }
                    onPress={() => setReleaseCondition(2)}
                  >
                    emergency_only
                  </Button>
                  <Button
                    className={
                      releaseCondition === 3
                        ? buttonClasses.primarySm
                        : buttonClasses.ghostSm
                    }
                    onPress={() => setReleaseCondition(3)}
                  >
                    post_death_only
                  </Button>
                </div>
                <p className="text-xs text-gray-500">
                  Selected: {releaseConditionLabel(releaseCondition)}
                </p>
              </div>

              <div className="p-4 bg-brand-700/10 border border-brand-700/20 rounded-2xl">
                <p className="text-sm">
                  <span className="font-medium">Note:</span> Files are encrypted
                  client-side before upload. Save the encryption key shown after
                  upload.
                </p>
                <p className="text-xs text-gray-400 mt-2">
                  Security mode: document keys are cached for the current
                  browser session only.
                </p>
              </div>
              {uploading && (
                <div className="p-4 bg-gray-900/70 border border-gray-700/70 rounded-2xl space-y-1">
                  <div className="flex items-center gap-2">
                    <FiLoader className="text-brand-400 animate-spin" />
                    <p className="text-sm font-medium">Upload Status</p>
                    <span className="inline-flex items-center gap-1 text-brand-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                      <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse [animation-delay:160ms]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse [animation-delay:320ms]" />
                    </span>
                  </div>
                  <p className="text-sm text-gray-300" aria-live="polite">
                    {uploadStageLabel(uploadStage)}
                  </p>
                </div>
              )}
            </div>
          </ModalBody>
          <ModalFooter className="border-t border-gray-800/80 px-4 sm:px-6 py-3 flex-col-reverse sm:flex-row gap-2">
            <Button
              className={`${buttonClasses.ghostMd} w-full sm:w-auto`}
              onPress={onClose}
              isDisabled={uploading}
            >
              Cancel
            </Button>
            <Button
              className={`${buttonClasses.outlineMd} w-full sm:w-auto`}
              onPress={handleAbortUpload}
              isDisabled={!uploading || !isUploadAbortable}
            >
              Abort Upload
            </Button>
            <Button
              className={`${buttonClasses.primaryMd} w-full sm:w-auto`}
              onPress={handleUpload}
              isLoading={uploading}
              isDisabled={
                uploadableVaults.length === 0 ||
                !selectedFile ||
                !selectedVaultId ||
                uploading
              }
            >
              {uploading ? uploadStageLabel(uploadStage) : "Upload Document"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={showKeyModal}
        onClose={handleCloseKeyModal}
        size="md"
        className="bg-gray-900"
        scrollBehavior="inside"
        placement="center"
      >
        <ModalContent className="bg-gray-900 w-[92vw] max-w-lg max-h-[80vh] overflow-hidden">
          <ModalHeader>Encryption Key Backup</ModalHeader>
          <ModalBody className="max-h-[70vh] overflow-y-auto">
            <p className="text-gray-400 text-sm">
              Save this key securely. Owners, guardians, or approved
              beneficiaries may need it to decrypt Document #{lastDocumentId}.
            </p>
            <div className="p-3 bg-gray-800/60 rounded-lg font-mono text-sm break-all">
              {lastKey}
            </div>
            <div className="rounded-xl border border-gray-700/70 bg-gray-900/65 p-3 space-y-2">
              <p className="text-sm font-medium">Recommended backup steps</p>
              <p className="text-xs text-gray-400">1. Download backup file</p>
              <p className="text-xs text-gray-400">
                2. Store in secure cloud/USB/password manager
              </p>
              <p className="text-xs text-gray-400">3. Keep at least 2 copies</p>
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-red-600"
                checked={keyBackupConfirmed}
                onChange={(event) =>
                  setKeyBackupConfirmed(event.target.checked)
                }
              />
              <span>I have copied or downloaded this key backup.</span>
            </label>
          </ModalBody>
          <ModalFooter className="flex-col-reverse sm:flex-row gap-2">
            <Button
              className={`${buttonClasses.ghostMd} w-full sm:w-auto`}
              onPress={handleCloseKeyModal}
              isDisabled={!keyBackupConfirmed}
            >
              Close
            </Button>
            <Button
              className={`${buttonClasses.outlineMd} w-full sm:w-auto`}
              onPress={() => {
                if (lastKey) {
                  navigator.clipboard.writeText(lastKey);
                  toast.success("Key copied to clipboard");
                }
              }}
            >
              Copy Key
            </Button>
            <Button
              className={`${buttonClasses.primaryMd} w-full sm:w-auto`}
              onPress={() => {
                if (lastKey && lastDocumentId) {
                  downloadKeyBackupFile(lastDocumentId, lastKey);
                  toast.success("Key backup downloaded");
                }
              }}
            >
              Download Backup
            </Button>
            <Button
              className={`${buttonClasses.outlineMd} w-full sm:w-auto`}
              onPress={() => {
                if (lastDocumentId) {
                  openShareModalForDocument(lastDocumentId);
                }
              }}
            >
              Create Beneficiary Package
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={isShareModalOpen}
        onClose={resetShareModal}
        size="md"
        className="bg-gray-900"
        scrollBehavior="inside"
        placement="center"
      >
        <ModalContent className="bg-gray-900 w-[92vw] max-w-lg max-h-[80vh] overflow-hidden">
          <ModalHeader>Share Beneficiary Key Package</ModalHeader>
          <ModalBody className="max-h-[70vh] overflow-y-auto space-y-3">
            <p className="text-gray-400 text-sm">
              Download a wallet-bound key package for the beneficiary. They must
              request access on-chain and import this package to decrypt.
            </p>
            {selectedShareDocument && (
              <div className="rounded-xl border border-gray-700/70 bg-gray-900/65 p-3 text-sm">
                <p className="font-medium">{selectedShareDocument.name}</p>
                <p className="text-gray-400 text-xs mt-1">
                  Vault: {selectedShareDocument.vaultName} • Document #
                  {selectedShareDocument.doc.id}
                </p>
              </div>
            )}
            <Input
              label="Beneficiary Wallet Address"
              placeholder="0x..."
              value={shareRecipient}
              onValueChange={setShareRecipient}
              classNames={{
                inputWrapper:
                  "bg-gray-900/75 border border-gray-700/80 shadow-none data-[hover=true]:border-gray-600",
                input: "text-sm text-gray-100",
                label: "text-gray-300",
              }}
            />
            <div className="rounded-xl border border-gray-700/70 bg-gray-900/65 p-3 space-y-1">
              <p className="text-sm font-medium">
                How beneficiary uses this package
              </p>
              <p className="text-xs text-gray-400">
                1. Receive an NFT pass for the vault.
              </p>
              <p className="text-xs text-gray-400">
                2. Request document access and wait for guardian approvals.
              </p>
              <p className="text-xs text-gray-400">
                3. Open My Access and click "Fetch Inbox Keys" (or import
                package file).
              </p>
            </div>
          </ModalBody>
          <ModalFooter className="flex-col-reverse sm:flex-row gap-2">
            <Button
              className={`${buttonClasses.ghostMd} w-full sm:w-auto`}
              onPress={resetShareModal}
            >
              Cancel
            </Button>
            <Button
              className={`${buttonClasses.outlineMd} w-full sm:w-auto`}
              onPress={sendBeneficiaryKeyToInbox}
              isDisabled={
                !shareTargetDocId || !shareRecipient.trim() || sendingInboxKey
              }
              isLoading={sendingInboxKey}
            >
              Send to In-App Inbox
            </Button>
            <Button
              className={`${buttonClasses.primaryMd} w-full sm:w-auto`}
              onPress={downloadBeneficiaryKeyPackage}
              isDisabled={!shareTargetDocId || !shareRecipient.trim()}
            >
              Download Package
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
};

export default Documents;

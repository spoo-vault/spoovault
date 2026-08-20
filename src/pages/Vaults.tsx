import { useState, useEffect } from "react";
import {
  Card,
  CardBody,
  CardHeader,
  Input,
  Button,
  Chip,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
  Textarea,
  Badge,
  Avatar,
  Skeleton,
} from "@heroui/react";
import {
  FiSearch,
  FiFilter,
  FiChevronDown,
  FiPlus,
  FiShield,
  FiUsers,
  FiFile,
  FiLock,
  FiUserPlus,
  FiCheck,
  FiX,
  FiZap,
  FiClock,
  FiAlertTriangle,
  FiAlertCircle,
} from "react-icons/fi";
import { useSearchParams } from "react-router-dom";
import { useWeb3 } from "../context/Web3Context";
import {
  contractService,
  VaultData,
  VaultReleaseState,
} from "../services/contract.service";
import { toast } from "react-hot-toast";
import { shortenAddress, isValidAddress, isValidStellarAddress, formatDate, getVaultGID, buildVaultDocumentCounts, keyRecordByVaultGID } from "../utils/helpers";
import { buttonClasses } from "../utils/buttonClasses";

interface Vault extends VaultData {
  gid: string;
  documentCount: number;
}

const Vaults = () => {
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "mine" | "inactive">("all");
  const [searchParams] = useSearchParams();
  const { account, isConnected, connect, provider, signer, isFujiNetwork, ecosystem, chainId } = useWeb3();

  const [vaults, setVaults] = useState<Vault[]>([]);
  const [releaseStatesByVault, setReleaseStatesByVault] = useState<Record<string, VaultReleaseState>>({});
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [togglingEmergencyVaultId, setTogglingEmergencyVaultId] = useState<number | null>(null);
  const [provingLifeVaultId, setProvingLifeVaultId] = useState<number | null>(null);

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    guardians: [] as string[],
    newGuardian: "",
    approvalThreshold: 1,
    inactivityDays: 30,
  });

  useEffect(() => {
    if (searchParams.get("create") === "true") {
      onOpen();
    }
  }, [searchParams, onOpen]);

  useEffect(() => {
    if (isConnected && ((provider && signer && isFujiNetwork) || ecosystem === "stellar")) {
      if (provider && signer) {
        contractService.initialize(provider, signer);
      }
      loadVaults();
    } else {
      setLoading(false);
      setVaults([]);
      setReleaseStatesByVault({});
    }
  }, [account, isConnected, provider, signer, isFujiNetwork, ecosystem, chainId]);

  const loadVaults = async (options?: { silent?: boolean }) => {
    if (!account) {
      setLoading(false);
      return;
    }

    if (!options?.silent) {
      setLoading(true);
    }
    try {
      const vaultsData = await contractService.fetchVaultsForAccount(account);
      const docsData = await contractService.fetchDocumentsForVaults(
        vaultsData.map((vault) => vault.id)
      );

      const visibleVaults = vaultsData;

      const docCounts = buildVaultDocumentCounts(ecosystem, chainId, visibleVaults, docsData);

      const enriched: Vault[] = visibleVaults.map((vault) => {
        const gid = getVaultGID(ecosystem, chainId, vault.id);
        return {
          ...vault,
          gid,
          documentCount: docCounts[gid] || 0,
        };
      });

      setVaults(enriched);
      const releaseStates = await contractService.fetchVaultReleaseStates(
        visibleVaults.map((vault) => vault.id)
      );
      setReleaseStatesByVault(keyRecordByVaultGID(ecosystem, chainId, releaseStates));
    } catch (error) {
      console.error("Error loading vaults:", error);
      const message = error instanceof Error ? error.message : "Failed to load vaults";
      toast.error(message);
      setReleaseStatesByVault({});
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  };

  const handleAddGuardian = () => {
    if (!formData.newGuardian.trim()) {
      toast.error("Please enter a guardian address");
      return;
    }

    if (ecosystem === "stellar" ? !isValidStellarAddress(formData.newGuardian) : !isValidAddress(formData.newGuardian, "avalanche")) {
      toast.error(ecosystem === "stellar" ? "Invalid Stellar address" : "Invalid Ethereum address");
      return;
    }

    if (formData.guardians.includes(formData.newGuardian)) {
      toast.error("Guardian already added");
      return;
    }

    setFormData({
      ...formData,
      guardians: [...formData.guardians, formData.newGuardian],
      newGuardian: "",
    });

    toast.success("Guardian added");
  };

  const handleRemoveGuardian = (address: string) => {
    setFormData({
      ...formData,
      guardians: formData.guardians.filter((addr: string) => addr !== address),
    });
  };

  const handleCreateVault = async () => {
    if (!isConnected) {
      toast.error("Please connect your wallet first");
      await connect();
      return;
    }

    if (!isFujiNetwork) {
      toast.error("Please switch to Avalanche Fuji network");
      return;
    }

    if (!formData.name.trim()) {
      toast.error("Vault name is required");
      return;
    }

    if (formData.guardians.length === 0) {
      toast.error("At least one guardian is required");
      return;
    }

    if (formData.approvalThreshold > formData.guardians.length + 1) {
      toast.error("Approval threshold cannot exceed number of guardians");
      return;
    }

    const draftForm = {
      ...formData,
      name: formData.name.trim(),
      description: formData.description.trim(),
      guardians: [...formData.guardians],
    };

    setCreating(true);
    try {
      const vaultId = await contractService.createVault(
        draftForm.name,
        draftForm.description,
        draftForm.guardians,
        draftForm.approvalThreshold
      );

      if (!vaultId) {
        toast.error("Vault created but ID was not returned");
      } else {
        toast.success(`Vault #${vaultId} created successfully!`);
        const nowTs = Math.floor(Date.now() / 1000);
        const ownerAddress = account || "";
        const gid = getVaultGID(ecosystem, chainId, vaultId);
        const optimisticVault: Vault = {
          id: vaultId,
          gid,
          creator: ownerAddress,
          name: draftForm.name,
          description: draftForm.description,
          guardians: ownerAddress ? [ownerAddress] : [],
          approvalThreshold: draftForm.approvalThreshold,
          isActive: true,
          createdAt: nowTs,
          documentCount: 0,
        };
        setVaults((prev: Vault[]) => {
          const existingIndex = prev.findIndex((vault: Vault) => vault.gid === gid);
          if (existingIndex >= 0) {
            const copy = [...prev];
            copy[existingIndex] = optimisticVault;
            return copy;
          }
          return [optimisticVault, ...prev];
        });
        setReleaseStatesByVault((prev: Record<string, VaultReleaseState>) => ({
          ...prev,
          [gid]: {
            emergencyMode: false,
            inactivityPeriod: draftForm.inactivityDays * 24 * 60 * 60,
            lastProofOfLife: nowTs,
            postDeathUnlocked: false,
          },
          
        }));
        try {
          await contractService.configureVaultRelease(
            vaultId,
            draftForm.inactivityDays * 24 * 60 * 60
          );
          toast.success(`Post-death timer set to ${draftForm.inactivityDays} days`);
        } catch (policyError) {
          const policyMessage =
            policyError instanceof Error
              ? policyError.message
              : "Vault created, but release policy setup was skipped";
          toast.error(policyMessage);
        }
      }

      setFormData({
        name: "",
        description: "",
        guardians: [],
        newGuardian: "",
        approvalThreshold: 1,
        inactivityDays: 30,
      });

      onClose();
      void loadVaults({ silent: true });
    } catch (error: any) {
      toast.error(error.message || "Failed to create vault");
    } finally {
      setCreating(false);
    }
  };

  const handleToggleEmergencyMode = async (vaultId: number, enabled: boolean) => {
    setTogglingEmergencyVaultId(vaultId);
    try {
      await contractService.setEmergencyMode(vaultId, enabled);
      toast.success(enabled ? "Emergency mode enabled" : "Emergency mode disabled");
      await loadVaults();
    } catch (error: any) {
      toast.error(error.message || "Failed to update emergency mode");
    } finally {
      setTogglingEmergencyVaultId(null);
    }
  };

  const handleProveLife = async (vaultId: number) => {
    setProvingLifeVaultId(vaultId);
    try {
      await contractService.recordProofOfLife(vaultId);
      toast.success("Proof-of-life recorded");
      await loadVaults();
    } catch (error: any) {
      toast.error(error.message || "Failed to record proof-of-life");
    } finally {
      setProvingLifeVaultId(null);
    }
  };

  const filteredVaults = vaults
    .filter((vault: Vault) =>
      vault.name.toLowerCase().includes(search.toLowerCase()) ||
      vault.description.toLowerCase().includes(search.toLowerCase()) ||
      vault.creator.toLowerCase().includes(search.toLowerCase())
    )
    .filter((vault: Vault) => {
      if (filter === "active") return vault.isActive;
      if (filter === "inactive") return !vault.isActive;
      if (filter === "mine") return vault.creator.toLowerCase() === account?.toLowerCase();
      return true;
    });

  const getRoleBadge = (isCreator: boolean, isGuardian: boolean): { roleLabel: string; roleColor: "danger" | "success" | "default" } => {
    if (isCreator) return { roleLabel: "Owner", roleColor: "danger" };
    if (isGuardian) return { roleLabel: "Guardian", roleColor: "success" };
    return { roleLabel: "Beneficiary", roleColor: "default" };
  };

  const stepChipClass = "bg-brand-700/12 text-brand-300 border border-brand-700/35";
  const modalInputClassNames = {
    inputWrapper: "bg-gray-900/75 border border-gray-700/80 shadow-none data-[hover=true]:border-gray-600",
    input: "text-sm text-gray-100",
  };
  const modalTextareaClassNames = {
    inputWrapper: "bg-gray-900/75 border border-gray-700/80 shadow-none data-[hover=true]:border-gray-600 min-h-[8.75rem]",
    input: "text-sm text-gray-100 leading-relaxed whitespace-pre-wrap break-words",
    innerWrapper: "items-start",
  };
  const filterSelectClass =
    "h-11 w-full rounded-full border border-gray-700/80 bg-gray-900/75 pl-10 pr-10 text-sm text-gray-100 outline-none transition-colors hover:border-gray-600 focus:border-brand-700/70";
  const rangeInputClass =
    "w-full h-2 rounded-lg appearance-none cursor-pointer bg-gray-800 accent-red-600";
  const maxApprovalThreshold = Math.max(1, formData.guardians.length + 1);

  useEffect(() => {
    if (formData.approvalThreshold > maxApprovalThreshold) {
      setFormData((prev: typeof formData) => ({
        ...prev,
        approvalThreshold: maxApprovalThreshold,
      }));
    }
  }, [formData.approvalThreshold, maxApprovalThreshold]);

  if (!isConnected) {
    return (
      <div className="min-h-[calc(100vh-11rem)] flex items-center justify-center">
        <div className="w-full max-w-4xl rounded-2xl bg-gradient-to-r from-gray-900/50 to-[#040306] border border-gray-800 p-8 text-center">
          <div className="w-20 h-20 bg-gradient-to-br from-brand-700 to-brand-900 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <FiZap className="text-white text-3xl" />
          </div>
          <h1 className="text-3xl font-bold mb-4">Connect Your Wallet</h1>
          <p className="text-gray-400 mb-8 max-w-2xl mx-auto">
            Connect your wallet to create and manage access vaults for daily, emergency, and inheritance document release on Avalanche.
          </p>
          <Button
            size="lg"
            className={buttonClasses.primaryLg}
            onPress={connect}
            startContent={<FiZap />}
          >
            Connect Wallet
          </Button>
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
            Please switch to Avalanche Fuji Testnet to manage vaults.
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
          <h1 className="text-3xl font-bold mb-2">Your Access Vaults</h1>
          <p className="text-gray-400">
            Set up guardian-controlled vaults for living access, emergencies, and inheritance delivery.
          </p>
        </div>
        <Button
          className={`${buttonClasses.primaryMd} group`}
          startContent={<FiPlus className="group-hover:rotate-90 transition-transform" />}
          onPress={onOpen}
        >
          Create Access Vault
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <Input
          placeholder="Search vaults by name, description, or creator..."
          startContent={<FiSearch className="text-gray-400" />}
          value={search}
          onValueChange={setSearch}
          className="max-w-lg"
        />
        <div className="relative w-full sm:w-56">
          <FiFilter className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <select
            value={filter}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setFilter(event.target.value as typeof filter)}
            className={filterSelectClass}
          >
            <option value="all">All Access Vaults</option>
            <option value="active">Active</option>
            <option value="mine">My Access Vaults</option>
            <option value="inactive">Inactive</option>
          </select>
          <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-500" />
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[...Array(6)].map((_, i) => (
            <Card key={i} className="border border-gray-800 bg-gray-900/30">
              <CardBody className="p-6">
                <div className="flex items-center gap-3 mb-4">
                  <Skeleton className="rounded-lg">
                    <div className="w-12 h-12 rounded-lg bg-default-300" />
                  </Skeleton>
                  <div className="space-y-2">
                    <Skeleton className="rounded-lg">
                      <div className="h-4 w-24 rounded-lg bg-default-300" />
                    </Skeleton>
                    <Skeleton className="rounded-lg">
                      <div className="h-3 w-16 rounded-lg bg-default-300" />
                    </Skeleton>
                  </div>
                </div>
                <Skeleton className="rounded-lg w-full mb-4">
                  <div className="h-3 w-full rounded-lg bg-default-300" />
                </Skeleton>
                <Skeleton className="rounded-lg w-3/4 mb-2">
                  <div className="h-3 rounded-lg bg-default-300" />
                </Skeleton>
                <Skeleton className="rounded-lg w-1/2">
                  <div className="h-3 rounded-lg bg-default-300" />
                </Skeleton>
              </CardBody>
            </Card>
          ))}
        </div>
      ) : filteredVaults.length === 0 ? (
        <div className="text-center py-12">
          <div className="w-20 h-20 bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <FiShield className="text-gray-600 text-3xl" />
          </div>
          <h3 className="text-xl font-bold mb-2">No access vaults found</h3>
          <p className="text-gray-400 mb-6">
            {search ? "Try a different search term" : "Create your first access vault to get started"}
          </p>
          <Button
            className={buttonClasses.primaryMd}
            onPress={onOpen}
            startContent={<FiPlus />}
          >
            Create Your First Access Vault
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredVaults.map((vault: Vault) => {
            const releaseState = releaseStatesByVault[vault.gid] ?? {
              emergencyMode: false,
              inactivityPeriod: 30 * 24 * 60 * 60,
              lastProofOfLife: vault.createdAt,
              postDeathUnlocked: false,
            };
            const inactivityDays = Math.max(1, Math.round(releaseState.inactivityPeriod / 86400));
            const isCreator = vault.creator.toLowerCase() === account?.toLowerCase();
            const isGuardian = vault.guardians.some(
              (guardian: string) => guardian.toLowerCase() === account?.toLowerCase()
            );
            const { roleLabel, roleColor } = getRoleBadge(isCreator, isGuardian);

            return (
              <Card
                key={vault.gid || vault.id}
                className="border border-gray-800 bg-gray-900/30 backdrop-blur-sm hover:border-brand-700/30 transition-all duration-300 group"
              >
                <CardHeader className="flex justify-between items-start">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-gradient-to-br from-brand-700 to-brand-900 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform">
                      <FiShield className="text-white text-xl" />
                    </div>
                    <div>
                      <h3 className="font-bold text-lg">{vault.name}</h3>
                      <div className="mt-1 flex items-center gap-2">
                        <Chip
                          color={vault.isActive ? "success" : "warning"}
                          variant="flat"
                          size="sm"
                        >
                          {vault.isActive ? "ACTIVE" : "INACTIVE"}
                        </Chip>
                        <Chip color={roleColor} variant="flat" size="sm">
                          {roleLabel}
                        </Chip>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardBody>
                  <p className="text-gray-400 text-sm mb-4">{vault.description}</p>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2 text-gray-400">
                        <FiUsers />
                        <span>Guardians</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Badge color="primary" variant="flat" size="sm">
                          {vault.guardians.length}
                        </Badge>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2 text-gray-400">
                        <FiFile />
                        <span>Documents</span>
                      </div>
                      <span className="font-medium">{vault.documentCount}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2 text-gray-400">
                        <FiLock />
                        <span>Approval</span>
                      </div>
                      <span className="font-medium">{vault.approvalThreshold}/{vault.guardians.length}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-400">Creator</span>
                      <span className="font-mono text-xs">{shortenAddress(vault.creator)}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-400">Vault GID</span>
                      <span className="font-mono text-xs font-semibold text-brand-400">{vault.gid || `#${vault.id}`}</span>
                    </div>
                  </div>

                  <div className="mt-4 rounded-xl border border-gray-700/80 bg-gray-900/60 p-3 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-gray-300">Release Policy</p>
                      <div className="flex gap-1.5">
                        <Chip
                          size="sm"
                          variant="flat"
                          color={releaseState.emergencyMode ? "warning" : "default"}
                        >
                          {releaseState.emergencyMode ? "Emergency ON" : "Emergency OFF"}
                        </Chip>
                        <Chip
                          size="sm"
                          variant="flat"
                          color={releaseState.postDeathUnlocked ? "danger" : "success"}
                        >
                          {releaseState.postDeathUnlocked ? "Post-Death Unlocked" : "Live Mode"}
                        </Chip>
                      </div>
                    </div>
                    <div className="text-xs text-gray-400 space-y-1">
                      <div className="flex items-center gap-2">
                        <FiClock className="text-gray-500" />
                        <span>Inactivity unlock: {inactivityDays} days</span>
                      </div>
                      <p>
                        Last proof-of-life:{" "}
                        {releaseState.lastProofOfLife
                          ? formatDate(releaseState.lastProofOfLife)
                          : "not recorded"}
                      </p>
                    </div>
                    {isCreator && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                          size="sm"
                          className={buttonClasses.ghostSm}
                          startContent={<FiClock />}
                          isLoading={provingLifeVaultId === vault.id}
                          isDisabled={provingLifeVaultId !== null || togglingEmergencyVaultId !== null}
                          onPress={() => handleProveLife(vault.id)}
                        >
                          Prove Life
                        </Button>
                        <Button
                          size="sm"
                          className={releaseState.emergencyMode ? buttonClasses.outlineSm : buttonClasses.primarySm}
                          startContent={<FiAlertTriangle />}
                          isLoading={togglingEmergencyVaultId === vault.id}
                          isDisabled={togglingEmergencyVaultId !== null || provingLifeVaultId !== null}
                          onPress={() =>
                            handleToggleEmergencyMode(vault.id, !releaseState.emergencyMode)
                          }
                        >
                          {releaseState.emergencyMode ? "Disable Emergency" : "Enable Emergency"}
                        </Button>
                      </div>
                    )}
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="2xl"
        backdrop="blur"
        classNames={{
          wrapper: "z-[120]",
          backdrop: "bg-black/70",
        }}
        scrollBehavior="inside"
        placement="center"
      >
        <ModalContent className="bg-gray-950 w-[94vw] max-w-[44rem] max-h-[88vh] overflow-hidden border border-gray-800/90 shadow-2xl">
          <ModalHeader className="flex flex-col gap-1 border-b border-gray-800/80 px-4 sm:px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-brand-700 to-brand-900 rounded-xl flex items-center justify-center">
                <FiShield className="text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold">Create Access Vault</h2>
                <p className="text-sm text-gray-400">Owner + guardian controlled release security</p>
              </div>
            </div>
          </ModalHeader>
          <ModalBody className="modal-scroll max-h-[70vh] overflow-y-auto px-4 sm:px-6 py-4">
            <div className="space-y-4">
              <div className="rounded-2xl border border-gray-800/85 bg-gray-900/78 p-4 sm:p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">Access Vault Details</p>
                    <p className="text-xs text-gray-400">Name and describe the vault</p>
                  </div>
                  <Chip size="sm" variant="flat" className={stepChipClass}>
                    Step 1
                  </Chip>
                </div>
                <div className="space-y-3">
                  <p className="text-xs text-gray-300 font-medium">Vault Name</p>
                  <Input
                    placeholder="e.g., Family Estate Records, Insurance Files"
                    value={formData.name}
                    onValueChange={(value: string) => setFormData({ ...formData, name: value })}
                    isRequired
                    classNames={modalInputClassNames}
                  />
                  <p className="text-xs text-gray-300 font-medium">Description</p>
                  <Textarea
                    placeholder="Describe which files this vault should protect for living, emergency, or inheritance access..."
                    value={formData.description}
                    onValueChange={(value: string) => setFormData({ ...formData, description: value })}
                    minRows={4}
                    maxRows={6}
                    maxLength={650}
                    classNames={modalTextareaClassNames}
                  />
                  <p className="text-[11px] text-gray-500">
                    Keep it concise: purpose, owners, and release conditions.
                  </p>
                </div>
              </div>

              <div className="rounded-2xl border border-gray-800/85 bg-gray-900/78 p-4 sm:p-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">Guardians</p>
                    <p className="text-xs text-gray-400">Add trusted guardians or executors for emergency and inheritance approvals</p>
                  </div>
                  <Chip size="sm" variant="flat" className={stepChipClass}>
                    Step 2
                  </Chip>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 sm:gap-3 items-end">
                  <div className="space-y-1">
                    <p className="text-xs text-gray-300 font-medium">Guardian Address</p>
                  <Input
                    placeholder={ecosystem === "stellar" ? "Enter guardian's Stellar address" : "Enter guardian's Ethereum address"}
                    value={formData.newGuardian}
                    onValueChange={(value: string) => setFormData({ ...formData, newGuardian: value })}
                    classNames={modalInputClassNames}
                  />
                  </div>
                  <Button
                    className={`${buttonClasses.primaryMd} w-full sm:w-auto sm:mb-[2px]`}
                    startContent={<FiUserPlus />}
                    onPress={handleAddGuardian}
                    isDisabled={!formData.newGuardian.trim()}
                  >
                    Add
                  </Button>
                </div>

                {formData.guardians.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm text-gray-400">Guardians ({formData.guardians.length})</p>
                    <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                      {formData.guardians.map((address: string, index: number) => (
                        <div
                          key={address}
                          className="flex items-center justify-between p-3 bg-gray-900/65 border border-gray-700/70 rounded-xl"
                        >
                          <div className="flex items-center gap-3">
                            <Avatar
                              className="w-8 h-8 bg-gray-700"
                              name={(index + 1).toString()}
                            />
                            <div>
                              <p className="font-mono text-sm">{shortenAddress(address, 6)}</p>
                              <p className="text-xs text-gray-400">Guardian #{index + 1}</p>
                            </div>
                          </div>
                          <Button
                            isIconOnly
                            variant="light"
                            size="sm"
                            onPress={() => handleRemoveGuardian(address)}
                          >
                            <FiX className="text-gray-400" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="p-3 bg-gray-900/60 border border-gray-700/70 rounded-xl">
                  <div className="flex items-center gap-3">
                    <FiCheck className="text-brand-500" />
                    <div>
                      <p className="text-sm font-medium">You will be the first guardian</p>
                      <p className="text-xs text-gray-400">Creators are automatically added</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-gray-800/85 bg-gray-900/78 p-4 sm:p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">Approval Threshold</p>
                    <p className="text-xs text-gray-400">Required guardian approvals for emergency or inheritance release</p>
                  </div>
                  <Chip size="sm" variant="flat" className={stepChipClass}>
                    Step 3
                  </Chip>
                </div>
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-sm text-gray-400">Current</span>
                    <span className="font-semibold">
                      {formData.approvalThreshold} of {maxApprovalThreshold}
                    </span>
                  </div>
                  <div className="mb-3 flex justify-end">
                    <input
                      type="number"
                      min={1}
                      max={maxApprovalThreshold}
                      step={1}
                      value={formData.approvalThreshold}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                        const raw = Number(event.target.value);
                        if (Number.isNaN(raw)) return;
                        const next = Math.min(maxApprovalThreshold, Math.max(1, raw));
                        setFormData({
                          ...formData,
                          approvalThreshold: next,
                        });
                      }}
                      className="h-9 w-24 rounded-lg border border-gray-700/80 bg-gray-900/75 px-3 text-right text-sm text-gray-100 outline-none transition-colors hover:border-gray-600 focus:border-brand-700/70"
                    />
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={maxApprovalThreshold}
                    step={1}
                    value={formData.approvalThreshold}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      setFormData({
                        ...formData,
                        approvalThreshold: Number(event.target.value),
                      })
                    }
                    className={rangeInputClass}
                  />
                  <div className="flex justify-between text-xs text-gray-400 mt-1">
                    <span>Less Secure</span>
                    <span>More Secure</span>
                  </div>
                  {formData.approvalThreshold >= formData.guardians.length + 1 && (
                    <p className="mt-2 text-xs text-yellow-400">
                      Requiring everyone can lock this vault if any guardian invite expires or is not accepted.
                    </p>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-gray-800/85 bg-gray-900/78 p-4 sm:p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">Post-Death Unlock Timer</p>
                    <p className="text-xs text-gray-400">
                      If owner inactivity passes this window, post-death release becomes available.
                    </p>
                  </div>
                  <Chip size="sm" variant="flat" className={stepChipClass}>
                    Step 4
                  </Chip>
                </div>
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-sm text-gray-400">Current</span>
                    <span className="font-semibold">{formData.inactivityDays} days</span>
                  </div>
                  <input
                    type="range"
                    min={7}
                    max={180}
                    step={1}
                    value={formData.inactivityDays}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      setFormData({
                        ...formData,
                        inactivityDays: Number(event.target.value),
                      })
                    }
                    className={rangeInputClass}
                  />
                  <div className="flex justify-between text-xs text-gray-400 mt-1">
                    <span>7 days</span>
                    <span>180 days</span>
                  </div>
                </div>
              </div>

              <div className="p-4 bg-brand-700/10 border border-brand-700/20 rounded-2xl">
                <p className="text-sm">
                  <span className="font-medium">Note:</span> Creating a vault requires a blockchain
                  transaction and will incur gas fees on Avalanche Fuji.
                </p>
              </div>
            </div>
          </ModalBody>
          <ModalFooter className="border-t border-gray-800/80 px-4 sm:px-6 py-3 flex-col-reverse sm:flex-row gap-2">
            <Button className={`${buttonClasses.ghostMd} w-full sm:w-auto`} onPress={onClose} isDisabled={creating}>
              Cancel
            </Button>
            <Button
              className={`${buttonClasses.primaryMd} w-full sm:w-auto`}
              onPress={handleCreateVault}
              isLoading={creating}
              isDisabled={!formData.name || formData.guardians.length === 0}
            >
              {creating ? "Creating..." : "Create Access Vault"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
};

export default Vaults;


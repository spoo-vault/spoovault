import { useState } from "react";
import { Card, CardBody, CardHeader, Chip } from "@heroui/react";
import {
  FiBook,
  FiCode,
  FiTerminal,
  FiShield,
  FiGitPullRequest,
  FiCheckCircle,
  FiExternalLink,
  FiLayers,
  FiCpu,
  FiCopy,
  FiServer,
  FiChevronDown,
  FiChevronUp,
} from "react-icons/fi";
import { toast } from "react-hot-toast";
import { buttonClasses } from "../utils/buttonClasses";

export default function DocsPage() {
  const [activeTab, setActiveTab] = useState<
    "overview" | "setup" | "contracts" | "testing" | "grantfox"
  >("overview");
  const [openStep, setOpenStep] = useState<number | null>(1);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  };

  const toggleStep = (step: number) => {
    setOpenStep((prev) => (prev === step ? null : step));
  };

  const steps = [
    {
      id: 1,
      title: "1. Claim an Issue on GrantFox",
      content:
        "Browse active issues on the GrantFox dashboard or GitHub issue tracker. Apply to the issue and wait for official assignment before commencing development work.",
    },
    {
      id: 2,
      title: "2. Adhere to Code Style & Design Tokens",
      content:
        "Maintain existing HeroUI and Tailwind CSS design tokens. Ensure accessibility (WCAG 2.1 AA), proper ARIA labeling, and responsive design across mobile and desktop viewports.",
    },
    {
      id: 3,
      title: "3. Link PR to GrantFox Issue",
      content:
        "Include Closes #IssueNumber in your Pull Request description so GrantFox automated webhooks track your milestone completion.",
    },
    {
      id: 4,
      title: "4. Provide Verification Evidence",
      content:
        "Attach screenshots/videos for UI changes and include passing test results from npm test.",
    },
  ];

  return (
    <div className="space-y-8 pb-12">
      {/* Hero Banner */}
      <div className="relative overflow-hidden rounded-3xl border border-gray-800 bg-gradient-to-br from-gray-950 via-gray-900 to-black p-6 md:p-10 shadow-2xl">
        <div className="absolute top-0 right-0 -mt-12 -mr-12 w-96 h-96 bg-brand-600/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10 space-y-4 max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-brand-500/30 bg-brand-500/10 text-brand-300 text-xs font-semibold">
            <FiBook className="text-sm" />
            <span>Developer & Contributor Hub</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-white font-display">
            SpooVault Documentation
          </h1>
          <p className="text-gray-400 text-sm md:text-base leading-relaxed">
            Welcome contributors! SpooVault is an open-source decentralized
            document custody protocol supporting dual-chain infrastructure on{" "}
            <span className="text-red-400 font-medium">Avalanche (EVM)</span>{" "}
            and{" "}
            <span className="text-purple-400 font-medium">
              Stellar (Soroban)
            </span>
            . Use this guide to start building, running tests, and submitting
            contributions.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <a
              href="https://github.com/spoo-vault/spoovault"
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses.primarySm}
            >
              <FiCode className="text-base" />
              <span>GitHub Repository</span>
              <FiExternalLink className="text-xs ml-1" />
            </a>
            <a
              href="https://grantfox.com"
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses.outlineSm}
            >
              <FiGitPullRequest className="text-base text-brand-400" />
              <span>GrantFox Platform</span>
              <FiExternalLink className="text-xs ml-1" />
            </a>
          </div>
        </div>
      </div>

      {/* Main Tab Navigation */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2 border-b border-gray-800/80">
        {[
          { id: "overview", label: "Architecture Overview", icon: FiLayers },
          { id: "setup", label: "Local Setup", icon: FiTerminal },
          { id: "contracts", label: "Smart Contracts", icon: FiCpu },
          { id: "testing", label: "Testing Suite", icon: FiCheckCircle },
          {
            id: "grantfox",
            label: "GrantFox Contribution Guide",
            icon: FiShield,
          },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all whitespace-nowrap border ${
                isActive
                  ? "bg-brand-700/20 border-brand-500/50 text-white shadow-lg shadow-brand-900/20"
                  : "bg-gray-900/50 border-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-800/60"
              }`}
            >
              <Icon className={isActive ? "text-brand-400" : "text-gray-500"} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab 1: Architecture Overview */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Card className="bg-gray-900/60 border border-gray-800 rounded-2xl">
              <CardBody className="p-6 space-y-3">
                <div className="w-10 h-10 rounded-xl bg-brand-500/10 border border-brand-500/30 flex items-center justify-center text-brand-400 text-xl">
                  <FiShield />
                </div>
                <h3 className="text-lg font-bold text-white font-display">
                  Zero-Knowledge Client Encryption
                </h3>
                <p className="text-gray-400 text-xs leading-relaxed">
                  Files are encrypted entirely client-side using AES-256 and
                  TweetNaCl X25519 before being uploaded to IPFS. Keys never
                  touch backend servers unencrypted.
                </p>
              </CardBody>
            </Card>

            <Card className="bg-gray-900/60 border border-gray-800 rounded-2xl">
              <CardBody className="p-6 space-y-3">
                <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400 text-xl">
                  <FiCpu />
                </div>
                <h3 className="text-lg font-bold text-white font-display">
                  Multi-Chain Protocol
                </h3>
                <p className="text-gray-400 text-xs leading-relaxed">
                  Supports dual-chain smart contract infrastructure: Solidity
                  0.8.20 on Avalanche EVM Fuji and Soroban Rust SDK on Stellar
                  Soroban network.
                </p>
              </CardBody>
            </Card>

            <Card className="bg-gray-900/60 border border-gray-800 rounded-2xl">
              <CardBody className="p-6 space-y-3">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400 text-xl">
                  <FiServer />
                </div>
                <h3 className="text-lg font-bold text-white font-display">
                  Guardian Multi-Sig & Dead-Man's Switch
                </h3>
                <p className="text-gray-400 text-xs leading-relaxed">
                  Distributes key packages across trusted guardians requiring
                  threshold approval, or automatically releases documents upon
                  proof-of-life inactivity timeout.
                </p>
              </CardBody>
            </Card>
          </div>

          <Card className="bg-gray-900/70 border border-gray-800 rounded-2xl">
            <CardHeader className="px-6 pt-6 pb-2">
              <h2 className="text-xl font-bold text-white font-display">
                System Architecture Diagram
              </h2>
            </CardHeader>
            <CardBody className="px-6 pb-6">
              <div className="bg-gray-950 p-6 rounded-xl border border-gray-800 font-mono text-xs text-gray-300 overflow-x-auto space-y-2">
                <p className="text-brand-400 font-semibold">
                  // SpooVault Technical Component Flow
                </p>
                <pre>{`
[ User Browser ]
   │
   ├─► [ AES-256 / TweetNaCl Encryption ] ──► [ Encrypted Blob ] ──► [ IPFS / Pinata Gateway ]
   │
   ├─► [ Avalanche Fuji EVM Contract ] ──────► [ On-Chain Vault Metadata & Multi-Sig Thresholds ]
   │
   └─► [ Stellar Soroban Rust Contract ] ────► [ Soroban Persistent Storage & Access Releases ]
                `}</pre>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {/* Tab 2: Local Setup */}
      {activeTab === "setup" && (
        <div className="space-y-6">
          <Card className="bg-gray-900/70 border border-gray-800 rounded-2xl">
            <CardHeader className="px-6 pt-6 pb-2">
              <h2 className="text-xl font-bold text-white font-display">
                Prerequisites & System Setup
              </h2>
            </CardHeader>
            <CardBody className="px-6 pb-6 space-y-4 text-sm text-gray-300">
              <ul className="list-disc pl-5 space-y-2 text-gray-400">
                <li>
                  <strong className="text-white">Node.js</strong>: v18.0.0 or
                  higher
                </li>
                <li>
                  <strong className="text-white">Package Manager</strong>: npm
                  v9+
                </li>
                <li>
                  <strong className="text-white">Web3 Wallets</strong>: MetaMask
                  (for Avalanche Fuji) and Freighter Wallet (for Stellar)
                </li>
                <li>
                  <strong className="text-white">Rust & Cargo</strong>:
                  (Optional) for compiling Stellar Soroban smart contracts
                  locally
                </li>
              </ul>

              <div className="space-y-3 pt-4">
                <h3 className="font-semibold text-white">
                  1. Clone & Install Dependencies
                </h3>
                <div className="relative bg-gray-950 p-4 rounded-xl border border-gray-800 font-mono text-xs text-brand-300">
                  <button
                    onClick={() =>
                      copyToClipboard(
                        "git clone https://github.com/spoovault/spoovault.git\ncd spoovault\nnpm install",
                        "Commands"
                      )
                    }
                    className="absolute top-3 right-3 text-gray-400 hover:text-white p-1"
                  >
                    <FiCopy />
                  </button>
                  <pre>{`git clone https://github.com/spoo-vault/spoovault.git
cd spoovault
npm install`}</pre>
                </div>
              </div>

              <div className="space-y-3 pt-2">
                <h3 className="font-semibold text-white">
                  2. Environment Configuration
                </h3>
                <p className="text-xs text-gray-400">
                  Create a{" "}
                  <code className="text-brand-400 bg-gray-950 px-1.5 py-0.5 rounded">
                    .env
                  </code>{" "}
                  file based on{" "}
                  <code className="text-brand-400 bg-gray-950 px-1.5 py-0.5 rounded">
                    .env.example
                  </code>
                  :
                </p>
                <div className="relative bg-gray-950 p-4 rounded-xl border border-gray-800 font-mono text-xs text-gray-300 overflow-x-auto">
                  <pre>{`VITE_CONTRACT_ADDRESS=0x64128680775Ef626379DeF6E5c815AeA8F4707Ef
VITE_AVALANCHE_RPC=https://api.avax-test.network/ext/bc/C/rpc
VITE_CHAIN_ID=43113
VITE_CHAIN_NAME=Avalanche Fuji Testnet
VITE_IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs/
# Downloads also race Infura, Cloudflare IPFS, and ipfs.io if Pinata returns 429 or times out
VITE_CONTRACT_DEPLOY_BLOCK=51988771
VITE_TX_WAIT_TIMEOUT_MS=180000`}</pre>
                </div>
              </div>

              <div className="space-y-3 pt-2">
                <h3 className="font-semibold text-white">
                  3. Launch Development Server
                </h3>
                <div className="relative bg-gray-950 p-4 rounded-xl border border-gray-800 font-mono text-xs text-brand-300">
                  <pre>{`npm run dev`}</pre>
                </div>
                <p className="text-xs text-gray-400">
                  App will be available locally at{" "}
                  <code className="text-brand-400 bg-gray-950 px-1.5 py-0.5 rounded">
                    http://localhost:5173
                  </code>
                  .
                </p>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {/* Tab 3: Smart Contracts */}
      {activeTab === "contracts" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Avalanche Solidity */}
            <Card className="bg-gray-900/70 border border-gray-800 rounded-2xl">
              <CardHeader className="px-6 pt-6 pb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Chip color="danger" size="sm" variant="flat">
                    Avalanche EVM
                  </Chip>
                  <h3 className="text-lg font-bold text-white font-display">
                    Solidity Contract
                  </h3>
                </div>
              </CardHeader>
              <CardBody className="px-6 pb-6 space-y-3 text-xs text-gray-300">
                <p>
                  <strong>Location</strong>:{" "}
                  <code className="text-brand-400 bg-gray-950 px-1.5 py-0.5 rounded">
                    contracts/SpooVault.sol
                  </code>
                </p>
                <p>
                  <strong>Compiler Version</strong>: Solidity 0.8.20 (Hardhat)
                </p>
                <p>
                  <strong>Deployed Address (Fuji)</strong>:
                </p>
                <div className="bg-gray-950 p-2.5 rounded-lg border border-gray-800 font-mono text-[11px] text-red-300 break-all flex items-center justify-between">
                  <span>0x64128680775Ef626379DeF6E5c815AeA8F4707Ef</span>
                  <button
                    onClick={() =>
                      copyToClipboard(
                        "0x64128680775Ef626379DeF6E5c815AeA8F4707Ef",
                        "Contract Address"
                      )
                    }
                    className="text-gray-400 hover:text-white ml-2"
                  >
                    <FiCopy />
                  </button>
                </div>
                <div className="pt-2">
                  <p className="font-semibold text-white mb-1">Commands:</p>
                  <div className="bg-gray-950 p-3 rounded-lg border border-gray-800 font-mono text-[11px] text-gray-300 space-y-1">
                    <p># Compile Solidity contracts</p>
                    <p className="text-brand-300">npx hardhat compile</p>
                    <p className="mt-2"># Run Hardhat unit tests</p>
                    <p className="text-brand-300">npm run test:contracts</p>
                  </div>
                </div>
              </CardBody>
            </Card>

            {/* Stellar Soroban */}
            <Card className="bg-gray-900/70 border border-gray-800 rounded-2xl">
              <CardHeader className="px-6 pt-6 pb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Chip color="secondary" size="sm" variant="flat">
                    Stellar Soroban
                  </Chip>
                  <h3 className="text-lg font-bold text-white font-display">
                    Rust Contract
                  </h3>
                </div>
              </CardHeader>
              <CardBody className="px-6 pb-6 space-y-3 text-xs text-gray-300">
                <p>
                  <strong>Location</strong>:{" "}
                  <code className="text-purple-400 bg-gray-950 px-1.5 py-0.5 rounded">
                    contracts-stellar/src/lib.rs
                  </code>
                </p>
                <p>
                  <strong>SDK</strong>: Soroban Rust SDK (
                  <code className="text-purple-300">#![no_std]</code>)
                </p>
                <p>
                  <strong>Wallet Integration</strong>: Freighter API
                  (@stellar/freighter-api)
                </p>
                <div className="pt-2">
                  <p className="font-semibold text-white mb-1">Commands:</p>
                  <div className="bg-gray-950 p-3 rounded-lg border border-gray-800 font-mono text-[11px] text-gray-300 space-y-1">
                    <p># Run Soroban contract tests</p>
                    <p className="text-purple-300">npm run test:stellar</p>
                  </div>
                </div>
              </CardBody>
            </Card>
          </div>
        </div>
      )}

      {/* Tab 4: Testing */}
      {activeTab === "testing" && (
        <div className="space-y-6">
          <Card className="bg-gray-900/70 border border-gray-800 rounded-2xl">
            <CardHeader className="px-6 pt-6 pb-2">
              <h2 className="text-xl font-bold text-white font-display">
                Quality Gates & Verification Suite
              </h2>
            </CardHeader>
            <CardBody className="px-6 pb-6 space-y-4">
              <p className="text-sm text-gray-400">
                Before submitting any Pull Request, ensure that all quality
                gates pass:
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-2">
                  <div className="flex items-center gap-2 text-white font-semibold text-sm">
                    <FiCheckCircle className="text-green-400" />
                    <span>Unit Testing (Vitest)</span>
                  </div>
                  <p className="text-xs text-gray-400">
                    Executes encryption, helper, and service unit tests.
                  </p>
                  <div className="bg-gray-900 p-2 rounded text-xs font-mono text-brand-300">
                    npm test
                  </div>
                </div>

                <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-2">
                  <div className="flex items-center gap-2 text-white font-semibold text-sm">
                    <FiCheckCircle className="text-green-400" />
                    <span>TypeScript Verification</span>
                  </div>
                  <p className="text-xs text-gray-400">
                    Checks static types across all components and services.
                  </p>
                  <div className="bg-gray-900 p-2 rounded text-xs font-mono text-brand-300">
                    npx tsc --noEmit
                  </div>
                </div>

                <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-2">
                  <div className="flex items-center gap-2 text-white font-semibold text-sm">
                    <FiCheckCircle className="text-green-400" />
                    <span>Live Contract Smoke Check</span>
                  </div>
                  <p className="text-xs text-gray-400">
                    Validates RPC connectivity and contract code on Avalanche
                    Fuji.
                  </p>
                  <div className="bg-gray-900 p-2 rounded text-xs font-mono text-brand-300">
                    npm run test:smoke
                  </div>
                </div>

                <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-2">
                  <div className="flex items-center gap-2 text-white font-semibold text-sm">
                    <FiCheckCircle className="text-green-400" />
                    <span>Production Bundle Build</span>
                  </div>
                  <p className="text-xs text-gray-400">
                    Ensures production web application bundle compiles.
                  </p>
                  <div className="bg-gray-900 p-2 rounded text-xs font-mono text-brand-300">
                    npm run build
                  </div>
                </div>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {/* Tab 5: GrantFox */}
      {activeTab === "grantfox" && (
        <div className="space-y-6">
          <Card className="bg-gray-900/70 border border-gray-800 rounded-2xl">
            <CardHeader className="px-6 pt-6 pb-2">
              <h2 className="text-xl font-bold text-white font-display">
                GrantFox Open Source Contribution Lifecycle
              </h2>
            </CardHeader>
            <CardBody className="px-6 pb-6 space-y-4 text-sm text-gray-300">
              <p className="text-gray-400 text-xs leading-relaxed">
                Spoovault participates in GrantFox open-source ecosystem
                bounties and milestone-based funding. Follow this checklist when
                claiming and submitting contributions:
              </p>

              <div className="space-y-3">
                {steps.map((step) => {
                  const isOpen = openStep === step.id;
                  return (
                    <div
                      key={step.id}
                      className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden"
                    >
                      <button
                        type="button"
                        onClick={() => toggleStep(step.id)}
                        className="w-full px-4 py-3 flex items-center justify-between text-left font-medium text-white hover:bg-gray-900/50 transition-colors"
                      >
                        <span className="text-sm font-semibold">
                          {step.title}
                        </span>
                        {isOpen ? (
                          <FiChevronUp className="text-brand-400 text-base" />
                        ) : (
                          <FiChevronDown className="text-gray-500 text-base" />
                        )}
                      </button>
                      {isOpen && (
                        <div className="px-4 pb-4 pt-1 text-xs text-gray-400 border-t border-gray-800/80 leading-relaxed">
                          {step.content}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}

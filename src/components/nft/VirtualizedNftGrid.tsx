import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Card, CardBody, Button, Chip } from "@heroui/react";
import { FiKey, FiEye, FiTrash, FiFile } from "react-icons/fi";
import { TokenData } from "../../services/contract.service";
import { formatDate, shortenAddress } from "../../utils/helpers";

export interface VirtualizedNftGridProps {
  tokens: TokenData[];
  columns: number;
  vaultNameById: Record<number, string>;
  burningTokenId: number | null;
  getPassArtGradient: (token: TokenData) => string;
  onView: (token: TokenData) => void;
  onBurn: (tokenId: number) => void;
  onOpenVaultDocuments: (token: TokenData) => void;
}

const NFT_ROW_ESTIMATED_HEIGHT = 380;
const NFT_GRID_ROW_CLASS =
  "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 pb-6";

export const VirtualizedNftGrid = ({
  tokens,
  columns,
  vaultNameById,
  burningTokenId,
  getPassArtGradient,
  onView,
  onBurn,
  onOpenVaultDocuments,
}: VirtualizedNftGridProps) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const rows: TokenData[][] = [];
  for (let i = 0; i < tokens.length; i += columns) {
    rows.push(tokens.slice(i, i + columns));
  }

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => NFT_ROW_ESTIMATED_HEIGHT,
    overscan: 3,
  });

  return (
    <div
      ref={scrollRef}
      data-testid="nft-scroll-container"
      className="max-h-[48rem] overflow-auto"
    >
      <div
        style={{ position: "relative", height: rowVirtualizer.getTotalSize() }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const rowTokens = rows[virtualRow.index];
          return (
            <div
              key={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              data-index={virtualRow.index}
              data-testid="nft-row"
              className={NFT_GRID_ROW_CLASS}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {rowTokens.map((token) => (
                <Card
                  key={token.tokenId}
                  data-testid="nft-card"
                  data-token-id={token.tokenId}
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
                        <Chip
                          size="sm"
                          variant="flat"
                          className="bg-black/35 text-gray-100 border border-white/15"
                        >
                          {token.vaultId !== null
                            ? `Vault #${token.vaultId}`
                            : "Vault Unlinked"}
                        </Chip>
                      </div>
                      <div className="absolute top-3 right-3">
                        <Chip color="success" variant="flat" size="sm">
                          active
                        </Chip>
                      </div>
                    </div>

                    <div className="p-6">
                      <h3 className="font-bold text-lg mb-3">
                        Access Pass #{token.tokenId}
                      </h3>

                      <div className="space-y-2 mb-4">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-400">Vault</span>
                          <span className="font-medium">
                            {token.vaultId !== null
                              ? vaultNameById[token.vaultId] ||
                                `Vault #${token.vaultId}`
                              : "Unknown"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-400">Owner</span>
                          <span className="font-mono text-xs">
                            {shortenAddress(token.owner)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-400">Issued</span>
                          <span>
                            {token.mintedAt ? formatDate(token.mintedAt) : "-"}
                          </span>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <Button
                          fullWidth
                          variant="flat"
                          startContent={<FiEye />}
                          data-testid="nft-view-button"
                          onPress={() => {
                            onView(token);
                          }}
                        >
                          View
                        </Button>
                        <Button
                          fullWidth
                          color="danger"
                          variant="flat"
                          startContent={<FiTrash />}
                          data-testid="nft-burn-button"
                          isLoading={burningTokenId === token.tokenId}
                          onPress={() => onBurn(token.tokenId)}
                        >
                          Burn
                        </Button>
                      </div>
                      <Button
                        fullWidth
                        variant="flat"
                        className="mt-2"
                        startContent={<FiFile />}
                        data-testid="nft-vault-documents-button"
                        isDisabled={token.vaultId === null}
                        onPress={() => onOpenVaultDocuments(token)}
                      >
                        Vault Documents
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default VirtualizedNftGrid;

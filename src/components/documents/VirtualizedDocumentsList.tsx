import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button, Chip } from "@heroui/react";
import {
  FiFile,
  FiUser,
  FiCalendar,
  FiShield,
  FiEye,
  FiDownload,
  FiSend,
  FiCopy,
} from "react-icons/fi";
import { DocumentData, AccessRequestData } from "../../services/contract.service";
import { buttonClasses } from "../../utils/buttonClasses";
import { formatDate, shortenAddress } from "../../utils/helpers";

export interface DocumentRowItem {
  doc: DocumentData;
  metadata: { name?: string; size?: number; type?: string } | null;
  name: string;
  vaultName: string;
  hasChainAccess: boolean;
  hasLocalKey: boolean;
  canDecrypt: boolean;
  latestRequest: AccessRequestData | null;
  isRequestPending: boolean;
  releaseCondition: number;
}

export interface VirtualizedDocumentsListProps {
  items: DocumentRowItem[];
  loading: boolean;
  requestingDocId: number | null;
  accessLabel: (level: number) => string;
  releaseConditionLabel: (condition: number) => string;
  onView: (doc: DocumentData) => void;
  onDownload: (doc: DocumentData) => void;
  onRequestAccess: (docId: number) => void;
  onShareKey: (docId: number) => void;
  onCopyIpfsHash: (ipfsHash: string) => void;
}

const DOCUMENT_ROW_ESTIMATED_HEIGHT = 84;
const DOCUMENTS_GRID_COLUMNS_CLASS =
  "grid grid-cols-[minmax(220px,2.2fr)_minmax(140px,1.2fr)_minmax(120px,1fr)_minmax(110px,0.9fr)_minmax(130px,1fr)_minmax(240px,1.8fr)] gap-4";

export const VirtualizedDocumentsList = ({
  items,
  loading,
  requestingDocId,
  accessLabel,
  releaseConditionLabel,
  onView,
  onDownload,
  onRequestAccess,
  onShareKey,
  onCopyIpfsHash,
}: VirtualizedDocumentsListProps) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => DOCUMENT_ROW_ESTIMATED_HEIGHT,
    overscan: 6,
  });

  return (
    <div
      ref={scrollRef}
      role="table"
      aria-label="Documents table"
      className="max-h-[36rem] overflow-auto"
    >
      <div className="min-w-[58rem]">
        <div
          role="row"
          className={`${DOCUMENTS_GRID_COLUMNS_CLASS} sticky top-0 z-10 items-center border-b border-gray-800 bg-gray-900/95 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-400 backdrop-blur-sm`}
        >
          <span role="columnheader">FILE</span>
          <span role="columnheader">VAULT</span>
          <span role="columnheader">STATUS</span>
          <span role="columnheader">ACCESS</span>
          <span role="columnheader">RELEASE</span>
          <span role="columnheader">ACTIONS</span>
        </div>

        {items.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400" role="row">
            {loading ? "Loading files..." : "No files found"}
          </div>
        ) : (
          <div role="rowgroup" style={{ position: "relative", height: rowVirtualizer.getTotalSize() }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const item = items[virtualRow.index];
              return (
                <div
                  key={item.doc.id}
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  data-testid="document-row"
                  data-document-id={item.doc.id}
                  role="row"
                  className={`${DOCUMENTS_GRID_COLUMNS_CLASS} items-center border-b border-gray-800/60 px-4 py-3`}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div role="cell" className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gray-800 rounded-lg flex items-center justify-center">
                      <FiFile className="text-gray-400" />
                    </div>
                    <div>
                      <p className="font-medium">{item.name}</p>
                      <div className="flex items-center gap-2 text-xs text-gray-400">
                        <FiUser />
                        <span>{shortenAddress(item.doc.uploadedBy)}</span>
                        <FiCalendar />
                        <span>{formatDate(item.doc.uploadedAt)}</span>
                      </div>
                    </div>
                  </div>
                  <div role="cell" className="flex items-center gap-2">
                    <FiShield className="text-gray-400" />
                    <span>{item.vaultName}</span>
                  </div>
                  <div role="cell">
                    {item.canDecrypt ? (
                      <Chip color="success" variant="flat" size="sm">
                        Decryptable
                      </Chip>
                    ) : item.isRequestPending ? (
                      <Chip color="warning" variant="flat" size="sm">
                        Request Pending
                      </Chip>
                    ) : item.hasChainAccess ? (
                      <Chip color="warning" variant="flat" size="sm">
                        Key Missing
                      </Chip>
                    ) : (
                      <Chip color="danger" variant="flat" size="sm">
                        Locked
                      </Chip>
                    )}
                  </div>
                  <div role="cell">
                    <Chip
                      color={
                        item.doc.requiredAccess === 2
                          ? "danger"
                          : item.doc.requiredAccess === 1
                          ? "warning"
                          : "success"
                      }
                      variant="flat"
                      size="sm"
                    >
                      {accessLabel(item.doc.requiredAccess)}
                    </Chip>
                  </div>
                  <div role="cell">
                    <Chip
                      color={
                        item.releaseCondition === 3
                          ? "danger"
                          : item.releaseCondition === 2
                          ? "warning"
                          : item.releaseCondition === 1
                          ? "primary"
                          : "success"
                      }
                      variant="flat"
                      size="sm"
                    >
                      {releaseConditionLabel(item.releaseCondition)}
                    </Chip>
                  </div>
                  <div role="cell" className="flex items-center gap-2 flex-wrap">
                    <Button
                      isIconOnly
                      variant="light"
                      size="sm"
                      aria-label="View document"
                      data-testid="document-view-button"
                      isDisabled={!item.canDecrypt}
                      onPress={() => onView(item.doc)}
                    >
                      <FiEye />
                    </Button>
                    <Button
                      isIconOnly
                      variant="light"
                      size="sm"
                      aria-label="Download document"
                      data-testid="document-download-button"
                      isDisabled={!item.canDecrypt}
                      onPress={() => onDownload(item.doc)}
                    >
                      <FiDownload />
                    </Button>
                    {!item.hasChainAccess && (
                      <Button
                        size="sm"
                        className={buttonClasses.outlineSm}
                        data-testid="document-request-access-button"
                        isDisabled={item.isRequestPending || requestingDocId === item.doc.id}
                        isLoading={requestingDocId === item.doc.id}
                        onPress={() => onRequestAccess(item.doc.id)}
                      >
                        {item.isRequestPending ? "Pending" : "Request Access"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      className={buttonClasses.ghostSm}
                      startContent={<FiSend />}
                      data-testid="document-share-key-button"
                      isDisabled={!item.hasLocalKey}
                      onPress={() => onShareKey(item.doc.id)}
                    >
                      Share Key
                    </Button>
                    <Button
                      isIconOnly
                      variant="light"
                      size="sm"
                      aria-label="Copy IPFS hash"
                      data-testid="document-copy-ipfs-button"
                      onPress={() => onCopyIpfsHash(item.doc.ipfsHash)}
                    >
                      <FiCopy />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default VirtualizedDocumentsList;

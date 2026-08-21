// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  VirtualizedDocumentsList,
  DocumentRowItem,
} from "../components/documents/VirtualizedDocumentsList";
import { DocumentData } from "../services/contract.service";

const DOCUMENT_ROW_HEIGHT = 84;
const VIEWPORT_HEIGHT = 600;

const stubRect = (height: number) => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  bottom: height,
  right: 900,
  width: 900,
  height,
  toJSON: () => ({}),
});

const buildItem = (id: number, overrides: Partial<DocumentRowItem> = {}): DocumentRowItem => {
  const doc: DocumentData = {
    id,
    vaultId: 1,
    encryptedMetadata: "",
    ipfsHash: `hash-${id}`,
    uploadedBy: "0x1111111111111111111111111111111111111111",
    uploadedAt: 1700000000,
    requiredAccess: 0,
  };
  return {
    metadata: { name: `Document ${id}` },
    name: `Document ${id}`,
    vaultName: "Family Vault",
    hasChainAccess: true,
    hasLocalKey: true,
    canDecrypt: true,
    latestRequest: null,
    isRequestPending: false,
    releaseCondition: 0,
    ...overrides,
    doc: { ...doc, ...(overrides.doc ?? {}) },
  };
};

const buildItems = (count: number): DocumentRowItem[] =>
  Array.from({ length: count }, (_, i) => buildItem(i + 1));

const noop = () => {};

const renderList = (
  items: DocumentRowItem[],
  overrides: Partial<ComponentProps<typeof VirtualizedDocumentsList>> = {}
) =>
  render(
    <VirtualizedDocumentsList
      items={items}
      loading={false}
      requestingDocId={null}
      accessLabel={(level) => (level === 2 ? "admin" : level === 1 ? "read_write" : "read")}
      releaseConditionLabel={(condition) =>
        condition === 1 ? "live_only" : condition === 2 ? "emergency_only" : condition === 3 ? "post_death_only" : "anytime"
      }
      onView={noop}
      onDownload={noop}
      onRequestAccess={noop}
      onShareKey={noop}
      onCopyIpfsHash={noop}
      {...overrides}
    />
  );

const getMountedDocumentIds = () =>
  screen
    .getAllByTestId("document-row")
    .map((row) => row.getAttribute("data-document-id"));

describe("VirtualizedDocumentsList", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.getAttribute("data-testid") === "document-row") {
        return stubRect(DOCUMENT_ROW_HEIGHT) as DOMRect;
      }
      return stubRect(VIEWPORT_HEIGHT) as DOMRect;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the empty-state message when there are no documents", () => {
    renderList([]);
    expect(screen.getByText("No files found")).toBeInTheDocument();
    expect(screen.queryAllByTestId("document-row")).toHaveLength(0);
  });

  it("renders every row when the list is smaller than the overscan window", () => {
    renderList(buildItems(5));
    expect(screen.getAllByTestId("document-row")).toHaveLength(5);
  });

  it("keeps the mounted row count bounded when there are hundreds of documents", () => {
    const items = buildItems(500);
    renderList(items);

    const mountedRows = screen.getAllByTestId("document-row");
    expect(mountedRows.length).toBeGreaterThan(0);
    expect(mountedRows.length).toBeLessThan(50);
    expect(mountedRows.length).toBeLessThan(items.length);
  });

  it("mounts only documents near the top of the list before scrolling", () => {
    const items = buildItems(500);
    renderList(items);

    const mountedIds = getMountedDocumentIds();
    expect(mountedIds).toContain("1");
    expect(mountedIds).not.toContain("500");
  });

  it("swaps the mounted set of documents when the container is scrolled", () => {
    const items = buildItems(500);
    const { container } = renderList(items);

    const scrollContainer = container.querySelector('[role="table"]') as HTMLElement;
    expect(scrollContainer).toBeTruthy();

    const idsBeforeScroll = new Set(getMountedDocumentIds());
    expect(idsBeforeScroll.has("1")).toBe(true);

    Object.defineProperty(scrollContainer, "scrollTop", {
      value: 200 * DOCUMENT_ROW_HEIGHT,
      writable: true,
    });
    fireEvent.scroll(scrollContainer);

    const idsAfterScroll = new Set(getMountedDocumentIds());
    expect(idsAfterScroll.has("1")).toBe(false);
    expect([...idsAfterScroll].some((id) => !idsBeforeScroll.has(id as string))).toBe(true);
  });

  it("invokes onView and onDownload for a decryptable document", () => {
    const onView = vi.fn();
    const onDownload = vi.fn();
    const item = buildItem(1, { canDecrypt: true });
    renderList([item], { onView, onDownload });

    fireEvent.click(screen.getByTestId("document-view-button"));
    fireEvent.click(screen.getByTestId("document-download-button"));

    expect(onView).toHaveBeenCalledWith(item.doc);
    expect(onDownload).toHaveBeenCalledWith(item.doc);
  });

  it("disables view/download and shows the Locked chip when a document cannot be decrypted", () => {
    const item = buildItem(1, { canDecrypt: false, hasChainAccess: false, hasLocalKey: false });
    renderList([item]);

    expect(screen.getByTestId("document-view-button")).toBeDisabled();
    expect(screen.getByTestId("document-download-button")).toBeDisabled();
    expect(screen.getByText("Locked")).toBeInTheDocument();
  });

  it("invokes onRequestAccess for a document without chain access", () => {
    const onRequestAccess = vi.fn();
    const item = buildItem(1, { hasChainAccess: false, canDecrypt: false, isRequestPending: false });
    renderList([item], { onRequestAccess });

    fireEvent.click(screen.getByTestId("document-request-access-button"));
    expect(onRequestAccess).toHaveBeenCalledWith(1);
  });

  it("shows a disabled Pending state while an access request is outstanding", () => {
    const item = buildItem(1, {
      hasChainAccess: false,
      canDecrypt: false,
      isRequestPending: true,
    });
    renderList([item]);

    expect(screen.getByText("Request Pending")).toBeInTheDocument();
    expect(screen.getByTestId("document-request-access-button")).toBeDisabled();
    expect(screen.getByTestId("document-request-access-button")).toHaveTextContent("Pending");
  });

  it("disables the request-access button while that document's request is in flight", () => {
    const item = buildItem(1, { hasChainAccess: false, canDecrypt: false });
    renderList([item], { requestingDocId: 1 });

    expect(screen.getByTestId("document-request-access-button")).toBeDisabled();
  });

  it("hides the Request Access button once chain access has been granted", () => {
    const item = buildItem(1, { hasChainAccess: true, canDecrypt: true });
    renderList([item]);

    expect(screen.queryByTestId("document-request-access-button")).not.toBeInTheDocument();
  });

  it("shows Key Missing when access is granted on-chain but no local key is present", () => {
    const item = buildItem(1, { hasChainAccess: true, hasLocalKey: false, canDecrypt: false });
    renderList([item]);

    expect(screen.getByText("Key Missing")).toBeInTheDocument();
  });

  it("invokes onShareKey only when a local key is available", () => {
    const onShareKey = vi.fn();
    const item = buildItem(1, { hasLocalKey: true });
    renderList([item], { onShareKey });

    const shareButton = screen.getByTestId("document-share-key-button");
    expect(shareButton).toBeEnabled();
    fireEvent.click(shareButton);
    expect(onShareKey).toHaveBeenCalledWith(1);
  });

  it("disables Share Key when the document has no local key", () => {
    const item = buildItem(1, { hasLocalKey: false });
    renderList([item]);

    expect(screen.getByTestId("document-share-key-button")).toBeDisabled();
  });

  it("invokes onCopyIpfsHash with the document's IPFS hash", () => {
    const onCopyIpfsHash = vi.fn();
    const item = buildItem(1);
    renderList([item], { onCopyIpfsHash });

    fireEvent.click(screen.getByTestId("document-copy-ipfs-button"));
    expect(onCopyIpfsHash).toHaveBeenCalledWith(item.doc.ipfsHash);
  });

  it("renders the access and release labels returned by the provided formatters for every level", () => {
    const items = [0, 1, 2, 3].map((level) =>
      buildItem(level + 1, {
        doc: { requiredAccess: level % 3 } as DocumentData,
        releaseCondition: level,
      })
    );
    renderList(items);

    ["read", "read_write", "admin", "anytime", "live_only", "emergency_only", "post_death_only"].forEach(
      (label) => {
        expect(screen.getAllByText(label).length).toBeGreaterThan(0);
      }
    );
  });

  it("shows the loading message instead of the empty message while documents are loading", () => {
    renderList([], { loading: true });
    expect(screen.getByText("Loading files...")).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { VirtualizedNftGrid } from "../components/nft/VirtualizedNftGrid";
import { TokenData } from "../services/contract.service";

const NFT_ROW_HEIGHT = 380;
const VIEWPORT_HEIGHT = 900;

const stubRect = (height: number) => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  bottom: height,
  right: 1200,
  width: 1200,
  height,
  toJSON: () => ({}),
});

const buildToken = (
  id: number,
  overrides: Partial<TokenData> = {}
): TokenData => ({
  tokenId: id,
  owner: "0x2222222222222222222222222222222222222222",
  vaultId: 1,
  tokenURI: "",
  mintedAt: 1700000000,
  ...overrides,
});

const buildTokens = (count: number): TokenData[] =>
  Array.from({ length: count }, (_, i) => buildToken(i + 1));

const noop = () => {};

const renderGrid = (
  tokens: TokenData[],
  overrides: Partial<ComponentProps<typeof VirtualizedNftGrid>> = {}
) =>
  render(
    <VirtualizedNftGrid
      tokens={tokens}
      columns={3}
      vaultNameById={{ 1: "Family Vault" }}
      burningTokenId={null}
      getPassArtGradient={() => "none"}
      onView={noop}
      onBurn={noop}
      onOpenVaultDocuments={noop}
      {...overrides}
    />
  );

const getMountedTokenIds = () =>
  screen
    .getAllByTestId("nft-card")
    .map((card: HTMLElement) => card.getAttribute("data-token-id"));

describe("VirtualizedNftGrid", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.getAttribute("data-testid") === "nft-row") {
          return stubRect(NFT_ROW_HEIGHT) as DOMRect;
        }
        return stubRect(VIEWPORT_HEIGHT) as DOMRect;
      }
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders every card when the token list is smaller than the overscan window", () => {
    renderGrid(buildTokens(6));
    expect(screen.getAllByTestId("nft-card")).toHaveLength(6);
  });

  it("keeps the mounted card count bounded when there are hundreds of tokens", () => {
    const tokens = buildTokens(450);
    renderGrid(tokens);

    const mountedCards = screen.getAllByTestId("nft-card");
    expect(mountedCards.length).toBeGreaterThan(0);
    expect(mountedCards.length).toBeLessThan(80);
    expect(mountedCards.length).toBeLessThan(tokens.length);
  });

  it("mounts only tokens near the top of the list before scrolling", () => {
    renderGrid(buildTokens(450));

    const mountedIds = getMountedTokenIds();
    expect(mountedIds).toContain("1");
    expect(mountedIds).not.toContain("450");
  });

  it("swaps the mounted set of tokens when the container is scrolled", () => {
    const tokens = buildTokens(450);
    const { container } = renderGrid(tokens);

    const scrollContainer = container.querySelector(
      '[data-testid="nft-scroll-container"]'
    ) as HTMLElement;
    expect(scrollContainer).toBeTruthy();

    const idsBeforeScroll = new Set(getMountedTokenIds());
    expect(idsBeforeScroll.has("1")).toBe(true);

    Object.defineProperty(scrollContainer, "scrollTop", {
      value: 100 * NFT_ROW_HEIGHT,
      writable: true,
    });
    fireEvent.scroll(scrollContainer);

    const idsAfterScroll = new Set(getMountedTokenIds());
    expect(idsAfterScroll.has("1")).toBe(false);
    expect(
      [...idsAfterScroll].some((id) => !idsBeforeScroll.has(id as string))
    ).toBe(true);
  });

  it("invokes onView with the token when View is pressed", () => {
    const onView = vi.fn();
    const token = buildToken(1);
    renderGrid([token], { onView });

    fireEvent.click(screen.getByTestId("nft-view-button"));
    expect(onView).toHaveBeenCalledWith(token);
  });

  it("invokes onBurn with the tokenId when Burn is pressed", () => {
    const onBurn = vi.fn();
    renderGrid([buildToken(7)], { onBurn });

    fireEvent.click(screen.getByTestId("nft-burn-button"));
    expect(onBurn).toHaveBeenCalledWith(7);
  });

  it("shows the Burn button as loading only for the token currently being burned", () => {
    renderGrid([buildToken(1), buildToken(2)], { burningTokenId: 1 });

    const burnButtons = screen.getAllByTestId("nft-burn-button");
    expect(burnButtons[0]).toHaveAttribute("data-loading", "true");
    expect(burnButtons[1]).not.toHaveAttribute("data-loading", "true");
  });

  it("invokes onOpenVaultDocuments when a linked token's Vault Documents button is pressed", () => {
    const onOpenVaultDocuments = vi.fn();
    const token = buildToken(1, { vaultId: 4 });
    renderGrid([token], { onOpenVaultDocuments });

    fireEvent.click(screen.getByTestId("nft-vault-documents-button"));
    expect(onOpenVaultDocuments).toHaveBeenCalledWith(token);
  });

  it("disables Vault Documents and labels the pass Unlinked when no vault is associated", () => {
    renderGrid([buildToken(1, { vaultId: null })]);

    expect(screen.getByTestId("nft-vault-documents-button")).toBeDisabled();
    expect(screen.getByText("Vault Unlinked")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("falls back to a generic vault label when the id isn't present in vaultNameById", () => {
    renderGrid([buildToken(1, { vaultId: 99 })]);
    expect(screen.getAllByText("Vault #99").length).toBeGreaterThan(0);
  });

  it("shows a placeholder dash when a token has no mintedAt timestamp", () => {
    renderGrid([buildToken(1, { mintedAt: null })]);
    expect(screen.getByText("-")).toBeInTheDocument();
  });

  it("renders no cards when given an empty tokens array directly", () => {
    const { container } = renderGrid([]);
    expect(screen.queryAllByTestId("nft-card")).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="nft-scroll-container"]')
    ).toBeInTheDocument();
  });
});

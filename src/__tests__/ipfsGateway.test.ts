import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IPFS_GATEWAYS,
  IpfsGatewayFetchError,
  buildGatewayUrl,
  createIpfsGatewayClient,
  ipfsGateway,
  normalizeGatewayBase,
  normalizeIpfsCid,
  resolveGatewayPool,
  type FetchFn,
} from "../services/ipfsGateway";
import { ipfsService } from "../services/ipfs.service";
import { fetchFromIPFS, getIPFSURL } from "../utils/helpers";

const CID = "QmTestDocumentCid1234567890";
const PINATA = "https://gateway.pinata.cloud/ipfs/";
const INFURA = "https://ipfs.infura.io/ipfs/";
const CLOUDFLARE = "https://cloudflare-ipfs.com/ipfs/";
const IPFS_IO = "https://ipfs.io/ipfs/";

const jsonResponse = (status: number, body = "encrypted-bytes"): Response =>
  new Response(body, { status, statusText: status === 200 ? "OK" : "Error" });

const hangingFetch = (ms = 5_000): FetchFn => {
  return (_input, init) =>
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("hang never aborted")),
        ms
      );
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        },
        { once: true }
      );
    });
};

const delayedFetch = (
  status: number,
  body: string,
  delayMs: number
): FetchFn => {
  return (_input, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(jsonResponse(status, body)),
        delayMs
      );
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        },
        { once: true }
      );
    });
};

const gatewayOf = (url: string): string => {
  if (url.includes("pinata")) return PINATA;
  if (url.includes("infura")) return INFURA;
  if (url.includes("cloudflare")) return CLOUDFLARE;
  if (url.includes("ipfs.io")) return IPFS_IO;
  return url;
};

describe("IPFS CID and gateway URL helpers", () => {
  it("normalizes ipfs://, /ipfs/, query, and hash fragments", () => {
    expect(normalizeIpfsCid(`ipfs://${CID}`)).toBe(CID);
    expect(normalizeIpfsCid(`/ipfs/${CID}`)).toBe(CID);
    expect(normalizeIpfsCid(`ipfs/${CID}?download=1#frag`)).toBe(CID);
    expect(normalizeIpfsCid(`  ${CID}  `)).toBe(CID);
  });

  it("extracts a CID from an existing gateway HTTP URL", () => {
    expect(normalizeIpfsCid(`https://gateway.pinata.cloud/ipfs/${CID}`)).toBe(
      CID
    );
    expect(normalizeIpfsCid(`https://example.com/${CID}`)).toBe(CID);
  });

  it("returns empty for blank input and survives invalid HTTP URLs", () => {
    expect(normalizeIpfsCid("")).toBe("");
    expect(normalizeIpfsCid("   ")).toBe("");
    expect(normalizeIpfsCid("https://")).toBe("https://");
  });

  it("normalizes gateway bases and joins CID paths", () => {
    expect(normalizeGatewayBase("")).toBe("");
    expect(normalizeGatewayBase("https://ipfs.io/ipfs")).toBe(
      "https://ipfs.io/ipfs/"
    );
    expect(normalizeGatewayBase(PINATA)).toBe(PINATA);
    expect(buildGatewayUrl(PINATA, CID)).toBe(`${PINATA}${CID}`);
  });

  it("builds a pool with Pinata, Infura, Cloudflare, and ipfs.io", () => {
    const pool = resolveGatewayPool({ primary: PINATA });
    expect(pool[0]).toBe(PINATA);
    expect(pool).toEqual([...DEFAULT_IPFS_GATEWAYS]);
  });

  it("puts a custom primary first and appends extra gateways without duplicates", () => {
    const pool = resolveGatewayPool({
      primary: "https://w3s.link/ipfs/",
      extras: [PINATA, "https://dweb.link/ipfs", "", "https://dweb.link/ipfs/"],
    });
    expect(pool[0]).toBe("https://w3s.link/ipfs/");
    expect(pool).toContain(PINATA);
    expect(pool.filter((item) => item.includes("dweb.link"))).toHaveLength(1);
  });
});

describe("createIpfsGatewayClient race fetch and circuit breaker", () => {
  it("returns the primary gateway response when Pinata is healthy", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.startsWith(PINATA)) {
        return jsonResponse(200, "pinata-body");
      }
      return jsonResponse(500, "unused");
    });
    const client = createIpfsGatewayClient({ fetchFn, timeoutMs: 200 });

    const response = await client.fetchFile(CID);
    expect(await response.text()).toBe("pinata-body");
    expect(client.getURL(`ipfs://${CID}`)).toBe(`${PINATA}${CID}`);
    expect(client.getGatewayPool()).toEqual([...DEFAULT_IPFS_GATEWAYS]);
  });

  it("failovers when the primary gateway returns HTTP 429", async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.startsWith(PINATA)) return jsonResponse(429, "rate-limited");
      if (url.startsWith(CLOUDFLARE))
        return jsonResponse(200, "cloudflare-body");
      return jsonResponse(503, "down");
    };
    const client = createIpfsGatewayClient({ fetchFn, timeoutMs: 200 });

    const response = await client.fetchFile(`ipfs://${CID}`);
    expect(await response.text()).toBe("cloudflare-body");
    expect(client.getCircuitState(PINATA)).toBe("open");
    expect(client.getCircuitState(CLOUDFLARE)).toBe("closed");
  });

  it("failovers when the primary gateway times out", async () => {
    const fetchFn: FetchFn = async (url, init) => {
      if (url.startsWith(PINATA)) return hangingFetch(5_000)(url, init);
      if (url.startsWith(IPFS_IO)) return jsonResponse(200, "ipfs-io-body");
      return jsonResponse(503);
    };
    const client = createIpfsGatewayClient({ fetchFn, timeoutMs: 200 });

    const response = await client.fetchFile(CID);
    expect(await response.text()).toBe("ipfs-io-body");
  });

  it("opens the circuit when a gateway exceeds the request timeout", async () => {
    const client = createIpfsGatewayClient({
      fetchFn: hangingFetch(5_000),
      timeoutMs: 40,
      gateways: [PINATA],
    });

    await expect(client.fetchFile(CID)).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof IpfsGatewayFetchError &&
        error.failures.some((failure) => failure.includes("timeout"))
      );
    });
    expect(client.getCircuitState(PINATA)).toBe("open");
  });

  it("races gateways and aborts losers once the first 2xx arrives", async () => {
    const aborted = new Set<string>();
    const fetchFn: FetchFn = (url, init) => {
      const gateway = gatewayOf(url);
      if (url.startsWith(CLOUDFLARE)) {
        return delayedFetch(200, "fast-cloudflare", 20)(url, init);
      }
      return new Promise((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted.add(gateway);
            reject(
              new DOMException("The operation was aborted.", "AbortError")
            );
          },
          { once: true }
        );
      });
    };
    const client = createIpfsGatewayClient({ fetchFn, timeoutMs: 400 });

    const response = await client.fetchFile(CID);
    expect(await response.text()).toBe("fast-cloudflare");
    expect(aborted.has(PINATA)).toBe(true);
  });

  it("skips an open Pinata circuit on the next download", async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(gatewayOf(url));
      if (url.startsWith(PINATA)) return jsonResponse(429);
      if (url.startsWith(INFURA)) return jsonResponse(200, "infura-body");
      return jsonResponse(404);
    };
    const client = createIpfsGatewayClient({
      fetchFn,
      timeoutMs: 200,
      cooldownMs: 30_000,
    });

    await client.fetchFile(CID);
    calls.length = 0;
    const response = await client.fetchFile(CID);

    expect(await response.text()).toBe("infura-body");
    expect(calls).not.toContain(PINATA);
    expect(client.getCircuitState(PINATA)).toBe("open");
  });

  it("moves a cooled-down circuit to half-open and closes it after a probe succeeds", async () => {
    let now = 1_000;
    let pinataHealthy = false;
    const fetchFn = vi.fn(async (url: string) => {
      if (url.startsWith(PINATA)) {
        return pinataHealthy
          ? jsonResponse(200, "recovered")
          : jsonResponse(429);
      }
      return jsonResponse(503);
    });
    const client = createIpfsGatewayClient({
      fetchFn,
      now: () => now,
      timeoutMs: 50,
      cooldownMs: 1_000,
      gateways: [PINATA, INFURA],
    });

    await expect(client.fetchFile(CID)).rejects.toBeInstanceOf(
      IpfsGatewayFetchError
    );
    expect(client.getCircuitState(PINATA)).toBe("open");

    now += 1_000;
    pinataHealthy = true;
    expect(client.getCircuitState(PINATA)).toBe("half-open");

    const response = await client.fetchFile(CID);
    expect(await response.text()).toBe("recovered");
    expect(client.getCircuitState(PINATA)).toBe("closed");
  });

  it("still probes gateways when every circuit is open so downloads can recover", async () => {
    let now = 5_000;
    const fetchFn = vi.fn(async () => jsonResponse(429));
    const client = createIpfsGatewayClient({
      fetchFn,
      now: () => now,
      timeoutMs: 50,
      cooldownMs: 10_000,
      gateways: [PINATA, CLOUDFLARE],
    });

    await expect(client.fetchFile(CID)).rejects.toBeInstanceOf(
      IpfsGatewayFetchError
    );
    const firstCalls = fetchFn.mock.calls.length;
    await expect(client.fetchFile(CID)).rejects.toBeInstanceOf(
      IpfsGatewayFetchError
    );
    expect(fetchFn.mock.calls.length).toBeGreaterThan(firstCalls);
  });

  it("does not trip a circuit on HTTP 404 so the gateway stays eligible", async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.startsWith(PINATA)) return jsonResponse(404);
      if (url.startsWith(CLOUDFLARE))
        return jsonResponse(200, "found-elsewhere");
      return jsonResponse(404);
    };
    const client = createIpfsGatewayClient({ fetchFn, timeoutMs: 200 });

    expect(await (await client.fetchFile(CID)).text()).toBe("found-elsewhere");
    expect(client.getCircuitState(PINATA)).toBe("closed");
  });

  it("trips the circuit on 401/403 and 5xx responses", async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.startsWith(PINATA)) return jsonResponse(403);
      if (url.startsWith(INFURA)) return jsonResponse(502);
      if (url.startsWith(CLOUDFLARE)) return jsonResponse(200, "ok");
      return jsonResponse(408);
    };
    const client = createIpfsGatewayClient({ fetchFn, timeoutMs: 200 });

    expect(await (await client.fetchFile(CID)).text()).toBe("ok");
    expect(client.getCircuitState(PINATA)).toBe("open");
    expect(client.getCircuitState(INFURA)).toBe("open");
  });

  it("treats network errors as failures and trips the circuit", async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.startsWith(PINATA)) throw new TypeError("Failed to fetch");
      if (url.startsWith(INFURA)) throw "";
      if (url.startsWith(CLOUDFLARE)) throw new Error("");
      return jsonResponse(200, "last-resort");
    };
    const client = createIpfsGatewayClient({ fetchFn, timeoutMs: 200 });

    expect(await (await client.fetchFile(CID)).text()).toBe("last-resort");
    expect(client.getCircuitState(PINATA)).toBe("open");
    expect(client.getCircuitState(INFURA)).toBe("open");
    expect(client.getCircuitState(CLOUDFLARE)).toBe("open");
  });

  it("rejects with IpfsGatewayFetchError when every gateway fails", async () => {
    const client = createIpfsGatewayClient({
      fetchFn: async () => jsonResponse(429),
      timeoutMs: 50,
    });

    try {
      await client.fetchFile(CID);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(IpfsGatewayFetchError);
      const failed = error as IpfsGatewayFetchError;
      expect(failed.cid).toBe(CID);
      expect(failed.code).toBe("GATEWAY_FETCH_FAILED");
      expect(failed.failures.length).toBe(DEFAULT_IPFS_GATEWAYS.length);
      expect(failed.message).toContain("all gateways failed");
    }
  });

  it("rejects empty CIDs and already-aborted signals", async () => {
    const client = createIpfsGatewayClient({
      fetchFn: async () => jsonResponse(200),
    });
    await expect(client.fetchFile("   ")).rejects.toThrow(
      "IPFS CID is required"
    );

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      client.fetchFile(CID, { signal: aborted.signal })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError"
    );

    const custom = new AbortController();
    const reason = new Error("user canceled");
    custom.abort(reason);
    await expect(client.fetchFile(CID, { signal: custom.signal })).rejects.toBe(
      reason
    );

    const stringAbort = new AbortController();
    stringAbort.abort("nope");
    await expect(
      client.fetchFile(CID, { signal: stringAbort.signal })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError"
    );
  });

  it("aborts an in-flight race when the caller cancels", async () => {
    const controller = new AbortController();
    const client = createIpfsGatewayClient({
      fetchFn: hangingFetch(5_000),
      timeoutMs: 500,
    });

    const pending = client.fetchFile(CID, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError"
    );
  });

  it("keeps a circuit closed until the failure threshold is reached", async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.startsWith(PINATA)) return jsonResponse(429);
      return jsonResponse(200, "fallback");
    };
    const client = createIpfsGatewayClient({
      fetchFn,
      timeoutMs: 200,
      failureThreshold: 2,
      cooldownMs: 5_000,
      gateways: [PINATA, CLOUDFLARE],
    });

    await client.fetchFile(CID);
    expect(client.getCircuitState(PINATA)).toBe("closed");
    await client.fetchFile(CID);
    expect(client.getCircuitState(PINATA)).toBe("open");
  });

  it("falls back to defaults for empty gateway lists and non-positive timings", () => {
    const client = createIpfsGatewayClient({
      gateways: ["", "   "],
      timeoutMs: 0,
      cooldownMs: -1,
      failureThreshold: Number.NaN,
    });
    expect(client.getGatewayPool()).toEqual([...DEFAULT_IPFS_GATEWAYS]);
    expect(client.getCircuitState("unknown-gateway")).toBe("closed");
  });

  it("forwards extra request init and resets circuits", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, "ok"));
    const client = createIpfsGatewayClient({
      fetchFn,
      timeoutMs: 200,
      gateways: [PINATA],
    });

    await client.fetchFile(CID, {
      headers: { Accept: "application/octet-stream" },
    });
    expect(fetchFn).toHaveBeenCalledWith(
      `${PINATA}${CID}`,
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/octet-stream" },
      })
    );

    const failing = createIpfsGatewayClient({
      fetchFn: async () => jsonResponse(429),
      timeoutMs: 50,
      gateways: [PINATA],
    });
    await expect(failing.fetchFile(CID)).rejects.toBeInstanceOf(
      IpfsGatewayFetchError
    );
    expect(failing.getCircuitState(PINATA)).toBe("open");
    failing.resetCircuits();
    expect(failing.getCircuitState(PINATA)).toBe("closed");
  });

  it("combines an already-aborted parent signal without hanging", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createIpfsGatewayClient({
      fetchFn: hangingFetch(5_000),
      timeoutMs: 30,
      gateways: [PINATA],
    });
    await expect(
      client.fetchFile(CID, { signal: controller.signal })
    ).rejects.toSatisfy((error: unknown) => error instanceof Error);
  });
});

describe("ipfsService and helper wrappers", () => {
  afterEach(() => {
    ipfsGateway.resetCircuits();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes the default gateway pool and a Pinata display URL", () => {
    expect(ipfsService.getGatewayPool()).toEqual([...DEFAULT_IPFS_GATEWAYS]);
    expect(ipfsService.getURL(CID)).toBe(`${PINATA}${CID}`);
    expect(getIPFSURL(`ipfs://${CID}`)).toBe(`${PINATA}${CID}`);
  });

  it("routes fetchFile and fetchFromIPFS through the resilient client", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(PINATA)) return jsonResponse(429);
      if (url.startsWith(CLOUDFLARE)) return jsonResponse(200, "via-wrapper");
      return jsonResponse(500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const viaService = await ipfsService.fetchFile(CID);
    expect(await viaService.text()).toBe("via-wrapper");

    ipfsGateway.resetCircuits();
    const viaHelper = await fetchFromIPFS(CID);
    expect(await viaHelper.text()).toBe("via-wrapper");
  });
});

import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  STREAMING_CHUNK_SIZE,
  STREAMING_HEADER_SIZE,
  benchmarkStreamingRoundTrip,
  collectStream,
  createDecryptTransform,
  createEncryptTransform,
  createMemoryStats,
  decryptIpfsDownloadToWritable,
  decryptStream,
  detectStreamingCiphertext,
  encryptAndUploadFile,
  encryptStream,
  hashStreamSha256,
  importStreamingKey,
  isStreamingEncryptedPrefix,
  streamingCryptoService,
} from "../services/streamingCrypto.service";
import { createMultipartFileStream, ipfsService } from "../services/ipfs.service";

const TEST_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const bytesFromStream = async (stream: ReadableStream<Uint8Array>) =>
  collectStream(stream);

const readableFromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      // Emit in irregular slice sizes to stress framing.
      let offset = 0;
      while (offset < bytes.byteLength) {
        const n = Math.min(1000 + (offset % 2000), bytes.byteLength - offset);
        controller.enqueue(bytes.subarray(offset, offset + n));
        offset += n;
      }
      controller.close();
    },
  });

describe("streamingCrypto.service", () => {
  it("imports a 32-byte hex key as AES-GCM", async () => {
    const key = await importStreamingKey(TEST_KEY_HEX);
    expect(key.algorithm).toEqual({ name: "AES-GCM", length: 256 });
    expect(key.usages).toEqual(expect.arrayContaining(["encrypt", "decrypt"]));
  });

  it("rejects malformed keys", async () => {
    await expect(importStreamingKey("deadbeef")).rejects.toThrow(/64-character/);
  });

  it("round-trips empty, small, and non-aligned payloads", async () => {
    const key = await importStreamingKey(TEST_KEY_HEX);
    const cases = [
      new Uint8Array(0),
      new Uint8Array([1, 2, 3, 4, 5]),
      new Uint8Array(STREAMING_CHUNK_SIZE),
      new Uint8Array(STREAMING_CHUNK_SIZE + 1),
      new Uint8Array(STREAMING_CHUNK_SIZE * 2),
      new Uint8Array(STREAMING_CHUNK_SIZE * 2 + 123),
    ];

    for (const plain of cases) {
      for (let i = 0; i < plain.length; i++) plain[i] = (i * 31) & 0xff;
      const encrypted = await bytesFromStream(
        encryptStream(readableFromBytes(plain), key)
      );
      expect(isStreamingEncryptedPrefix(encrypted)).toBe(true);
      expect(encrypted.byteLength).toBeGreaterThanOrEqual(STREAMING_HEADER_SIZE);

      const decrypted = await bytesFromStream(
        decryptStream(readableFromBytes(encrypted), key)
      );
      expect(decrypted).toEqual(plain);
    }
  }, 30_000);

  it("keeps transform peak buffers well under 50MB for multi-chunk inputs", async () => {
    const key = await importStreamingKey(TEST_KEY_HEX);
    const size = STREAMING_CHUNK_SIZE * 40; // 2.5 MiB
    const plain = new Uint8Array(size);
    const encStats = createMemoryStats();
    const decStats = createMemoryStats();

    const encrypted = encryptStream(readableFromBytes(plain), key, { stats: encStats });
    const decrypted = decryptStream(encrypted, key, { stats: decStats });
    const out = await collectStream(decrypted);

    expect(out.byteLength).toBe(size);
    expect(encStats.peakBufferBytes).toBeLessThan(50 * 1024 * 1024);
    expect(decStats.peakBufferBytes).toBeLessThan(50 * 1024 * 1024);
    // Structural bound: a couple of chunks plus frame overhead.
    expect(encStats.peakBufferBytes).toBeLessThan(STREAMING_CHUNK_SIZE * 4);
  });

  it("fails closed on wrong key and tampered ciphertext", async () => {
    const key = await importStreamingKey(TEST_KEY_HEX);
    const wrongKey = await importStreamingKey("ff".repeat(32));
    const plain = new Uint8Array(1000).fill(7);
    const encrypted = await bytesFromStream(
      encryptStream(readableFromBytes(plain), key)
    );

    await expect(
      bytesFromStream(decryptStream(readableFromBytes(encrypted), wrongKey))
    ).rejects.toThrow(/decryption failed/i);

    const tampered = encrypted.slice();
    tampered[tampered.byteLength - 1] ^= 0xff;
    await expect(
      bytesFromStream(decryptStream(readableFromBytes(tampered), key))
    ).rejects.toThrow(/decryption failed|trailing|truncated/i);
  });

  it("detects streaming ciphertext via magic prefix", async () => {
    const key = await importStreamingKey(TEST_KEY_HEX);
    const encrypted = await bytesFromStream(
      encryptStream(readableFromBytes(new Uint8Array([9, 8, 7])), key)
    );
    const { isStreaming, stream } = await detectStreamingCiphertext(
      readableFromBytes(encrypted)
    );
    expect(isStreaming).toBe(true);
    const again = await collectStream(stream);
    expect(again).toEqual(encrypted);

    const legacy = new TextEncoder().encode("Salted__not-streaming");
    const detected = await detectStreamingCiphertext(readableFromBytes(legacy));
    expect(detected.isStreaming).toBe(false);
  });

  it("pipes decryption into a WritableStream sink (FileSystemWritableFileStream stand-in)", async () => {
    const key = await importStreamingKey(TEST_KEY_HEX);
    const plain = new Uint8Array(50_000);
    for (let i = 0; i < plain.length; i++) plain[i] = i & 0xff;
    const encrypted = await bytesFromStream(
      encryptStream(readableFromBytes(plain), key)
    );

    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk.slice());
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response(readableFromBytes(encrypted), { status: 200 });
    }) as typeof fetch;

    try {
      await decryptIpfsDownloadToWritable("https://example.test/ipfs/cid", TEST_KEY_HEX, writable);
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
      }
      expect(out).toEqual(plain);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("matches Node crypto SHA-256 for hashStreamSha256", async () => {
    const payload = new Uint8Array(10_000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 13) & 0xff;
    const expected = createHash("sha256").update(payload).digest("hex");
    const actual = await hashStreamSha256(readableFromBytes(payload));
    expect(actual).toBe(expected);
  });

  it("exports a cohesive service facade", () => {
    expect(streamingCryptoService.STREAMING_CHUNK_SIZE).toBe(64 * 1024);
    expect(typeof streamingCryptoService.encryptAndUploadFile).toBe("function");
    expect(typeof streamingCryptoService.benchmarkStreamingRoundTrip).toBe("function");
  });
});

describe("ipfs multipart streaming helpers", () => {
  it("builds a multipart body that embeds the file stream bytes", async () => {
    const payload = new TextEncoder().encode("stream-me");
    const { body, contentType, boundary } = createMultipartFileStream(
      readableFromBytes(payload),
      {
        filename: "doc.svsc",
        metadata: { name: "doc.bin" },
      }
    );

    expect(contentType).toContain(`boundary=${boundary}`);
    const bytes = await collectStream(body);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain(`filename="doc.svsc"`);
    expect(text).toContain("stream-me");
    expect(text).toContain("pinataMetadata");
    expect(text).toContain(`--${boundary}--`);
  });
});

describe("streamingCrypto benchmarks", () => {
  const runBenchmark = async (sizeBytes: number, timeoutMs: number) => {
    const result = await benchmarkStreamingRoundTrip(sizeBytes, { patternSeed: 0xc0ffee });
    expect(result.match).toBe(true);
    expect(result.inputHash).toBe(result.outputHash);
    expect(result.peakBufferBytes).toBeLessThan(50 * 1024 * 1024);
    expect(result.elapsedMs).toBeLessThan(timeoutMs);
    return result;
  };

  it(
    "benchmarks 10MB streaming encrypt/decrypt with hash match and <50MB peak buffers",
    async () => {
      const result = await runBenchmark(10 * 1024 * 1024, 120_000);
      expect(result.sizeBytes).toBe(10 * 1024 * 1024);
    },
    180_000
  );

  it(
    "benchmarks 100MB streaming encrypt/decrypt with hash match and <50MB peak buffers",
    async () => {
      const result = await runBenchmark(100 * 1024 * 1024, 600_000);
      expect(result.sizeBytes).toBe(100 * 1024 * 1024);
    },
    900_000
  );

  it(
    "benchmarks 1GB streaming encrypt/decrypt with hash match and <50MB peak buffers",
    async () => {
      const result = await runBenchmark(1024 * 1024 * 1024, 3_600_000);
      expect(result.sizeBytes).toBe(1024 * 1024 * 1024);
    },
    3_600_000
  );
});

describe("encrypt transform framing invariants", () => {
  it("emits a final short/empty frame after exact multiples of chunk size", async () => {
    const key = await importStreamingKey(TEST_KEY_HEX);
    const plain = new Uint8Array(STREAMING_CHUNK_SIZE);
    const encrypted = await bytesFromStream(
      encryptStream(readableFromBytes(plain), key)
    );
    // Header + one full frame + one empty final frame.
    expect(encrypted.byteLength).toBeGreaterThan(STREAMING_HEADER_SIZE + STREAMING_CHUNK_SIZE);
    const decrypted = await bytesFromStream(
      decryptStream(readableFromBytes(encrypted), key)
    );
    expect(decrypted.byteLength).toBe(STREAMING_CHUNK_SIZE);
  });

  it("createEncryptTransform / createDecryptTransform are usable directly", async () => {
    const key = await importStreamingKey(TEST_KEY_HEX);
    const stats = createMemoryStats();
    const enc = createEncryptTransform(key, { stats });
    const dec = createDecryptTransform(key);
    const input = readableFromBytes(new TextEncoder().encode("vault-stream"));
    const out = await collectStream(input.pipeThrough(enc).pipeThrough(dec));
    expect(new TextDecoder().decode(out)).toBe("vault-stream");
    expect(stats.chunkCount).toBeGreaterThan(0);
  });
});

describe("encryptAndUploadFile integration (mocked IPFS)", () => {
  beforeEach(() => {
    vi.spyOn(ipfsService, "isConfigured").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("encrypts a Blob and uploads via uploadStream without buffering plaintext", async () => {
    const uploadSpy = vi
      .spyOn(ipfsService, "uploadStream")
      .mockImplementation(async (stream) => {
        // Drain and verify ciphertext magic without keeping plaintext.
        const cipher = await collectStream(stream);
        expect(isStreamingEncryptedPrefix(cipher)).toBe(true);
        return { hash: "QmMockCid", size: cipher.byteLength };
      });

    const file = new Blob([new Uint8Array(12_345).fill(3)], {
      type: "application/octet-stream",
    });
    const result = await encryptAndUploadFile(file, TEST_KEY_HEX, {
      filename: "large.bin.svsc",
      metadata: { name: "large.bin" },
    });

    expect(result.hash).toBe("QmMockCid");
    expect(uploadSpy).toHaveBeenCalledOnce();
  });
});

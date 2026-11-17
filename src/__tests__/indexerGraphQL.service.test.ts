// @ts-ignore
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { buildSchema, execute, parse } from 'graphql';
import {
  INDEXER_SCHEMA_SDL,
  indexerSchema,
  createIndexerClient,
  fetchDashboardData,
  subscribeToVaultActivity,
  reconcileOptimisticVaults,
  type IndexedVault,
  type IndexedActivityLog,
} from '../services/indexerGraphQL.service';

/* -------------------------------------------------------------------- */
/* Schema structure                                                      */
/* -------------------------------------------------------------------- */

describe('indexerGraphQL schema (issue #144)', () => {
  it('should build a valid schema and define all five required types', () => {
    const schema = buildSchema(INDEXER_SCHEMA_SDL);
    const typeMap = schema.getTypeMap();

    expect(typeMap.Vault).toBeDefined();
    expect(typeMap.Document).toBeDefined();
    expect(typeMap.AccessRequest).toBeDefined();
    expect(typeMap.GuardianApproval).toBeDefined();
    expect(typeMap.ActivityLog).toBeDefined();
  });

  it('should expose a single dashboard query and a vaultActivity subscription', () => {
    const queryFields = indexerSchema.getQueryType()?.getFields();
    const subscriptionFields = indexerSchema.getSubscriptionType()?.getFields();

    expect(queryFields).toHaveProperty('dashboard');
    expect(subscriptionFields).toHaveProperty('vaultActivity');
  });
});

/* -------------------------------------------------------------------- */
/* In-process mock indexer server (HTTP query + WS subscription)         */
/* -------------------------------------------------------------------- */

const MOCK_VAULT: IndexedVault = {
  gid: '43113:1',
  chainId: '43113',
  vaultId: 1,
  owner: '0xabc',
  documentCount: 2,
  emergencyMode: false,
  inactivityPeriod: 2592000,
  lastProofOfLife: '2026-08-01T00:00:00.000Z',
  postDeathUnlocked: false,
};

const mockSchema = buildSchema(INDEXER_SCHEMA_SDL);
const activityPublishers = new Set<(event: unknown) => void>();

const rootValue = {
  dashboard: () => ({
    vaults: [MOCK_VAULT],
    documents: [],
    accessRequests: [],
    guardianApprovals: [],
    activityLog: [],
  }),
};

let httpServer: http.Server;
let wsServer: WebSocketServer;
let httpUrl: string;
let wsUrl: string;

/**
 * Minimal server-side implementation of the graphql-transport-ws protocol,
 * just enough to drive the real client (graphql-ws's createClient, used
 * inside indexerGraphQL.service.ts) through a genuine WebSocket handshake
 * and push a real "next" message for the vaultActivity subscription.
 */
function attachGraphqlTransportWs(server: WebSocketServer) {
  server.on('connection', (socket: WsSocket) => {
    let unsubscribe: (() => void) | null = null;

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type === 'connection_init') {
        socket.send(JSON.stringify({ type: 'connection_ack' }));
        return;
      }

      if (message.type === 'subscribe') {
        const { id } = message;
        const publish = (event: unknown) => {
          socket.send(
            JSON.stringify({ type: 'next', id, payload: { data: { vaultActivity: event } } })
          );
        };
        activityPublishers.add(publish);
        unsubscribe = () => activityPublishers.delete(publish);
        return;
      }

      if (message.type === 'complete') {
        unsubscribe?.();
        unsubscribe = null;
      }
    });

    socket.on('close', () => {
      unsubscribe?.();
      unsubscribe = null;
    });
  });
}

beforeAll(async () => {
  httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const { query, variables } = JSON.parse(body || '{}');
      const result = await execute({
        schema: mockSchema,
        document: parse(query),
        rootValue,
        variableValues: variables,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const httpPort = (httpServer.address() as { port: number }).port;
  httpUrl = `http://127.0.0.1:${httpPort}/graphql`;

  wsServer = new WebSocketServer({ port: 0, handleProtocols: () => 'graphql-transport-ws' });
  attachGraphqlTransportWs(wsServer);
  const wsPort = (wsServer.address() as { port: number }).port;
  wsUrl = `ws://127.0.0.1:${wsPort}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => wsServer.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/* -------------------------------------------------------------------- */
/* Dashboard query (single request)                                      */
/* -------------------------------------------------------------------- */

describe('fetchDashboardData (single optimized request)', () => {
  it('should fetch all dashboard lists via one GraphQL query', async () => {
    const { client, dispose } = createIndexerClient({ httpUrl, wsUrl });
    try {
      const data = await fetchDashboardData(client, '0xabc');
      expect(data.vaults).toHaveLength(1);
      expect(data.vaults[0].gid).toBe('43113:1');
      expect(data.documents).toEqual([]);
    } finally {
      dispose();
    }
  });
});

/* -------------------------------------------------------------------- */
/* Real-time subscription                                                */
/* -------------------------------------------------------------------- */

describe('subscribeToVaultActivity (WebSocket push updates)', () => {
  it('should receive a live event pushed after the subscription is established', async () => {
    const { client, dispose } = createIndexerClient({ httpUrl, wsUrl });
    const received: IndexedActivityLog[] = [];

    const unsubscribe = subscribeToVaultActivity(client, '43113:1', (event) => {
      received.push(event);
    });

    // Wait until the subscription handler is registered before publishing.
    await vi.waitFor(
      () => {
        expect(activityPublishers.size).toBeGreaterThan(0);
      },
      { timeout: 5000 }
    );

    const event = {
      id: 'evt-1',
      vaultGid: '43113:1',
      action: 'EmergencyModeToggled',
      actor: '0xabc',
      occurredAt: new Date().toISOString(),
    };
    activityPublishers.forEach((publish) => publish(event));

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    }, { timeout: 5000 });
    expect(received[0]).toEqual(event);

    unsubscribe();
    dispose();
  });
});

/* -------------------------------------------------------------------- */
/* Optimistic cache reconciliation                                       */
/* -------------------------------------------------------------------- */

describe('reconcileOptimisticVaults', () => {
  const remote: IndexedVault = { ...MOCK_VAULT };
  const localOnly: IndexedVault = { ...MOCK_VAULT, gid: '43113:2', vaultId: 2 };

  it('should treat the indexer as authoritative for vaults it already knows about', () => {
    const result = reconcileOptimisticVaults([remote], [remote]);
    expect(result.confirmed).toEqual([remote]);
    expect(result.pending).toEqual([]);
  });

  it('should keep an optimistic-only vault visible as pending until the indexer catches up', () => {
    const result = reconcileOptimisticVaults([remote], [remote, localOnly]);
    expect(result.confirmed).toEqual([remote]);
    expect(result.pending).toEqual([localOnly]);
  });

  it('should return no pending vaults once the indexer has ingested everything', () => {
    const result = reconcileOptimisticVaults([remote, localOnly], [localOnly]);
    expect(result.pending).toEqual([]);
  });
});
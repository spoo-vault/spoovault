export interface SorobanEvent {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  pagingToken: string;
  topic: string[];
  value: any;
  inSuccessfulContractCall: boolean;
}

export type SorobanEventHandler = (event: SorobanEvent) => void;

class SorobanEventWatcher {
  private isRunning = false;
  private intervalId: number | null = null;
  private rpcUrl: string = "";
  private contractId: string = "";
  private lastCursor: string | undefined = undefined;
  private listeners: Record<string, SorobanEventHandler[]> = {};

  // Standard polling interval: 5 seconds (Stellar ledger time)
  private readonly POLLING_INTERVAL_MS = 5000;

  constructor() {}

  /**
   * Start watching for events from a specific contract
   */
  public start(rpcUrl: string, contractId: string) {
    if (this.isRunning) {
      if (this.rpcUrl === rpcUrl && this.contractId === contractId) {
        return; // Already running for this contract
      }
      this.stop(); // Stop previous if contract changed
    }

    this.rpcUrl = rpcUrl;
    this.contractId = contractId;
    this.isRunning = true;

    // Start polling loop
    this.poll();
  }

  /**
   * Stop watching for events
   */
  public stop() {
    this.isRunning = false;
    if (this.intervalId) {
      window.clearTimeout(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Subscribe to a specific event topic (e.g. "VaultCreated")
   */
  public on(topicName: string, handler: SorobanEventHandler) {
    if (!this.listeners[topicName]) {
      this.listeners[topicName] = [];
    }
    this.listeners[topicName].push(handler);
  }

  /**
   * Unsubscribe from a specific event topic
   */
  public off(topicName: string, handler: SorobanEventHandler) {
    if (!this.listeners[topicName]) return;
    this.listeners[topicName] = this.listeners[topicName].filter(
      (h) => h !== handler
    );
  }

  private async poll() {
    if (!this.isRunning) return;

    try {
      await this.fetchEvents();
    } catch (error) {
      console.error("SorobanEventWatcher polling error:", error);
    }

    // Schedule next poll if still running
    if (this.isRunning) {
      this.intervalId = window.setTimeout(
        () => this.poll(),
        this.POLLING_INTERVAL_MS
      );
    }
  }

  private async fetchEvents() {
    if (!this.rpcUrl || !this.contractId) return;

    // Build JSON-RPC payload
    // Fetch all contract events and filter them locally for simplicity.
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "getEvents",
      params: {
        startLedger: this.lastCursor ? undefined : await this.getLatestLedger(),
        filters: [
          {
            type: "contract",
            contractIds: [this.contractId],
          },
        ],
        pagination: this.lastCursor
          ? { cursor: this.lastCursor, limit: 100 }
          : { limit: 100 },
      },
    };

    if (payload.params.startLedger === 0) return;

    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`RPC error: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message);
    }

    const events: SorobanEvent[] = data.result?.events || [];

    for (const event of events) {
      // Update cursor
      this.lastCursor = event.pagingToken;

      this.dispatchEvent("SorobanEvent", event);

      // Dispatch generic refresh events for standard topics
      this.dispatchEvent("VaultCreated", event);
      this.dispatchEvent("DocumentAdded", event);
    }
  }

  private async getLatestLedger(): Promise<number> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getLatestLedger",
        }),
      });
      const data = await response.json();
      return data.result?.sequence || 0;
    } catch (e) {
      return 0;
    }
  }

  private dispatchEvent(topicName: string, event: SorobanEvent) {
    const handlers = this.listeners[topicName] || [];
    handlers.forEach((handler) => {
      try {
        handler(event);
      } catch (e) {
        console.error(`Error in event handler for ${topicName}:`, e);
      }
    });

    // Also dispatch to window for global listeners
    try {
      const customEvent = new CustomEvent(`spoovault:stellar:${topicName}`, {
        detail: event,
      });
      window.dispatchEvent(customEvent);
    } catch (e) {
      // Ignore
    }
  }
}

export const sorobanEventWatcher = new SorobanEventWatcher();

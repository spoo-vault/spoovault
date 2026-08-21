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
  private rpcUrl = "";
  private contractId = "";
  private lastCursor: string | undefined = undefined;
  private listeners: Record<string, SorobanEventHandler[]> = {};

  private readonly POLLING_INTERVAL_MS = 5000;

  public start(rpcUrl: string, contractId: string): void {
    if (this.isRunning) {
      if (this.rpcUrl === rpcUrl && this.contractId === contractId) {
        return;
      }
      this.stop();
    }

    this.rpcUrl = rpcUrl;
    this.contractId = contractId;
    this.isRunning = true;
    void this.poll();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalId !== null) {
      window.clearTimeout(this.intervalId);
      this.intervalId = null;
    }
  }

  public on(topicName: string, handler: SorobanEventHandler): void {
    if (!this.listeners[topicName]) {
      this.listeners[topicName] = [];
    }
    this.listeners[topicName].push(handler);
  }

  public off(topicName: string, handler: SorobanEventHandler): void {
    if (!this.listeners[topicName]) return;
    this.listeners[topicName] = this.listeners[topicName].filter((item) => item !== handler);
  }

  private async poll(): Promise<void> {
    if (!this.isRunning) return;

    try {
      await this.fetchEvents();
    } catch (error) {
      console.error("SorobanEventWatcher polling error:", error);
    }

    if (this.isRunning) {
      this.intervalId = window.setTimeout(() => void this.poll(), this.POLLING_INTERVAL_MS);
    }
  }

  private async fetchEvents(): Promise<void> {
    if (!this.rpcUrl || !this.contractId) return;

    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "getEvents",
      params: {
        startLedger: this.lastCursor ? undefined : await this.getLatestLedger(),
        filters: [{ type: "contract", contractIds: [this.contractId] }],
        pagination: this.lastCursor ? { cursor: this.lastCursor, limit: 100 } : { limit: 100 },
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
      this.lastCursor = event.pagingToken;
      this.dispatchEvent("SorobanEvent", event);
      this.dispatchEvent("VaultCreated", event);
      this.dispatchEvent("DocumentAdded", event);
    }
  }

  private async getLatestLedger(): Promise<number> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
      });
      const data = await response.json();
      return data.result?.sequence || 0;
    } catch {
      return 0;
    }
  }

  private dispatchEvent(topicName: string, event: SorobanEvent): void {
    const handlers = this.listeners[topicName] || [];
    handlers.forEach((handler) => {
      try {
        handler(event);
      } catch (error) {
        console.error(`Error in event handler for ${topicName}:`, error);
      }
    });

    try {
      const customEvent = new CustomEvent(`spoovault:stellar:${topicName}`, { detail: event });
      window.dispatchEvent(customEvent);
    } catch {
      // Ignore environments without a DOM.
    }
  }
}

export const sorobanEventWatcher = new SorobanEventWatcher();

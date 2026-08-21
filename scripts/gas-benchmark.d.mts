export interface GasEntry {
  name: string;
  avg: number;
  min: number;
  max: number;
  calls: number;
}

export interface ComparisonRow extends GasEntry {
  base: number | null;
  delta: number;
  pct: number;
  status: string;
}

export interface ComparisonResult {
  rows: ComparisonRow[];
  maxIncreasePct: number;
  regressionCount: number;
}

export interface BaselineInfo {
  gas: Record<string, number>;
  fingerprint: string | null;
  knownCompiler: boolean;
}

export interface Evaluation {
  comparison: ComparisonResult;
  currentFingerprint: string | null;
  baselineFingerprint: string | null;
  compilerChanged: boolean;
  gateReliable: boolean;
}

export declare function computeCompilerFingerprint(configText: string): string;
export declare function loadBaseline(rawText: string): BaselineInfo;
export declare function parseGasReport(raw: string): GasEntry[];
export declare function buildComparison(
  entries: GasEntry[],
  baseline: Record<string, number>
): ComparisonResult;
export declare function evaluate(entries: GasEntry[], baselineInfo: BaselineInfo): Evaluation;
export declare function renderMarkdown(evaluation: Evaluation, baselineExists: boolean): string;
export declare function main(): void;

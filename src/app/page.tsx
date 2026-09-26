import Studio from "./studio";
import { DBC_PROGRAM_ID, DBC_PROGRAM_SNAPSHOT, DEFAULT_RPC_URL } from "@/lib/protocol";

export const dynamic = "force-dynamic";

type RpcAccountResponse = {
  result?: {
    value?: {
      executable?: boolean;
      owner?: string;
      lamports?: number;
      rentEpoch?: number | string;
      data?: unknown;
    } | null;
  };
  error?: { message?: string };
};

async function getInitialProgramStatus() {
  const started = Date.now();
  const snapshotFallback = (warning: string) => ({
    ...DBC_PROGRAM_SNAPSHOT,
    ok: true,
    latencyMs: null,
    warning,
  });
  try {
    const response = await fetch(process.env.SOLANA_RPC_URL ?? DEFAULT_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [DBC_PROGRAM_ID, { encoding: "base64" }] }),
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
    const body = await response.json() as RpcAccountResponse;
    if (body.error) throw new Error(body.error.message ?? "RPC error");
    const account = body.result?.value ?? null;
    if (!account) return snapshotFallback("Live RPC returned no account; showing the stored mainnet snapshot.");
    const data = account.data;
    const encoded = Array.isArray(data) && typeof data[0] === "string" ? data[0] : null;
    const dataSize = encoded === null ? null : Math.max(0, Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0));
    return {
      ok: true,
      network: "mainnet-beta",
      address: DBC_PROGRAM_ID,
      executable: account.executable ?? null,
      owner: account.owner ?? null,
      lamports: account.lamports ?? null,
      rentEpoch: account.rentEpoch ?? null,
      dataSize,
      latencyMs: Date.now() - started,
      slotCheckedAt: new Date().toISOString(),
      source: "rpc" as const,
    };
  } catch (error) {
    return snapshotFallback(error instanceof Error ? `Live RPC unavailable: ${error.message}. Showing the stored mainnet snapshot.` : "Live RPC unavailable; showing the stored mainnet snapshot.");
  }
}

export default async function Page() {
  const initialRpc = await getInitialProgramStatus();
  return <Studio initialRpc={initialRpc} />;
}

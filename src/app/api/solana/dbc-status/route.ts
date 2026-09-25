import { NextResponse } from "next/server";
import { DBC_PROGRAM_ID, DBC_PROGRAM_SNAPSHOT, DEFAULT_RPC_URL, base58Address } from "@/lib/protocol";

type RpcResponse = { result?: { value?: { executable?: boolean; owner?: string; lamports?: number; rentEpoch?: number | string; data?: unknown } | null }; error?: { message?: string } };
let cached: { at: number; payload: Record<string, unknown> } | null = null;
export async function GET(request: Request) {
  const started = Date.now();
  const { searchParams } = new URL(request.url);
  const input = searchParams.get("address") ?? DBC_PROGRAM_ID;
  const address = base58Address.safeParse(input).success ? input : DBC_PROGRAM_ID;
  if (cached && Date.now() - cached.at < 30_000 && address === DBC_PROGRAM_ID) return NextResponse.json({ ...cached.payload, cached: true });
  const snapshot = (warning: string) => ({ ...DBC_PROGRAM_SNAPSHOT, ok: true, programId: DBC_PROGRAM_ID, latencyMs: null, cached: true, warning });
  const unavailable = (warning: string) => ({ ok: false, network: "mainnet-beta", programId: DBC_PROGRAM_ID, address, source: "rpc", executable: null, owner: null, lamports: null, rentEpoch: null, dataSize: null, latencyMs: Date.now() - started, slotCheckedAt: new Date().toISOString(), cached: false, warning });
  try {
    const response = await fetch(process.env.SOLANA_RPC_URL ?? DEFAULT_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64" }] }), signal: AbortSignal.timeout(5000), cache: "no-store" });
    const body = await response.json() as RpcResponse;
    if (body.error) throw new Error(body.error.message ?? "RPC error");
    const account = body.result?.value ?? null;
    if (!account) {
      const payload = address === DBC_PROGRAM_ID ? snapshot("Live RPC returned no account; showing the stored mainnet snapshot.") : unavailable("The RPC returned no account for this address.");
      if (address === DBC_PROGRAM_ID) cached = { at: Date.now(), payload };
      return NextResponse.json(payload);
    }
    const rawData = account?.data;
    const dataSize = Array.isArray(rawData) && typeof rawData[0] === "string" ? Math.floor(rawData[0].length * 3 / 4) : null;
    const payload = { ok: true, network: "mainnet-beta", programId: DBC_PROGRAM_ID, address, executable: account.executable ?? null, owner: account.owner ?? null, lamports: account.lamports ?? null, rentEpoch: account.rentEpoch ?? null, dataSize, latencyMs: Date.now() - started, slotCheckedAt: new Date().toISOString(), source: "rpc", cached: false };
    if (address === DBC_PROGRAM_ID) cached = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "RPC unavailable";
    const payload = address === DBC_PROGRAM_ID ? snapshot(`Live RPC unavailable: ${reason}. Showing the stored mainnet snapshot.`) : unavailable(reason);
    if (address === DBC_PROGRAM_ID) cached = { at: Date.now(), payload };
    return NextResponse.json(payload, { status: 200 });
  }
}

import fs from "fs";
import http from "http";
import net from "net";
import path from "path";
import url from "url";
import anchorPkg from "@coral-xyz/anchor";
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";

const anchor = anchorPkg as typeof import("@coral-xyz/anchor");
const { BN, web3 } = anchor;

type DemoState = {
  status: string;
  charger: string;
  session: string;
  totalUsageKwh: number;
  targetUsageKwh: number;
  updateCount: number;
  walletBalanceSol: number;
  depositSol: number;
  costSol: number;
  refundSol: number;
  merchant: string;
  connected: boolean;
  log?: string;
};

const SESSION_SEED = "session";
const ESCROW_SEED = "escrow";
const DEMO_PORT = Number(process.env.DEMO_PORT || 8080);
const UPDATE_INTERVAL_MS = Number(process.env.DEMO_INTERVAL_MS || 10);
const DEMO_DURATION_MS = Number(process.env.DEMO_DURATION_MS || 120_000);
const USAGE_INCREMENT = Number(process.env.DEMO_INCREMENT || 1);
const DECIMALS = 3;
const UNIT_KWH = 1;
const RATE_SOL_PER_KWH = 0.007;

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const UI_PATH = path.resolve(__dirname, "ui", "index.html");
const IDL_PATH = path.resolve(
  __dirname,
  "..",
  "target",
  "idl",
  "flowstream.json"
);

const state: DemoState = {
  status: "Ready",
  charger: "-",
  session: "-",
  totalUsageKwh: 0,
  targetUsageKwh: 0,
  updateCount: 0,
  walletBalanceSol: 0,
  depositSol: 0,
  costSol: 0,
  refundSol: 0,
  merchant: "-",
  connected: false,
};

const clients: http.ServerResponse[] = [];

let program: anchor.Program | null = null;
let provider: anchor.AnchorProvider | null = null;
let providerEphemeralRollup: anchor.AnchorProvider | null = null;
let wallet: anchor.Wallet | null = null;
let sessionPda: web3.PublicKey | null = null;
let escrowPda: web3.PublicKey | null = null;
let chargerId: web3.PublicKey | null = null;
let merchantKeypair: web3.Keypair | null = null;
let stopRequested = false;
let streamingPromise: Promise<void> | null = null;
let finalizing = false;

function broadcast(update: Partial<DemoState>) {
  Object.assign(state, update);
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  clients.forEach((res) => res.write(payload));
}

function log(message: string) {
  const line = `[${new Date().toISOString()}] ${message}`;
  broadcast({ log: line });
  console.log(line);
}

async function isPortAvailable(port: number) {
  return new Promise<boolean>((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.close(() => resolve(true));
      })
      .listen(port, "0.0.0.0");
  });
}

async function findAvailablePort(startPort: number, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    const port = startPort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port starting at ${startPort}`);
}

async function readJson(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

async function startServer() {
  const port = await findAvailablePort(DEMO_PORT);
  const server = http.createServer(async (req, res) => {
    const pathname = url.parse(req.url || "").pathname;
    if (pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.push(res);
      req.on("close", () => {
        const idx = clients.indexOf(res);
        if (idx >= 0) clients.splice(idx, 1);
      });
      return;
    }

    if (pathname === "/connect" && req.method === "POST") {
      const payload = await readJson(req);
      try {
        await connectSession(payload.depositSol);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
      return;
    }

    if (pathname === "/disconnect" && req.method === "POST") {
      try {
        await disconnectSession();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
      return;
    }

    if (pathname === "/") {
      const html = fs.readFileSync(UI_PATH, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, () => {
    console.log(`Demo UI running at http://localhost:${port}`);
  });
}

async function initClients() {
  const baseEndpoint =
    process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
  const walletPath =
    process.env.ANCHOR_WALLET ||
    path.resolve(process.env.HOME || "", ".config", "solana", "id.json");
  const keypair = web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  wallet = new anchor.Wallet(keypair);
  provider = new anchor.AnchorProvider(
    new web3.Connection(baseEndpoint, "confirmed"),
    wallet
  );
  anchor.setProvider(provider);

  const erEndpoint =
    process.env.EPHEMERAL_PROVIDER_ENDPOINT || "http://127.0.0.1:7799";
  const erWs = process.env.EPHEMERAL_WS_ENDPOINT || "ws://127.0.0.1:7800";

  providerEphemeralRollup = new anchor.AnchorProvider(
    new web3.Connection(erEndpoint, { wsEndpoint: erWs }),
    wallet
  );

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
  program = new anchor.Program(idl, provider);

  await updateBalances();
  broadcast({ status: "Ready to connect" });
}

async function updateBalances() {
  if (!provider || !wallet) {
    return;
  }
  const balance = await provider.connection.getBalance(wallet.publicKey);
  broadcast({ walletBalanceSol: balance / web3.LAMPORTS_PER_SOL });
}

async function connectSession(depositSol: number) {
  if (!program || !provider || !wallet || !providerEphemeralRollup) {
    throw new Error("Clients not initialized");
  }
  if (state.connected) {
    throw new Error("Session already active");
  }
  if (!depositSol || depositSol <= 0) {
    throw new Error("Deposit must be greater than 0");
  }

  merchantKeypair = web3.Keypair.generate();
  const airdropSig = await provider.connection.requestAirdrop(
    merchantKeypair.publicKey,
    web3.LAMPORTS_PER_SOL
  );
  await provider.connection.confirmTransaction(airdropSig, "confirmed");

  chargerId = web3.Keypair.generate().publicKey;
  sessionPda = web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from(SESSION_SEED),
      wallet.publicKey.toBuffer(),
      chargerId.toBuffer(),
    ],
    program.programId
  )[0];
  escrowPda = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_SEED), sessionPda.toBuffer()],
    program.programId
  )[0];

  const totalUpdates = Math.floor(DEMO_DURATION_MS / UPDATE_INTERVAL_MS);
  const targetUsage = (totalUpdates * USAGE_INCREMENT) / 10 ** DECIMALS;
  const depositLamports = Math.round(depositSol * web3.LAMPORTS_PER_SOL);
  const rateLamportsPerUnit = Math.round(
    (RATE_SOL_PER_KWH * web3.LAMPORTS_PER_SOL) / 10 ** DECIMALS
  );

  broadcast({
    status: "Initializing session",
    charger: chargerId.toBase58().slice(0, 8) + "…",
    session: sessionPda.toBase58().slice(0, 8) + "…",
    targetUsageKwh: targetUsage,
    depositSol,
    costSol: 0,
    refundSol: 0,
    merchant: merchantKeypair.publicKey.toBase58().slice(0, 8) + "…",
    connected: true,
  });

  await program.methods
    .initializeSession(
      chargerId,
      UNIT_KWH,
      DECIMALS,
      new BN(depositLamports),
      new BN(rateLamportsPerUnit),
      merchantKeypair.publicKey
    )
    .accounts({
      session: sessionPda,
      escrow: escrowPda,
      owner: wallet.publicKey,
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc({ skipPreflight: true, commitment: "confirmed" });

  await updateBalances();

  log("Session initialized on base layer");

  const remainingAccounts =
    providerEphemeralRollup.connection.rpcEndpoint.includes("localhost") ||
    providerEphemeralRollup.connection.rpcEndpoint.includes("127.0.0.1")
      ? [
          {
            pubkey: new web3.PublicKey(
              "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"
            ),
            isSigner: false,
            isWritable: false,
          },
        ]
      : [];

  await program.methods
    .delegate(wallet.publicKey, chargerId)
    .accounts({
      payer: wallet.publicKey,
      pda: sessionPda,
    })
    .remainingAccounts(remainingAccounts)
    .rpc({ skipPreflight: true, commitment: "confirmed" });

  log("Session delegated to ER");
  stopRequested = false;
  streamingPromise = streamUsage(rateLamportsPerUnit, depositSol);
}

async function streamUsage(rateLamportsPerUnit: number, depositSol: number) {
  if (!program || !providerEphemeralRollup || !wallet || !sessionPda) {
    throw new Error("Session not initialized");
  }
  let count = 0;
  const increment = new BN(USAGE_INCREMENT);
  const start = Date.now();

  while (!stopRequested && Date.now() - start < DEMO_DURATION_MS) {
    const tx = await program.methods
      .recordUsage(increment)
      .accounts({ session: sessionPda, owner: wallet.publicKey })
      .transaction();
    tx.add(
      new web3.TransactionInstruction({
        keys: [],
        programId: new web3.PublicKey(
          "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
        ),
        data: Buffer.from(`flowstream-demo-${Date.now()}-${count}`),
      })
    );

    tx.feePayer = providerEphemeralRollup.wallet.publicKey;
    tx.recentBlockhash = (
      await providerEphemeralRollup.connection.getLatestBlockhash()
    ).blockhash;
    const signed = await providerEphemeralRollup.wallet.signTransaction(tx);
    await providerEphemeralRollup.sendAndConfirm(signed, [], {
      skipPreflight: true,
      commitment: "confirmed",
    });

    count += 1;
    const totalUsageKwh = (count * USAGE_INCREMENT) / 10 ** DECIMALS;
    const accruedCostSol =
      (count * USAGE_INCREMENT * rateLamportsPerUnit) / web3.LAMPORTS_PER_SOL;
    broadcast({
      status: "Charging on ER",
      updateCount: count,
      totalUsageKwh,
      costSol: accruedCostSol,
      depositSol,
    });

    await new Promise((resolve) => setTimeout(resolve, UPDATE_INTERVAL_MS));
  }

  await finalizeSession();
}

async function finalizeSession() {
  if (finalizing || !program || !providerEphemeralRollup || !wallet) {
    return;
  }
  if (!sessionPda || !escrowPda || !merchantKeypair || !provider) {
    return;
  }
  finalizing = true;
  broadcast({ status: "Committing & settling" });
  log("Committing ER state to base layer");

  let undelegateTx = await program.methods
    .commitAndUndelegate()
    .accounts({
      payer: providerEphemeralRollup.wallet.publicKey,
      session: sessionPda,
    })
    .transaction();

  undelegateTx.feePayer = providerEphemeralRollup.wallet.publicKey;
  undelegateTx.recentBlockhash = (
    await providerEphemeralRollup.connection.getLatestBlockhash()
  ).blockhash;
  undelegateTx = await providerEphemeralRollup.wallet.signTransaction(
    undelegateTx
  );

  const commitSig = await providerEphemeralRollup.sendAndConfirm(
    undelegateTx,
    [],
    {
      skipPreflight: true,
      commitment: "confirmed",
    }
  );
  await GetCommitmentSignature(commitSig, providerEphemeralRollup.connection);

  const settleSig = await program.methods
    .settleSession()
    .accounts({
      session: sessionPda,
      escrow: escrowPda,
      owner: wallet.publicKey,
      merchant: merchantKeypair.publicKey,
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  log(`Settled session on base layer: ${settleSig}`);

  const finalSession = await program.account.usageSession.fetch(sessionPda);
  const finalUsageKwh = Number(finalSession.totalUsage) / 10 ** DECIMALS;
  const costSol =
    Number(finalSession.settledCostLamports) / web3.LAMPORTS_PER_SOL;
  const refundSol =
    Number(finalSession.refundedLamports) / web3.LAMPORTS_PER_SOL;
  broadcast({
    status: "Session closed",
    totalUsageKwh: finalUsageKwh,
    costSol,
    refundSol,
    connected: false,
  });
  log(`Final usage: ${finalUsageKwh.toFixed(3)} kWh`);
  log(
    `Charged: ${costSol.toFixed(3)} SOL, refund: ${refundSol.toFixed(3)} SOL`
  );

  await updateBalances();
  sessionPda = null;
  escrowPda = null;
  chargerId = null;
  merchantKeypair = null;
  stopRequested = false;
  streamingPromise = null;
  finalizing = false;
}

async function disconnectSession() {
  if (!state.connected) {
    return;
  }
  stopRequested = true;
  if (!streamingPromise) {
    await finalizeSession();
    return;
  }
  await streamingPromise;
}

startServer()
  .then(() => initClients())
  .catch((err) => {
    console.error(err);
    broadcast({ status: "Error", log: err.message || String(err) });
    process.exit(1);
  });

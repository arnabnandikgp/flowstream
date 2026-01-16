import fs from "fs";
import http from "http";
import net from "net";
import path from "path";
import url from "url";
import anchorPkg from "@coral-xyz/anchor";
const anchor = anchorPkg as typeof import("@coral-xyz/anchor");
const { BN, web3 } = anchor;
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";

type DemoState = {
  status: string;
  charger: string;
  session: string;
  totalUsageKwh: number;
  targetUsageKwh: number;
  updateCount: number;
  log?: string;
};

const SESSION_SEED = "session";
const DEMO_PORT = Number(process.env.DEMO_PORT || 8080);
const UPDATE_INTERVAL_MS = Number(process.env.DEMO_INTERVAL_MS || 10);
const DEMO_DURATION_MS = Number(process.env.DEMO_DURATION_MS || 120_000);
const USAGE_INCREMENT = Number(process.env.DEMO_INCREMENT || 1);
const DECIMALS = 3;
const UNIT_KWH = 1;

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
  status: "Starting",
  charger: "-",
  session: "-",
  totalUsageKwh: 0,
  targetUsageKwh: 0,
  updateCount: 0,
};

const clients: http.ServerResponse[] = [];

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
      .once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          resolve(false);
        } else {
          resolve(false);
        }
      })
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

async function startServer() {
  const port = await findAvailablePort(DEMO_PORT);
  const server = http.createServer((req, res) => {
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

async function runDemo() {
  const baseEndpoint =
    process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
  const walletPath =
    process.env.ANCHOR_WALLET ||
    path.resolve(process.env.HOME || "", ".config", "solana", "id.json");
  const keypair = web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(
    new web3.Connection(baseEndpoint, "confirmed"),
    wallet
  );
  anchor.setProvider(provider);

  const erEndpoint =
    process.env.EPHEMERAL_PROVIDER_ENDPOINT || "http://127.0.0.1:7799";
  const erWs = process.env.EPHEMERAL_WS_ENDPOINT || "ws://127.0.0.1:7800";

  const providerEphemeralRollup = new anchor.AnchorProvider(
    new web3.Connection(erEndpoint, { wsEndpoint: erWs }),
    wallet
  );

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
  const program = new anchor.Program(idl, provider);
  const programId = program.programId;
  const owner = provider.wallet.publicKey;
  const chargerId = web3.Keypair.generate().publicKey;
  const [sessionPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(SESSION_SEED), owner.toBuffer(), chargerId.toBuffer()],
    program.programId
  );

  const totalUpdates = Math.floor(DEMO_DURATION_MS / UPDATE_INTERVAL_MS);
  const targetUsage = (totalUpdates * USAGE_INCREMENT) / 10 ** DECIMALS;

  broadcast({
    status: "Initializing session",
    charger: chargerId.toBase58().slice(0, 8) + "…",
    session: sessionPda.toBase58().slice(0, 8) + "…",
    targetUsageKwh: targetUsage,
  });

  await program.methods
    .initializeSession(chargerId, UNIT_KWH, DECIMALS)
    .accounts({
      session: sessionPda,
      owner,
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc({ skipPreflight: true, commitment: "confirmed" });

  log("Session initialized on base layer");

  const remainingAccounts = erEndpoint.includes("127.0.0.1")
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
    .delegate(owner, chargerId)
    .accounts({
      payer: owner,
      pda: sessionPda,
    })
    .remainingAccounts(remainingAccounts)
    .rpc({ skipPreflight: true, commitment: "confirmed" });

  broadcast({ status: "Delegated to ER" });
  log("Session delegated to ER");

  let count = 0;
  const increment = new BN(USAGE_INCREMENT);

  const start = Date.now();
  while (Date.now() - start < DEMO_DURATION_MS) {
    const tx = await program.methods
      .recordUsage(increment)
      .accounts({ session: sessionPda, owner })
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
    broadcast({
      status: "Streaming on ER",
      updateCount: count,
      totalUsageKwh,
    });

    await new Promise((resolve) => setTimeout(resolve, UPDATE_INTERVAL_MS));
  }

  broadcast({ status: "Committing to base layer" });
  log("Committing ER state to base layer");

  let commitTx = await program.methods
    .commit()
    .accounts({
      payer: providerEphemeralRollup.wallet.publicKey,
      session: sessionPda,
    })
    .transaction();

  commitTx.feePayer = providerEphemeralRollup.wallet.publicKey;
  commitTx.recentBlockhash = (
    await providerEphemeralRollup.connection.getLatestBlockhash()
  ).blockhash;
  commitTx = await providerEphemeralRollup.wallet.signTransaction(commitTx);

  const commitSig = await providerEphemeralRollup.sendAndConfirm(commitTx, [], {
    skipPreflight: true,
    commitment: "confirmed",
  });
  await GetCommitmentSignature(commitSig, providerEphemeralRollup.connection);

  const finalSession = await program.account.usageSession.fetch(sessionPda);
  const finalUsageKwh = Number(finalSession.totalUsage) / 10 ** DECIMALS;
  broadcast({ status: "Committed", totalUsageKwh: finalUsageKwh });
  log(`Final usage committed: ${finalUsageKwh.toFixed(3)} kWh`);

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

  await providerEphemeralRollup.sendAndConfirm(undelegateTx, [], {
    skipPreflight: true,
    commitment: "confirmed",
  });

  broadcast({ status: "Session closed" });
  log("Session closed and undelegated");
}

startServer()
  .then(() => runDemo())
  .catch((err) => {
    console.error(err);
    broadcast({ status: "Error", log: err.message || String(err) });
    process.exit(1);
  });

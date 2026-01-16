import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { Flowstream } from "../target/types/flowstream";
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";
import fs from "fs";

const SESSION_SEED = "session";
const ESCROW_SEED = "escrow";

describe("flowstream", () => {
  const cluster = (process.env.FLOWSTREAM_CLUSTER || "localnet").toLowerCase();
  const isDevnet = cluster === "devnet";
  const devnetRpc =
    process.env.FLOWSTREAM_DEVNET_RPC ||
    "https://devnet.helius-rpc.com/?api-key=daa43648-936f-40e1-9303-2ea12ba55a2a";

  const provider = isDevnet
    ? new anchor.AnchorProvider(
        new web3.Connection(devnetRpc, {
          commitment: "confirmed",
        }),
        new anchor.Wallet(loadKeypairFromFile()),
        { commitment: "confirmed" }
      )
    : anchor.AnchorProvider.env();

  anchor.setProvider(provider);

  const isLocalnet =
    provider.connection.rpcEndpoint.includes("localhost") ||
    provider.connection.rpcEndpoint.includes("127.0.0.1");

  const defaultEphemeralHttp = isLocalnet
    ? "http://127.0.0.1:7799"
    : "https://devnet-as.magicblock.app/";
  const defaultEphemeralWs = isLocalnet
    ? "ws://127.0.0.1:7800"
    : "wss://devnet-as.magicblock.app/";

  const providerEphemeralRollup = new anchor.AnchorProvider(
    new web3.Connection(
      process.env.EPHEMERAL_PROVIDER_ENDPOINT || defaultEphemeralHttp,
      {
        wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || defaultEphemeralWs,
      }
    ),
    provider.wallet
  );

  console.log("Base Layer Connection: ", provider.connection.rpcEndpoint);
  console.log(
    "Ephemeral Rollup Connection: ",
    providerEphemeralRollup.connection.rpcEndpoint
  );
  console.log(`Current SOL Public Key: ${provider.wallet.publicKey}`);

  const program = anchor.workspace.Flowstream as Program<Flowstream>;
  const owner = provider.wallet.publicKey;
  const serviceId = web3.Keypair.generate().publicKey;
  const [sessionPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(SESSION_SEED), owner.toBuffer(), serviceId.toBuffer()],
    program.programId
  );

  const unit = 1;
  const decimals = 3;
  const usageAmount = new anchor.BN(1500);
  const depositLamports = new anchor.BN(5 * web3.LAMPORTS_PER_SOL);
  const rateLamportsPerUnit = new anchor.BN(7000);
  const merchant = web3.Keypair.generate().publicKey;
  const [escrowPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_SEED), sessionPda.toBuffer()],
    program.programId
  );

  it("Initialize session on Solana", async () => {
    const start = Date.now();
    const txHash = await program.methods
      .initializeSession(
        serviceId,
        unit,
        decimals,
        depositLamports,
        rateLamportsPerUnit,
        merchant
      )
      .accountsPartial({
        session: sessionPda,
        escrow: escrowPda,
        owner,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc({
        skipPreflight: true,
        commitment: "confirmed",
      });
    const duration = Date.now() - start;
    console.log(`${duration}ms (Base Layer) Initialize txHash: ${txHash}`);
  });

  it("Record usage on Solana", async () => {
    const start = Date.now();
    const txHash = await program.methods
      .recordUsage(usageAmount)
      .accountsPartial({
        session: sessionPda,
        owner,
      })
      .rpc({
        skipPreflight: true,
        commitment: "confirmed",
      });
    const duration = Date.now() - start;
    console.log(`${duration}ms (Base Layer) Record usage txHash: ${txHash}`);
  });

  const isEphemeralLocal =
    providerEphemeralRollup.connection.rpcEndpoint.includes("localhost") ||
    providerEphemeralRollup.connection.rpcEndpoint.includes("127.0.0.1");
  const describeEr = isLocalnet && !isEphemeralLocal ? describe.skip : describe;

  describeEr("ephemeral rollup flow", () => {
    it("Delegate session to ER", async () => {
      const start = Date.now();
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

      const txHash = await program.methods
        .delegate(owner, serviceId)
        .accountsPartial({
          payer: owner,
          pda: sessionPda,
        })
        .remainingAccounts(remainingAccounts)
        .rpc({
          skipPreflight: true,
          commitment: "confirmed",
        });
      const duration = Date.now() - start;
      console.log(`${duration}ms (Base Layer) Delegate txHash: ${txHash}`);
    });

    it("Record usage on ER", async () => {
      const start = Date.now();
      let tx = await program.methods
        .recordUsage(usageAmount)
        .accountsPartial({
          session: sessionPda,
          owner,
        })
        .transaction();

      tx.feePayer = providerEphemeralRollup.wallet.publicKey;
      tx.recentBlockhash = (
        await providerEphemeralRollup.connection.getLatestBlockhash()
      ).blockhash;
      tx = await providerEphemeralRollup.wallet.signTransaction(tx);

      const txHash = await providerEphemeralRollup.sendAndConfirm(tx, [], {
        skipPreflight: true,
        commitment: "confirmed",
      });
      const duration = Date.now() - start;
      console.log(`${duration}ms (ER) Record usage txHash: ${txHash}`);
    });

    it("Commit session state to Solana", async () => {
      const start = Date.now();
      let tx = await program.methods
        .commit()
        .accountsPartial({
          payer: providerEphemeralRollup.wallet.publicKey,
          session: sessionPda,
        })
        .transaction();

      tx.feePayer = providerEphemeralRollup.wallet.publicKey;
      tx.recentBlockhash = (
        await providerEphemeralRollup.connection.getLatestBlockhash()
      ).blockhash;
      tx = await providerEphemeralRollup.wallet.signTransaction(tx);

      const txHash =
        await providerEphemeralRollup.connection.sendRawTransaction(
          tx.serialize(),
          { skipPreflight: true }
        );
      await providerEphemeralRollup.connection.confirmTransaction(
        txHash,
        "confirmed"
      );
      const duration = Date.now() - start;
      console.log(`${duration}ms (ER) Commit txHash: ${txHash}`);

      const commitStart = Date.now();
      const commitSig = await GetCommitmentSignature(
        txHash,
        providerEphemeralRollup.connection
      );
      const commitDuration = Date.now() - commitStart;
      console.log(
        `${commitDuration}ms (Base Layer) Commit txHash: ${commitSig}`
      );

      const session = await program.account.usageSession.fetch(sessionPda);
      const expectedUsage = usageAmount.muln(2);
      if (!session.totalUsage.eq(expectedUsage)) {
        throw new Error(
          `Unexpected usage: ${session.totalUsage.toString()} expected ${expectedUsage.toString()}`
        );
      }
    });

    it("Commit and undelegate session", async () => {
      const start = Date.now();
      let tx = await program.methods
        .commitAndUndelegate()
        .accountsPartial({
          payer: providerEphemeralRollup.wallet.publicKey,
          session: sessionPda,
        })
        .transaction();

      tx.feePayer = providerEphemeralRollup.wallet.publicKey;
      tx.recentBlockhash = (
        await providerEphemeralRollup.connection.getLatestBlockhash()
      ).blockhash;
      tx = await providerEphemeralRollup.wallet.signTransaction(tx);

      const txHash =
        await providerEphemeralRollup.connection.sendRawTransaction(
          tx.serialize(),
          { skipPreflight: true }
        );
      await providerEphemeralRollup.connection.confirmTransaction(
        txHash,
        "confirmed"
      );
      const duration = Date.now() - start;
      console.log(`${duration}ms (ER) Commit and Undelegate txHash: ${txHash}`);

      const commitSig = await GetCommitmentSignature(
        txHash,
        providerEphemeralRollup.connection
      );
      const commitDuration = Date.now() - start;
      console.log(
        `${commitDuration}ms (Base Layer) Commit txHash: ${commitSig}`
      );

      const settleTx = await program.methods
        .settleSession()
        .accounts({
          session: sessionPda,
          escrow: escrowPda,
          owner,
          merchant,
          systemProgram: web3.SystemProgram.programId,
        })
        .rpc({
          commitment: "confirmed",
        });
      console.log(`(Base Layer) Settle txHash: ${settleTx}`);

      const session = await program.account.usageSession.fetch(sessionPda);
      const expectedUsage = usageAmount.muln(2);
      const expectedCost = expectedUsage.mul(rateLamportsPerUnit);
      const expectedRefund = depositLamports.sub(expectedCost);
      if (!session.settledCostLamports.eq(expectedCost)) {
        throw new Error(
          `Unexpected cost: ${session.settledCostLamports.toString()} expected ${expectedCost.toString()}`
        );
      }
      if (!session.refundedLamports.eq(expectedRefund)) {
        throw new Error(
          `Unexpected refund: ${session.refundedLamports.toString()} expected ${expectedRefund.toString()}`
        );
      }
      if (session.status !== 2) {
        throw new Error(`Unexpected status: ${session.status} expected 2`);
      }
    });
  });
});

function loadKeypairFromFile(): web3.Keypair {
  const keypairPath = process.env.FLOWSTREAM_KEYPAIR_PATH;
  if (!keypairPath) {
    throw new Error(
      "FLOWSTREAM_KEYPAIR_PATH must be set when FLOWSTREAM_CLUSTER=devnet"
    );
  }
  const raw = fs.readFileSync(keypairPath, "utf-8");
  const secretKey = Uint8Array.from(JSON.parse(raw));
  return web3.Keypair.fromSecretKey(secretKey);
}

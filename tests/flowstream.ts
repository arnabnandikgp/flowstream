import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { Flowstream } from "../target/types/flowstream";
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";
import fs from "fs";

const SESSION_SEED = "session";

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

  const providerEphemeralRollup = new anchor.AnchorProvider(
    new web3.Connection(
      process.env.EPHEMERAL_PROVIDER_ENDPOINT ||
        "https://devnet-as.magicblock.app/",
      {
        wsEndpoint:
          process.env.EPHEMERAL_WS_ENDPOINT ||
          "wss://devnet-as.magicblock.app/",
      }
    ),
    provider.wallet
  );

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

  it("Initialize session on Solana", async () => {
    const start = Date.now();
    const txHash = await program.methods
      .initializeSession(serviceId, unit, decimals)
      .accounts({
        session: sessionPda,
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
      .accounts({
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

  const describeEr = isLocalnet ? describe.skip : describe;

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
        .accounts({
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
        .accounts({
          session: sessionPda,
          owner,
        })
        .transaction();

      tx.feePayer = providerEphemeralRollup.wallet.publicKey;
      tx.recentBlockhash = (
        await providerEphemeralRollup.connection.getLatestBlockhash()
      ).blockhash;
      tx = await providerEphemeralRollup.wallet.signTransaction(tx);

      const txHash = await providerEphemeralRollup.sendAndConfirm(tx);
      const duration = Date.now() - start;
      console.log(`${duration}ms (ER) Record usage txHash: ${txHash}`);
    });

    it("Commit session state to Solana", async () => {
      const start = Date.now();
      let tx = await program.methods
        .commit()
        .accounts({
          payer: providerEphemeralRollup.wallet.publicKey,
          session: sessionPda,
        })
        .transaction();

      tx.feePayer = providerEphemeralRollup.wallet.publicKey;
      tx.recentBlockhash = (
        await providerEphemeralRollup.connection.getLatestBlockhash()
      ).blockhash;
      tx = await providerEphemeralRollup.wallet.signTransaction(tx);

      const txHash = await providerEphemeralRollup.sendAndConfirm(tx, [], {
        skipPreflight: true,
      });
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
      if (!session.totalUsage.eq(usageAmount)) {
        throw new Error(
          `Unexpected usage: ${session.totalUsage.toString()} expected ${usageAmount.toString()}`
        );
      }
    });

    it("Commit and undelegate session", async () => {
      const start = Date.now();
      let tx = await program.methods
        .commitAndUndelegate()
        .accounts({
          payer: providerEphemeralRollup.wallet.publicKey,
          session: sessionPda,
        })
        .transaction();

      tx.feePayer = providerEphemeralRollup.wallet.publicKey;
      tx.recentBlockhash = (
        await providerEphemeralRollup.connection.getLatestBlockhash()
      ).blockhash;
      tx = await providerEphemeralRollup.wallet.signTransaction(tx);

      const txHash = await providerEphemeralRollup.sendAndConfirm(tx, [], {
        skipPreflight: true,
      });
      const duration = Date.now() - start;
      console.log(`${duration}ms (ER) Commit and Undelegate txHash: ${txHash}`);
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

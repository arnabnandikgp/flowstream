# FlowStream

FlowStream is a Solana-native streaming utility for real-time usage metering (EV charging, internet, etc.) using MagicBlock Simple Ephemeral Rollups (ER). High-frequency usage updates stream to the ER with zero fees and are committed back to Solana at disconnect, where escrowed SOL is settled between user and merchant.

## Features
- Ephemeral Rollup delegation for high-frequency updates.
- Usage session PDA with cumulative metering.
- Escrowed SOL deposit with merchant payout + user refund on disconnect.
- Local ER test harness and demo UI for hackathon demos.

## Repo Layout
- `programs/flowstream`: Anchor program (session state, ER commit, escrow settlement).
- `tests/flowstream.ts`: Base-layer + ER tests.
- `scripts/test-local-er.sh`: Local validator + ER validator + tests.
- `demo/ev-demo.ts` + `demo/ui/index.html`: Demo server + UI.

## Prerequisites
- Node.js + npm
- Rust + Anchor CLI
- MagicBlock ER binaries (`mb-test-validator`, `ephemeral-validator`) on PATH

## Quick Start (Local ER Demo)
```bash
npm install
npm run demo:ev
```
Open `http://localhost:8080` to run the demo. Use **Connect** to start streaming usage and **Disconnect** to commit and settle escrow.

## Tests (Local ER)
```bash
npm run test:local-er
```

## Environment Variables
- `EPHEMERAL_PROVIDER_ENDPOINT`: ER RPC (defaults to `http://127.0.0.1:7799` in scripts).
- `EPHEMERAL_WS_ENDPOINT`: ER WS (defaults to `ws://127.0.0.1:7800` in scripts).
- `FLOWSTREAM_CLUSTER`: set to `devnet` to use devnet in tests.
- `FLOWSTREAM_KEYPAIR_PATH`: path to a keypair for devnet tests.
- `FLOWSTREAM_DEVNET_RPC`: custom devnet RPC URL.

## Usage Model
1. **Initialize** a session with deposit and rate.
2. **Delegate** the session PDA to the ER.
3. **Record** usage updates on the ER at high frequency.
4. **Commit + undelegate** on disconnect to sync back to base layer.
5. **Settle** escrow on base layer (merchant payout + user refund).

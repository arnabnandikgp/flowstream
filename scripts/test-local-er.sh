#!/bin/bash
set -e

if ! command -v ephemeral-validator &> /dev/null; then
  echo "Error: ephemeral-validator is not installed"
  echo "Install it with: npm install -g @magicblock-labs/ephemeral-validator@latest"
  exit 1
fi

check_port() {
  local port=$1
  if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
    return 0
  else
    return 1
  fi
}

cleanup() {
  if [ "$STARTED_MB_VALIDATOR" = "true" ]; then
    kill "$MB_VALIDATOR_PID" 2>/dev/null || true
    pkill -f "mb-test-validator" 2>/dev/null || true
  fi
  if [ "$STARTED_EPHEMERAL" = "true" ]; then
    kill "$EPHEMERAL_PID" 2>/dev/null || true
    pkill -f "ephemeral-validator" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

STARTED_MB_VALIDATOR="false"
STARTED_EPHEMERAL="false"

solana config set --url localhost

if check_port 8899; then
  echo "Solana validator already running on 8899"
else
  echo "Starting mb-test-validator..."
  mb-test-validator --reset > /tmp/mb-test-validator.log 2>&1 &
  MB_VALIDATOR_PID=$!
  STARTED_MB_VALIDATOR="true"

  for i in {1..60}; do
    if curl -s http://127.0.0.1:8899/health > /dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if check_port 7799; then
  echo "Ephemeral validator already running on 7799"
else
  echo "Starting ephemeral-validator..."
  RUST_LOG=info ephemeral-validator \
    --remotes http://127.0.0.1:8899 \
    --lifecycle ephemeral \
    --listen 127.0.0.1:7799 \
    > /tmp/ephemeral-validator.log 2>&1 &
  EPHEMERAL_PID=$!
  STARTED_EPHEMERAL="true"

  for i in {1..60}; do
    if curl -s http://127.0.0.1:7799/health > /dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! curl -s http://127.0.0.1:7799/health > /dev/null 2>&1; then
    echo "ephemeral-validator failed to start; log:" >&2
    cat /tmp/ephemeral-validator.log >&2 || true
    exit 1
  fi
fi

export EPHEMERAL_PROVIDER_ENDPOINT=http://127.0.0.1:7799
export EPHEMERAL_WS_ENDPOINT=ws://127.0.0.1:7800
export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899

anchor test \
  --provider.cluster localnet \
  --skip-local-validator


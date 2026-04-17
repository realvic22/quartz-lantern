# Public Kudos and Endorsements

Standalone Stacks dapp implementing plan 03 (Public Kudos and Endorsements).

## What is implemented

- Clarity contract `public-kudos` with:
  - Give category-based kudos
  - Revoke kudos
  - Cooldown guard for sender-to-recipient actions
  - Read-only functions for category counts, total counts, active state, and last action height
- Contract tests covering MVP invariants (7 tests)
- React + TypeScript frontend with:
  - Wallet connect/disconnect
  - Locked UI until wallet connection
  - Give/revoke actions by fixed category
  - Profile lookup for any principal
  - Backendless on-chain reads via Stacks API

## Project structure

- `contracts/public-kudos.clar`
- `tests/public-kudos.test.ts`
- `frontend/`

## Run contract tests

```bash
cd quartz-lantern
npm install
npm test
```

## Run frontend

```bash
cd quartz-lantern/frontend
npm install
cp .env.example .env
npm run dev
```

## Build frontend

```bash
cd quartz-lantern/frontend
npm run build
```

## Environment variables

Set these in `frontend/.env`:

- `VITE_STACKS_NETWORK` - `mainnet` or `testnet`
- `VITE_STACKS_API_BASE` - Stacks API base URL
- `VITE_CONTRACT_ADDRESS` - deployed contract address
- `VITE_CONTRACT_NAME` - deployed contract name

# Pons Sniper Bot for Robinhood Chain

Open-source **Pons sniper bot** and **Pons bundler** for [pons.family](https://www.ponsfamily.com) **v2** on **Robinhood Chain** (chain ID `4663`). Detect `TokenLaunched` events, filter launches, quote the bonding curve with official math, and buy with dry-run, slippage, and risk limits - or launch your own token with `launchAndBuy`.

This is Pons-specific. It is not a generic DEX sniper, not an ERC-4337 UserOp bundler, and not a volume or wash-trading tool.

- Site: [wooyang.github.io/pons-bundler](https://wooyang.github.io/pons-bundler/) ([bundler page](https://wooyang.github.io/pons-bundler/bundler.html))
- Protocol: [docs.ponsfamily.com/v2](https://docs.ponsfamily.com/v2)

Preview the site locally with `npm run site`.

## Pons sniper vs Pons bundler

| | Pons sniper bot | Pons bundler |
| --- | --- | --- |
| Job | Detect other v2 launches and optionally buy | Launch **your** token and buy from wallets you control |
| Entry | Factory `TokenLaunched` | `launchAndBuy` |
| Wallets | One configured sniper wallet | Master + up to 32 snipe-tax exemptions |
| Opening tax | Public wallets pay it unless exempted by the creator | Exemption list is set at creation |

Same CLI: `npm run pons -- sniper …` and `npm run pons -- launch …`.

## What the sniper does

It watches the live Pons v2 factory for `TokenLaunched` events, filters those launches with your rules, quotes a buy with the official curve math (fees + `currentSnipeTaxBps`), enforces risk limits, then either simulates or broadcasts `buy(quoteIn, minTokensOut, recipient)` on that launch's bonding curve.

```text
Pons Event (TokenLaunched)
    ↓
Detector
    ↓
Signal
    ↓
Risk
    ↓
Quote
    ↓
Execution
    ↓
Transaction Monitor
    ↓
Reconciliation
    ↓
Position
```

Dry-run is the default. Live execution has to be opted into twice: `SNIPER_DRY_RUN=false` and `sniper run --live`.

## Architecture

```text
                 PONS SNIPER BOT
                       │
                       ▼
               Opportunity Scanner
                       │
                       ▼
                 Signal Engine
                       │
                       ▼
                  Risk Engine
                       ▼
                 Quote Engine
                       │
                       ▼
              Execution Controller
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
        Pons Protocol        Transaction
                              Manager
             │                   │
             └─────────┬─────────┘
                       ▼
                 Robinhood Chain
                       │
                       ▼
                  Reconciliation
                       │
                       ▼
                  Position Store
```

Existing bundler commands (`status`, `wallets`, `launch`, `buy`, `sell`) are unchanged. The sniper reuses their ABI, curve quote, wallet, and transaction helpers.

| Layer | Source |
| --- | --- |
| CLI | `src/cli.ts`, `src/sniper/cli.ts` |
| Wallet | `src/wallets.ts`, `src/sniper/wallet.ts` |
| Pons protocol | `src/abi.ts`, `src/protocol.ts` |
| Curve / quote | `src/quote.ts`, `src/sniper/quote/PonsQuoteEngine.ts` |
| Transactions | `src/tx.ts`, `src/sniper/execution/` |
| RPC | `src/clients.ts`, `src/chain.ts` |
| Configuration | `src/env.ts`, `src/sniper/config.ts` |

## Installation

```bash
npm install
cp .env.example .env
```

Set `MASTER_PRIVATE_KEY` and/or `SNIPER_PRIVATE_KEY`, and a paid `RH_RPC_URL` if you can. The public RPC is rate-limited. Never commit `.env` or `wallets.json`.

```bash
npm run pons -- status
npm run pons -- sniper test
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `RH_RPC_URL` | Robinhood Chain HTTP RPC |
| `RH_WS_URL` | Optional websocket for event subscriptions |
| `PONS_FACTORY` / `PONS_LAUNCH_AND_BUY` | Optional overrides; defaults are the live v2 addresses |
| `MASTER_PRIVATE_KEY` | Bundler master key; also the default sniper wallet |
| `SNIPER_PRIVATE_KEY` | Optional sniper wallet override |
| `SNIPER_DRY_RUN` | Default `true`. Live requires `false` plus `--live` |
| `SNIPER_BUY_AMOUNT` | Native ETH (or pair token) spent per buy |
| `SNIPER_MAX_SLIPPAGE_BPS` | Output protection. `800` = 8.00% |
| `SNIPER_GAS_RESERVE` | Native ETH that must remain after a buy |
| `SNIPER_MAX_POSITIONS` / `SNIPER_MAX_EXPOSURE` | Portfolio caps |
| `SNIPER_MAX_SNIPE_TAX_BPS` | Skip (and retry) while `currentSnipeTaxBps` is above this. `0` waits out the opening tax |
| `SNIPER_DETECTION_MODE` | `event` or `polling` |
| `SNIPER_DATA_DIR` | Persistent opportunity, execution, and position state |

See `.env.example` for the full list. No real secrets belong in that file.

## Dry-run example

```bash
npm run pons -- sniper run --dry-run
```

Dry-run still detects, validates, quotes, risk-checks, and simulates `buy` via `eth_call`. It does **not** sign or broadcast.

```text
PONS SNIPER
────────────────────────────
Opportunity detected
Token: 0x...
Signal: BUY
Amount: 0.02 ETH
Expected output: ...
Minimum output: ...
Risk: APPROVED
Execution: DRY RUN
No transaction broadcast
```

## Live execution example

```bash
# in .env: SNIPER_DRY_RUN=false
npm run pons -- sniper run --live
```

Only the configured sniper wallet is used. There is no implicit multi-wallet spray.

## Bundler commands (unchanged)

```bash
npm run pons -- wallets generate --count 8 --out wallets.json
npm run pons -- launch --name "Example" --symbol EXMPL --master-buy 0.1 --file wallets.json --each-buy 0.02 --dry-run
```

## Sniper CLI

```bash
npm run pons -- sniper status
npm run pons -- sniper config
npm run pons -- sniper run --dry-run
npm run pons -- sniper test
npm run pons -- sniper reconcile
```

## Configuration and risk controls

Every filter is env-driven: creator allow/deny lists, symbol rules, native-quote-only, min/max real quote reserve, max creator tax, max snipe tax, max positions, one position per token, max exposure, max entries per hour, and cooldowns after skips or executions.

The opening snipe tax starts near 99% and decays within seconds. Exempt wallets are chosen by the **creator at launch**. A public sniper wallet is not exempt. The default `SNIPER_MAX_SNIPE_TAX_BPS=0` waits until `currentSnipeTaxBps(recipient)` is zero rather than buying into the tax.

## Transaction lifecycle

```text
DETECTED → VALIDATED → QUOTED → RISK_APPROVED → TX_PREPARED
    → SIGNED → SUBMITTED → PENDING → CONFIRMED | REVERTED | UNKNOWN
```

State is written under `SNIPER_DATA_DIR`. A restart does **not** automatically send another buy for an in-flight or confirmed opportunity. After an RPC timeout the bot records `UNKNOWN` and reconciles the original hash instead of blindly resubmitting.

## Failure recovery

| Class | Behaviour |
| --- | --- |
| `TRANSIENT_RPC` | Counted, not blindly retried on the send path |
| `TX_REVERT` | Terminal for that opportunity |
| `RISK_REJECTED` | Skip + cooldown |
| `INSUFFICIENT_FUNDS` | Skip |
| `STALE_QUOTE` | Used for opening snipe-tax waits (retry until the window ends) |
| `UNKNOWN` | Reconcile against chain; never auto-resubmit |

Reconciliation runs after execution, after restart, after receipt timeout, and on an interval. Chain balances and receipts are the source of truth. Position size is the wallet's token `balanceOf`, not the quoted output.

## Testing

```bash
npm test
npm run typecheck
```

The default suite never submits a transaction and does not need real funds.

## Security

- Private keys stay in `.env` / `wallets.json` (gitignored). They are never logged.
- Contract addresses default to the documented Pons v2 factory and router, overridable only by env.
- Live buys always set `minTokensOut` from official quote math plus slippage bps.
- Gas reserve is checked before send.
- Nonces are allocated through a per-wallet lock.

## FAQ

**What is a Pons sniper bot?**  
A TypeScript CLI that watches the pons.family v2 factory on Robinhood Chain, filters launches, quotes the bonding curve (including `currentSnipeTaxBps`), and can execute `buy(quoteIn, minTokensOut, recipient)` under your risk rules.

**Does it work on Robinhood Chain?**  
Yes. Chain ID `4663`, live Pons v2 factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`.

**Do public snipers skip the 99% opening tax?**  
No. Only the creator, fee recipient, and wallets listed as `snipeTaxExemptions` at launch skip it. Default config waits until `currentSnipeTaxBps` is `0`.

**Can I dry-run?**  
Yes. Dry-run is the default: `npm run pons -- sniper run --dry-run`. Live requires `SNIPER_DRY_RUN=false` and `--live`.

**Is this Pons v1?**  
No. V2 only (bonding curve → locked Uniswap v4).

## Limitations

- Curve trading only (factory `phase == 0`). Graduated Uniswap v4 routing is out of scope.
- Default path is a **single** sniper wallet. Multi-wallet bundling remains the existing `launch` / `buy` commands for wallets you control.
- Token logo/URI is not read; the verified ERC-20 ABI here only exposes `name` / `symbol` / `decimals`.
- Robinhood Chain is FCFS. This bot does not bid priority fees and cannot guarantee first fill.
- Public launches may be gated (`canLaunch`). That gate does not stop the sniper from seeing other people's `TokenLaunched` events.

## What it talks to

| Role | Address |
| --- | --- |
| Factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Launch and buy | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` |

Detection uses the factory event:

```text
TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)
```

Buys call the per-launch curve:

```text
buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
```

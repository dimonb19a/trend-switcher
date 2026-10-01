// Base chain access: balances, Uniswap quotes, gas budgeting and the swap
// itself. The signer exists only when the runner is ARMED (MODE=live and
// --live together, TR-01) and only inside this module; the private key is read
// from process.env here and nowhere else, never logged. In paper mode the key
// is never touched: the public account address is used for reads.
//
// Swaps go through SwapRouter02.multicall(deadline, [exactInputSingle]) so the
// router itself refuses a stale transaction ("Transaction too old", verified
// with estimateGas on Base 2026-09-22) — TR-04. Approvals are exact, not
// unlimited (TR-05). Sending returns the hash immediately so the caller can
// record a durable intent before waiting for the receipt (TR-03).
import { Contract, Interface, JsonRpcProvider, Transaction, Wallet, formatEther, formatUnits, parseUnits } from 'ethers';
import { withRetry } from './retry.mjs';
import { RecordableError, describeError } from './errors.mjs';
import { cfg } from './config.mjs';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
];
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];
const SWAP_IFACE = new Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)',
]);
const MULTICALL_IFACE = new Interface(['function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)']);
const ERC20_IFACE = new Interface(ERC20_ABI);
const ORACLE_ABI = [
  'function getL1Fee(bytes data) view returns (uint256)',
  'function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)', // Fjord: an upper bound including the signature bytes
];
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)

export const EXPECTED_SLIPPAGE_BPS = cfg.expectedSlippageBps;
export const raw = { parseUnits, formatUnits, formatEther };

export const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });

let armedState = false;
let signer = null;

/** Called once by the runner with the resolved arming decision. Without it no signer can exist. */
export function arm({ armed }) {
  armedState = armed === true;
  if (!armedState) signer = null;
}

export function isArmed() { return armedState; }

export function getSigner() {
  if (!armedState) throw new RecordableError('signer requested while not armed (MODE=live and --live are both required)');
  if (!signer) {
    if (!cfg.hasPrivateKey) throw new RecordableError('wallet private key missing or malformed in .env');
    signer = new Wallet(process.env.PRIVATE_KEY, provider);
    if (signer.address.toLowerCase() !== cfg.accountAddress.toLowerCase()) {
      signer = null;
      throw new RecordableError('the private key does not belong to the configured ACCOUNT_ADDRESS; refusing');
    }
  }
  return signer;
}

/** The account used for reads: the public address in paper, the signer's address when armed. Never derives from the key in paper. */
export function address() {
  return armedState ? getSigner().address : cfg.accountAddress;
}

export async function balances(owner = address()) {
  // No wallet configured (a paper run on a virtual capital): nothing to read, and nothing is invented.
  if (!owner) return { ethRaw: 0n, wethRaw: 0n, usdcRaw: 0n, eth: 0, weth: 0, usdc: 0 };
  const [eth, weth, usdc] = await Promise.all([
    provider.getBalance(owner),
    new Contract(cfg.weth, ERC20_ABI, provider).balanceOf(owner),
    new Contract(cfg.usdc, ERC20_ABI, provider).balanceOf(owner),
  ]);
  return { ethRaw: eth, wethRaw: weth, usdcRaw: usdc, eth: Number(formatEther(eth)), weth: Number(formatEther(weth)), usdc: Number(formatUnits(usdc, 6)) };
}

/** A quote (or the block read before it) that could not be obtained: the failure happened before any effect. */
export class QuoteUnavailableError extends RecordableError {
  constructor(message, { cause = null, stage, attempts, elapsedMs, transient, stopped }) {
    super(message, cause ? { cause } : undefined);
    this.name = 'QuoteUnavailableError';
    this.code = 'QUOTE_UNAVAILABLE';
    this.shortMessage = message;
    this.preEffect = true;   // nothing was booked, signed or sent
    this.stage = stage;       // 'block number' | 'quote'
    this.attempts = attempts;
    this.elapsedMs = elapsedMs;
    this.transient = transient; // the failure class was transient (a retry made sense), not a deterministic revert
    this.stopped = stopped;   // an operator stop ended the retry
  }
}

const TRANSIENT_CODES = new Set(['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR', 'UNKNOWN_ERROR', 'BAD_DATA']);

/**
 * Which RPC errors are worth another attempt. Transport, timeout, server (a rate limit answers as
 * one) and malformed-response errors are transient. A revert WITH revert data is deterministic and
 * is never retried. A revert WITHOUT data cannot be told from a transport fault: ethers reports an
 * `eth_call` that fails with no data as "missing revert data" whether the contract reverted or the
 * endpoint refused the call, so it is retried within the deadline and named as ambiguous.
 */
export function isTransientRpcError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.code === 'ABORTED') return false;
  if (TRANSIENT_CODES.has(error.code)) return true;
  if (error.code === 'CALL_EXCEPTION') return error.data === null || error.data === undefined;
  return false;
}

let stopCheck = () => false;
/** The runner installs its stop flag here so a retry wait ends when the operator stops the agent. */
export function setStopCheck(fn) { stopCheck = typeof fn === 'function' ? fn : () => false; }

const defaultLog = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

/**
 * Exact-input quote through QuoterV2 (static call), with its provenance. The block number is read
 * BEFORE the quote and recorded as the block observed just before the request (the call itself is
 * made at `latest`; it is not pinned, so a lagging node cannot refuse it — and on a load-balanced
 * endpoint a later request may be answered by another backend, so the number is an observation,
 * not a proven lower bound of the block the quote reflects). `at` is the instant
 * the successful quote request was ISSUED: a quote is never younger than its request, and no later
 * await can make it look fresh. Both reads are retried under one wall-clock deadline that covers the
 * waits, with a timeout per attempt, only for transient errors, and the waits end on an operator
 * stop. Any failure is thrown as a typed QuoteUnavailableError (pre-effect by construction) with the
 * sanitized reason; the engine decides what a pre-effect failure means in its mode.
 */
export async function quote(tokenIn, tokenOut, amountInRaw, { attempts = 4, deadlineMs = cfg.quoteDeadlineMs, timeoutMs = cfg.rpcTimeoutMs, log = defaultLog, now = Date.now } = {}) {
  const quoter = new Contract(cfg.quoter, QUOTER_ABI, provider);
  const startedAt = now();
  const retryOptions = (stage) => ({
    attempts, timeoutMs, now, shouldRetry: isTransientRpcError, shouldStop: stopCheck,
    deadlineMs: Math.max(0, deadlineMs - (now() - startedAt)),
    onRetry: (error, attempt, wait) => log(`${stage} retry ${attempt}/${attempts - 1} in ${wait} ms: ${describeError(error)}`),
  });
  let stage = 'block number';
  try {
    // two sequential requests, not one batched pair: fewer simultaneous calls against a public endpoint
    const block = await withRetry(() => provider.getBlockNumber(), retryOptions(stage));
    stage = 'quote';
    let issuedAt = now();
    const result = await withRetry(() => { issuedAt = now(); return quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn: amountInRaw, fee: cfg.poolFee, sqrtPriceLimitX96: 0n }); }, retryOptions(stage));
    return { amountOut: result.amountOut, gasEstimate: result.gasEstimate, at: issuedAt, block, blockMeaning: 'observed just before the quote request; not a proven bound on a load-balanced endpoint', source: 'uniswap-quoterv2', elapsedMs: now() - startedAt };
  } catch (error) {
    const info = error?.retryInfo ?? {};
    const stopped = error?.code === 'ABORTED';
    throw new QuoteUnavailableError(`${stage} unavailable after ${info.attempts ?? 1} attempt${(info.attempts ?? 1) === 1 ? '' : 's'} (${info.stoppedBecause ?? 'error'}): ${describeError(error)}`,
      { cause: error, stage, attempts: info.attempts ?? 1, elapsedMs: now() - startedAt, transient: !stopped && (isTransientRpcError(error) || error?.code === 'TIMEOUT'), stopped });
  }
}

/**
 * Expected switching cost against the tape mid: pool fee + impact + expected slippage. Both
 * directions are quoted for the whole pilot capital, so a shadow arm on the other side of the
 * main position has its own price (R1-G); the impact shown to the judge is the main's direction.
 */
export async function costPicture({ ethSide, usdc, midPrice }) {
  const out = {
    at: Date.now(), impactBps: 0,
    expectedSlippagePct: cfg.expectedSlippageBps / 100, tolerancePct: cfg.slippageBps / 100,
    costPct: 0.05 + cfg.expectedSlippageBps / 100, sellQuotePrice: null, buyQuotePrice: null, block: null,
  };
  try {
    const capitalEth = ethSide + (midPrice > 0 ? usdc / midPrice : 0);
    const capitalUsdc = ethSide * midPrice + usdc;
    // the cost picture is informational and refreshed every tick: a short retry budget PER QUOTE (the two directions
    // are quoted one after the other, each under its own deadline); the next tick tries again
    const brief = { attempts: 2, deadlineMs: Math.min(cfg.quoteDeadlineMs, 8_000) };
    if (capitalEth > 0.0005) {
      const q = await quote(cfg.weth, cfg.usdc, parseUnits(capitalEth.toFixed(18), 18), brief);
      out.sellQuotePrice = Number(formatUnits(q.amountOut, 6)) / capitalEth;
      out.block = q.block;
    }
    if (capitalUsdc > 1) {
      const q = await quote(cfg.usdc, cfg.weth, parseUnits(capitalUsdc.toFixed(6), 6), brief);
      out.buyQuotePrice = capitalUsdc / Number(formatEther(q.amountOut));
      out.block = q.block;
    }
    const ref = ethSide * midPrice >= usdc ? (out.sellQuotePrice ?? out.buyQuotePrice) : (out.buyQuotePrice ?? out.sellQuotePrice);
    if (ref && midPrice) out.impactBps = Math.max(0, Math.abs((ref / midPrice) - 1) * 10_000 - 5); // the quote already includes the 0.05% fee
    out.costPct = 0.05 + out.impactBps / 100 + out.expectedSlippagePct;
  } catch (error) {
    out.error = describeError(error);
    out.costPct = null;
  }
  return out;
}

export function minOut(amountOutRaw) { return (amountOutRaw * BigInt(10_000 - cfg.slippageBps)) / 10_000n; }

/** The fee caps that will be serialized into the transaction; the execution bound is gasLimit × maxFeePerGas. */
export async function feeCaps() {
  const fee = await provider.getFeeData();
  const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice ?? BigInt(await provider.send('eth_gasPrice', []));
  const maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? maxFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/** Nonces: the next nonce to use and whether anything of ours is still in the mempool. */
export async function nonceState(owner = address()) {
  const [latest, pending] = await Promise.all([
    provider.getTransactionCount(owner, 'latest'),
    provider.getTransactionCount(owner, 'pending'),
  ]);
  return { latest, pending, inFlight: pending - latest };
}

export async function allowance(token, owner, spender = cfg.router) {
  return new Contract(token, ERC20_ABI, provider).allowance(owner, spender);
}

/** Calldata for one swap leg wrapped in a deadline-bearing multicall. */
export function buildSwapTx({ tokenIn, tokenOut, amountInRaw, minOutRaw, recipient, deadline, useValue }) {
  const inner = SWAP_IFACE.encodeFunctionData('exactInputSingle', [{ tokenIn, tokenOut, fee: cfg.poolFee, recipient, amountIn: amountInRaw, amountOutMinimum: minOutRaw, sqrtPriceLimitX96: 0n }]);
  const data = MULTICALL_IFACE.encodeFunctionData('multicall', [deadline, [inner]]);
  return { to: cfg.router, data, value: useValue ? amountInRaw : 0n };
}

export function buildApproveTx({ token, amountRaw, spender = cfg.router }) {
  return { to: token, data: ERC20_IFACE.encodeFunctionData('approve', [spender, amountRaw]), value: 0n };
}

/**
 * L1 data fee for the bytes that will actually be sent: the oracle's upper bound for the
 * unsigned size (which accounts for the signature) when the node offers it, otherwise the
 * plain fee of the unsigned bytes. Null means unknown, never zero.
 */
async function l1FeeWei(tx, { gasLimit, maxFeePerGas, maxPriorityFeePerGas, nonce = 0 }) {
  try {
    const unsigned = Transaction.from({ to: tx.to, data: tx.data, value: tx.value, chainId: cfg.chainId, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, type: 2 }).unsignedSerialized;
    const oracle = new Contract(cfg.gasOracle, ORACLE_ABI, provider);
    const size = BigInt((unsigned.length - 2) / 2);
    try { return { wei: await oracle.getL1FeeUpperBound(size), upperBound: true }; } catch { /* pre-Fjord oracle */ }
    return { wei: await oracle.getL1Fee(unsigned), upperBound: false };
  } catch {
    return null;
  }
}

/**
 * The bound of one transaction before it is sent (R1-D). The serialized gas limit is the
 * estimate plus the configured margin; the execution bound is that limit times maxFeePerGas,
 * which the chain cannot exceed. The L1 data fee is set at inclusion: the oracle's upper bound
 * when available, plus the configured margin — a stated assumption, not a chain guarantee.
 * Throws when the L1 fee is unknown: an unpriceable transaction is not sent.
 */
export async function estimateTx(tx, from, priceUsd) {
  const gasEstimate = await provider.estimateGas({ from, to: tx.to, data: tx.data, value: tx.value });
  const gasLimit = gasEstimate + (gasEstimate * BigInt(cfg.gasLimitMarginPct)) / 100n;
  const { maxFeePerGas, maxPriorityFeePerGas } = await feeCaps();
  const l1 = await l1FeeWei(tx, { gasLimit, maxFeePerGas, maxPriorityFeePerGas });
  if (l1 === null) throw new RecordableError('L1 data fee unknown; refusing to price the transaction');
  const l2BoundWei = gasLimit * maxFeePerGas;
  const l1BoundWei = l1.wei + (l1.wei * BigInt(cfg.l1FeeMarginPct)) / 100n;
  const boundWei = l2BoundWei + l1BoundWei;
  return { gasEstimate, gasLimit, maxFeePerGas, maxPriorityFeePerGas, l1Wei: l1.wei, l1UpperBound: l1.upperBound, l2BoundWei, l1BoundWei, boundWei, boundUsd: Number(formatEther(boundWei)) * priceUsd };
}

/** Sign and broadcast exactly the estimated shape: explicit nonce, the bounded gas limit and the fee caps of the estimate. */
export async function send(tx, { nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas }) {
  const wallet = getSigner();
  const response = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, type: 2 });
  return { hash: response.hash, nonce: response.nonce };
}

/** Wait for one confirmation; null on timeout (the transaction may still be mined later). */
export async function waitReceipt(hash, timeoutMs = cfg.receiptTimeoutMs) {
  try { return await provider.waitForTransaction(hash, 1, timeoutMs); } catch (error) {
    if (/timeout/iu.test(error.message)) return null;
    throw error;
  }
}

/**
 * Receipt facts from the raw JSON-RPC receipt: status, block, L2 gas actually paid, the Base L1
 * fee when the node reports it, and — when `owner` and `tokenOut` are given — the amount of
 * `tokenOut` transferred to `owner` in this transaction, read from the ERC-20 Transfer logs,
 * so a restart can reconcile the output of a swap it never saw confirm (R1-C).
 */
export async function receiptFacts(hash, { owner = null, tokenOut = null } = {}) {
  const r = await provider.send('eth_getTransactionReceipt', [hash]);
  if (!r) return null;
  const gasUsed = BigInt(r.gasUsed); const effective = BigInt(r.effectiveGasPrice ?? '0x0');
  const l1Fee = r.l1Fee ? BigInt(r.l1Fee) : null;
  let amountOutRaw = null;
  if (owner && tokenOut && Array.isArray(r.logs)) {
    const to = `0x${'0'.repeat(24)}${owner.slice(2).toLowerCase()}`;
    for (const entry of r.logs) {
      if (String(entry.address).toLowerCase() !== tokenOut.toLowerCase()) continue;
      if (!Array.isArray(entry.topics) || entry.topics[0] !== TRANSFER_TOPIC || String(entry.topics[2]).toLowerCase() !== to) continue;
      amountOutRaw = (amountOutRaw ?? 0n) + BigInt(entry.data);
    }
  }
  return { status: parseInt(r.status, 16), block: parseInt(r.blockNumber, 16), gasUsed, effectiveGasPrice: effective, l2Wei: gasUsed * effective, l1Wei: l1Fee, totalWei: gasUsed * effective + (l1Fee ?? 0n), l1Known: l1Fee !== null, amountOutRaw };
}

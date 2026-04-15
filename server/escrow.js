// server/escrow.js — Solana escrow for wager system (CommonJS)
const {
    Connection, Keypair, PublicKey, SystemProgram,
    Transaction, sendAndConfirmTransaction
} = require('@solana/web3.js');
const {
    getAssociatedTokenAddress, createTransferInstruction,
    createAssociatedTokenAccountInstruction,
    getAccount
} = require('@solana/spl-token');
const bs58 = require('bs58');

// === CONFIG ===
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const ESCROW_PRIVATE_KEY = process.env.ESCROW_PRIVATE_KEY || null;
const TREASURY_WALLET = process.env.TREASURY_WALLET || null;

// USDC mints per network
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const isMainnet = SOLANA_RPC_URL.includes('mainnet');
const USDC_MINT = new PublicKey(isMainnet ? USDC_MINT_MAINNET : USDC_MINT_DEVNET);

// === INIT ===
let connection = null;
let escrowKeypair = null;
let treasuryPubkey = null;

try {
    connection = new Connection(SOLANA_RPC_URL, 'confirmed');

    if (ESCROW_PRIVATE_KEY) {
        const secretKey = bs58.decode(ESCROW_PRIVATE_KEY);
        escrowKeypair = Keypair.fromSecretKey(secretKey);
        console.log('[escrow] Escrow wallet:', escrowKeypair.publicKey.toBase58());
    } else {
        console.warn('[escrow] WARNING: ESCROW_PRIVATE_KEY not set — escrow functions disabled');
    }

    if (TREASURY_WALLET) {
        treasuryPubkey = new PublicKey(TREASURY_WALLET);
        console.log('[escrow] Treasury wallet:', treasuryPubkey.toBase58());
    } else {
        console.warn('[escrow] WARNING: TREASURY_WALLET not set — rake disabled');
    }
} catch (err) {
    console.error('[escrow] Init error:', err.message);
}

// === HELPERS ===

function isReady() {
    return connection && escrowKeypair;
}

/**
 * Build an unsigned deposit transaction for a user to sign client-side.
 * @param {string} userWalletPubkey - User's wallet public key (base58)
 * @param {number} amount - Amount in base units (lamports for SOL, smallest unit for USDC)
 * @param {'SOL'|'USDC'} token - Token type
 * @returns {Promise<string|null>} Base64-encoded serialized transaction, or null on error
 */
async function createDepositTransaction(userWalletPubkey, amount, token) {
    if (!isReady()) return null;
    try {
        const userPubkey = new PublicKey(userWalletPubkey);
        const tx = new Transaction();
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = userPubkey;

        if (token === 'SOL') {
            tx.add(SystemProgram.transfer({
                fromPubkey: userPubkey,
                toPubkey: escrowKeypair.publicKey,
                lamports: amount
            }));
        } else if (token === 'USDC') {
            const userAta = await getAssociatedTokenAddress(USDC_MINT, userPubkey);
            const escrowAta = await getAssociatedTokenAddress(USDC_MINT, escrowKeypair.publicKey);

            // Check if escrow ATA exists, if not add create instruction
            try {
                await getAccount(connection, escrowAta);
            } catch (e) {
                // ATA doesn't exist — add create instruction (user pays)
                tx.add(createAssociatedTokenAccountInstruction(
                    userPubkey,           // payer
                    escrowAta,            // ata
                    escrowKeypair.publicKey, // owner
                    USDC_MINT             // mint
                ));
            }

            tx.add(createTransferInstruction(
                userAta,                  // source
                escrowAta,                // destination
                userPubkey,               // authority (user signs)
                amount                    // amount in base units
            ));
        } else {
            console.error('[escrow] Unknown token:', token);
            return null;
        }

        // Serialize the message (what the user signs) and the full tx (for reconstruction)
        const message = tx.serializeMessage();
        const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        return {
            transaction: serialized.toString('base64'),
            message: message.toString('base64'),
        };
    } catch (err) {
        console.error('[escrow] createDepositTransaction error:', err.message);
        return null;
    }
}

/**
 * Confirm a deposit transaction on chain and verify it matches expected parameters.
 * @param {string} txSignature - Transaction signature
 * @param {number} expectedAmount - Expected amount in base units
 * @param {'SOL'|'USDC'} expectedToken - Expected token
 * @param {string} expectedFrom - Expected sender wallet (base58)
 * @returns {Promise<{confirmed: boolean, fromWallet?: string, error?: string}>}
 */
async function confirmDeposit(txSignature, expectedAmount, expectedToken, expectedFrom) {
    if (!isReady()) return { confirmed: false, error: 'Escrow not initialized' };
    try {
        // Wait for confirmation
        const result = await connection.getTransaction(txSignature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
        });

        if (!result) {
            return { confirmed: false, error: 'Transaction not found' };
        }
        if (result.meta && result.meta.err) {
            return { confirmed: false, error: 'Transaction failed: ' + JSON.stringify(result.meta.err) };
        }

        const escrowAddr = escrowKeypair.publicKey.toBase58();

        if (expectedToken === 'SOL') {
            // Verify SOL transfer: check post-balances change on escrow account
            const accountKeys = result.transaction.message.staticAccountKeys
                ? result.transaction.message.staticAccountKeys.map(k => k.toBase58())
                : result.transaction.message.accountKeys.map(k => k.toBase58());

            const escrowIdx = accountKeys.indexOf(escrowAddr);
            const fromIdx = accountKeys.indexOf(expectedFrom);

            if (escrowIdx === -1) {
                return { confirmed: false, error: 'Escrow wallet not in transaction' };
            }
            if (fromIdx === -1) {
                return { confirmed: false, error: 'Sender wallet not in transaction' };
            }

            const preBalance = result.meta.preBalances[escrowIdx];
            const postBalance = result.meta.postBalances[escrowIdx];
            const received = postBalance - preBalance;

            if (received < expectedAmount) {
                return { confirmed: false, error: 'Amount mismatch: expected ' + expectedAmount + ', received ' + received };
            }

            return { confirmed: true, fromWallet: expectedFrom };
        } else if (expectedToken === 'USDC') {
            // Verify USDC transfer via token balance changes
            const preTokenBalances = result.meta.preTokenBalances || [];
            const postTokenBalances = result.meta.postTokenBalances || [];

            // Find escrow's USDC balance change
            const escrowPost = postTokenBalances.find(b =>
                b.owner === escrowAddr && b.mint === USDC_MINT.toBase58()
            );
            const escrowPre = preTokenBalances.find(b =>
                b.owner === escrowAddr && b.mint === USDC_MINT.toBase58()
            );

            const preBal = escrowPre ? parseInt(escrowPre.uiTokenAmount.amount) : 0;
            const postBal = escrowPost ? parseInt(escrowPost.uiTokenAmount.amount) : 0;
            const received = postBal - preBal;

            if (received < expectedAmount) {
                return { confirmed: false, error: 'USDC amount mismatch: expected ' + expectedAmount + ', received ' + received };
            }

            return { confirmed: true, fromWallet: expectedFrom };
        }

        return { confirmed: false, error: 'Unknown token: ' + expectedToken };
    } catch (err) {
        console.error('[escrow] confirmDeposit error:', err.message);
        return { confirmed: false, error: err.message };
    }
}

/**
 * Send payout from escrow to a wallet.
 * @param {string} toWalletPubkey - Recipient wallet (base58)
 * @param {number} amount - Amount in base units
 * @param {'SOL'|'USDC'} token - Token type
 * @returns {Promise<{signature?: string, error?: string}>}
 */
async function sendPayout(toWalletPubkey, amount, token) {
    if (!isReady()) return { error: 'Escrow not initialized' };
    try {
        const toPubkey = new PublicKey(toWalletPubkey);
        const tx = new Transaction();

        if (token === 'SOL') {
            tx.add(SystemProgram.transfer({
                fromPubkey: escrowKeypair.publicKey,
                toPubkey: toPubkey,
                lamports: amount
            }));
        } else if (token === 'USDC') {
            const escrowAta = await getAssociatedTokenAddress(USDC_MINT, escrowKeypair.publicKey);
            const toAta = await getAssociatedTokenAddress(USDC_MINT, toPubkey);

            // Ensure recipient ATA exists
            try {
                await getAccount(connection, toAta);
            } catch (e) {
                tx.add(createAssociatedTokenAccountInstruction(
                    escrowKeypair.publicKey, // payer (escrow pays for ATA creation)
                    toAta,
                    toPubkey,
                    USDC_MINT
                ));
            }

            tx.add(createTransferInstruction(
                escrowAta,
                toAta,
                escrowKeypair.publicKey, // authority (escrow signs)
                amount
            ));
        } else {
            return { error: 'Unknown token: ' + token };
        }

        const signature = await sendAndConfirmTransaction(connection, tx, [escrowKeypair], {
            commitment: 'confirmed'
        });
        console.log('[escrow] Payout sent:', signature, 'to:', toWalletPubkey, amount, token);
        return { signature };
    } catch (err) {
        console.error('[escrow] sendPayout error:', err.message);
        return { error: err.message };
    }
}

/**
 * Send rake (fee) from escrow to treasury.
 * @param {number} amount - Amount in base units
 * @param {'SOL'|'USDC'} token - Token type
 * @returns {Promise<{signature?: string, error?: string}>}
 */
async function sendRake(amount, token) {
    if (!treasuryPubkey) return { error: 'Treasury wallet not configured' };
    return sendPayout(treasuryPubkey.toBase58(), amount, token);
}

/**
 * Get balance of a wallet.
 * @param {string} walletPubkey - Wallet public key (base58)
 * @param {'SOL'|'USDC'} token - Token type
 * @returns {Promise<number|null>} Balance in base units, or null on error
 */
async function getBalance(walletPubkey, token) {
    if (!connection) return null;
    try {
        const pubkey = new PublicKey(walletPubkey);

        if (token === 'SOL') {
            return await connection.getBalance(pubkey, 'confirmed');
        } else if (token === 'USDC') {
            const ata = await getAssociatedTokenAddress(USDC_MINT, pubkey);
            try {
                const account = await getAccount(connection, ata);
                return Number(account.amount);
            } catch (e) {
                // ATA doesn't exist — balance is 0
                return 0;
            }
        }
        return null;
    } catch (err) {
        console.error('[escrow] getBalance error:', err.message);
        return null;
    }
}

/**
 * Check if a blockhash is still valid.
 * @param {string} blockhash - The blockhash to check
 * @returns {Promise<boolean>}
 */
async function isBlockhashValid(blockhash) {
    if (!connection) return false;
    try {
        const result = await connection.isBlockhashValid(blockhash, { commitment: 'confirmed' });
        return result.value;
    } catch (err) {
        console.error('[escrow] isBlockhashValid error:', err.message);
        return false;
    }
}

module.exports = {
    createDepositTransaction,
    confirmDeposit,
    sendPayout,
    sendRake,
    getBalance,
    isBlockhashValid,
    USDC_MINT,
    isReady
};

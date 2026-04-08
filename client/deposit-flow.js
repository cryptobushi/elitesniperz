/**
 * deposit-flow.js — Deposit transaction flow for sniperz wager system
 *
 * Handles fetching unsigned deposit transactions from the server,
 * signing/confirming them, and checking wallet balances.
 *
 * Dev mode: auto-confirms with a fake tx signature.
 * Production: would sign with Privy embedded wallet and submit to Solana.
 */

import { getToken } from '../dist/privy-bundle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(token) {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token || getToken()}`,
    };
}

/** Generate a fake Solana transaction signature for dev/mock mode. */
function fakeTxSignature() {
    const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let sig = '';
    for (let i = 0; i < 88; i++) {
        sig += chars[Math.floor(Math.random() * chars.length)];
    }
    return sig;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Request and execute a deposit for a wager match.
 *
 * Flow:
 *   1. GET /api/matches/:matchId/deposit-tx — fetch unsigned transaction
 *   2. Sign the transaction (dev: skip, prod: Privy embedded wallet)
 *   3. POST /api/matches/:matchId/confirm-deposit — confirm with tx signature
 *
 * @param {string} matchId — the match to deposit for
 * @param {string} [token] — auth token override (defaults to getToken())
 * @returns {Promise<{ success: boolean, status?: string, error?: string }>}
 */
export async function requestDeposit(matchId, token) {
    const authToken = token || getToken();
    if (!authToken) {
        return { success: false, error: 'Not authenticated' };
    }

    try {
        // Step 1: Fetch the unsigned deposit transaction
        const txRes = await fetch(`/api/matches/${matchId}/deposit-tx`, {
            headers: authHeaders(authToken),
        });

        if (!txRes.ok) {
            const body = await txRes.json().catch(() => ({}));
            return { success: false, error: body.error || `Failed to get deposit tx (${txRes.status})` };
        }

        const txBody = await txRes.json();
        if (!txBody.success) {
            return { success: false, error: txBody.error || 'Failed to get deposit transaction' };
        }

        const unsignedTx = txBody.data?.transaction;

        // Step 2: Sign the transaction
        // PRODUCTION: Replace this block with actual Privy wallet signing:
        // ---------------------------------------------------------------
        // import { signTransaction } from '@privy-io/js-sdk-core';
        // const signedTx = await signTransaction(unsignedTx);
        // const connection = new Connection(RPC_URL);
        // const txSig = await connection.sendRawTransaction(signedTx);
        // await connection.confirmTransaction(txSig);
        // ---------------------------------------------------------------

        // DEV MODE: Auto-confirm with a fake signature
        const txSignature = fakeTxSignature();
        console.log(`[deposit-flow] Dev mode — auto-confirming with fake sig: ${txSignature.slice(0, 16)}...`);

        // Step 3: Confirm the deposit on the server
        const confirmRes = await fetch(`/api/matches/${matchId}/confirm-deposit`, {
            method: 'POST',
            headers: authHeaders(authToken),
            body: JSON.stringify({ txSignature }),
        });

        if (!confirmRes.ok) {
            const body = await confirmRes.json().catch(() => ({}));
            return { success: false, error: body.error || `Deposit confirmation failed (${confirmRes.status})` };
        }

        const confirmBody = await confirmRes.json();
        if (!confirmBody.success) {
            return { success: false, error: confirmBody.error || 'Deposit confirmation failed' };
        }

        return {
            success: true,
            status: confirmBody.data?.status || 'confirmed',
            txSignature,
        };

    } catch (e) {
        console.error('[deposit-flow] Error:', e);
        return { success: false, error: e.message };
    }
}

/**
 * Check the authenticated user's wallet balance.
 *
 * @param {string} [token] — auth token override (defaults to getToken())
 * @returns {Promise<{ sol: number, usdc: number }>}
 */
export async function checkBalance(token) {
    const authToken = token || getToken();
    if (!authToken) {
        return { sol: 0, usdc: 0 };
    }

    try {
        const res = await fetch('/api/wallet/balance', {
            headers: authHeaders(authToken),
        });

        if (!res.ok) {
            console.warn('[deposit-flow] Balance check failed:', res.status);
            return { sol: 0, usdc: 0 };
        }

        const body = await res.json();
        if (body.success && body.data) {
            return { sol: body.data.sol || 0, usdc: body.data.usdc || 0 };
        }

        return { sol: 0, usdc: 0 };
    } catch (e) {
        console.warn('[deposit-flow] Balance check error:', e.message);
        return { sol: 0, usdc: 0 };
    }
}

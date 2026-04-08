/**
 * deposit-flow.js — Real Solana deposit flow via Privy embedded wallet
 */
import { getToken, getSolanaProvider } from '../dist/privy-bundle.js';

function authHeaders(token) {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token || getToken()}`,
    };
}

/**
 * Request and execute a deposit for a wager match.
 *
 * Flow:
 *   1. GET /api/matches/:matchId/deposit-tx — get unsigned transaction (base64)
 *   2. Deserialize transaction
 *   3. Sign and send via Privy Solana provider
 *   4. POST /api/matches/:matchId/confirm-deposit — confirm with real tx signature
 */
export async function requestDeposit(matchId, token) {
    const authToken = token || getToken();
    if (!authToken) return { success: false, error: 'Not authenticated' };

    try {
        // Step 1: Get unsigned transaction from server
        console.log('[deposit] Fetching deposit transaction...');
        const txRes = await fetch(`/api/matches/${matchId}/deposit-tx`, {
            headers: authHeaders(authToken),
        });

        if (!txRes.ok) {
            const body = await txRes.json().catch(() => ({}));
            return { success: false, error: body.error || `Failed to get deposit tx (${txRes.status})` };
        }

        const txBody = await txRes.json();
        if (!txBody.success) return { success: false, error: txBody.error || 'Failed to get deposit transaction' };

        const unsignedTxBase64 = txBody.data?.transaction;
        if (!unsignedTxBase64 || unsignedTxBase64 === 'dev-mock-tx') {
            // Dev mode fallback
            console.log('[deposit] Dev mode — auto-confirming');
            return _devConfirm(matchId, authToken);
        }

        // Step 2: Get Privy Solana provider
        console.log('[deposit] Getting Solana provider...');
        const provider = await getSolanaProvider();
        if (!provider) {
            return { success: false, error: 'Wallet not available. Try logging out and back in.' };
        }

        // Step 3: Sign the transaction with Privy wallet
        console.log('[deposit] Signing transaction with Privy wallet...');

        const txBytes = Uint8Array.from(atob(unsignedTxBase64), c => c.charCodeAt(0));

        // signTransaction returns the signed transaction object
        const signResult = await provider.request({
            method: 'signTransaction',
            params: { transaction: txBytes },
        });

        // Extract the signed transaction — could be the signed tx object or serialized bytes
        const signedTx = signResult?.signedTransaction || signResult;
        let signedTxBase64;
        if (signedTx instanceof Uint8Array || signedTx instanceof ArrayBuffer) {
            const bytes = new Uint8Array(signedTx);
            signedTxBase64 = btoa(String.fromCharCode(...bytes));
        } else if (typeof signedTx === 'string') {
            signedTxBase64 = signedTx;
        } else if (signedTx?.serialize) {
            // It's a Transaction object — serialize it
            const serialized = signedTx.serialize();
            signedTxBase64 = btoa(String.fromCharCode(...new Uint8Array(serialized)));
        } else {
            console.log('[deposit] signResult type:', typeof signedTx, signedTx);
            return { success: false, error: 'Unexpected sign result format' };
        }

        console.log('[deposit] Signed, submitting to server...');

        // Step 3b: Send signed tx to server for submission
        const submitRes = await fetch(`/api/matches/${matchId}/submit-signed-tx`, {
            method: 'POST',
            headers: authHeaders(authToken),
            body: JSON.stringify({ signedTransaction: signedTxBase64 }),
        });
        const submitBody = await submitRes.json();
        if (!submitRes.ok || !submitBody.success) {
            return { success: false, error: submitBody.error || 'Failed to submit transaction' };
        }
        const signature = submitBody.data?.txSignature;
        console.log('[deposit] Transaction confirmed:', signature);

        // Step 4: Confirm with server
        console.log('[deposit] Confirming deposit on server...');
        const confirmRes = await fetch(`/api/matches/${matchId}/confirm-deposit`, {
            method: 'POST',
            headers: authHeaders(authToken),
            body: JSON.stringify({ txSignature: signature }),
        });

        if (!confirmRes.ok) {
            const body = await confirmRes.json().catch(() => ({}));
            return { success: false, error: body.error || `Confirmation failed (${confirmRes.status})` };
        }

        const confirmBody = await confirmRes.json();
        if (!confirmBody.success) return { success: false, error: confirmBody.error || 'Confirmation failed' };

        return {
            success: true,
            status: confirmBody.data?.status || 'confirmed',
            txSignature: signature,
        };
    } catch (e) {
        console.error('[deposit] Error:', e);
        return { success: false, error: e.message };
    }
}

/** Dev mode fallback — fake confirm */
async function _devConfirm(matchId, authToken) {
    const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let sig = '';
    for (let i = 0; i < 88; i++) sig += chars[Math.floor(Math.random() * chars.length)];
    console.log(`[deposit] Dev auto-confirm: ${sig.slice(0, 16)}...`);

    const confirmRes = await fetch(`/api/matches/${matchId}/confirm-deposit`, {
        method: 'POST',
        headers: authHeaders(authToken),
        body: JSON.stringify({ txSignature: sig }),
    });
    const body = await confirmRes.json().catch(() => ({}));
    if (!confirmRes.ok || !body.success) {
        return { success: false, error: body.error || 'Dev confirm failed' };
    }
    return { success: true, status: body.data?.status, txSignature: sig };
}

/**
 * Check wallet balance
 */
export async function checkBalance(token) {
    const authToken = token || getToken();
    if (!authToken) return { sol: 0, usdc: 0 };

    try {
        const res = await fetch('/api/wallet/balance', { headers: authHeaders(authToken) });
        if (!res.ok) return { sol: 0, usdc: 0 };
        const body = await res.json();
        if (body.success && body.data) return { sol: body.data.sol || 0, usdc: body.data.usdc || 0 };
    } catch (e) {
        console.warn('[deposit] Balance check error:', e.message);
    }
    return { sol: 0, usdc: 0 };
}

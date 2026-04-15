import { getToken, getSolanaProvider } from '../dist/privy-bundle.js';

function authHeaders(token) {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token || getToken()}`,
    };
}

export async function requestDeposit(matchId, token) {
    const authToken = token || getToken();
    if (!authToken) return { success: false, error: 'Not authenticated' };

    try {

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

        const txBase64 = txBody.data?.transaction;
        const messageBase64 = txBody.data?.message;

        if (!txBase64) {
            return { success: false, error: 'No transaction data returned' };
        }
        console.log('[deposit] Getting Solana provider...');
        const provider = await getSolanaProvider();
        if (!provider) {
            return { success: false, error: 'Wallet not available. Try logging out and back in.' };
        }
        console.log('[deposit] Signing transaction message with Privy wallet...');

        const signResult = await provider.request({
            method: 'signMessage',
            params: { message: messageBase64 },
        });
        const signatureBase64 = signResult?.signature || signResult;
        console.log('[deposit] Signed, submitting to server...');
        console.log('[deposit] Sending signed lock-in to server (held until both ready)...');
        const submitRes = await fetch(`/api/matches/${matchId}/lock-in`, {
            method: 'POST',
            headers: authHeaders(authToken),
            body: JSON.stringify({
                transaction: txBase64,
                signature: signatureBase64,
            }),
        });
        const submitBody = await submitRes.json();
        if (!submitRes.ok || !submitBody.success) {
            return { success: false, error: submitBody.error || 'Lock-in failed' };
        }
        return {
            success: true,
            status: submitBody.data?.status || 'locked',
            txSignature: submitBody.data?.txSignature || 'pending',
        };
    } catch (e) {
        console.error('[deposit] Error:', e);
        return { success: false, error: e.message };
    }
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

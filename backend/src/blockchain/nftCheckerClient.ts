import { config } from '../config';

export interface NftOwnershipResult {
  verdict: string;
  itemAddress: string;
  ownerWallet: string | null;
  expectedOwner: string | null;
  checkedAt: string;
  reason?: string;
  error?: string;
}

export async function checkNftOwnership(itemAddress: string, expectedOwner: string): Promise<NftOwnershipResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${config.checkerUrl.replace(/\/+$/, '')}/api/check/nft`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.checkerApiKey ? { 'x-api-key': config.checkerApiKey } : {}),
      },
      body: JSON.stringify({ itemAddress, expectedOwner }),
      signal: controller.signal,
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as NftOwnershipResult) : ({} as NftOwnershipResult);
    if (!res.ok) throw new Error(data.error || `checker_${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/queries', () => ({
  db: { query: vi.fn() },
}));
vi.mock('../blockchain/nftCheckerClient', () => ({
  checkNftOwnership: vi.fn(),
}));
vi.mock('../blockchain/signerClient', () => ({
  getSignerAddress: vi.fn(),
  sendNft: vi.fn(),
}));
vi.mock('./dealService', () => ({
  DEAL_STATUS: {
    DEPOSIT_CONFIRMED: 'DEPOSIT_CONFIRMED',
    ITEM_SENT: 'ITEM_SENT',
  },
  getDealById: vi.fn(),
}));

import { checkNftOwnership } from '../blockchain/nftCheckerClient';
import { getSignerAddress, sendNft } from '../blockchain/signerClient';
import { db } from '../db/queries';
import { getDealById } from './dealService';
import { confirmNftDelivery, confirmNftEscrowCustody, returnNftToSeller, sendNftToBuyer } from './nftEscrowService';

const ITEM = `0:${'11'.repeat(32)}`;
const SELLER = `0:${'22'.repeat(32)}`;
const BUYER = `0:${'33'.repeat(32)}`;
const ESCROW = `0:${'44'.repeat(32)}`;
const ownership = (owner: string) => ({
  verdict: 'verified',
  itemAddress: ITEM,
  ownerWallet: owner,
  expectedOwner: owner,
  checkedAt: new Date(0).toISOString(),
});

const nftDeal = (over: Record<string, unknown> = {}) => ({
  id: 7,
  deal_type: 'NFT',
  status: 'DEPOSIT_CONFIRMED',
  nft_item_address: ITEM,
  nft_seller_address: SELLER,
  nft_buyer_address: BUYER,
  nft_verified_at: new Date(0),
  nft_escrow_received_at: new Date(0),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDealById).mockResolvedValue(nftDeal() as never);
  vi.mocked(getSignerAddress).mockResolvedValue(ESCROW);
  vi.mocked(checkNftOwnership).mockResolvedValue(ownership(ESCROW));
  vi.mocked(sendNft).mockResolvedValue({ seqno: 10 });
  vi.mocked(db.query).mockResolvedValue({ rowCount: 1, rows: [{ id: 7 }] } as never);
});

describe('NFT escrow custody', () => {
  it('will not acknowledge custody before the money deposit is confirmed', async () => {
    vi.mocked(getDealById).mockResolvedValue(nftDeal({ status: 'AWAITING_DEPOSIT' }) as never);

    await expect(confirmNftEscrowCustody(7)).rejects.toThrow('deposit_not_confirmed');
    expect(checkNftOwnership).not.toHaveBeenCalled();
  });

  it('rechecks signer custody and uses a stable delivery idempotency key', async () => {
    await sendNftToBuyer(7);

    expect(checkNftOwnership).toHaveBeenCalledWith(ITEM, ESCROW);
    expect(sendNft).toHaveBeenCalledWith(
      expect.objectContaining({
        itemAddress: ITEM,
        idempotencyKey: 'nft-delivery:7',
      }),
    );
  });

  it('marks ITEM_SENT only after the checker proves buyer ownership', async () => {
    vi.mocked(checkNftOwnership).mockResolvedValue(ownership(BUYER));

    await confirmNftDelivery(7);

    expect(checkNftOwnership).toHaveBeenCalledWith(ITEM, expect.any(String));
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $2 AND status = $3'), [
      'ITEM_SENT',
      7,
      'DEPOSIT_CONFIRMED',
    ]);
  });

  it('returns an escrow-held NFT to the seller before a money refund', async () => {
    vi.mocked(checkNftOwnership)
      .mockResolvedValueOnce({ ...ownership(SELLER), verdict: 'mismatch' })
      .mockResolvedValueOnce(ownership(ESCROW));

    await returnNftToSeller(nftDeal());

    expect(sendNft).toHaveBeenCalledWith(
      expect.objectContaining({
        itemAddress: ITEM,
        idempotencyKey: 'nft-refund:7',
      }),
    );
  });
});

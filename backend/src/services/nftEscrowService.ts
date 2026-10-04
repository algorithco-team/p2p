import { Address } from '@ton/core';
import { db } from '../db/queries';
import { checkNftOwnership } from '../blockchain/nftCheckerClient';
import { getSignerAddress, sendNft } from '../blockchain/signerClient';
import { DEAL_STATUS, getDealById } from './dealService';

function assertAddress(value: unknown, field: string): string {
  const raw = String(value || '').trim();
  try {
    return Address.parse(raw).toString({ urlSafe: true, bounceable: false });
  } catch {
    throw new Error(`${field}_invalid`);
  }
}

function assertNftDeal(deal: any): void {
  if (String(deal?.deal_type || '').toUpperCase() !== 'NFT') throw new Error('not_nft_deal');
  if (!deal.nft_item_address) throw new Error('nft_item_address_required');
}

export async function setNftBuyerAddress(dealId: number, buyerTelegramId: number, address: string) {
  const normalized = assertAddress(address, 'nft_buyer_address');
  const res = await db.query(
    `UPDATE deals SET nft_buyer_address = $1, updated_at = now()
     WHERE id = $2 AND buyer_telegram_id = $3
       AND status NOT IN ('RELEASE_PENDING','REFUND_PENDING','RELEASED','REFUNDED','CLOSED')
     RETURNING *`,
    [normalized, dealId, buyerTelegramId],
  );
  if (!res.rows[0]) throw new Error('buyer_not_authorized_or_deal_locked');
  return res.rows[0];
}

export async function verifyNftSellerOwnership(dealId: number) {
  const deal: any = await getDealById(dealId);
  if (!deal) throw new Error('deal_not_found');
  assertNftDeal(deal);
  const expected = assertAddress(deal.nft_seller_address, 'nft_seller_address');
  const result = await checkNftOwnership(String(deal.nft_item_address), expected);
  if (result.verdict !== 'verified') throw new Error(`nft_seller_not_owner:${result.reason || result.verdict}`);
  await db.query('UPDATE deals SET nft_verified_at = now(), updated_at = now() WHERE id = $1', [dealId]);
  return result;
}

export async function confirmNftEscrowCustody(dealId: number) {
  const deal: any = await getDealById(dealId);
  if (!deal) throw new Error('deal_not_found');
  assertNftDeal(deal);
  if (String(deal.status) !== DEAL_STATUS.DEPOSIT_CONFIRMED) throw new Error('deposit_not_confirmed');
  if (!deal.nft_verified_at) throw new Error('seller_ownership_not_verified');
  const escrow = await getSignerAddress();
  const result = await checkNftOwnership(String(deal.nft_item_address), escrow);
  if (result.verdict !== 'verified') throw new Error(`nft_not_in_escrow:${result.reason || result.verdict}`);
  await db.query('UPDATE deals SET nft_escrow_received_at = now(), updated_at = now() WHERE id = $1', [dealId]);
  return result;
}

export async function sendNftToBuyer(dealId: number) {
  const deal: any = await getDealById(dealId);
  if (!deal) throw new Error('deal_not_found');
  assertNftDeal(deal);
  if (String(deal.status) !== DEAL_STATUS.DEPOSIT_CONFIRMED) throw new Error('deposit_not_confirmed');
  if (!deal.nft_escrow_received_at) throw new Error('nft_not_confirmed_in_escrow');
  const buyerAddress = assertAddress(deal.nft_buyer_address, 'nft_buyer_address');
  const escrow = await getSignerAddress();
  const custody = await checkNftOwnership(String(deal.nft_item_address), escrow);
  if (custody.verdict !== 'verified') throw new Error('nft_custody_lost');
  const key = `nft-delivery:${dealId}`;
  const sent = await sendNft({
    itemAddress: String(deal.nft_item_address),
    newOwner: buyerAddress,
    responseDestination: escrow,
    forwardAmount: '0.01',
    comment: `Escrow NFT delivery #${dealId}`,
    idempotencyKey: key,
  });
  await db.query('UPDATE deals SET nft_transfer_idempotency_key = $1, updated_at = now() WHERE id = $2', [key, dealId]);
  return sent;
}

export async function confirmNftDelivery(dealId: number) {
  const deal: any = await getDealById(dealId);
  if (!deal) throw new Error('deal_not_found');
  assertNftDeal(deal);
  const buyerAddress = assertAddress(deal.nft_buyer_address, 'nft_buyer_address');
  const result = await checkNftOwnership(String(deal.nft_item_address), buyerAddress);
  if (result.verdict !== 'verified') throw new Error(`nft_not_delivered:${result.reason || result.verdict}`);
  const updated = await db.query(
    `UPDATE deals SET status = $1, nft_delivered_at = now(), updated_at = now()
     WHERE id = $2 AND status = $3 RETURNING id`,
    [DEAL_STATUS.ITEM_SENT, dealId, DEAL_STATUS.DEPOSIT_CONFIRMED],
  );
  if ((updated.rowCount ?? 0) === 0 && String(deal.status) !== DEAL_STATUS.ITEM_SENT)
    throw new Error(`invalid_status:${deal.status}`);
  return result;
}

export async function assertNftDeliveredForRelease(deal: any): Promise<void> {
  if (String(deal?.deal_type || '').toUpperCase() !== 'NFT') return;
  const buyerAddress = assertAddress(deal.nft_buyer_address, 'nft_buyer_address');
  const result = await checkNftOwnership(String(deal.nft_item_address), buyerAddress);
  if (result.verdict !== 'verified') throw new Error(`nft_not_delivered:${result.reason || result.verdict}`);
  await db.query(
    'UPDATE deals SET nft_delivered_at = COALESCE(nft_delivered_at, now()), updated_at = now() WHERE id = $1',
    [Number(deal.id)],
  );
}

export async function returnNftToSeller(deal: any): Promise<void> {
  if (String(deal?.deal_type || '').toUpperCase() !== 'NFT' || !deal.nft_escrow_received_at || deal.nft_delivered_at)
    return;
  const seller = assertAddress(deal.nft_seller_address, 'nft_seller_address');
  const alreadyReturned = await checkNftOwnership(String(deal.nft_item_address), seller);
  if (alreadyReturned.verdict === 'verified') return;
  const escrow = await getSignerAddress();
  const custody = await checkNftOwnership(String(deal.nft_item_address), escrow);
  if (custody.verdict !== 'verified') throw new Error('nft_refund_blocked_custody_lost');
  await sendNft({
    itemAddress: String(deal.nft_item_address),
    newOwner: seller,
    responseDestination: escrow,
    forwardAmount: '0.01',
    comment: `Escrow NFT return #${deal.id}`,
    idempotencyKey: `nft-refund:${deal.id}`,
  });
}

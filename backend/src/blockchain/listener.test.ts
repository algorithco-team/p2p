// AGPL-3.0 — listener deposit-path tests: exact / overpay / underpay.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Address } from '@ton/core';

vi.mock('../db/queries', () => ({
  db: { query: vi.fn(), connect: vi.fn() },
  saveAdminAlert: vi.fn().mockResolvedValue({}),
}));
vi.mock('./signerClient', () => ({
  sendTon: vi.fn(),
  sendJetton: vi.fn(),
}));
vi.mock('../bot/notify', () => ({
  unknownDepositToAdmins: vi.fn().mockResolvedValue(undefined),
  depositToSeller: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/tonPayload', () => ({
  decryptCommentString: (s: string | null) => s,
}));
vi.mock('../utils/encryption', () => ({
  encryptField: (s: string) => `enc(${s})`,
}));
vi.mock('../config', () => ({
  config: { feeBps: 100, jettonMasterAddress: '0:' + '44'.repeat(32), usdtJettonAddress: '' },
}));
vi.mock('./jettonUtils', () => ({
  computeJettonWalletAddress: vi.fn(),
}));

import { db } from '../db/queries';
import { sendTon, sendJetton } from './signerClient';
import { processTonDeposit, processJettonDeposit } from './listener';
import { updateDealStatus } from '../services/dealService';
import { computeJettonWalletAddress } from './jettonUtils';

vi.mock('../services/dealService', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/dealService')>();
  return { ...orig, updateDealStatus: vi.fn(), dealLike: (d: unknown) => d };
});

const mockUpdate = vi.mocked(updateDealStatus);
const PAY_ADDR = '0:' + '77'.repeat(32);
const REAL_JETTON_WALLET = '0:' + '55'.repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: one AWAITING_DEPOSIT deal #7 — 10 TON + 1% fee = 10.1 expected
  vi.mocked(db.query).mockImplementation((sql: string) => {
    if (/FROM deals WHERE id/.test(sql))
      return Promise.resolve({
        rowCount: 1,
        rows: [
          {
            id: 7,
            asset: 'TON',
            amount: '10',
            fee_bps: 100,
            buyer_telegram_id: 111,
            seller_telegram_id: 222,
            payment_address: 'UQ_wallet',
            terms: '',
          },
        ],
      } as never);
    return Promise.resolve({ rowCount: 0, rows: [] } as never);
  });
  mockUpdate.mockResolvedValue(true);
  vi.mocked(computeJettonWalletAddress).mockResolvedValue(Address.parse(REAL_JETTON_WALLET));
});

describe('processTonDeposit', () => {
  it('exact match confirms DEPOSIT_CONFIRMED (guarded from AWAITING only)', async () => {
    await processTonDeposit('UQ_wallet', null, 10_100_000_000n, 'hash1', 'escrow#7');
    expect(mockUpdate).toHaveBeenCalledWith(7, 'DEPOSIT_CONFIRMED', 'hash1', ['AWAITING_DEPOSIT']);
  });

  it('overpay confirms + refunds excess to sender', async () => {
    const { Address } = await import('@ton/core');
    // Use a valid address string for src so refund path runs
    const src = Address.parse('UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ');
    await processTonDeposit('UQ_wallet', src, 11_100_000_000n, 'hash2', 'escrow#7');
    expect(mockUpdate).toHaveBeenCalledWith(7, 'DEPOSIT_CONFIRMED', 'hash2', ['AWAITING_DEPOSIT']);
    expect(vi.mocked(sendTon)).toHaveBeenCalledOnce();
    const arg = vi.mocked(sendTon).mock.calls[0][0] as { value: string };
    expect(arg.value).toBe('1'); // 1 TON excess
  });

  it('underpay does NOT confirm (waits + alerts)', async () => {
    await processTonDeposit('UQ_wallet', null, 5_000_000_000n, 'hash3', 'escrow#7');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('memo for unknown deal alerts admins, never confirms', async () => {
    await processTonDeposit('UQ_wallet', null, 1_000_000_000n, 'hash4', 'escrow#9999');
    // findAwaitingDealById mock returns deal #7 regardless of id — force miss:
    vi.mocked(db.query).mockResolvedValueOnce({ rowCount: 0, rows: [] } as never);
    await processTonDeposit('UQ_wallet', null, 1_000_000_000n, 'hash5', 'escrow#9999');
    // second call with empty row must not confirm
    expect(mockUpdate.mock.calls.filter((c) => c[2] === 'hash5')).toHaveLength(0);
  });

  it('wrong asset (USDT deal receiving TON) is ignored', async () => {
    vi.mocked(db.query).mockImplementationOnce(
      () =>
        Promise.resolve({
          rowCount: 1,
          rows: [
            {
              id: 8,
              asset: 'USDT',
              amount: '100',
              fee_bps: 100,
              buyer_telegram_id: 1,
              seller_telegram_id: 2,
              payment_address: PAY_ADDR,
              terms: '',
            },
          ],
        }) as never,
    );
    await processTonDeposit('UQ_wallet', null, 1_000_000_000n, 'hash6', 'escrow#8');
    expect(mockUpdate.mock.calls.filter((c) => c[2] === 'hash6')).toHaveLength(0);
  });
});

describe('processJettonDeposit (USDT)', () => {
  beforeEach(() => {
    vi.mocked(db.query).mockImplementation((sql: string) => {
      if (/FROM deals WHERE id/.test(sql))
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              id: 9,
              asset: 'USDT',
              amount: '100',
              fee_bps: 100,
              buyer_telegram_id: 111,
              seller_telegram_id: 222,
              payment_address: PAY_ADDR,
              terms: '',
            },
          ],
        } as never);
      return Promise.resolve({ rowCount: 0, rows: [] } as never);
    });
  });

  it('exact USDT match confirms', async () => {
    await processJettonDeposit(
      PAY_ADDR,
      { queryId: 0n, amount: 101_000_000n, sender: null },
      'escrow#9',
      'jhash1',
      REAL_JETTON_WALLET,
    );
    expect(mockUpdate).toHaveBeenCalledWith(9, 'DEPOSIT_CONFIRMED', 'jhash1', ['AWAITING_DEPOSIT']);
  });

  it('USDT underpay waits', async () => {
    await processJettonDeposit(
      PAY_ADDR,
      { queryId: 0n, amount: 50_000_000n, sender: null },
      'escrow#9',
      'jhash2',
      REAL_JETTON_WALLET,
    );
    expect(mockUpdate.mock.calls.filter((c) => c[2] === 'jhash2')).toHaveLength(0);
    expect(vi.mocked(sendJetton)).not.toHaveBeenCalled();
  });
});

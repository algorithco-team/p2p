import { Address, Cell } from '@ton/core';
import { describe, expect, it } from 'vitest';
import { JETTON_OPS } from '../blockchain/jettonUtils';
import { jettonDepositPayload } from './tonPayload';

describe('jettonDepositPayload', () => {
  it('encodes price plus fee, matching the listener expected deposit', () => {
    const payload = jettonDepositPayload({
      price: '100',
      asset: 'USDT',
      feeBps: 100,
      destination: Address.parse(`0:${'11'.repeat(32)}`),
      forwardComment: 'encrypted-memo',
    });
    const slice = Cell.fromBoc(Buffer.from(payload, 'base64'))[0].beginParse();

    expect(slice.loadUint(32)).toBe(JETTON_OPS.transfer);
    slice.loadUintBig(64);
    expect(slice.loadCoins()).toBe(101_000_000n);
  });
});

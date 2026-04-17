import { describe, expect, it } from 'vitest';
import { Cl } from '@stacks/transactions';

const accounts = simnet.getAccounts();
const owner = accounts.get('wallet_1')!;
const userA = accounts.get('wallet_2')!;
const userB = accounts.get('wallet_3')!;

describe('community-guestbook', () => {
  it('community creation increments nonce and stores config', () => {
    const created = simnet.callPublicFn(
      'community-guestbook',
      'create-community',
      [Cl.stringUtf8('Builders Hub'), Cl.stringUtf8('Guestbook for builders'), Cl.uint(3)],
      owner,
    );

    expect(created.result).toBeOk(Cl.uint(1));

    const count = simnet.callReadOnlyFn('community-guestbook', 'get-community-count', [], owner);
    expect(count.result).toBeOk(Cl.uint(1));
  });

  it('sign message increments entry count', () => {
    simnet.callPublicFn(
      'community-guestbook',
      'create-community',
      [Cl.stringUtf8('One'), Cl.stringUtf8('Desc'), Cl.uint(1)],
      owner,
    );

    const signed = simnet.callPublicFn(
      'community-guestbook',
      'sign-guestbook',
      [Cl.uint(1), Cl.stringUtf8('Hello chain')],
      userA,
    );

    expect(signed.result).toBeOk(Cl.uint(1));

    const community = simnet.callReadOnlyFn('community-guestbook', 'get-community', [Cl.uint(1)], owner);
    expect(community.result).toBeOk(
      Cl.some(
        Cl.tuple({
          owner: Cl.principal(owner),
          name: Cl.stringUtf8('One'),
          description: Cl.stringUtf8('Desc'),
          'rate-limit-blocks': Cl.uint(1),
          active: Cl.bool(true),
          'created-height': Cl.uint(2),
          'entry-count': Cl.uint(1),
        }),
      ),
    );
  });

  it('sign too soon fails with ERR_RATE_LIMIT', () => {
    simnet.callPublicFn(
      'community-guestbook',
      'create-community',
      [Cl.stringUtf8('Two'), Cl.stringUtf8('Desc'), Cl.uint(5)],
      owner,
    );

    simnet.callPublicFn(
      'community-guestbook',
      'sign-guestbook',
      [Cl.uint(1), Cl.stringUtf8('First')],
      userA,
    );

    const tooSoon = simnet.callPublicFn(
      'community-guestbook',
      'sign-guestbook',
      [Cl.uint(1), Cl.stringUtf8('Second')],
      userA,
    );

    expect(tooSoon.result).toBeErr(Cl.uint(102));
  });

  it('owner can toggle active status', () => {
    simnet.callPublicFn(
      'community-guestbook',
      'create-community',
      [Cl.stringUtf8('Three'), Cl.stringUtf8('Desc'), Cl.uint(1)],
      owner,
    );

    const toggled = simnet.callPublicFn(
      'community-guestbook',
      'set-community-active',
      [Cl.uint(1), Cl.bool(false)],
      owner,
    );

    expect(toggled.result).toBeOk(Cl.bool(true));
  });

  it('non-owner admin actions fail', () => {
    simnet.callPublicFn(
      'community-guestbook',
      'create-community',
      [Cl.stringUtf8('Four'), Cl.stringUtf8('Desc'), Cl.uint(1)],
      owner,
    );

    const deniedToggle = simnet.callPublicFn(
      'community-guestbook',
      'set-community-active',
      [Cl.uint(1), Cl.bool(false)],
      userA,
    );

    const deniedRate = simnet.callPublicFn(
      'community-guestbook',
      'set-rate-limit',
      [Cl.uint(1), Cl.uint(20)],
      userB,
    );

    expect(deniedToggle.result).toBeErr(Cl.uint(103));
    expect(deniedRate.result).toBeErr(Cl.uint(103));
  });

  it('inactive community rejects new messages', () => {
    simnet.callPublicFn(
      'community-guestbook',
      'create-community',
      [Cl.stringUtf8('Five'), Cl.stringUtf8('Desc'), Cl.uint(1)],
      owner,
    );

    simnet.callPublicFn(
      'community-guestbook',
      'set-community-active',
      [Cl.uint(1), Cl.bool(false)],
      owner,
    );

    const signed = simnet.callPublicFn(
      'community-guestbook',
      'sign-guestbook',
      [Cl.uint(1), Cl.stringUtf8('Blocked')],
      userA,
    );

    expect(signed.result).toBeErr(Cl.uint(101));
  });
});

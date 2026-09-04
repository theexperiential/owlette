/**
 * @jest-environment node
 *
 * One-shot approval ledger (OWL-47). Pins: first claim creates and returns
 * 'claimed'; a concurrent duplicate (Firestore ALREADY_EXISTS, both numeric 6
 * and string codes) returns 'already-consumed'; an indeterminate error retries
 * once then FAILS OPEN as 'claimed' (a blip must not block a legitimate
 * approval); claims are addressed per chat + toolCallId.
 */

import { claimApproval } from '@/lib/hoot/approvalLedger.server';

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'server-ts' },
  Timestamp: { fromMillis: (ms: number) => ({ ms }) },
}));

function makeDb(create: jest.Mock) {
  const docRef = { create };
  const paths: string[] = [];
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        collection: (sub: string) => ({
          doc: (subId: string) => {
            paths.push(`${name}/${id}/${sub}/${subId}`);
            return docRef;
          },
        }),
      }),
    }),
  } as unknown as FirebaseFirestore.Firestore;
  return { db, paths };
}

const alreadyExists = Object.assign(new Error('already exists'), { code: 6 });

describe('claimApproval', () => {
  it('claims on first create and writes under chats/{chatId}/approvals/{toolCallId}', async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const { db, paths } = makeDb(create);

    await expect(claimApproval(db, 'chat_1', 'tc_1', { turnId: 'turn_1' })).resolves.toBe(
      'claimed',
    );
    expect(paths).toEqual(['chats/chat_1/approvals/tc_1']);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ turnId: 'turn_1' });
  });

  it("returns 'already-consumed' on ALREADY_EXISTS without retrying", async () => {
    const create = jest.fn().mockRejectedValue(alreadyExists);
    const { db } = makeDb(create);

    await expect(claimApproval(db, 'chat_1', 'tc_1', { turnId: 'turn_2' })).resolves.toBe(
      'already-consumed',
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('recognizes the string form of the conflict code', async () => {
    const create = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('exists'), { code: 'already-exists' }));
    const { db } = makeDb(create);

    await expect(claimApproval(db, 'c', 't', { turnId: 'x' })).resolves.toBe('already-consumed');
  });

  it('retries an indeterminate error once, then succeeds', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(new Error('UNAVAILABLE'))
      .mockResolvedValueOnce(undefined);
    const { db } = makeDb(create);

    await expect(claimApproval(db, 'c', 't', { turnId: 'x' })).resolves.toBe('claimed');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('sees ALREADY_EXISTS on the retry as consumed (lost the race during the blip)', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(new Error('UNAVAILABLE'))
      .mockRejectedValueOnce(alreadyExists);
    const { db } = makeDb(create);

    await expect(claimApproval(db, 'c', 't', { turnId: 'x' })).resolves.toBe('already-consumed');
  });

  it('fails OPEN as claimed after two indeterminate errors (logged, not thrown)', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const create = jest.fn().mockRejectedValue(new Error('UNAVAILABLE'));
    const { db } = makeDb(create);

    await expect(claimApproval(db, 'c', 't', { turnId: 'x' })).resolves.toBe('claimed');
    expect(create).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

/**
 * @jest-environment node
 *
 * Context pinning for the hoot transport (OWL-48). Pins: a request is addressed
 * by the ISSUING chat instance (pinned site/machine + the transport's own id),
 * never by the live UI selectors; an orphaned instance (id no longer active)
 * throws instead of retargeting the new conversation — the pre-fix behavior
 * (negative control) was a body addressed to the NEW chat with the OLD
 * conversation's messages.
 */

import {
  buildHootRequestBody,
  StaleChatInstanceError,
} from '@/lib/hoot/requestBody';

const pinned = { siteId: 'site-A', machineId: 'machine-1', machineName: 'machine-1' };
const live = { siteId: 'site-B', machineId: 'machine-9', machineName: 'machine-9' };
const messages = [{ id: 'u1', role: 'user', parts: [] }];

describe('buildHootRequestBody', () => {
  it('addresses the body with the pinned context, ignoring live selectors', () => {
    const { body } = buildHootRequestBody({
      transportChatId: 'chat_1',
      activeChatId: 'chat_1',
      pinnedContext: pinned,
      liveContext: live,
      messages,
      supersede: false,
    });

    expect(body).toEqual({
      messages,
      siteId: 'site-A',
      machineId: 'machine-1',
      machineName: 'machine-1',
      chatId: 'chat_1',
    });
  });

  it('throws StaleChatInstanceError for an orphaned instance instead of retargeting', () => {
    // Negative control for the pre-fix bug: the old code would have produced a
    // body with chatId 'chat_NEW' + site-B here — the cross-chat delivery.
    expect(() =>
      buildHootRequestBody({
        transportChatId: 'chat_OLD',
        activeChatId: 'chat_NEW',
        pinnedContext: pinned,
        liveContext: live,
        messages,
        supersede: false,
      }),
    ).toThrow(StaleChatInstanceError);
  });

  it('falls back to the live context only when no pin exists (initial mount chat)', () => {
    const { body } = buildHootRequestBody({
      transportChatId: 'chat_1',
      activeChatId: 'chat_1',
      pinnedContext: null,
      liveContext: live,
      messages,
      supersede: false,
    });

    expect(body).toMatchObject({ siteId: 'site-B', machineId: 'machine-9', chatId: 'chat_1' });
  });

  it('includes supersede only when set', () => {
    const withFlag = buildHootRequestBody({
      transportChatId: 'c',
      activeChatId: 'c',
      pinnedContext: pinned,
      liveContext: live,
      messages,
      supersede: true,
    });
    expect(withFlag.body.supersede).toBe(true);

    const withoutFlag = buildHootRequestBody({
      transportChatId: 'c',
      activeChatId: 'c',
      pinnedContext: pinned,
      liveContext: live,
      messages,
      supersede: false,
    });
    expect('supersede' in withoutFlag.body).toBe(false);
  });

  it('tolerates a transport with no id (uses the active chat)', () => {
    const { body } = buildHootRequestBody({
      transportChatId: undefined,
      activeChatId: 'chat_active',
      pinnedContext: null,
      liveContext: live,
      messages,
      supersede: false,
    });
    expect(body.chatId).toBe('chat_active');
  });
});

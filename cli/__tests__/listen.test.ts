import { _internals } from '../src/commands/listen';
import { createHmac } from 'crypto';

const { parseSseBlock, buildForwardHeaders } = _internals;

describe('parseSseBlock', () => {
  it('parses a canonical event+data pair', () => {
    const evt = parseSseBlock('event: connected\ndata: {"ok":true}');
    expect(evt).toEqual({ kind: 'connected', id: null, data: '{"ok":true}' });
  });

  it('defaults the event kind to "message" when none is set', () => {
    const evt = parseSseBlock('data: hello');
    expect(evt?.kind).toBe('message');
    expect(evt?.data).toBe('hello');
  });

  it('ignores comment lines (leading ":")', () => {
    const evt = parseSseBlock(': ping\nevent: keepalive\ndata: {}');
    expect(evt?.kind).toBe('keepalive');
  });

  it('returns null for completely empty blocks', () => {
    expect(parseSseBlock('')).toBeNull();
    expect(parseSseBlock(': comment only')).toBeNull();
  });

  it('captures the id field when present', () => {
    const evt = parseSseBlock('id: abc-123\nevent: x\ndata: y');
    expect(evt?.id).toBe('abc-123');
  });
});

describe('buildForwardHeaders', () => {
  it('always sets Content-Type + Roost-Event', () => {
    const h = buildForwardHeaders(
      { kind: 'connected', id: null, data: '{}' },
      undefined,
    );
    expect(h['Content-Type']).toBe('application/json');
    expect(h['Roost-Event']).toBe('connected');
    expect(h['Roost-Signature']).toBeUndefined();
  });

  it('propagates the SSE id into Roost-Delivery', () => {
    const h = buildForwardHeaders(
      { kind: 'keepalive', id: 'delivery-42', data: '{}' },
      undefined,
    );
    expect(h['Roost-Delivery']).toBe('delivery-42');
  });

  it('signs the payload with the stripe-style t=<unix>,v1=<hmac> scheme when a secret is supplied', () => {
    const h = buildForwardHeaders(
      { kind: 'x', id: null, data: '{"a":1}' },
      'shhh-secret',
    );
    const sig = h['Roost-Signature'];
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    // Recompute the hmac with the same secret + timestamp and confirm it matches.
    const [tPart, v1Part] = sig!.split(',');
    const t = Number(tPart!.slice(2));
    const v1 = v1Part!.slice(3);
    const expected = createHmac('sha256', 'shhh-secret')
      .update(`${t}.{"a":1}`)
      .digest('hex');
    expect(v1).toBe(expected);
  });

  it('falls back to event.data.roostSignature when the server pre-signed the payload', () => {
    const h = buildForwardHeaders(
      {
        kind: 'x',
        id: null,
        data: JSON.stringify({ roostSignature: 't=123,v1=deadbeef' }),
      },
      undefined,
    );
    expect(h['Roost-Signature']).toBe('t=123,v1=deadbeef');
  });

  it('leaves signature untouched when data is non-JSON and no secret is supplied', () => {
    const h = buildForwardHeaders(
      { kind: 'x', id: null, data: 'not-json' },
      undefined,
    );
    expect(h['Roost-Signature']).toBeUndefined();
  });
});

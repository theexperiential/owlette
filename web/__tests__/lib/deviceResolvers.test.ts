/** @jest-environment node */

/**
 * Tests for deviceResolvers.ts — generic device selection helpers.
 *
 * Verifies: resolveDevice, shouldShowDeviceDropdown.
 */

import { resolveDevice, shouldShowDeviceDropdown, unionIds } from '@/lib/deviceResolvers';

type Device = { id: string; label?: string };

const d = (id: string, label?: string): Device => ({ id, label });

describe('resolveDevice', () => {
  it('returns null when devices is undefined', () => {
    expect(resolveDevice(undefined, 'a', 'b')).toBeNull();
  });

  it('returns null when devices is empty', () => {
    expect(resolveDevice<Device>([], 'a', 'b')).toBeNull();
  });

  it('returns the selected device when it exists in the list', () => {
    const devices = [d('a'), d('b'), d('c')];
    expect(resolveDevice(devices, 'b', 'a')).toEqual(d('b'));
  });

  it('falls through to primary when the selected device is not in the list', () => {
    const devices = [d('a'), d('b')];
    expect(resolveDevice(devices, 'missing', 'a')).toEqual(d('a'));
  });

  it('returns the primary device when no selection is provided', () => {
    const devices = [d('a'), d('b'), d('c')];
    expect(resolveDevice(devices, null, 'c')).toEqual(d('c'));
  });

  it('returns the first device when no selection and no primary are provided', () => {
    const devices = [d('a'), d('b')];
    expect(resolveDevice(devices, null, null)).toEqual(d('a'));
  });

  it('returns the first device when both selection and primary are missing from the list', () => {
    const devices = [d('a'), d('b')];
    expect(resolveDevice(devices, 'ghost', 'phantom')).toEqual(d('a'));
  });

  it('treats undefined selectedId and primaryId like null', () => {
    const devices = [d('a'), d('b')];
    expect(resolveDevice(devices, undefined, undefined)).toEqual(d('a'));
  });
});

describe('shouldShowDeviceDropdown', () => {
  it('returns false when devices is undefined', () => {
    expect(shouldShowDeviceDropdown(undefined)).toBe(false);
  });

  it('returns false when devices is empty', () => {
    expect(shouldShowDeviceDropdown([])).toBe(false);
  });

  it('returns false when there is exactly one device', () => {
    expect(shouldShowDeviceDropdown([{ id: 'a' }])).toBe(false);
  });

  it('returns true when there are two or more devices', () => {
    expect(shouldShowDeviceDropdown([{ id: 'a' }, { id: 'b' }])).toBe(true);
    expect(shouldShowDeviceDropdown([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toBe(true);
  });
});

describe('unionIds', () => {
  it('returns an empty array for no lists', () => {
    expect(unionIds([])).toEqual([]);
  });

  it('de-duplicates ids across lists, preserving first-seen order', () => {
    expect(unionIds([['a', 'b'], ['b', 'c'], ['a', 'd']])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles empty inner lists', () => {
    expect(unionIds([[], ['x'], []])).toEqual(['x']);
  });
});

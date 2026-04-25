/**
 * @jest-environment jsdom
 *
 * Unit tests for `useSelectedRoost` — URL-synced selection state for the
 * roost detail panel. Verifies push-only history semantics so the browser
 * back button reliably closes the panel.
 */
import { act, renderHook } from '@testing-library/react';

const pushMock = jest.fn();
const replaceMock = jest.fn();
let mockSearchParams = new URLSearchParams();
let mockPathname = '/roosts';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => mockPathname,
}));

import { useSelectedRoost } from '@/hooks/useSelectedRoost';

beforeEach(() => {
  pushMock.mockClear();
  replaceMock.mockClear();
  mockSearchParams = new URLSearchParams();
  mockPathname = '/roosts';
});

describe('useSelectedRoost — read', () => {
  it('reads `roost` param from the URL', () => {
    mockSearchParams = new URLSearchParams('roost=abc');
    const { result } = renderHook(() => useSelectedRoost());
    expect(result.current.selectedRoostId).toBe('abc');
  });

  it('returns null when the `roost` param is empty', () => {
    mockSearchParams = new URLSearchParams('roost=');
    const { result } = renderHook(() => useSelectedRoost());
    expect(result.current.selectedRoostId).toBeNull();
  });

  it('returns null when the `roost` param is whitespace only', () => {
    mockSearchParams = new URLSearchParams('roost=%20%20');
    const { result } = renderHook(() => useSelectedRoost());
    expect(result.current.selectedRoostId).toBeNull();
  });
});

describe('useSelectedRoost — write', () => {
  it('setSelectedRoostId(id) pushes the path with `?roost=<id>`', () => {
    const { result } = renderHook(() => useSelectedRoost());
    act(() => {
      result.current.setSelectedRoostId('abc');
    });
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][0]).toBe('/roosts?roost=abc');
  });

  it('setSelectedRoostId(null) pushes the path without the `roost` param', () => {
    mockSearchParams = new URLSearchParams('roost=abc');
    const { result } = renderHook(() => useSelectedRoost());
    act(() => {
      result.current.setSelectedRoostId(null);
    });
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][0]).toBe('/roosts');
  });

  it('never calls router.replace', () => {
    mockSearchParams = new URLSearchParams('roost=abc');
    const { result } = renderHook(() => useSelectedRoost());
    act(() => {
      result.current.setSelectedRoostId('x');
    });
    act(() => {
      result.current.setSelectedRoostId(null);
    });
    expect(replaceMock).not.toHaveBeenCalled();
  });
});

/** @jest-environment node */

import {
  collectFilteredPage,
  nextPageTokenFromDocs,
  parsePagination,
  withPaginationFields,
} from '@/lib/pagination';

describe('pagination helpers', () => {
  it('prefers canonical page params over legacy aliases', () => {
    const params = new URLSearchParams({
      page_size: '7',
      page_token: 'canonical-token',
      limit: '3',
      cursor: 'legacy-token',
    });

    const parsed = parsePagination(params, { defaultPageSize: 20 });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.pagination).toEqual({
        pageSize: 7,
        pageToken: 'canonical-token',
      });
    }
  });

  it('accepts legacy limit/cursor aliases', () => {
    const params = new URLSearchParams({
      limit: '3',
      cursor: 'legacy-token',
    });

    const parsed = parsePagination(params, { defaultPageSize: 20 });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.pagination).toEqual({
        pageSize: 3,
        pageToken: 'legacy-token',
      });
    }
  });

  it('rejects non-positive, non-integer, and over-max page sizes', () => {
    for (const pageSize of ['0', '-1', '1.5', '101']) {
      const parsed = parsePagination(new URLSearchParams({ page_size: pageSize }), {
        defaultPageSize: 20,
        maxPageSize: 100,
      });

      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.response.status).toBe(400);
    }
  });

  it('emits both canonical and legacy response token fields', () => {
    expect(withPaginationFields({ users: [] }, 'next-token')).toEqual({
      users: [],
      next_page_token: 'next-token',
      nextPageToken: 'next-token',
    });
  });

  it('uses the last emitted doc as the next token when overfetching', () => {
    expect(
      nextPageTokenFromDocs(
        [{ id: 'doc-1' }, { id: 'doc-2' }, { id: 'doc-3' }],
        2,
      ),
    ).toBe('doc-2');
  });

  it('keeps filtered docs out of next token semantics', async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'visible-1', hidden: false },
        { id: 'hidden-1', hidden: true },
      ])
      .mockResolvedValueOnce([{ id: 'visible-2', hidden: false }]);

    const page = await collectFilteredPage({
      pageSize: 1,
      pageToken: null,
      fetchPage,
      include: (doc) => !doc.hidden,
    });

    expect(page.docs).toEqual([{ id: 'visible-1', hidden: false }]);
    expect(page.nextPageToken).toBe('visible-1');
    expect(fetchPage).toHaveBeenLastCalledWith('hidden-1', 2);
  });
});

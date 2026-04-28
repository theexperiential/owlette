import type { NextResponse } from 'next/server';

import { problemValidation } from '@/lib/apiErrors';

export interface PaginationOptions {
  defaultPageSize: number;
  maxPageSize?: number;
  allowLegacyAliases?: boolean;
}

export interface Pagination {
  pageSize: number;
  pageToken: string | null;
}

export type PaginationParseResult =
  | { ok: true; pagination: Pagination }
  | { ok: false; response: NextResponse };

const DEFAULT_MAX_PAGE_SIZE = 100;

export function parsePagination(
  searchParams: URLSearchParams,
  options: PaginationOptions,
): PaginationParseResult {
  const maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;
  const allowLegacyAliases = options.allowLegacyAliases ?? true;

  const canonicalPageSize = searchParams.get('page_size');
  const legacyPageSize = allowLegacyAliases
    ? searchParams.get('limit')
    : null;
  const pageSizeParam = canonicalPageSize ?? legacyPageSize;
  const pageSizeParamName = canonicalPageSize !== null ? 'page_size' : 'limit';
  const pageSizeRaw =
    pageSizeParam === null ? options.defaultPageSize : Number(pageSizeParam);

  if (
    pageSizeParam !== null &&
    (!Number.isFinite(pageSizeRaw) ||
      !Number.isInteger(pageSizeRaw) ||
      pageSizeRaw < 1 ||
      pageSizeRaw > maxPageSize)
  ) {
    return {
      ok: false,
      response: problemValidation(
        `${pageSizeParamName} must be a positive integer`,
        {
          [`query.${pageSizeParamName}`]: [
            `must be a positive integer <= ${maxPageSize}`,
          ],
        },
      ),
    };
  }

  const pageSize = Math.min(
    pageSizeParam === null ? options.defaultPageSize : pageSizeRaw,
    maxPageSize,
  );
  const pageToken =
    searchParams.get('page_token') ??
    (allowLegacyAliases ? searchParams.get('cursor') : null);

  return { ok: true, pagination: { pageSize, pageToken } };
}

export function withPaginationFields<T extends Record<string, unknown>>(
  body: T,
  nextPageToken: string,
): T & { next_page_token: string; nextPageToken: string } {
  return {
    ...body,
    next_page_token: nextPageToken,
    nextPageToken,
  };
}

export function nextPageTokenFromDocs(
  docs: Array<{ id: string }>,
  pageSize: number,
): string {
  if (docs.length <= pageSize) return '';
  return docs[Math.max(0, pageSize - 1)]?.id ?? '';
}

export interface FilteredPageOptions<TDoc extends { id: string }> {
  pageSize: number;
  pageToken: string | null;
  fetchPage: (pageToken: string | null, limit: number) => Promise<TDoc[]>;
  include: (doc: TDoc) => boolean;
  batchLimit?: number;
}

export async function collectFilteredPage<TDoc extends { id: string }>(
  options: FilteredPageOptions<TDoc>,
): Promise<{ docs: TDoc[]; nextPageToken: string }> {
  const batchLimit = options.batchLimit ?? options.pageSize + 1;
  const emitted: TDoc[] = [];
  let cursor = options.pageToken;

  for (;;) {
    const batch = await options.fetchPage(cursor, batchLimit);
    if (batch.length === 0) break;

    for (const doc of batch) {
      if (options.include(doc)) emitted.push(doc);
      if (emitted.length > options.pageSize) {
        const docs = emitted.slice(0, options.pageSize);
        return {
          docs,
          nextPageToken: docs[docs.length - 1]?.id ?? '',
        };
      }
    }

    if (batch.length < batchLimit) break;
    cursor = batch[batch.length - 1]?.id ?? null;
  }

  return { docs: emitted, nextPageToken: '' };
}

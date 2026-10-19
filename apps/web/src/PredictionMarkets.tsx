import type { PolymarketCatalog, PolymarketOrderBook } from '@honey-wallet/api-client';
import { useEffect, useState } from 'react';
import { api } from './lib/api';

export default function PredictionMarkets() {
  const [catalog, setCatalog] = useState<PolymarketCatalog | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [books, setBooks] = useState<Record<string, PolymarketOrderBook | null>>({});
  const [bookLoading, setBookLoading] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState(false);
  const [pageRestarted, setPageRestarted] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .polymarketCatalog({ signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setCatalog(result);
        setState('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('error');
      });
    return () => controller.abort();
  }, []);

  const loadBook = async (tokenId: string) => {
    setBookLoading(tokenId);
    try {
      const book = await api.polymarketOrderBook(tokenId);
      setBooks((current) => ({ ...current, [tokenId]: book }));
    } catch {
      setBooks((current) => ({ ...current, [tokenId]: null }));
    } finally {
      setBookLoading(null);
    }
  };

  const loadMore = async () => {
    if (!catalog?.nextCursor || pageLoading) return;
    setPageLoading(true);
    setPageError(false);
    try {
      const page = await api.polymarketCatalog(undefined, catalog.nextCursor);
      if (page.fetchedAtMs !== catalog.fetchedAtMs) {
        // Offsets are valid only for the snapshot that issued the cursor.
        // Restart from page one rather than append rows from a different snapshot.
        const firstPage = await api.polymarketCatalog();
        setCatalog(firstPage);
        setPageRestarted(true);
      } else {
        setCatalog((current) => {
          if (!current || current.fetchedAtMs !== page.fetchedAtMs) return page;
          const ids = new Set(current.markets.map((market) => market.id));
          return {
            ...page,
            markets: [...current.markets, ...page.markets.filter((market) => !ids.has(market.id))],
          };
        });
        setPageRestarted(false);
      }
    } catch {
      setPageError(true);
    } finally {
      setPageLoading(false);
    }
  };

  return (
    <section aria-label="Prediction market discovery">
      <h2>Prediction markets</h2>
      <p role="status">
        {state === 'loading'
          ? 'Loading public market data…'
          : state === 'error'
            ? 'Public market data is unavailable.'
            : `${catalog?.markets.length ?? 0} public markets · read only${catalog?.sourceTruncated ? ' · discovery capped' : ''}`}
      </p>
      <ul>
        {catalog?.markets.map((market) => (
          <li key={market.id}>
            <strong>{market.question ?? 'Untitled market'}</strong>
            <p>
              {market.version?.toUpperCase() ?? 'Protocol version unknown'} ·{' '}
              {market.outcomeTokenIds.length + market.positionIds.length} outcome identifiers
              {!market.active || market.closed ? ' · not active' : ''}
            </p>
            {market.slug && (
              <a
                href={`https://polymarket.com/event/${encodeURIComponent(market.slug)}`}
                target="_blank"
                rel="noreferrer"
              >
                View on Polymarket
              </a>
            )}
            {market.orderBookEnabled && market.active && !market.closed
              ? market.outcomeTokenIds.map((tokenId, index) => (
                  <div key={tokenId}>
                    <button
                      type="button"
                      disabled={bookLoading === tokenId}
                      onClick={() => void loadBook(tokenId)}
                    >
                      {bookLoading === tokenId ? 'Loading book…' : `View outcome ${index + 1} book`}
                    </button>
                    {tokenId in books ? (
                      books[tokenId] ? (
                        <p role="status">
                          {books[tokenId]?.dataStatus} book · best bid{' '}
                          {books[tokenId]?.book.bids[0]?.price ?? '—'} · best ask{' '}
                          {books[tokenId]?.book.asks[0]?.price ?? '—'}
                        </p>
                      ) : (
                        <p role="status">Order book is unavailable.</p>
                      )
                    ) : null}
                  </div>
                ))
              : null}
          </li>
        ))}
      </ul>
      {catalog?.nextCursor ? (
        <button type="button" disabled={pageLoading} onClick={() => void loadMore()}>
          {pageLoading ? 'Loading more markets…' : 'Load more markets'}
        </button>
      ) : null}
      {pageError ? <p role="status">More public markets are unavailable.</p> : null}
      {pageRestarted ? (
        <p role="status">
          The market list refreshed. Pagination restarted from the latest snapshot.
        </p>
      ) : null}
      <p>
        Public books and market metadata only. Eligibility, balances, and order execution are
        unavailable.
      </p>
    </section>
  );
}

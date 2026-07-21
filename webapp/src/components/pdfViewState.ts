export function getNextPage(currentPage: number, numPages: number | null): number {
  if (!Number.isFinite(currentPage) || currentPage <= 0) {
    return 1;
  }

  if (numPages === null || numPages <= 0) {
    return currentPage;
  }

  return Math.min(currentPage + 1, numPages);
}

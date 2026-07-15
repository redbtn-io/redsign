export function getPdfUrlFromQuery(search: string): string | null {
  return new URLSearchParams(search).get('doc');
}

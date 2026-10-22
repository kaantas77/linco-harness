export interface PageSnapshot {
  url: string;
  status: number;
  text: string;
  truncated: boolean;
}

export interface BrowserProvider {
  readonly id: string;
  fetchPage(url: string, signal?: AbortSignal): Promise<PageSnapshot>;
}

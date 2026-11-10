// A cookie in the Playwright storageState format.
export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
};

export type StorageState = { cookies: Cookie[]; origins?: unknown[] };

import { existsSync, readFileSync } from 'fs';

export function loadOwnAccountNames(): string[] {
  const path = process.env.OWN_ACCOUNTS_CONFIG || './.own-accounts.json';
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(data)) return [];
    return data.filter((name): name is string => typeof name === 'string' && name.trim() !== '');
  } catch {
    return [];
  }
}

export function isOwnAccountMerchant(
  merchant: string,
  names: string[] = loadOwnAccountNames()
): boolean {
  const raw = merchant.toLowerCase().trim();
  const stripped = raw.replace(/^(to|from)\s+/, '');
  return names.some(name => {
    const needle = name.toLowerCase().trim();
    return needle !== '' && (raw === needle || stripped === needle);
  });
}

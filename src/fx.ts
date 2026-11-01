import { DB } from './db.js';
import { FxRate } from './types.js';

export class FxConverter {
  constructor(private db: DB) {}

  async convertToCHF(
    amount: number,
    currency: string,
    date: string
  ): Promise<{ chfAmount: number; rate?: number; rateDate?: string; failed?: boolean }> {
    if (currency === 'CHF') {
      return { chfAmount: amount };
    }

    const rate = await this.getRate(date, currency);
    if (!rate) {
      return { chfAmount: amount, failed: true };
    }

    return {
      chfAmount: amount / rate.rateFromCHF,
      rate: rate.rateFromCHF,
      rateDate: rate.date,
    };
  }

  private async getRate(date: string, currency: string): Promise<FxRate | null> {
    const cached = this.db.getFxRate(date, currency);
    if (cached) {
      return cached;
    }

    const fetched = await this.fetchRate(date, currency);
    if (fetched) {
      this.db.saveFxRate(fetched);
      return fetched;
    }

    const fallback = await this.fetchRateWithFallback(date, currency);
    if (fallback) {
      this.db.saveFxRate(fallback);
      return fallback;
    }

    return null;
  }

  private async fetchRate(date: string, currency: string): Promise<FxRate | null> {
    try {
      const url = `https://api.frankfurter.app/${date}?from=CHF&to=${currency}`;
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as any;
      if (!data.rates || !data.rates[currency]) {
        return null;
      }

      return {
        date: data.date,
        currency,
        rateFromCHF: data.rates[currency],
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error(`Failed to fetch FX rate for ${currency} on ${date}:`, error);
      return null;
    }
  }

  private async fetchRateWithFallback(date: string, currency: string): Promise<FxRate | null> {
    const dateObj = new Date(date);
    for (let i = 1; i <= 7; i++) {
      dateObj.setDate(dateObj.getDate() - 1);
      const fallbackDate = dateObj.toISOString().split('T')[0];
      const rate = await this.fetchRate(fallbackDate, currency);
      if (rate) {
        return { ...rate, date };
      }
    }
    return null;
  }
}

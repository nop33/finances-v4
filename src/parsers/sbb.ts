import { ParsedTransaction } from '../types.js';
import { normalizeAmount, parseDate } from './utils.js';

interface ParseResult {
  orderNumber?: string;
  travelDate?: string;
  amount?: number;
  paymentMethod?: string;
  firstItem?: string;
}

export function parseSbb(content: string): ParsedTransaction[] {
  const lines = content.split(/\r?\n/);
  const result: ParseResult = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Extract travel date from subject line
    if (!result.travelDate) {
      // English: "your journey on" or "your journeys on"
      const englishMatch = line.match(/your journeys? on (\d{2}\.\d{2}\.\d{4})/i);
      if (englishMatch) {
        result.travelDate = parseDate(englishMatch[1], 'DD.MM.YYYY');
      }
      
      // German: "Ihre Fahrt am" or "Ihre Fahrten am"
      const germanMatch = line.match(/Ihre Fahrten? am (\d{2}\.\d{2}\.\d{4})/i);
      if (germanMatch) {
        result.travelDate = parseDate(germanMatch[1], 'DD.MM.YYYY');
      }
    }

    // Extract order number (on same line)
    if (!result.orderNumber) {
      const orderMatch = line.match(/^(?:Order number|Bestellnummer)\s+(\d+)/i);
      if (orderMatch) {
        result.orderNumber = orderMatch[1];
      }
    }

    // Extract amount (value on next line)
    if (!result.amount && line.match(/^(?:Amount|Betrag)$/i) && i + 1 < lines.length) {
      const amountLine = lines[i + 1].trim();
      const amountMatch = amountLine.match(/CHF\s+([\d.]+)/);
      if (amountMatch) {
        result.amount = parseFloat(amountMatch[1]);
      }
    }

    // Extract total (preferred over Amount, value on next line)
    if (line.match(/^Total$/i) && i + 1 < lines.length) {
      const totalLine = lines[i + 1].trim();
      const totalMatch = totalLine.match(/CHF\s+([\d.]+)/);
      if (totalMatch) {
        result.amount = parseFloat(totalMatch[1]);
      }
    }

    // Extract payment method (value on next line)
    if (!result.paymentMethod && line.match(/^(?:Payment method|Zahlungsart)$/i) && i + 1 < lines.length) {
      result.paymentMethod = lines[i + 1].trim();
    }

    // Extract first item (looking for item label followed by content)
    if (!result.firstItem && line.match(/^Item$/i)) {
      // Look ahead for next non-empty line
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (nextLine) {
          result.firstItem = nextLine;
          break;
        }
      }
    }
  }

  // Validate required fields
  if (!result.orderNumber || !result.amount) {
    throw new Error('Missing required fields: orderNumber or amount');
  }

  if (!result.travelDate) {
    throw new Error('Missing travel date from receipt');
  }

  // Build merchant name with order number for stable ID
  let merchant = 'SBB EasyRide';
  if (result.firstItem) {
    merchant += ` - ${result.firstItem}`;
  }
  // Include order number for stable ID generation
  merchant += ` [${result.orderNumber}]`;

  return [{
    date: result.travelDate,
    merchant,
    description: result.paymentMethod,
    originalAmount: normalizeAmount(result.amount),
    originalCurrency: 'CHF',
    source: 'sbb',
    fileRowIndex: 0,
  }];
}

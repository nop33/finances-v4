import { readFileSync } from 'fs';
import { ParsedTransaction } from '../types.js';
import { detectFormat } from './detect.js';
import { parseCembra } from './cembra.js';
import { parseSwisscard } from './swisscard.js';
import { parseNeon } from './neon.js';
import { parseRevolutCsv, parseRevolutXlsx } from './revolut.js';
import { parseSbb } from './sbb.js';

export function parseFile(filepath: string): ParsedTransaction[] {
  let content: string | Buffer;

  if (filepath.endsWith('.xlsx')) {
    content = readFileSync(filepath);
  } else {
    content = readFileSync(filepath, 'utf-8');
  }

  const format = detectFormat(content, filepath);

  switch (format) {
    case 'cembra':
      return parseCembra(content as string);
    case 'swisscard':
      return parseSwisscard(content as string);
    case 'neon':
      return parseNeon(content as string);
    case 'revolut-csv':
      return parseRevolutCsv(content as string);
    case 'revolut-xlsx':
      return parseRevolutXlsx(content as Buffer);
    case 'sbb':
      return parseSbb(content as string);
    default:
      throw new Error(`Unknown format for file: ${filepath}`);
  }
}

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { DB } from './db.js';
import { correctTransaction, categorizeTransaction } from './categorize.js';
import { loadCategories } from './categories.js';
import { splitTransaction } from './split.js';
import { Transaction, Category, TransactionSplit } from './types.js';
import crypto from 'crypto';

const REVIEW_COOKIE = 'review_token';

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.trim().indexOf('=');
    if (eq === -1) continue;
    const key = part.trim().slice(0, eq);
    if (key !== name) continue;
    const raw = part.trim().slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

export function validateReviewToken(token: string | undefined): string {
  if (!token) {
    throw new Error('REVIEW_TOKEN is required to start the review server');
  }
  if (token.length < 24) {
    throw new Error('REVIEW_TOKEN must be at least 24 characters');
  }
  return token;
}

function requestIsHttps(req: IncomingMessage): boolean {
  if (req.socket && (req.socket as any).encrypted) return true;
  const raw = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(raw) ? raw[0] : raw || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim();
  return first || req.socket?.remoteAddress || 'unknown';
}

function sessionCookie(id: string, req: IncomingMessage, maxAge = 2592000): string {
  let cookie = `${REVIEW_COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  if (requestIsHttps(req)) cookie += '; Secure';
  return cookie;
}

function escapeHtml(text: string | undefined | null): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

interface ReviewQueueOptions {
  month: string;
  mode: 'full' | 'exceptions';
}

interface UndoState {
  transactionId: string;
  previousCategory: string;
  previousConfidence: number;
  previousExplanation: string;
  previousCategorizationSource: 'merchant_memory' | 'rule' | 'unknown';
  previousReviewed: boolean;
  timestamp: number;
}

export class WebServer {
  private db: DB;
  private categories: Category[];
  private undoStack: UndoState[] = [];
  private sessions = new Set<string>();
  private loginFailures = new Map<string, number[]>();

  constructor(db: DB) {
    this.db = db;
    this.categories = loadCategories();
  }

  createSession(): string {
    const id = crypto.randomBytes(24).toString('hex');
    this.sessions.add(id);
    return id;
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const sid = cookieValue(req, REVIEW_COOKIE);
    return !!sid && this.sessions.has(sid);
  }

  private loginAllowed(ip: string, now = Date.now()): boolean {
    const times = (this.loginFailures.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
    this.loginFailures.set(ip, times);
    return times.length < LOGIN_MAX_FAILURES;
  }

  private recordLoginFailure(ip: string, now = Date.now()): void {
    const times = (this.loginFailures.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
    times.push(now);
    this.loginFailures.set(ip, times);
  }

  getReviewQueue(options: ReviewQueueOptions): Transaction[] {
    const transactions = this.db.getTransactionsByMonth(options.month);
    
    // Exclude transactions covered by fixed bills
    const uncovered = transactions.filter(tx => !tx.coveredByFixedBill);
    
    if (options.mode === 'full') {
      // All unreviewed transactions
      return uncovered.filter(tx => !tx.reviewed);
    } else {
      // Only low-confidence or flagged transactions
      return uncovered.filter(tx => 
        !tx.reviewed && (
          (tx.confidence || 0) < 0.7 ||
          tx.newMerchant ||
          tx.unusualAmount ||
          tx.possibleDuplicate ||
          tx.unconvertedFx ||
          tx.fixedMissing ||
          tx.fixedChanged
        )
      );
    }
  }

  getTransactionsList(month: string, filters?: {
    text?: string;
    category?: string;
    source?: string;
    flag?: string;
  }): Transaction[] {
    let transactions = this.db.getTransactionsByMonth(month);
    
    if (filters?.text) {
      const searchLower = filters.text.toLowerCase();
      transactions = transactions.filter(tx =>
        tx.merchant.toLowerCase().includes(searchLower) ||
        (tx.description?.toLowerCase().includes(searchLower))
      );
    }
    
    if (filters?.category) {
      transactions = transactions.filter(tx => tx.category === filters.category);
    }
    
    if (filters?.source) {
      transactions = transactions.filter(tx => tx.source === filters.source);
    }
    
    if (filters?.flag) {
      transactions = transactions.filter(tx => {
        switch (filters.flag) {
          case 'newMerchant': return tx.newMerchant;
          case 'unusualAmount': return tx.unusualAmount;
          case 'possibleDuplicate': return tx.possibleDuplicate;
          case 'unconvertedFx': return tx.unconvertedFx;
          case 'fixedMissing': return tx.fixedMissing;
          case 'fixedChanged': return tx.fixedChanged;
          default: return true;
        }
      });
    }
    
    return transactions;
  }

  acceptTransaction(id: string): void {
    const tx = this.db.getTransaction(id);
    if (!tx) {
      throw new Error(`Transaction ${id} not found`);
    }
    
    // Save undo state
    this.undoStack.push({
      transactionId: id,
      previousCategory: tx.category || '',
      previousConfidence: tx.confidence || 0,
      previousExplanation: tx.explanation || '',
      previousCategorizationSource: tx.categorizationSource || 'unknown',
      previousReviewed: tx.reviewed || false,
      timestamp: Date.now()
    });
    
    this.db.markAsReviewed(id);
  }

  correctTransactionViaWeb(id: string, category: string): void {
    const tx = this.db.getTransaction(id);
    if (!tx) {
      throw new Error(`Transaction ${id} not found`);
    }
    
    // Save undo state
    this.undoStack.push({
      transactionId: id,
      previousCategory: tx.category || '',
      previousConfidence: tx.confidence || 0,
      previousExplanation: tx.explanation || '',
      previousCategorizationSource: tx.categorizationSource || 'unknown',
      previousReviewed: tx.reviewed || false,
      timestamp: Date.now()
    });
    
    // Use the same code path as CLI correct
    correctTransaction(this.db, id, category);
  }

  undo(): boolean {
    const state = this.undoStack.pop();
    if (!state) {
      return false;
    }
    
    // Restore previous state
    this.db.updateTransactionCategorization(
      state.transactionId,
      state.previousCategory,
      state.previousConfidence,
      state.previousExplanation,
      state.previousCategorizationSource,
      {
        newMerchant: false,
        unusualAmount: false,
        possibleDuplicate: false,
        unconvertedFx: false
      }
    );
    
    // Restore reviewed state
    if (!state.previousReviewed) {
      const stmt = (this.db as any).db.prepare(`
        UPDATE transactions SET reviewed = 0 WHERE id = ?
      `);
      stmt.run(state.transactionId);
    }
    
    return true;
  }

  getCategories(): Array<{ group: string; categories: Array<{ full: string; leaf: string }> }> {
    const grouped = new Map<string, Array<{ full: string; leaf: string }>>();
    
    for (const cat of this.categories) {
      if (!grouped.has(cat.group)) {
        grouped.set(cat.group, []);
      }
      grouped.get(cat.group)!.push({
        full: `${cat.group}/${cat.leaf}`,
        leaf: cat.leaf
      });
    }
    
    return Array.from(grouped.entries()).map(([group, categories]) => ({
      group,
      categories
    }));
  }

  handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (url.pathname === '/login' && req.method === 'POST') {
        this.handleLogin(req, res);
        return;
      }
      if (url.pathname === '/logout' && (req.method === 'GET' || req.method === 'POST')) {
        this.handleLogout(req, res);
        return;
      }

      const isApi = url.pathname.startsWith('/api/');
      const isPage = url.pathname === '/' || url.pathname === '' || url.pathname === '/review'
        || url.pathname === '/transactions' || url.pathname === '/twint';
      if (!this.isAuthorized(req)) {
        if (isApi) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        if (isPage) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(this.getLoginPageHTML());
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      if (url.pathname === '/api/categories' && req.method === 'GET') {
        this.handleGetCategories(req, res);
      } else if (url.pathname === '/api/review-queue' && req.method === 'POST') {
        this.handleReviewQueue(req, res);
      } else if (url.pathname === '/api/transactions' && req.method === 'POST') {
        this.handleTransactions(req, res);
      } else if (url.pathname === '/api/accept' && req.method === 'POST') {
        this.handleAccept(req, res);
      } else if (url.pathname === '/api/correct' && req.method === 'POST') {
        this.handleCorrect(req, res);
      } else if (url.pathname === '/api/split' && req.method === 'POST') {
        this.handleSplit(req, res);
      } else if (url.pathname === '/api/undo' && req.method === 'POST') {
        this.handleUndo(req, res);
      } else if (url.pathname === '/api/twint' && req.method === 'POST') {
        this.handleAddTwint(req, res);
      } else if (url.pathname === '/api/twint' && req.method === 'GET') {
        this.handleGetTwint(req, res, url);
      } else if (url.pathname.startsWith('/api/twint/') && req.method === 'DELETE') {
        this.handleDeleteTwint(req, res, url);
      } else if (url.pathname === '/review') {
        this.handleReviewPage(req, res);
      } else if (url.pathname === '/transactions') {
        this.handleTransactionsPage(req, res);
      } else if (url.pathname === '/twint') {
        this.handleTwintPage(req, res);
      } else if (url.pathname === '/' || url.pathname === '') {
        this.handleIndexPage(req, res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    } catch (error: any) {
      console.error('Error handling request:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  private handleGetCategories(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.getCategories()));
  }

  private readJson(req: IncomingMessage, res: ServerResponse, fn: (parsed: any) => void): void {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        fn(parsed);
      } catch (error: any) {
        if (error instanceof SyntaxError) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      }
    });
  }

  private handleLogin(req: IncomingMessage, res: ServerResponse): void {
    this.readJson(req, res, (parsed) => {
      const ip = clientIp(req);
      if (!this.loginAllowed(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many login attempts' }));
        return;
      }
      const token = typeof parsed.token === 'string' ? parsed.token : '';
      const expected = process.env.REVIEW_TOKEN || '';
      const a = Buffer.from(token);
      const b = Buffer.from(expected);
      const ok = !!expected && a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!ok) {
        this.recordLoginFailure(ip);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const sid = this.createSession();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': sessionCookie(sid, req)
      });
      res.end(JSON.stringify({ success: true }));
    });
  }

  private handleLogout(req: IncomingMessage, res: ServerResponse): void {
    const sid = cookieValue(req, REVIEW_COOKIE);
    if (sid) this.sessions.delete(sid);
    const headers = {
      'Content-Type': req.method === 'GET' ? 'text/html' : 'application/json',
      'Set-Cookie': sessionCookie('', req, 0)
    };
    res.writeHead(200, headers);
    res.end(req.method === 'GET' ? this.getLoginPageHTML() : JSON.stringify({ success: true }));
  }

  private handleReviewQueue(req: IncomingMessage, res: ServerResponse): void {
    this.readJson(req, res, (parsed) => {
      const month = parsed.month;
      const mode = parsed.mode || 'full';
      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid month parameter' }));
        return;
      }
      if (mode !== 'full' && mode !== 'exceptions') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid mode parameter' }));
        return;
      }
      const queue = this.getReviewQueue({ month, mode });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(queue));
    });
  }

  private handleTransactions(req: IncomingMessage, res: ServerResponse): void {
    this.readJson(req, res, (parsed) => {
      const month = parsed.month;
      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid month parameter' }));
        return;
      }
      const filters = {
        text: typeof parsed.text === 'string' ? parsed.text : undefined,
        category: typeof parsed.category === 'string' ? parsed.category : undefined,
        source: typeof parsed.source === 'string' ? parsed.source : undefined,
        flag: typeof parsed.flag === 'string' ? parsed.flag : undefined,
      };
      const transactions = this.getTransactionsList(month, filters);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(transactions));
    });
  }

  private handleSplit(req: IncomingMessage, res: ServerResponse): void {
    this.readJson(req, res, (parsed) => {
      const { id, parts } = parsed;
      if (!id || !Array.isArray(parts)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing id or parts' }));
        return;
      }
      const splits: TransactionSplit[] = parts.map((p: any) => ({
        category: String(p.category || ''),
        chfAmount: Number(p.chfAmount)
      }));
      splitTransaction(this.db, id, splits);
      this.acceptTransaction(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  }

  private handleAccept(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const { id } = parsed;
        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing id parameter' }));
          return;
        }
        this.acceptTransaction(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error: any) {
        if (error instanceof SyntaxError) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      }
    });
  }

  private handleCorrect(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const { id, category } = parsed;
        if (!id || !category) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing id or category parameter' }));
          return;
        }
        this.correctTransactionViaWeb(id, category);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error: any) {
        if (error instanceof SyntaxError) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      }
    });
  }

  private handleUndo(req: IncomingMessage, res: ServerResponse): void {
    const success = this.undo();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success }));
  }

  private handleAddTwint(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const { date, merchant, amount, note, category } = parsed;

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or missing date (must be YYYY-MM-DD)' }));
          return;
        }

        if (!merchant || typeof merchant !== 'string' || merchant.trim() === '') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or missing merchant' }));
          return;
        }

        if (typeof amount !== 'number' || amount <= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid amount (must be positive number)' }));
          return;
        }

        if (note !== undefined && typeof note !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid note (must be string)' }));
          return;
        }

        const id = `twi-${crypto.randomUUID()}`;
        const yearMonth = date.substring(0, 7);

        const transaction: Transaction = {
          id,
          date,
          source: 'twint',
          merchant: merchant.trim(),
          description: note?.trim(),
          originalAmount: amount,
          originalCurrency: 'CHF',
          chfAmount: amount,
          fileRowIndex: 0,
          importedAt: new Date().toISOString(),
        };

        this.db.insertTransaction(transaction);

        if (typeof category === 'string' && category.trim()) {
          this.db.updateTransactionCategorization(
            id,
            category.trim(),
            1,
            'manual',
            'rule',
            { newMerchant: false, unusualAmount: false, possibleDuplicate: false, unconvertedFx: false }
          );
          this.db.markAsReviewed(id);
        } else {
          const allTransactions = this.db.getTransactionsByMonth(yearMonth);
          const categorized = categorizeTransaction(transaction, this.db, allTransactions);
          this.db.updateTransactionCategorization(
            id,
            categorized.category,
            categorized.confidence,
            categorized.explanation,
            categorized.source,
            categorized.anomalies
          );
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, id }));
      } catch (error: any) {
        if (error instanceof SyntaxError) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      }
    });
  }

  private handleGetTwint(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const month = url.searchParams.get('month') || new Date().toISOString().substring(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid month parameter' }));
      return;
    }
    const transactions = this.db.getTransactionsByMonth(month);
    const twintTransactions = transactions.filter(t => t.source === 'twint');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(twintTransactions));
  }

  private handleDeleteTwint(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const id = url.pathname.substring('/api/twint/'.length);
    
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing transaction id' }));
      return;
    }

    const tx = this.db.getTransaction(id);
    
    if (!tx) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Transaction not found' }));
      return;
    }

    if (tx.source !== 'twint') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Can only delete twint transactions' }));
      return;
    }

    this.db.deleteTransaction(id);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  private handleReviewPage(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(this.getReviewPageHTML());
  }

  private handleTransactionsPage(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(this.getTransactionsPageHTML());
  }

  private handleTwintPage(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(this.getTwintPageHTML());
  }

  private handleIndexPage(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(this.getIndexPageHTML());
  }

  private getLoginPageHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Review login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      padding: 24px 16px;
      padding-bottom: max(24px, env(safe-area-inset-bottom));
      min-height: 100vh;
    }
    .container { max-width: 390px; margin: 48px auto 0; }
    h1 { font-size: 24px; margin-bottom: 8px; color: #333; }
    p { font-size: 15px; color: #666; margin-bottom: 24px; }
    input {
      width: 100%;
      padding: 16px;
      border: 1px solid #e0e0e0;
      border-radius: 12px;
      font-size: 16px;
      margin-bottom: 16px;
    }
    button {
      width: 100%;
      min-height: 52px;
      border: none;
      border-radius: 12px;
      font-size: 18px;
      font-weight: 600;
      background: #007AFF;
      color: white;
    }
    button:active { background: #0051D5; }
    .error { color: #FF3B30; font-size: 14px; margin-bottom: 12px; min-height: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Review access</h1>
    <p>Enter the review token to continue.</p>
    <div class="error" id="error"></div>
    <form id="login-form">
      <input type="password" id="token" autocomplete="current-password" placeholder="Access token" required>
      <button type="submit">Continue</button>
    </form>
  </div>
  <script>
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = document.getElementById('token').value;
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      if (res.ok) {
        location.href = '/';
      } else {
        document.getElementById('error').textContent = 'Wrong token';
      }
    });
  </script>
</body>
</html>`;
  }

  private getIndexPageHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Finances Review</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      padding: 16px;
      padding-bottom: max(16px, env(safe-area-inset-bottom));
    }
    .container { max-width: 390px; margin: 0 auto; }
    h1 { font-size: 24px; margin-bottom: 24px; color: #333; }
    .card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .card h2 { font-size: 18px; margin-bottom: 12px; color: #333; }
    .card p { font-size: 14px; color: #666; margin-bottom: 16px; }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 52px;
      padding: 14px;
      border: none;
      border-radius: 12px;
      font-size: 18px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      text-align: center;
      background: #007AFF;
      color: white;
    }
    .btn:active { background: #0051D5; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Finances Review</h1>
    
    <div class="card">
      <h2>Review Transactions</h2>
      <p>Swipe through unreviewed transactions for the month.</p>
      <a href="/review" class="btn">Start Review</a>
    </div>
    
    <div class="card">
      <h2>All Transactions</h2>
      <p>View and search all transactions for the month.</p>
      <a href="/transactions" class="btn">View All</a>
    </div>
    
    <div class="card">
      <h2>Twint Prepaid</h2>
      <p>Add Twint transactions manually (no export available).</p>
      <a href="/twint" class="btn">Add Twint</a>
    </div>
    <p style="text-align:center;margin-top:8px"><a href="/logout" style="color:#007AFF">Log out</a></p>
  </div>
</body>
</html>`;
  }

  private getReviewPageHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">
  <title>Review Transactions</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      overflow-x: hidden;
      min-height: 100vh;
      padding-bottom: calc(168px + env(safe-area-inset-bottom));
    }
    .header {
      position: sticky;
      top: 0;
      background: white;
      padding: 12px 16px;
      padding-top: max(12px, env(safe-area-inset-top));
      border-bottom: 1px solid #e0e0e0;
      z-index: 100;
    }
    .nav { display: flex; gap: 12px; margin-bottom: 8px; }
    .nav a { font-size: 14px; color: #007AFF; text-decoration: none; }
    .header h1 { font-size: 18px; color: #333; margin-bottom: 8px; }
    .controls { display: flex; gap: 8px; }
    .controls input, .controls select {
      flex: 1;
      padding: 10px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
    }
    .progress { font-size: 14px; color: #666; margin-top: 8px; }
    .card-container {
      position: relative;
      padding: 16px;
      min-height: 280px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.15);
      transition: transform 0.3s ease, opacity 0.3s ease;
      touch-action: none;
      max-width: 390px;
      margin: 0 auto;
    }
    .card.swiping { transition: none; }
    .card-date { font-size: 14px; color: #999; margin-bottom: 8px; }
    .card-merchant { font-size: 22px; font-weight: 600; color: #333; margin-bottom: 4px; }
    .card-source { font-size: 13px; color: #666; margin-bottom: 12px; }
    .card-amount { font-size: 32px; font-weight: 700; color: #000; margin-bottom: 12px; }
    .card-fx { font-size: 14px; color: #666; margin-bottom: 12px; }
    .card-category {
      font-size: 16px;
      color: #333;
      margin-bottom: 8px;
      padding: 10px 12px;
      background: #f0f0f0;
      border-radius: 8px;
    }
    .card-confidence { font-size: 14px; color: #666; margin-bottom: 8px; }
    .card-explanation { font-size: 15px; color: #555; margin-bottom: 12px; font-style: italic; }
    .flags { display: flex; flex-wrap: wrap; gap: 8px; }
    .flag {
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      background: #FF3B30;
      color: white;
    }
    .actions {
      position: fixed;
      left: 0; right: 0; bottom: 0;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      padding: 12px 16px;
      padding-bottom: max(12px, env(safe-area-inset-bottom));
      background: white;
      border-top: 1px solid #e0e0e0;
      z-index: 200;
    }
    .btn {
      min-height: 52px;
      border: none;
      border-radius: 12px;
      font-size: 17px;
      font-weight: 600;
    }
    .btn-keep { background: #34C759; color: white; }
    .btn-change { background: #FF9500; color: white; }
    .btn-split { background: #007AFF; color: white; }
    .btn-skip { background: #8E8E93; color: white; }
    .btn:active { opacity: 0.7; }
    .empty { text-align: center; padding: 48px 16px; color: #666; }
    .modal {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 1000;
      padding: 16px;
      overflow-y: auto;
    }
    .modal.active { display: flex; flex-direction: column; }
    .picker-content {
      background: white;
      border-radius: 16px;
      padding: 16px;
      max-width: 390px;
      width: 100%;
      margin: auto;
      max-height: 80vh;
      overflow-y: auto;
    }
    .picker-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .picker-header h2 { font-size: 18px; color: #333; }
    .picker-close {
      background: none; border: none; font-size: 28px; color: #666;
      width: 44px; height: 44px;
    }
    .picker-search, .split-row input {
      width: 100%;
      padding: 14px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      margin-bottom: 12px;
    }
    .category-group { margin-bottom: 16px; }
    .category-group-name { font-size: 14px; font-weight: 600; color: #666; margin-bottom: 8px; }
    .category-item, .split-cat {
      padding: 14px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      margin-bottom: 8px;
      min-height: 48px;
      background: white;
      font-size: 16px;
    }
    .split-row { display: grid; grid-template-columns: 1fr 90px; gap: 8px; margin-bottom: 8px; }
    .split-remaining { font-size: 14px; color: #666; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="nav">
      <a href="/">Home</a>
      <a href="/transactions">List</a>
      <a href="/twint">Twint</a>
    </div>
    <h1>Review</h1>
    <div class="controls">
      <input type="month" id="month-input">
      <select id="mode-input">
        <option value="full">All unreviewed</option>
        <option value="exceptions">Exceptions</option>
      </select>
    </div>
    <div class="progress" id="progress">Loading...</div>
  </div>

  <div class="card-container" id="card-container"></div>
  <div class="actions" id="actions" hidden>
    <button class="btn btn-keep" id="btn-keep">Keep</button>
    <button class="btn btn-change" id="btn-change">Change</button>
    <button class="btn btn-split" id="btn-split">Split</button>
    <button class="btn btn-skip" id="btn-skip">Skip</button>
  </div>

  <div class="modal" id="category-picker">
    <div class="picker-content">
      <div class="picker-header">
        <h2>Choose Category</h2>
        <button class="picker-close" onclick="closePicker()">&times;</button>
      </div>
      <input type="text" class="picker-search" id="picker-search" placeholder="Search categories...">
      <div id="category-list"></div>
    </div>
  </div>

  <div class="modal" id="split-modal">
    <div class="picker-content">
      <div class="picker-header">
        <h2>Split</h2>
        <button class="picker-close" onclick="closeSplit()">&times;</button>
      </div>
      <div class="split-remaining" id="split-remaining"></div>
      <div id="split-rows"></div>
      <button class="btn btn-split" style="width:100%;margin-bottom:8px" onclick="addSplitRow()">Add part</button>
      <button class="btn btn-keep" style="width:100%" onclick="submitSplit()">Save split</button>
    </div>
  </div>

  <script>
    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    const monthInput = document.getElementById('month-input');
    const modeInput = document.getElementById('mode-input');
    monthInput.value = localStorage.getItem('reviewMonth') || new Date().toISOString().substring(0, 7);
    modeInput.value = localStorage.getItem('reviewMode') || 'full';

    let transactions = [];
    let currentIndex = 0;
    let categories = [];
    let touchStartX = 0;
    let touchStartY = 0;
    let currentCard = null;
    let pendingCategoryTxId = null;
    let pickerTarget = null;
    let splitParts = [];

    async function loadCategories() {
      const res = await fetch('/api/categories');
      categories = await res.json();
    }

    async function loadTransactions() {
      localStorage.setItem('reviewMonth', monthInput.value);
      localStorage.setItem('reviewMode', modeInput.value);
      const res = await fetch('/api/review-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: monthInput.value, mode: modeInput.value })
      });
      transactions = await res.json();
      currentIndex = 0;
      renderCard();
    }

    function renderCard() {
      const container = document.getElementById('card-container');
      const actions = document.getElementById('actions');
      container.innerHTML = '';

      if (currentIndex >= transactions.length) {
        container.innerHTML = '<div class="empty"><h2>All done</h2><p>No more transactions to review.</p></div>';
        document.getElementById('progress').textContent = 'Complete';
        actions.hidden = true;
        return;
      }

      actions.hidden = false;
      const tx = transactions[currentIndex];
      document.getElementById('progress').textContent = (currentIndex + 1) + ' of ' + transactions.length;

      const flags = [];
      if (tx.newMerchant) flags.push('New Merchant');
      if (tx.unusualAmount) flags.push('Unusual Amount');
      if (tx.possibleDuplicate) flags.push('Possible Duplicate');
      if (tx.unconvertedFx) flags.push('Unconverted FX');
      if (tx.fixedMissing) flags.push('Fixed Missing');
      if (tx.fixedChanged) flags.push('Fixed Changed');

      const fxInfo = tx.originalCurrency !== 'CHF' && tx.fxRate
        ? '<div class="card-fx">' + tx.originalAmount.toFixed(2) + ' ' + escapeHtml(tx.originalCurrency) + ' @ ' + tx.fxRate.toFixed(4) + '</div>'
        : '';

      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="card-date">' + escapeHtml(tx.date) + '</div>' +
        '<div class="card-merchant">' + escapeHtml(tx.merchant) + '</div>' +
        '<div class="card-source">' + escapeHtml(tx.source) + (tx.sourceCard ? ' • ' + escapeHtml(tx.sourceCard) : '') + '</div>' +
        '<div class="card-amount">CHF ' + tx.chfAmount.toFixed(2) + '</div>' +
        fxInfo +
        '<div class="card-category">' + (escapeHtml(tx.category) || 'Uncategorised') + '</div>' +
        '<div class="card-confidence">Confidence: ' + (((tx.confidence || 0) * 100).toFixed(0)) + '%</div>' +
        '<div class="card-explanation">' + escapeHtml(tx.explanation) + '</div>' +
        (flags.length ? '<div class="flags">' + flags.map(f => '<span class="flag">' + escapeHtml(f) + '</span>').join('') + '</div>' : '');

      currentCard = card;
      container.appendChild(card);
      card.addEventListener('touchstart', handleTouchStart, { passive: true });
      card.addEventListener('touchmove', handleTouchMove, { passive: false });
      card.addEventListener('touchend', handleTouchEnd, { passive: true });
    }

    function handleTouchStart(e) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }

    function handleTouchMove(e) {
      if (!touchStartX) return;
      const diffX = e.touches[0].clientX - touchStartX;
      const diffY = e.touches[0].clientY - touchStartY;
      if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 10) {
        e.preventDefault();
        currentCard.classList.add('swiping');
        currentCard.style.transform = 'translateX(' + diffX + 'px) rotate(' + (diffX / 20) + 'deg)';
        currentCard.style.opacity = 1 - Math.abs(diffX) / 400;
      }
    }

    function handleTouchEnd(e) {
      if (!touchStartX) return;
      const diffX = e.changedTouches[0].clientX - touchStartX;
      currentCard.classList.remove('swiping');
      if (diffX > 100) {
        animateSwipe(true);
        setTimeout(() => acceptCard(), 200);
      } else if (diffX < -100) {
        animateSwipe(false);
        setTimeout(() => rejectCard(), 200);
      } else {
        currentCard.style.transform = '';
        currentCard.style.opacity = '';
      }
      touchStartX = 0;
      touchStartY = 0;
    }

    function animateSwipe(right) {
      const direction = right ? 1 : -1;
      currentCard.style.transform = 'translateX(' + (direction * 500) + 'px) rotate(' + (direction * 30) + 'deg)';
      currentCard.style.opacity = '0';
    }

    async function acceptCard() {
      const tx = transactions[currentIndex];
      await fetch('/api/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tx.id })
      });
      currentIndex++;
      renderCard();
    }

    function rejectCard() {
      pendingCategoryTxId = transactions[currentIndex].id;
      pickerTarget = 'correct';
      showPicker();
    }

    function skipCard() {
      currentIndex++;
      renderCard();
    }

    function showPicker() {
      document.getElementById('category-picker').classList.add('active');
      document.getElementById('picker-search').value = '';
      renderCategoryList('');
    }

    function closePicker() {
      document.getElementById('category-picker').classList.remove('active');
      pendingCategoryTxId = null;
      pickerTarget = null;
    }

    function renderCategoryList(search) {
      const list = document.getElementById('category-list');
      list.innerHTML = '';
      const searchLower = search.toLowerCase();
      for (const group of categories) {
        const filteredCats = group.categories.filter(c =>
          c.leaf.toLowerCase().includes(searchLower) ||
          group.group.toLowerCase().includes(searchLower)
        );
        if (filteredCats.length === 0) continue;
        const groupDiv = document.createElement('div');
        groupDiv.className = 'category-group';
        const groupName = document.createElement('div');
        groupName.className = 'category-group-name';
        groupName.textContent = group.group;
        groupDiv.appendChild(groupName);
        for (const cat of filteredCats) {
          const item = document.createElement('div');
          item.className = 'category-item';
          item.textContent = cat.leaf;
          item.onclick = () => selectCategory(cat.full);
          groupDiv.appendChild(item);
        }
        list.appendChild(groupDiv);
      }
    }

    async function selectCategory(category) {
      if (pickerTarget === 'split') {
        splitParts[pendingCategoryTxId].category = category;
        closePicker();
        renderSplitRows();
        return;
      }
      if (!pendingCategoryTxId) return;
      await fetch('/api/correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pendingCategoryTxId, category })
      });
      closePicker();
      currentIndex++;
      renderCard();
    }

    function openSplit() {
      const tx = transactions[currentIndex];
      const half = Math.round((tx.chfAmount / 2) * 100) / 100;
      splitParts = [
        { category: tx.category || '', chfAmount: half },
        { category: '', chfAmount: Math.round((tx.chfAmount - half) * 100) / 100 }
      ];
      document.getElementById('split-modal').classList.add('active');
      renderSplitRows();
    }

    function closeSplit() {
      document.getElementById('split-modal').classList.remove('active');
    }

    function addSplitRow() {
      splitParts.push({ category: '', chfAmount: 0 });
      renderSplitRows();
    }

    function renderSplitRows() {
      const tx = transactions[currentIndex];
      const sum = splitParts.reduce((s, p) => s + (Number(p.chfAmount) || 0), 0);
      document.getElementById('split-remaining').textContent =
        'CHF ' + sum.toFixed(2) + ' of ' + tx.chfAmount.toFixed(2);
      const box = document.getElementById('split-rows');
      box.innerHTML = '';
      splitParts.forEach((part, i) => {
        const row = document.createElement('div');
        row.className = 'split-row';
        const cat = document.createElement('button');
        cat.type = 'button';
        cat.className = 'split-cat';
        cat.textContent = part.category || 'Category';
        cat.onclick = () => {
          pendingCategoryTxId = i;
          pickerTarget = 'split';
          showPicker();
        };
        const amt = document.createElement('input');
        amt.type = 'number';
        amt.step = '0.01';
        amt.value = part.chfAmount;
        amt.oninput = () => {
          splitParts[i].chfAmount = parseFloat(amt.value);
          const s = splitParts.reduce((n, p) => n + (Number(p.chfAmount) || 0), 0);
          document.getElementById('split-remaining').textContent =
            'CHF ' + s.toFixed(2) + ' of ' + tx.chfAmount.toFixed(2);
        };
        row.append(cat, amt);
        box.appendChild(row);
      });
    }

    async function submitSplit() {
      const tx = transactions[currentIndex];
      const res = await fetch('/api/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tx.id, parts: splitParts })
      });
      const data = await res.json();
      if (!res.ok) {
        document.getElementById('split-remaining').textContent = data.error || 'Split failed';
        return;
      }
      closeSplit();
      currentIndex++;
      renderCard();
    }

    document.getElementById('picker-search').addEventListener('input', (e) => {
      renderCategoryList(e.target.value);
    });
    document.getElementById('btn-keep').onclick = acceptCard;
    document.getElementById('btn-change').onclick = rejectCard;
    document.getElementById('btn-split').onclick = openSplit;
    document.getElementById('btn-skip').onclick = skipCard;
    monthInput.addEventListener('change', loadTransactions);
    modeInput.addEventListener('change', loadTransactions);

    (async () => {
      await loadCategories();
      await loadTransactions();
    })();
  </script>
</body>
</html>`;
  }

  private getTransactionsPageHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>All Transactions</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      padding-bottom: env(safe-area-inset-bottom);
    }
    .header {
      position: sticky;
      top: 0;
      background: white;
      padding: 12px 16px;
      padding-top: max(12px, env(safe-area-inset-top));
      border-bottom: 1px solid #e0e0e0;
      z-index: 100;
    }
    .nav { display: flex; gap: 12px; margin-bottom: 8px; }
    .nav a { font-size: 14px; color: #007AFF; text-decoration: none; }
    .header h1 { font-size: 18px; color: #333; margin-bottom: 8px; }
    .filters { display: flex; gap: 8px; }
    .filter-input {
      flex: 1;
      padding: 12px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
    }
    .transaction-list { padding: 16px; max-width: 390px; margin: 0 auto; }
    .transaction {
      background: white;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      min-height: 72px;
    }
    .tx-header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px; }
    .tx-merchant { font-size: 16px; font-weight: 600; color: #333; }
    .tx-amount { font-size: 16px; font-weight: 700; color: #000; }
    .tx-date { font-size: 12px; color: #999; margin-bottom: 4px; }
    .tx-category {
      font-size: 14px; color: #666; padding: 4px 8px; background: #f0f0f0;
      border-radius: 6px; display: inline-block; margin-top: 8px;
    }
    .tx-flags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .flag { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; background: #FF3B30; color: white; }
    .empty { text-align: center; padding: 48px 16px; color: #666; }
    .modal {
      display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5);
      z-index: 1000; padding: 16px; overflow-y: auto;
    }
    .modal.active { display: flex; flex-direction: column; }
    .picker-content {
      background: white; border-radius: 16px; padding: 16px;
      max-width: 390px; width: 100%; margin: auto; max-height: 80vh; overflow-y: auto;
    }
    .picker-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .picker-header h2 { font-size: 18px; color: #333; }
    .picker-close { background: none; border: none; font-size: 28px; color: #666; width: 44px; height: 44px; }
    .picker-search {
      width: 100%; padding: 14px; border: 1px solid #e0e0e0; border-radius: 8px;
      font-size: 16px; margin-bottom: 16px;
    }
    .category-group { margin-bottom: 16px; }
    .category-group-name { font-size: 14px; font-weight: 600; color: #666; margin-bottom: 8px; }
    .category-item {
      padding: 14px; border: 1px solid #e0e0e0; border-radius: 8px;
      margin-bottom: 8px; min-height: 48px; background: white;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="nav">
      <a href="/">Home</a>
      <a href="/review">Review</a>
      <a href="/twint">Twint</a>
    </div>
    <h1>All Transactions</h1>
    <div class="filters">
      <input type="month" id="month-input" class="filter-input">
      <input type="search" id="filter-text" class="filter-input" placeholder="Search...">
    </div>
  </div>

  <div class="transaction-list" id="transaction-list"></div>

  <div class="modal" id="category-picker">
    <div class="picker-content">
      <div class="picker-header">
        <h2>Recategorise</h2>
        <button class="picker-close" onclick="closePicker()">&times;</button>
      </div>
      <input type="text" class="picker-search" id="picker-search" placeholder="Search categories...">
      <div id="category-list"></div>
    </div>
  </div>

  <script>
    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    const monthInput = document.getElementById('month-input');
    monthInput.value = localStorage.getItem('reviewMonth') || new Date().toISOString().substring(0, 7);

    let transactions = [];
    let categories = [];
    let selectedTxId = null;

    async function loadCategories() {
      const res = await fetch('/api/categories');
      categories = await res.json();
    }

    async function loadTransactions() {
      localStorage.setItem('reviewMonth', monthInput.value);
      const text = document.getElementById('filter-text').value;
      const res = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: monthInput.value, text: text || undefined })
      });
      transactions = await res.json();
      renderTransactions();
    }

    function renderTransactions() {
      const list = document.getElementById('transaction-list');
      if (transactions.length === 0) {
        list.innerHTML = '<div class="empty"><h2>No transactions found</h2></div>';
        return;
      }
      list.innerHTML = transactions.map(tx => {
        const flags = [];
        if (tx.newMerchant) flags.push('New');
        if (tx.unusualAmount) flags.push('Unusual');
        if (tx.possibleDuplicate) flags.push('Duplicate?');
        if (tx.unconvertedFx) flags.push('FX Failed');
        if (tx.reviewed) flags.push('✓');
        return '<div class="transaction" data-id="' + escapeHtml(tx.id) + '">' +
          '<div class="tx-date">' + escapeHtml(tx.date) + ' • ' + escapeHtml(tx.source) + '</div>' +
          '<div class="tx-header"><div class="tx-merchant">' + escapeHtml(tx.merchant) + '</div>' +
          '<div class="tx-amount">CHF ' + tx.chfAmount.toFixed(2) + '</div></div>' +
          '<div class="tx-category">' + (escapeHtml(tx.category) || 'Uncategorised') + '</div>' +
          (flags.length ? '<div class="tx-flags">' + flags.map(f => '<span class="flag">' + escapeHtml(f) + '</span>').join('') + '</div>' : '') +
        '</div>';
      }).join('');
    }

    document.getElementById('transaction-list').addEventListener('click', (e) => {
      const row = e.target.closest('.transaction');
      if (row && row.dataset.id) selectTransaction(row.dataset.id);
    });

    function selectTransaction(id) {
      selectedTxId = id;
      showPicker();
    }
    function showPicker() {
      document.getElementById('category-picker').classList.add('active');
      renderCategoryList('');
    }
    function closePicker() {
      document.getElementById('category-picker').classList.remove('active');
      selectedTxId = null;
    }
    function renderCategoryList(search) {
      const list = document.getElementById('category-list');
      list.innerHTML = '';
      const searchLower = search.toLowerCase();
      for (const group of categories) {
        const filteredCats = group.categories.filter(c =>
          c.leaf.toLowerCase().includes(searchLower) || group.group.toLowerCase().includes(searchLower)
        );
        if (filteredCats.length === 0) continue;
        const groupDiv = document.createElement('div');
        groupDiv.className = 'category-group';
        const groupName = document.createElement('div');
        groupName.className = 'category-group-name';
        groupName.textContent = group.group;
        groupDiv.appendChild(groupName);
        for (const cat of filteredCats) {
          const item = document.createElement('div');
          item.className = 'category-item';
          item.textContent = cat.leaf;
          item.onclick = () => selectCategory(cat.full);
          groupDiv.appendChild(item);
        }
        list.appendChild(groupDiv);
      }
    }
    async function selectCategory(category) {
      if (!selectedTxId) return;
      await fetch('/api/correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedTxId, category })
      });
      closePicker();
      await loadTransactions();
    }
    document.getElementById('picker-search').addEventListener('input', (e) => renderCategoryList(e.target.value));
    let searchTimeout;
    document.getElementById('filter-text').addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(loadTransactions, 300);
    });
    monthInput.addEventListener('change', loadTransactions);
    (async () => { await loadCategories(); await loadTransactions(); })();
  </script>
</body>
</html>`;
  }

  private getTwintPageHTML(): string {
    const today = new Date().toISOString().substring(0, 10);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Twint Prepaid</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      padding: 16px;
      padding-bottom: max(16px, env(safe-area-inset-bottom));
    }
    .container { max-width: 390px; margin: 0 auto; }
    .nav { display: flex; gap: 12px; margin-bottom: 8px; }
    .nav a { font-size: 14px; color: #007AFF; text-decoration: none; }
    h1 { font-size: 24px; margin-bottom: 24px; color: #333; }
    .card {
      background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 14px; font-weight: 600; color: #333; margin-bottom: 8px; }
    .form-group input, .form-group textarea, .cat-btn {
      width: 100%; padding: 14px; border: 1px solid #e0e0e0; border-radius: 8px;
      font-size: 16px; font-family: inherit; min-height: 48px; background: white; text-align: left;
    }
    .btn {
      width: 100%; min-height: 52px; border: none; border-radius: 12px;
      font-size: 18px; font-weight: 600; background: #007AFF; color: white;
    }
    .btn:active { background: #0051D5; }
    .btn:disabled { background: #ccc; }
    .message { padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
    .message.success { background: #d4edda; color: #155724; }
    .message.error { background: #f8d7da; color: #721c24; }
    .transactions-list { margin-top: 32px; }
    .transactions-list h2 { font-size: 18px; margin-bottom: 16px; color: #333; }
    .transaction {
      background: white; border-radius: 12px; padding: 16px; margin-bottom: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1); display: flex; justify-content: space-between; align-items: center;
    }
    .tx-date { font-size: 12px; color: #999; margin-bottom: 4px; }
    .tx-merchant { font-size: 16px; font-weight: 600; color: #333; margin-bottom: 4px; }
    .tx-amount { font-size: 14px; color: #666; }
    .tx-note { font-size: 12px; color: #666; font-style: italic; margin-top: 4px; }
    .btn-delete {
      padding: 12px 16px; min-height: 44px; border: none; border-radius: 8px;
      font-size: 14px; font-weight: 600; background: #FF3B30; color: white; margin-left: 12px;
    }
    .empty { text-align: center; padding: 48px 16px; color: #666; font-size: 14px; }
    .modal {
      display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5);
      z-index: 1000; padding: 16px; overflow-y: auto;
    }
    .modal.active { display: flex; flex-direction: column; }
    .picker-content {
      background: white; border-radius: 16px; padding: 16px;
      max-width: 390px; width: 100%; margin: auto; max-height: 80vh; overflow-y: auto;
    }
    .picker-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .picker-close { background: none; border: none; font-size: 28px; width: 44px; height: 44px; }
    .picker-search { width: 100%; padding: 14px; border: 1px solid #e0e0e0; border-radius: 8px; font-size: 16px; margin-bottom: 16px; }
    .category-item { padding: 14px; border: 1px solid #e0e0e0; border-radius: 8px; margin-bottom: 8px; min-height: 48px; }
    .category-group-name { font-size: 14px; font-weight: 600; color: #666; margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="nav">
      <a href="/">Home</a>
      <a href="/review">Review</a>
      <a href="/transactions">List</a>
      <a href="/logout">Log out</a>
    </div>
    <h1>Twint Prepaid</h1>
    <div class="card">
      <div id="message"></div>
      <form id="twint-form">
        <div class="form-group">
          <label for="date">Date</label>
          <input type="date" id="date" name="date" value="${today}" required>
        </div>
        <div class="form-group">
          <label for="merchant">Merchant</label>
          <input type="text" id="merchant" name="merchant" placeholder="Shop name" required>
        </div>
        <div class="form-group">
          <label for="amount">Amount (CHF)</label>
          <input type="number" id="amount" name="amount" step="0.01" min="0.01" placeholder="0.00" required>
        </div>
        <div class="form-group">
          <label for="category">Category (optional)</label>
          <input type="hidden" id="category" name="category">
          <button type="button" class="cat-btn" id="category-btn">None — auto-categorise</button>
        </div>
        <button type="submit" class="btn" id="submit-btn">Add Transaction</button>
      </form>
    </div>
    <div class="transactions-list">
      <h2>Twint transactions</h2>
      <div class="form-group">
        <label for="month-input">Month</label>
        <input type="month" id="month-input">
      </div>
      <div id="transactions"></div>
    </div>
  </div>
  <div class="modal" id="category-picker">
    <div class="picker-content">
      <div class="picker-header">
        <h2>Category</h2>
        <button class="picker-close" onclick="closePicker()">&times;</button>
      </div>
      <input type="text" class="picker-search" id="picker-search" placeholder="Search categories...">
      <div id="category-list"></div>
    </div>
  </div>
  <script>
    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    let categories = [];
    function showMessage(text, type) {
      const messageEl = document.getElementById('message');
      messageEl.textContent = text;
      messageEl.className = 'message ' + type;
      setTimeout(() => { messageEl.textContent = ''; messageEl.className = ''; }, 3000);
    }
    async function loadCategories() {
      const res = await fetch('/api/categories');
      categories = await res.json();
    }
    const monthInput = document.getElementById('month-input');
    monthInput.value = localStorage.getItem('reviewMonth') || new Date().toISOString().substring(0, 7);
    monthInput.addEventListener('change', () => {
      localStorage.setItem('reviewMonth', monthInput.value);
      loadTransactions();
    });
    async function loadTransactions() {
      try {
        const month = monthInput.value;
        const res = await fetch('/api/twint?month=' + encodeURIComponent(month));
        const transactions = await res.json();
        const container = document.getElementById('transactions');
        if (transactions.length === 0) {
          container.innerHTML = '<div class="empty">No Twint transactions this month</div>';
          return;
        }
        container.innerHTML = transactions.map(tx =>
          '<div class="transaction"><div class="tx-info">' +
          '<div class="tx-date">' + escapeHtml(tx.date) + '</div>' +
          '<div class="tx-merchant">' + escapeHtml(tx.merchant) + '</div>' +
          '<div class="tx-amount">CHF ' + tx.chfAmount.toFixed(2) + (tx.category ? ' • ' + escapeHtml(tx.category) : '') + '</div>' +
          (tx.description ? '<div class="tx-note">' + escapeHtml(tx.description) + '</div>' : '') +
          '</div><button class="btn-delete" data-id="' + escapeHtml(tx.id) + '">Delete</button></div>'
        ).join('');
      } catch (error) {
        console.error('Failed to load transactions:', error);
      }
    }
    document.getElementById('transactions').addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-delete')) deleteTransaction(e.target.dataset.id);
    });
    async function deleteTransaction(id) {
      if (!confirm('Delete this transaction?')) return;
      try {
        const res = await fetch('/api/twint/' + id, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) { showMessage('Transaction deleted', 'success'); await loadTransactions(); }
        else showMessage(data.error || 'Failed to delete', 'error');
      } catch (error) {
        showMessage('Network error', 'error');
      }
    }
    function closePicker() {
      document.getElementById('category-picker').classList.remove('active');
    }
    function renderCategoryList(search) {
      const list = document.getElementById('category-list');
      list.innerHTML = '';
      const none = document.createElement('div');
      none.className = 'category-item';
      none.textContent = 'None — auto-categorise';
      none.onclick = () => selectCategory('');
      list.appendChild(none);
      const searchLower = search.toLowerCase();
      for (const group of categories) {
        const filteredCats = group.categories.filter(c =>
          c.leaf.toLowerCase().includes(searchLower) || group.group.toLowerCase().includes(searchLower)
        );
        if (!filteredCats.length) continue;
        const groupName = document.createElement('div');
        groupName.className = 'category-group-name';
        groupName.textContent = group.group;
        list.appendChild(groupName);
        for (const cat of filteredCats) {
          const item = document.createElement('div');
          item.className = 'category-item';
          item.textContent = cat.leaf;
          item.onclick = () => selectCategory(cat.full);
          list.appendChild(item);
        }
      }
    }
    function selectCategory(category) {
      document.getElementById('category').value = category;
      document.getElementById('category-btn').textContent = category || 'None — auto-categorise';
      closePicker();
    }
    document.getElementById('category-btn').onclick = () => {
      document.getElementById('category-picker').classList.add('active');
      renderCategoryList('');
    };
    document.getElementById('picker-search').addEventListener('input', (e) => renderCategoryList(e.target.value));
    document.getElementById('twint-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('submit-btn');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding...';
      const data = {
        date: document.getElementById('date').value,
        merchant: document.getElementById('merchant').value,
        amount: parseFloat(document.getElementById('amount').value),
        category: document.getElementById('category').value || undefined
      };
      try {
        const res = await fetch('/api/twint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const result = await res.json();
        if (res.ok) {
          showMessage('Transaction added successfully', 'success');
          document.getElementById('merchant').value = '';
          document.getElementById('amount').value = '';
          selectCategory('');
          await loadTransactions();
        } else {
          showMessage(result.error || 'Failed to add transaction', 'error');
        }
      } catch (error) {
        showMessage('Network error', 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add Transaction';
      }
    });
    (async () => { await loadCategories(); await loadTransactions(); })();
  </script>
</body>
</html>`;
  }
}

export function startServer(db: DB, port: number = 4321, host: string = '127.0.0.1'): void {
  try {
    validateReviewToken(process.env.REVIEW_TOKEN);
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  const server = new WebServer(db);
  
  const httpServer = createServer((req, res) => {
    server.handleRequest(req, res);
  });

  httpServer.listen(port, host, () => {
    console.log(`Server running at http://${host}:${port}/`);
  });
}

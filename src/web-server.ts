import { createServer, IncomingMessage, ServerResponse } from 'http';
import { DB } from './db.js';
import { correctTransaction, categorizeTransaction } from './categorize.js';
import { loadCategories } from './categories.js';
import { Transaction, Category } from './types.js';
import crypto from 'crypto';

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

  constructor(db: DB) {
    this.db = db;
    this.categories = loadCategories();
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
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    
    // Enable CORS for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    
    try {
      if (url.pathname === '/api/categories') {
        this.handleGetCategories(req, res);
      } else if (url.pathname === '/api/review-queue') {
        this.handleGetReviewQueue(req, res, url);
      } else if (url.pathname === '/api/transactions') {
        this.handleGetTransactions(req, res, url);
      } else if (url.pathname === '/api/accept' && req.method === 'POST') {
        this.handleAccept(req, res);
      } else if (url.pathname === '/api/correct' && req.method === 'POST') {
        this.handleCorrect(req, res);
      } else if (url.pathname === '/api/undo' && req.method === 'POST') {
        this.handleUndo(req, res);
      } else if (url.pathname === '/api/twint' && req.method === 'POST') {
        this.handleAddTwint(req, res);
      } else if (url.pathname === '/api/twint' && req.method === 'GET') {
        this.handleGetTwint(req, res);
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

  private handleGetReviewQueue(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const month = url.searchParams.get('month');
    const mode = url.searchParams.get('mode') || 'full';
    
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
  }

  private handleGetTransactions(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const month = url.searchParams.get('month');
    
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid month parameter' }));
      return;
    }
    
    const filters = {
      text: url.searchParams.get('text') || undefined,
      category: url.searchParams.get('category') || undefined,
      source: url.searchParams.get('source') || undefined,
      flag: url.searchParams.get('flag') || undefined,
    };
    
    const transactions = this.getTransactionsList(month, filters);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(transactions));
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
        const { date, merchant, amount, note } = parsed;

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

  private handleGetTwint(req: IncomingMessage, res: ServerResponse): void {
    const currentMonth = new Date().toISOString().substring(0, 7);
    const transactions = this.db.getTransactionsByMonth(currentMonth);
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

  private getIndexPageHTML(): string {
    const currentMonth = new Date().toISOString().substring(0, 7);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>Finances Review</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      padding: 16px;
    }
    .container { max-width: 600px; margin: 0 auto; }
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
      display: block;
      width: 100%;
      padding: 14px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
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
      <a href="/review?month=${currentMonth}&mode=full" class="btn">Start Review</a>
    </div>
    
    <div class="card">
      <h2>All Transactions</h2>
      <p>View and search all transactions for the month.</p>
      <a href="/transactions?month=${currentMonth}" class="btn">View All</a>
    </div>
    
    <div class="card">
      <h2>Twint Prepaid</h2>
      <p>Add Twint transactions manually (no export available).</p>
      <a href="/twint" class="btn">Add Twint</a>
    </div>
  </div>
</body>
</html>`;
  }

  private getReviewPageHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, maximum-scale=1.0">
  <title>Review Transactions</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      overflow-x: hidden;
      touch-action: pan-y;
    }
    .header {
      position: sticky;
      top: 0;
      background: white;
      padding: 12px 16px;
      border-bottom: 1px solid #e0e0e0;
      z-index: 100;
    }
    .header h1 { font-size: 18px; color: #333; margin-bottom: 4px; }
    .progress { font-size: 14px; color: #666; }
    .card-container {
      position: relative;
      min-height: calc(100vh - 100px);
      padding: 16px;
    }
    .card {
      position: absolute;
      top: 16px;
      left: 16px;
      right: 16px;
      background: white;
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.15);
      transition: transform 0.3s ease, opacity 0.3s ease;
      touch-action: none;
      max-width: 600px;
      margin: 0 auto;
    }
    .card.swiping { transition: none; }
    .card-date { font-size: 14px; color: #999; margin-bottom: 8px; }
    .card-merchant { font-size: 20px; font-weight: 600; color: #333; margin-bottom: 4px; }
    .card-source { font-size: 12px; color: #666; margin-bottom: 16px; }
    .card-amount { font-size: 32px; font-weight: 700; color: #000; margin-bottom: 16px; }
    .card-fx { font-size: 14px; color: #666; margin-bottom: 16px; }
    .card-category {
      font-size: 16px;
      color: #333;
      margin-bottom: 8px;
      padding: 8px 12px;
      background: #f0f0f0;
      border-radius: 8px;
    }
    .card-confidence { font-size: 14px; color: #666; margin-bottom: 8px; }
    .card-explanation { font-size: 14px; color: #666; margin-bottom: 16px; font-style: italic; }
    .flags {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }
    .flag {
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      background: #FF3B30;
      color: white;
    }
    .actions {
      display: flex;
      gap: 12px;
      margin-top: 24px;
    }
    .btn {
      flex: 1;
      padding: 14px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-accept { background: #34C759; color: white; }
    .btn-reject { background: #FF3B30; color: white; }
    .btn-undo { background: #666; color: white; }
    .btn:active { opacity: 0.7; }
    .empty {
      text-align: center;
      padding: 48px 16px;
      color: #666;
    }
    .category-picker {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      z-index: 1000;
      padding: 16px;
      overflow-y: auto;
    }
    .category-picker.active { display: flex; flex-direction: column; }
    .picker-content {
      background: white;
      border-radius: 16px;
      padding: 16px;
      max-width: 600px;
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
      background: none;
      border: none;
      font-size: 24px;
      color: #666;
      cursor: pointer;
      padding: 0;
      width: 32px;
      height: 32px;
    }
    .picker-search {
      width: 100%;
      padding: 12px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      margin-bottom: 16px;
    }
    .category-group {
      margin-bottom: 16px;
    }
    .category-group-name {
      font-size: 14px;
      font-weight: 600;
      color: #666;
      margin-bottom: 8px;
    }
    .category-item {
      padding: 12px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      margin-bottom: 8px;
      cursor: pointer;
      background: white;
    }
    .category-item:active { background: #f0f0f0; }
  </style>
</head>
<body>
  <div class="header">
    <h1 id="month-title">Review Transactions</h1>
    <div class="progress" id="progress">Loading...</div>
  </div>
  
  <div class="card-container" id="card-container"></div>
  
  <div class="category-picker" id="category-picker">
    <div class="picker-content">
      <div class="picker-header">
        <h2>Choose Category</h2>
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

    const urlParams = new URLSearchParams(window.location.search);
    const month = urlParams.get('month') || new Date().toISOString().substring(0, 7);
    const mode = urlParams.get('mode') || 'full';
    
    let transactions = [];
    let currentIndex = 0;
    let categories = [];
    let touchStartX = 0;
    let touchStartY = 0;
    let currentCard = null;
    let pendingCategoryTxId = null;

    async function loadCategories() {
      const res = await fetch('/api/categories');
      categories = await res.json();
    }

    async function loadTransactions() {
      const res = await fetch(\`/api/review-queue?month=\${month}&mode=\${mode}\`);
      transactions = await res.json();
      currentIndex = 0;
      renderCard();
    }

    function renderCard() {
      const container = document.getElementById('card-container');
      container.innerHTML = '';
      
      if (currentIndex >= transactions.length) {
        container.innerHTML = '<div class="empty"><h2>All done! 🎉</h2><p>No more transactions to review.</p></div>';
        document.getElementById('progress').textContent = 'Complete';
        return;
      }
      
      const tx = transactions[currentIndex];
      document.getElementById('progress').textContent = \`\${currentIndex + 1} of \${transactions.length}\`;
      
      const flags = [];
      if (tx.newMerchant) flags.push('New Merchant');
      if (tx.unusualAmount) flags.push('Unusual Amount');
      if (tx.possibleDuplicate) flags.push('Possible Duplicate');
      if (tx.unconvertedFx) flags.push('Unconverted FX');
      if (tx.fixedMissing) flags.push('Fixed Missing');
      if (tx.fixedChanged) flags.push('Fixed Changed');
      
      const fxInfo = tx.originalCurrency !== 'CHF' && tx.fxRate
        ? \`<div class="card-fx">\${tx.originalAmount.toFixed(2)} \${escapeHtml(tx.originalCurrency)} @ \${tx.fxRate.toFixed(4)}</div>\`
        : '';
      
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = \`
        <div class="card-date">\${escapeHtml(tx.date)}</div>
        <div class="card-merchant">\${escapeHtml(tx.merchant)}</div>
        <div class="card-source">\${escapeHtml(tx.source)}\${tx.sourceCard ? ' • ' + escapeHtml(tx.sourceCard) : ''}</div>
        <div class="card-amount">CHF \${tx.chfAmount.toFixed(2)}</div>
        \${fxInfo}
        <div class="card-category">\${escapeHtml(tx.category) || 'Uncategorised'}</div>
        <div class="card-confidence">Confidence: \${((tx.confidence || 0) * 100).toFixed(0)}%</div>
        <div class="card-explanation">\${escapeHtml(tx.explanation)}</div>
        \${flags.length ? '<div class="flags">' + flags.map(f => \`<span class="flag">\${escapeHtml(f)}</span>\`).join('') + '</div>' : ''}
        <div class="actions">
          <button class="btn btn-reject" onclick="rejectCard()">✗</button>
          <button class="btn btn-undo" onclick="undoLast()">Undo</button>
          <button class="btn btn-accept" onclick="acceptCard()">✓</button>
        </div>
      \`;
      
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
      
      const touchX = e.touches[0].clientX;
      const touchY = e.touches[0].clientY;
      const diffX = touchX - touchStartX;
      const diffY = touchY - touchStartY;
      
      // Only handle horizontal swipes
      if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 10) {
        e.preventDefault();
        currentCard.classList.add('swiping');
        const rotation = diffX / 20;
        currentCard.style.transform = \`translateX(\${diffX}px) rotate(\${rotation}deg)\`;
        currentCard.style.opacity = 1 - Math.abs(diffX) / 400;
      }
    }

    function handleTouchEnd(e) {
      if (!touchStartX) return;
      
      const touchX = e.changedTouches[0].clientX;
      const diffX = touchX - touchStartX;
      
      currentCard.classList.remove('swiping');
      
      if (diffX > 100) {
        // Swipe right = accept
        animateSwipe(diffX > 0);
        setTimeout(() => acceptCard(), 200);
      } else if (diffX < -100) {
        // Swipe left = reject
        animateSwipe(diffX > 0);
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
      currentCard.style.transform = \`translateX(\${direction * 500}px) rotate(\${direction * 30}deg)\`;
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
      const tx = transactions[currentIndex];
      pendingCategoryTxId = tx.id;
      showPicker();
    }

    async function undoLast() {
      const res = await fetch('/api/undo', { method: 'POST' });
      const data = await res.json();
      if (data.success && currentIndex > 0) {
        currentIndex--;
        renderCard();
      }
    }

    function showPicker() {
      document.getElementById('category-picker').classList.add('active');
      renderCategoryList('');
    }

    function closePicker() {
      document.getElementById('category-picker').classList.remove('active');
      pendingCategoryTxId = null;
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

    document.getElementById('picker-search').addEventListener('input', (e) => {
      renderCategoryList(e.target.value);
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('category-picker').classList.contains('active')) return;
      
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        acceptCard();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        rejectCard();
      } else if (e.key === 'u') {
        e.preventDefault();
        undoLast();
      }
    });

    // Initialize
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>All Transactions</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
    }
    .header {
      position: sticky;
      top: 0;
      background: white;
      padding: 12px 16px;
      border-bottom: 1px solid #e0e0e0;
      z-index: 100;
    }
    .header h1 { font-size: 18px; color: #333; margin-bottom: 8px; }
    .filters {
      display: flex;
      gap: 8px;
      margin-top: 8px;
      overflow-x: auto;
      padding-bottom: 8px;
    }
    .filter-input {
      padding: 8px 12px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      font-size: 14px;
      flex-shrink: 0;
    }
    .transaction-list {
      padding: 16px;
    }
    .transaction {
      background: white;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      cursor: pointer;
    }
    .transaction:active { background: #f9f9f9; }
    .tx-header {
      display: flex;
      justify-content: space-between;
      align-items: start;
      margin-bottom: 8px;
    }
    .tx-merchant { font-size: 16px; font-weight: 600; color: #333; }
    .tx-amount { font-size: 16px; font-weight: 700; color: #000; }
    .tx-date { font-size: 12px; color: #999; margin-bottom: 4px; }
    .tx-category {
      font-size: 14px;
      color: #666;
      padding: 4px 8px;
      background: #f0f0f0;
      border-radius: 6px;
      display: inline-block;
      margin-top: 8px;
    }
    .tx-flags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
    }
    .flag {
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      background: #FF3B30;
      color: white;
    }
    .empty {
      text-align: center;
      padding: 48px 16px;
      color: #666;
    }
    .category-picker {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      z-index: 1000;
      padding: 16px;
      overflow-y: auto;
    }
    .category-picker.active { display: flex; flex-direction: column; }
    .picker-content {
      background: white;
      border-radius: 16px;
      padding: 16px;
      max-width: 600px;
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
      background: none;
      border: none;
      font-size: 24px;
      color: #666;
      cursor: pointer;
      padding: 0;
      width: 32px;
      height: 32px;
    }
    .picker-search {
      width: 100%;
      padding: 12px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      margin-bottom: 16px;
    }
    .category-group {
      margin-bottom: 16px;
    }
    .category-group-name {
      font-size: 14px;
      font-weight: 600;
      color: #666;
      margin-bottom: 8px;
    }
    .category-item {
      padding: 12px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      margin-bottom: 8px;
      cursor: pointer;
      background: white;
    }
    .category-item:active { background: #f0f0f0; }
  </style>
</head>
<body>
  <div class="header">
    <h1 id="month-title">All Transactions</h1>
    <div class="filters">
      <input type="text" id="filter-text" class="filter-input" placeholder="Search...">
    </div>
  </div>
  
  <div class="transaction-list" id="transaction-list"></div>
  
  <div class="category-picker" id="category-picker">
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

    const urlParams = new URLSearchParams(window.location.search);
    const month = urlParams.get('month') || new Date().toISOString().substring(0, 7);
    
    let transactions = [];
    let categories = [];
    let selectedTxId = null;

    async function loadCategories() {
      const res = await fetch('/api/categories');
      categories = await res.json();
    }

    async function loadTransactions() {
      const text = document.getElementById('filter-text').value;
      const params = new URLSearchParams({ month });
      if (text) params.append('text', text);
      
      const res = await fetch(\`/api/transactions?\${params}\`);
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
        
        return \`
          <div class="transaction" onclick="selectTransaction('\${escapeHtml(tx.id)}')">
            <div class="tx-date">\${escapeHtml(tx.date)} • \${escapeHtml(tx.source)}</div>
            <div class="tx-header">
              <div class="tx-merchant">\${escapeHtml(tx.merchant)}</div>
              <div class="tx-amount">CHF \${tx.chfAmount.toFixed(2)}</div>
            </div>
            <div class="tx-category">\${escapeHtml(tx.category) || 'Uncategorised'}</div>
            \${flags.length ? '<div class="tx-flags">' + flags.map(f => \`<span class="flag">\${escapeHtml(f)}</span>\`).join('') + '</div>' : ''}
          </div>
        \`;
      }).join('');
    }

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
      if (!selectedTxId) return;
      
      await fetch('/api/correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedTxId, category })
      });
      
      closePicker();
      await loadTransactions();
    }

    document.getElementById('picker-search').addEventListener('input', (e) => {
      renderCategoryList(e.target.value);
    });

    let searchTimeout;
    document.getElementById('filter-text').addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(loadTransactions, 300);
    });

    // Initialize
    (async () => {
      await loadCategories();
      await loadTransactions();
    })();
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>Twint Prepaid</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      padding: 16px;
    }
    .container { max-width: 600px; margin: 0 auto; }
    h1 { font-size: 24px; margin-bottom: 24px; color: #333; }
    .card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .form-group {
      margin-bottom: 16px;
    }
    .form-group label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: #333;
      margin-bottom: 8px;
    }
    .form-group input, .form-group textarea {
      width: 100%;
      padding: 12px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      font-family: inherit;
    }
    .form-group textarea {
      resize: vertical;
      min-height: 60px;
    }
    .btn {
      width: 100%;
      padding: 14px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      background: #007AFF;
      color: white;
    }
    .btn:active { background: #0051D5; }
    .btn:disabled { background: #ccc; cursor: not-allowed; }
    .message {
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 16px;
      font-size: 14px;
    }
    .message.success { background: #d4edda; color: #155724; }
    .message.error { background: #f8d7da; color: #721c24; }
    .transactions-list {
      margin-top: 32px;
    }
    .transactions-list h2 {
      font-size: 18px;
      margin-bottom: 16px;
      color: #333;
    }
    .transaction {
      background: white;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .tx-info {
      flex: 1;
    }
    .tx-date {
      font-size: 12px;
      color: #999;
      margin-bottom: 4px;
    }
    .tx-merchant {
      font-size: 16px;
      font-weight: 600;
      color: #333;
      margin-bottom: 4px;
    }
    .tx-amount {
      font-size: 14px;
      color: #666;
    }
    .tx-note {
      font-size: 12px;
      color: #666;
      font-style: italic;
      margin-top: 4px;
    }
    .btn-delete {
      padding: 8px 16px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      background: #FF3B30;
      color: white;
      margin-left: 12px;
    }
    .btn-delete:active { background: #D12B1F; }
    .empty {
      text-align: center;
      padding: 48px 16px;
      color: #666;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
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
          <label for="note">Note (optional)</label>
          <textarea id="note" name="note" placeholder="Optional description"></textarea>
        </div>
        
        <button type="submit" class="btn" id="submit-btn">Add Transaction</button>
      </form>
    </div>
    
    <div class="transactions-list">
      <h2>This Month's Twint Transactions</h2>
      <div id="transactions"></div>
    </div>
  </div>

  <script>
    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function showMessage(text, type) {
      const messageEl = document.getElementById('message');
      messageEl.textContent = text;
      messageEl.className = \`message \${type}\`;
      setTimeout(() => {
        messageEl.textContent = '';
        messageEl.className = '';
      }, 3000);
    }

    async function loadTransactions() {
      try {
        const res = await fetch('/api/twint');
        const transactions = await res.json();
        
        const container = document.getElementById('transactions');
        
        if (transactions.length === 0) {
          container.innerHTML = '<div class="empty">No Twint transactions this month</div>';
          return;
        }
        
        container.innerHTML = transactions.map(tx => \`
          <div class="transaction">
            <div class="tx-info">
              <div class="tx-date">\${escapeHtml(tx.date)}</div>
              <div class="tx-merchant">\${escapeHtml(tx.merchant)}</div>
              <div class="tx-amount">CHF \${tx.chfAmount.toFixed(2)}</div>
              \${tx.description ? \`<div class="tx-note">\${escapeHtml(tx.description)}</div>\` : ''}
            </div>
            <button class="btn-delete" onclick="deleteTransaction('\${escapeHtml(tx.id)}')">Delete</button>
          </div>
        \`).join('');
      } catch (error) {
        console.error('Failed to load transactions:', error);
      }
    }

    async function deleteTransaction(id) {
      if (!confirm('Delete this transaction?')) {
        return;
      }
      
      try {
        const res = await fetch(\`/api/twint/\${id}\`, { method: 'DELETE' });
        const data = await res.json();
        
        if (res.ok) {
          showMessage('Transaction deleted', 'success');
          await loadTransactions();
        } else {
          showMessage(data.error || 'Failed to delete', 'error');
        }
      } catch (error) {
        showMessage('Network error', 'error');
      }
    }

    document.getElementById('twint-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const submitBtn = document.getElementById('submit-btn');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding...';
      
      const formData = new FormData(e.target);
      const data = {
        date: formData.get('date'),
        merchant: formData.get('merchant'),
        amount: parseFloat(formData.get('amount')),
        note: formData.get('note') || undefined
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
          document.getElementById('note').value = '';
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

    loadTransactions();
  </script>
</body>
</html>`;
  }
}

export function startServer(db: DB, port: number = 4321, host: string = '127.0.0.1'): void {
  const server = new WebServer(db);
  
  const httpServer = createServer((req, res) => {
    server.handleRequest(req, res);
  });

  httpServer.listen(port, host, () => {
    console.log(`Server running at http://${host}:${port}/`);
  });
}

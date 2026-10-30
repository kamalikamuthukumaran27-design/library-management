'use strict';

/**
 * @file Library Management Interface — application logic.
 *
 * Architecture (MVC + Repository/Service)
 * ---------------------------------------
 *   Model       Book, Issue, BookQuery, Validator, error types
 *   Data        Repository (interface) → LocalStorageRepository | ODataRepository
 *   Service     LibraryService — ALL business rules; depends only on the Repository contract
 *   View        LibraryView, ToastManager — DOM only, no business logic
 *   Controller  LibraryController — wires View events ↔ Service calls, owns UI state
 *
 * Swapping localStorage for an SAP CAP OData V4 backend:
 *   set CONFIG.DATA_SOURCE = 'odata' (see createRepositories). The Service, View and Controller
 *   are untouched because every Repository method is already asynchronous.
 *
 * Security: every dynamic value is escaped by the `html` tagged template (see Sanitizer),
 * user input is normalised by Validator, and toasts/dialogs use textContent.
 */

/* ==========================================================================
   1. CONFIGURATION
   ========================================================================== */

const CONFIG = Object.freeze({
  /** @type {'localStorage'|'odata'} */
  DATA_SOURCE: 'localStorage',
  ODATA_BASE_URL: '/odata/v4/library',
  STORAGE_PREFIX: 'lms.v1.',
  LOAN_PERIOD_DAYS: 14,
  PAGE_SIZES: [5, 10, 25, 50],
  DEFAULT_PAGE_SIZE: 10,
  SEARCH_DEBOUNCE_MS: 200,
  TOAST_DURATION_MS: 5000,
  TOAST_ERROR_DURATION_MS: 8000,
});

/* ==========================================================================
   2. UTILITIES
   ========================================================================== */

/** Input normalisation and output escaping. */
const Sanitizer = Object.freeze({
  /**
   * Normalises free text: strips control characters, collapses whitespace, trims and truncates.
   * @param {unknown} value
   * @param {number} [maxLength=200]
   * @returns {string}
   */
  clean(value, maxLength = 200) {
    return String(value ?? '')
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
  },

  /**
   * Escapes HTML-significant characters for safe insertion in element or quoted-attribute context.
   * @param {unknown} value
   * @returns {string}
   */
  escapeHtml(value) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
    return String(value ?? '').replace(/[&<>"'`]/g, (ch) => map[ch]);
  },
});

/** Wrapper marking a string as already-safe HTML (produced only by the `html` tag). */
class SafeHtml {
  /** @param {string} value */
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

/** @param {unknown} v */
const renderValue = (v) => {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  if (v === null || v === undefined || v === false) return '';
  return Sanitizer.escapeHtml(v);
};

/**
 * Tagged template that auto-escapes every interpolation. Nest `html` results freely.
 * ALWAYS quote attribute values: `<td title="${x}">`.
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 * @returns {SafeHtml}
 */
const html = (strings, ...values) =>
  new SafeHtml(strings.reduce((out, s, i) => out + s + (i < values.length ? renderValue(values[i]) : ''), ''));

/**
 * Marks a TRUSTED, developer-authored constant (never user data) as safe markup.
 * @param {string} s
 */
const raw = (s) => new SafeHtml(s);

/**
 * Replaces an element's content with safe markup.
 * @param {Element} el
 * @param {SafeHtml} safe
 */
const setHtml = (el, safe) => {
  if (!(safe instanceof SafeHtml)) throw new TypeError('setHtml expects output of the html`` tag');
  el.innerHTML = safe.value;
};

/** Local-time, date-only (YYYY-MM-DD) helpers — avoids timezone drift of toISOString(). */
const DateUtil = Object.freeze({
  /** @param {Date} d */
  toISO(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  todayISO() { return DateUtil.toISO(new Date()); },
  /** @param {string} iso */
  parse(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  },
  /** @param {string} iso @param {number} days */
  addDays(iso, days) {
    const d = DateUtil.parse(iso);
    d.setDate(d.getDate() + days);
    return DateUtil.toISO(d);
  },
  /** Whole days from b to a (a − b). */
  diffDays(a, b) {
    return Math.round((DateUtil.parse(a) - DateUtil.parse(b)) / 86400000);
  },
  /** @param {string} iso */
  format(iso) {
    return DateUtil.parse(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  },
});

/** @returns {string} */
const generateId = () =>
  globalThis.crypto?.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

/**
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} wait
 * @returns {F}
 */
const debounce = (fn, wait) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ==========================================================================
   3. ERRORS
   ========================================================================== */

/** Base class for expected application errors. */
class AppError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = 'APP_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

/** Input failed validation. `fields` maps input names to messages. */
class ValidationError extends AppError {
  /** @param {Record<string,string>} fields */
  constructor(fields) {
    super('Please correct the highlighted fields.', 'VALIDATION');
    this.fields = fields;
  }
}

/** A business rule prevented the operation (e.g. no copies available). */
class BusinessRuleError extends AppError {
  /** @param {string} message */
  constructor(message) { super(message, 'BUSINESS_RULE'); }
}

/** Entity does not exist (anymore). */
class NotFoundError extends AppError {
  /** @param {string} message */
  constructor(message) { super(message, 'NOT_FOUND'); }
}

/* ==========================================================================
   4. MODELS
   ========================================================================== */

/**
 * @typedef {Object} BookDto
 * @property {string} id
 * @property {string} title
 * @property {string} author
 * @property {string} isbn            Normalised: digits only (last char may be X for ISBN-10)
 * @property {string} category
 * @property {number} totalQty
 * @property {number} availableQty
 */

/**
 * @typedef {Object} IssueDto
 * @property {string} id
 * @property {string} bookId
 * @property {string} bookTitle       Snapshot kept for history if the book is later removed
 * @property {string} bookIsbn
 * @property {string} borrower
 * @property {string} [borrowerEmail]
 * @property {string} issuedOn        YYYY-MM-DD
 * @property {string} dueOn           YYYY-MM-DD
 * @property {string|null} returnedOn YYYY-MM-DD or null while on loan
 */

/** A catalogue book. */
class Book {
  /** @param {BookDto} dto */
  constructor({ id, title, author, isbn, category, totalQty, availableQty }) {
    Object.assign(this, { id, title, author, isbn, category, totalQty, availableQty });
  }
  /** Copies currently on loan. */
  get issuedQty() { return this.totalQty - this.availableQty; }
  get isAvailable() { return this.availableQty > 0; }
}

/**
 * @typedef {{state:'returned'|'overdue'|'due-today'|'on-time', days:number}} IssueStatus
 */

/** A loan of one copy of a book to a borrower. */
class Issue {
  /** @param {IssueDto} dto */
  constructor({ id, bookId, bookTitle, bookIsbn, borrower, borrowerEmail = '', issuedOn, dueOn, returnedOn = null }) {
    Object.assign(this, { id, bookId, bookTitle, bookIsbn, borrower, borrowerEmail, issuedOn, dueOn, returnedOn });
  }
  get isActive() { return !this.returnedOn; }

  /**
   * @param {string} [today]
   * @returns {IssueStatus}
   */
  getStatus(today = DateUtil.todayISO()) {
    if (this.returnedOn) return { state: 'returned', days: 0 };
    const remaining = DateUtil.diffDays(this.dueOn, today);
    if (remaining < 0) return { state: 'overdue', days: -remaining };
    if (remaining === 0) return { state: 'due-today', days: 0 };
    return { state: 'on-time', days: remaining };
  }
}

/** Pure filtering / sorting / pagination over an in-memory list of books. */
class BookQuery {
  static SORTABLE = new Set(['title', 'author', 'isbn', 'category', 'totalQty', 'availableQty']);

  /**
   * @param {Book[]} books
   * @param {{search?:string, categories?:Set<string>, availability?:Set<string>, sortKey?:string, sortDir?:'asc'|'desc'}} opts
   * @returns {Book[]}
   */
  static apply(books, { search = '', categories = new Set(), availability = new Set(), sortKey = 'title', sortDir = 'asc' } = {}) {
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/[-\s]/g, '');

    let result = books.filter((b) => {
      if (q) {
        const hit =
          b.title.toLowerCase().includes(q) ||
          b.author.toLowerCase().includes(q) ||
          (qDigits !== '' && b.isbn.toLowerCase().includes(qDigits));
        if (!hit) return false;
      }
      if (categories.size && !categories.has(b.category)) return false;
      if (availability.size) {
        const ok = (availability.has('in-stock') && b.availableQty > 0) ||
                   (availability.has('out-of-stock') && b.availableQty === 0);
        if (!ok) return false;
      }
      return true;
    });

    const key = BookQuery.SORTABLE.has(sortKey) ? sortKey : 'title';
    const dir = sortDir === 'desc' ? -1 : 1;
    result = result.sort((a, b) => {
      const cmp = typeof a[key] === 'number'
        ? a[key] - b[key]
        : String(a[key]).localeCompare(String(b[key]), undefined, { numeric: true, sensitivity: 'base' });
      return cmp * dir || a.title.localeCompare(b.title);
    });
    return result;
  }

  /**
   * @template T
   * @param {T[]} items
   * @param {number} page 1-based; clamped into range
   * @param {number} pageSize
   * @returns {{rows:T[], page:number, pageCount:number, total:number}}
   */
  static paginate(items, page, pageSize) {
    const total = items.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(Math.max(1, page), pageCount);
    const start = (current - 1) * pageSize;
    return { rows: items.slice(start, start + pageSize), page: current, pageCount, total };
  }
}

/** Input validation + normalisation. Returns cleaned values and per-field error messages. */
class Validator {
  /**
   * @param {Record<string, unknown>} raw
   * @returns {{values: Omit<BookDto,'id'|'availableQty'>, errors: Record<string,string>}}
   */
  static book(raw) {
    const errors = {};
    const title = Sanitizer.clean(raw.title, 200);
    const author = Sanitizer.clean(raw.author, 200);
    const category = Sanitizer.clean(raw.category, 60);
    const isbn = String(raw.isbn ?? '').replace(/[\s-]/g, '').toUpperCase();
    const totalQty = Number(raw.totalQty);

    if (!title) errors.title = 'Title is required.';
    if (!author) errors.author = 'Author is required.';
    if (!category) errors.category = 'Category is required.';
    if (!isbn) errors.isbn = 'ISBN is required.';
    else if (!/^(?:\d{13}|\d{9}[\dX])$/.test(isbn)) errors.isbn = 'Enter a valid 10 or 13 digit ISBN.';
    if (String(raw.totalQty ?? '').trim() === '' || !Number.isInteger(totalQty) || totalQty < 1 || totalQty > 9999) {
      errors.totalQty = 'Enter a whole number between 1 and 9999.';
    }
    return { values: { title, author, isbn, category, totalQty }, errors };
  }

  /**
   * @param {Record<string, unknown>} raw
   * @returns {{values:{borrower:string,email:string}, errors:Record<string,string>}}
   */
  static issue(raw) {
    const errors = {};
    const borrower = Sanitizer.clean(raw.borrower, 100);
    const email = Sanitizer.clean(raw.email, 120);
    if (borrower.length < 2) errors.borrower = 'Enter the borrower’s name (at least 2 characters).';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.';
    return { values: { borrower, email }, errors };
  }
}

/* ==========================================================================
   5. DATA ACCESS — REPOSITORY PATTERN
   ========================================================================== */

/**
 * Repository contract. Every method is async so that synchronous storage and network
 * back-ends are interchangeable. Implementations exchange plain DTO objects.
 * @interface
 */
class Repository {
  /** @returns {Promise<Object[]>} */
  async findAll() { throw new Error('Not implemented'); }
  /** @param {string} id @returns {Promise<Object|null>} */
  async findById(id) { throw new Error('Not implemented'); }
  /** @param {Object} entity @returns {Promise<Object>} the persisted entity (with id) */
  async create(entity) { throw new Error('Not implemented'); }
  /** @param {string} id @param {Object} patch @returns {Promise<Object>} the updated entity */
  async update(id, patch) { throw new Error('Not implemented'); }
  /** @param {string} id @returns {Promise<void>} */
  async remove(id) { throw new Error('Not implemented'); }
}

/** Browser localStorage implementation (JSON array per entity). */
class LocalStorageRepository extends Repository {
  #key;
  #storage;

  /**
   * @param {string} entityName   Used to build the storage key
   * @param {{seed?:Object[], storage?:Storage}} [opts]  `seed` is written only when the key does not exist yet
   */
  constructor(entityName, { seed = [], storage = globalThis.localStorage } = {}) {
    super();
    this.#key = `${CONFIG.STORAGE_PREFIX}${entityName}`;
    this.#storage = storage;
    if (this.#storage.getItem(this.#key) === null) this.#write(seed);
  }

  #read() {
    try {
      const parsed = JSON.parse(this.#storage.getItem(this.#key));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  #write(items) {
    try {
      this.#storage.setItem(this.#key, JSON.stringify(items));
    } catch (err) {
      throw new AppError('Could not save data to browser storage (quota exceeded or storage disabled).', 'STORAGE');
    }
  }

  async findAll() { return this.#read(); }

  async findById(id) { return this.#read().find((e) => e.id === id) ?? null; }

  async create(entity) {
    const items = this.#read();
    const created = { ...entity, id: entity.id ?? generateId() };
    items.push(created);
    this.#write(items);
    return { ...created };
  }

  async update(id, patch) {
    const items = this.#read();
    const idx = items.findIndex((e) => e.id === id);
    if (idx === -1) throw new NotFoundError('The record no longer exists.');
    items[idx] = { ...items[idx], ...patch, id };
    this.#write(items);
    return { ...items[idx] };
  }

  async remove(id) {
    const items = this.#read();
    const next = items.filter((e) => e.id !== id);
    if (next.length === items.length) throw new NotFoundError('The record no longer exists.');
    this.#write(next);
  }
}

/**
 * SAP CAP OData V4 implementation (drop-in replacement for LocalStorageRepository).
 *
 * Expected service (CDS): `service LibraryService { entity Books {...}; entity Issues {...}; }`
 * served at CONFIG.ODATA_BASE_URL with `cuid` (UUID) keys. Use `fromOData` / `toOData` to map
 * property names or types if the CDS model differs from the DTOs documented above.
 *
 * Production notes:
 *  - CAP server-driven paging: follow `@odata.nextLink` (or request `$top`) for large sets.
 *  - Authentication (XSUAA/IAS) is handled by the approuter/session; add headers via `headers`.
 *  - For strict atomicity, expose `issueBook` / `returnBook` as CAP actions and have
 *    LibraryService call them; the Service interface already hides this from the UI.
 */
class ODataRepository extends Repository {
  #baseUrl;
  #entitySet;
  #fetch;
  #headers;
  #fromOData;
  #toOData;

  /**
   * @param {{baseUrl:string, entitySet:string, fetchImpl?:typeof fetch, headers?:Record<string,string>,
   *          fromOData?:(o:Object)=>Object, toOData?:(o:Object)=>Object}} opts
   */
  constructor({ baseUrl, entitySet, fetchImpl, headers = {}, fromOData = (o) => o, toOData = (o) => o }) {
    super();
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#entitySet = entitySet;
    this.#fetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.#headers = headers;
    this.#fromOData = fromOData;
    this.#toOData = toOData;
  }

  /** OData V4 key predicate for UUID keys, e.g. Books(0b6c…). */
  #keyPath(id) { return `(${encodeURIComponent(id)})`; }

  /**
   * @param {string} path
   * @param {{method?:string, body?:Object}} [opts]
   */
  async #request(path = '', { method = 'GET', body } = {}) {
    const res = await this.#fetch(`${this.#baseUrl}/${this.#entitySet}${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' && method !== 'DELETE' ? { Prefer: 'return=representation' } : {}),
        ...this.#headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 404) throw new NotFoundError('The record no longer exists.');
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message ?? ''; } catch { /* non-JSON error body */ }
      throw new AppError(detail || `Request failed (HTTP ${res.status}).`, 'HTTP_ERROR');
    }
    return res.status === 204 ? null : res.json();
  }

  async findAll() {
    const json = await this.#request();
    return (json?.value ?? []).map(this.#fromOData);
  }

  async findById(id) {
    try {
      return this.#fromOData(await this.#request(this.#keyPath(id)));
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  async create(entity) {
    const { id, ...rest } = entity; // let the server generate the key
    return this.#fromOData(await this.#request('', { method: 'POST', body: this.#toOData(rest) }));
  }

  async update(id, patch) {
    const { id: _ignored, ...rest } = patch;
    return this.#fromOData(await this.#request(this.#keyPath(id), { method: 'PATCH', body: this.#toOData(rest) }));
  }

  async remove(id) {
    await this.#request(this.#keyPath(id), { method: 'DELETE' });
  }
}

/**
 * Seed data for first run (localStorage only). Dates are relative to today so that
 * the demo always contains on-time, due-today and overdue loans.
 * @returns {{books: BookDto[], issues: IssueDto[]}}
 */
function buildSeedData() {
  const today = DateUtil.todayISO();
  const ago = (n) => DateUtil.addDays(today, -n);
  const loanDays = CONFIG.LOAN_PERIOD_DAYS;

  const catalogue = [
    ['Clean Code', 'Robert C. Martin', '9780132350884', 'Software Engineering', 4],
    ['The Pragmatic Programmer', 'Andrew Hunt, David Thomas', '9780135957059', 'Software Engineering', 3],
    ['Designing Data-Intensive Applications', 'Martin Kleppmann', '9781449373320', 'Software Engineering', 2],
    ['Sapiens', 'Yuval Noah Harari', '9780062316097', 'History', 5],
    ['A Brief History of Time', 'Stephen Hawking', '9780553380163', 'Science', 3],
    ['Cosmos', 'Carl Sagan', '9780345539434', 'Science', 2],
    ['The God of Small Things', 'Arundhati Roy', '9780812979657', 'Fiction', 4],
    ['1984', 'George Orwell', '9780451524935', 'Fiction', 6],
    ['Atomic Habits', 'James Clear', '9780735211292', 'Self-Help', 3],
    ['Thinking, Fast and Slow', 'Daniel Kahneman', '9780374533557', 'Psychology', 2],
    ['The Lean Startup', 'Eric Ries', '9780307887894', 'Business', 3],
    ['Zero to One', 'Peter Thiel', '9780804139298', 'Business', 1],
    ['Educated', 'Tara Westover', '9780399590504', 'Biography', 2],
  ];

  const books = catalogue.map(([title, author, isbn, category, totalQty], i) => ({
    id: `book-${String(i + 1).padStart(3, '0')}`, title, author, isbn, category, totalQty, availableQty: totalQty,
  }));

  // [bookIndex, borrower, daysAgoIssued, daysAgoReturned|null]
  const loans = [
    [3, 'Priya Nair', 20, null],      // overdue by 6 days
    [7, 'Arjun Mehta', 5, null],      // on time
    [0, 'Meera Iyer', loanDays, null],// due today
    [8, 'Karthik Rao', 2, null],      // on time
    [11, 'Divya Krishnan', 3, null],  // makes "Zero to One" unavailable
    [6, 'Rahul Sharma', 17, null],    // overdue by 3 days
    [2, 'Sneha Pillai', 30, 20],      // returned (history)
  ];

  const issues = loans.map(([bi, borrower, issuedAgo, returnedAgo], i) => {
    const book = books[bi];
    const issuedOn = ago(issuedAgo);
    if (returnedAgo === null) book.availableQty -= 1;
    return {
      id: `issue-${String(i + 1).padStart(3, '0')}`,
      bookId: book.id, bookTitle: book.title, bookIsbn: book.isbn,
      borrower, borrowerEmail: '',
      issuedOn, dueOn: DateUtil.addDays(issuedOn, loanDays),
      returnedOn: returnedAgo === null ? null : ago(returnedAgo),
    };
  });

  return { books, issues };
}

/**
 * Composition root for data access — the ONLY place that knows which back-end is used.
 * @param {typeof CONFIG} [config]
 * @param {{storage?: Storage}} [deps]
 * @returns {{books: Repository, issues: Repository}}
 */
function createRepositories(config = CONFIG, deps = {}) {
  if (config.DATA_SOURCE === 'odata') {
    return {
      books: new ODataRepository({ baseUrl: config.ODATA_BASE_URL, entitySet: 'Books' }),
      issues: new ODataRepository({ baseUrl: config.ODATA_BASE_URL, entitySet: 'Issues' }),
    };
  }
  const seed = buildSeedData();
  return {
    books: new LocalStorageRepository('books', { seed: seed.books, ...deps }),
    issues: new LocalStorageRepository('issues', { seed: seed.issues, ...deps }),
  };
}

/* ==========================================================================
   6. SERVICE LAYER — BUSINESS RULES
   ========================================================================== */

/**
 * @typedef {Object} LibraryStats
 * @property {number} titles
 * @property {number} copies
 * @property {number} availableCopies
 * @property {number} activeLoans
 * @property {number} overdue
 */

/**
 * Application service. Contains every business rule and knows nothing about the DOM or
 * the concrete persistence technology (only the {@link Repository} contract).
 */
class LibraryService {
  #books;
  #issues;
  #loanDays;

  /**
   * @param {Repository} bookRepo
   * @param {Repository} issueRepo
   * @param {{loanPeriodDays?:number}} [opts]
   */
  constructor(bookRepo, issueRepo, { loanPeriodDays = CONFIG.LOAN_PERIOD_DAYS } = {}) {
    this.#books = bookRepo;
    this.#issues = issueRepo;
    this.#loanDays = loanPeriodDays;
  }

  /** @returns {Promise<Book[]>} */
  async getBooks() { return (await this.#books.findAll()).map((d) => new Book(d)); }

  /** @returns {Promise<Issue[]>} */
  async getIssues() { return (await this.#issues.findAll()).map((d) => new Issue(d)); }

  /** @param {string} [from] YYYY-MM-DD @returns {string} due date = from + loan period */
  calculateDueDate(from = DateUtil.todayISO()) { return DateUtil.addDays(from, this.#loanDays); }

  /**
   * @param {Book[]} books
   * @param {Issue[]} issues
   * @param {string} [today]
   * @returns {LibraryStats}
   */
  computeStats(books, issues, today = DateUtil.todayISO()) {
    const active = issues.filter((i) => i.isActive);
    return {
      titles: books.length,
      copies: books.reduce((s, b) => s + b.totalQty, 0),
      availableCopies: books.reduce((s, b) => s + b.availableQty, 0),
      activeLoans: active.length,
      overdue: active.filter((i) => i.getStatus(today).state === 'overdue').length,
    };
  }

  /* ----- Book CRUD ----- */

  /**
   * @param {Record<string,unknown>} raw
   * @returns {Promise<Book>}
   * @throws {ValidationError}
   */
  async addBook(raw) {
    const { values, errors } = Validator.book(raw);
    await this.#checkIsbnUnique(values.isbn, null, errors);
    if (Object.keys(errors).length) throw new ValidationError(errors);
    return new Book(await this.#books.create({ ...values, availableQty: values.totalQty }));
  }

  /**
   * Updates a book. Available quantity is re-derived so that copies on loan stay consistent.
   * @param {string} id
   * @param {Record<string,unknown>} raw
   * @returns {Promise<Book>}
   * @throws {ValidationError|NotFoundError}
   */
  async updateBook(id, raw) {
    const existing = await this.#books.findById(id);
    if (!existing) throw new NotFoundError('This book no longer exists.');

    const { values, errors } = Validator.book(raw);
    await this.#checkIsbnUnique(values.isbn, id, errors);

    const onLoan = existing.totalQty - existing.availableQty;
    if (!errors.totalQty && values.totalQty < onLoan) {
      errors.totalQty = `Cannot be lower than the ${onLoan} ${onLoan === 1 ? 'copy' : 'copies'} currently on loan.`;
    }
    if (Object.keys(errors).length) throw new ValidationError(errors);

    return new Book(await this.#books.update(id, { ...values, availableQty: values.totalQty - onLoan }));
  }

  /**
   * Deletes a book unless copies are still on loan.
   * @param {string} id
   * @returns {Promise<void>}
   * @throws {BusinessRuleError|NotFoundError}
   */
  async deleteBook(id) {
    const book = await this.#books.findById(id);
    if (!book) throw new NotFoundError('This book no longer exists.');
    const activeLoans = (await this.getIssues()).filter((i) => i.bookId === id && i.isActive).length;
    const onLoan = Math.max(activeLoans, book.totalQty - book.availableQty);
    if (onLoan > 0) {
      throw new BusinessRuleError(
        `“${book.title}” cannot be deleted while ${onLoan} ${onLoan === 1 ? 'copy is' : 'copies are'} on loan.`);
    }
    await this.#books.remove(id);
  }

  /* ----- Issue / return lifecycle ----- */

  /**
   * Issues one copy of a book.
   * Rules: book must exist; availableQty > 0; the same borrower may not hold two copies of the
   * same title. Decrements availableQty and sets due date = today + loan period.
   *
   * NOTE: with a real backend this read-check-write sequence should run server-side as one
   * transaction (CAP action). The compensation below keeps the localStorage variant consistent.
   *
   * @param {string} bookId
   * @param {Record<string,unknown>} raw  { borrower, email }
   * @returns {Promise<Issue>}
   * @throws {ValidationError|BusinessRuleError|NotFoundError}
   */
  async issueBook(bookId, raw) {
    const { values, errors } = Validator.issue(raw);
    if (Object.keys(errors).length) throw new ValidationError(errors);

    const book = await this.#books.findById(bookId); // fresh read, never trust UI state
    if (!book) throw new NotFoundError('This book no longer exists.');
    if (book.availableQty <= 0) {
      throw new BusinessRuleError(`No copies of “${book.title}” are available to issue.`);
    }

    const sameBorrower = (await this.getIssues()).some(
      (i) => i.isActive && i.bookId === bookId && i.borrower.toLowerCase() === values.borrower.toLowerCase());
    if (sameBorrower) {
      throw new BusinessRuleError(`${values.borrower} already has a copy of “${book.title}” on loan.`);
    }

    const issuedOn = DateUtil.todayISO();
    const issue = await this.#issues.create({
      bookId, bookTitle: book.title, bookIsbn: book.isbn,
      borrower: values.borrower, borrowerEmail: values.email,
      issuedOn, dueOn: this.calculateDueDate(issuedOn), returnedOn: null,
    });

    try {
      await this.#books.update(bookId, { availableQty: book.availableQty - 1 });
    } catch (err) {
      await this.#issues.remove(issue.id).catch(() => {}); // compensate
      throw err;
    }
    return new Issue(issue);
  }

  /**
   * Returns a loan: stamps returnedOn and increments availableQty (never above totalQty).
   * @param {string} issueId
   * @returns {Promise<{issue: Issue, overdueDays: number}>}
   * @throws {BusinessRuleError|NotFoundError}
   */
  async returnBook(issueId) {
    const dto = await this.#issues.findById(issueId);
    if (!dto) throw new NotFoundError('This loan no longer exists.');
    const issue = new Issue(dto);
    if (!issue.isActive) throw new BusinessRuleError('This book has already been returned.');

    const today = DateUtil.todayISO();
    const overdueDays = Math.max(0, DateUtil.diffDays(today, issue.dueOn));
    const updated = await this.#issues.update(issueId, { returnedOn: today });

    try {
      const book = await this.#books.findById(issue.bookId);
      if (book) await this.#books.update(book.id, { availableQty: Math.min(book.totalQty, book.availableQty + 1) });
    } catch (err) {
      await this.#issues.update(issueId, { returnedOn: null }).catch(() => {}); // compensate
      throw err;
    }
    return { issue: new Issue(updated), overdueDays };
  }

  /**
   * @param {string} isbn
   * @param {string|null} ignoreId
   * @param {Record<string,string>} errors mutated in place
   */
  async #checkIsbnUnique(isbn, ignoreId, errors) {
    if (errors.isbn || !isbn) return;
    const clash = (await this.#books.findAll()).find((b) => b.isbn === isbn && b.id !== ignoreId);
    if (clash) errors.isbn = `This ISBN is already used by “${clash.title}”.`;
  }
}

/* ==========================================================================
   7. VIEW
   ========================================================================== */

/** Global toast notifications (replaces alert()). All text is inserted with textContent. */
class ToastManager {
  #container;
  #max = 5;
  #icons = { success: '✓', error: '✕', warning: '!', info: 'i' };

  /** @param {HTMLElement} container live-region element */
  constructor(container) { this.#container = container; }

  /**
   * @param {'success'|'error'|'warning'|'info'} type
   * @param {string} message
   * @param {{duration?:number}} [opts] duration in ms (0 = sticky)
   * @returns {HTMLElement}
   */
  show(type, message, { duration } = {}) {
    const ms = duration ?? (type === 'error' ? CONFIG.TOAST_ERROR_DURATION_MS : CONFIG.TOAST_DURATION_MS);
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.setAttribute('role', type === 'error' || type === 'warning' ? 'alert' : 'status');

    const icon = document.createElement('span');
    icon.className = 'toast__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = this.#icons[type] ?? 'i';

    const text = document.createElement('span');
    text.className = 'toast__message';
    text.textContent = message;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast__close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '✕';

    toast.append(icon, text, close);
    this.#container.append(toast);
    while (this.#container.children.length > this.#max) this.#container.firstElementChild.remove();

    let timer = null;
    const dismiss = () => {
      clearTimeout(timer);
      toast.classList.add('toast--leaving');
      setTimeout(() => toast.remove(), 200);
    };
    const start = () => { if (ms > 0) timer = setTimeout(dismiss, ms); };
    const pause = () => clearTimeout(timer);

    close.addEventListener('click', dismiss);
    toast.addEventListener('mouseenter', pause);
    toast.addEventListener('mouseleave', start);
    toast.addEventListener('focusin', pause);
    toast.addEventListener('focusout', start);
    start();
    return toast;
  }

  success(message, opts) { return this.show('success', message, opts); }
  error(message, opts) { return this.show('error', message, opts); }
  warning(message, opts) { return this.show('warning', message, opts); }
  info(message, opts) { return this.show('info', message, opts); }
}

/**
 * @typedef {Object} ViewHandlers
 * @property {(value:string)=>void} onSearch
 * @property {(f:{categories:Set<string>, availability:Set<string>})=>void} onFilterChange
 * @property {()=>void} onClearFilters
 * @property {(key:string)=>void} onSort
 * @property {(page:number)=>void} onPage
 * @property {(size:number)=>void} onPageSize
 * @property {()=>void} onAddBook
 * @property {(action:string, id:string)=>void} onBookAction
 * @property {()=>void} onBookSubmit
 * @property {()=>void} onIssueSubmit
 * @property {(value:string)=>void} onIssueSearch
 * @property {(on:boolean)=>void} onOverdueToggle
 * @property {(action:string, id:string)=>void} onIssueAction
 * @property {(route:'books'|'issues', opts:{focus:boolean})=>void} onRouteChange
 */

/** Renders state into the DOM and reports user intent to the controller. Contains no business logic. */
class LibraryView {
  /** @param {Document} doc */
  constructor(doc) {
    const $ = (id) => doc.getElementById(id);
    this.doc = doc;
    this.els = {
      main: $('main'),
      viewBooks: $('view-books'), viewIssues: $('view-issues'),
      navBooks: $('nav-books'), navIssues: $('nav-issues'), overdueBadge: $('overdue-badge'),
      themeToggle: $('theme-toggle'), themeIcon: $('theme-icon'),
      filters: $('filters'), search: $('book-search'), categoryFilter: $('category-filter'),
      clearFilters: $('clear-filters'), addBook: $('add-book-btn'),
      resultCount: $('result-count'), booksTableWrap: $('books-table-wrap'), booksTable: $('books-table'),
      booksBody: $('books-body'), pageSize: $('page-size'), pagination: $('pagination'),
      stats: $('stats'), issueSearch: $('issue-search'), overdueOnly: $('overdue-only'),
      issueCount: $('issue-count'), issuesBody: $('issues-body'),
      bookDialog: $('book-dialog'), bookDialogTitle: $('book-dialog-title'), bookForm: $('book-form'),
      bookSubmit: $('book-submit'), categoryOptions: $('category-options'),
      issueDialog: $('issue-dialog'), issueForm: $('issue-form'), issueInfo: $('issue-info'), issueSubmit: $('issue-submit'),
      confirmDialog: $('confirm-dialog'), confirmTitle: $('confirm-title'), confirmMessage: $('confirm-message'), confirmOk: $('confirm-ok'),
    };
    this.#renderPageSizes();
  }

  /* ----- wiring ----- */

  /** @param {ViewHandlers} h */
  bind(h) {
    const e = this.els;

    // Filters
    e.filters.addEventListener('submit', (ev) => ev.preventDefault());
    const debouncedSearch = debounce((v) => h.onSearch(v), CONFIG.SEARCH_DEBOUNCE_MS);
    e.search.addEventListener('input', (ev) => debouncedSearch(ev.target.value));
    e.filters.addEventListener('change', (ev) => {
      if (ev.target.matches('input[type="checkbox"]')) h.onFilterChange(this.#readFilters());
    });
    e.clearFilters.addEventListener('click', () => { this.resetFilters(); h.onClearFilters(); });

    // Table
    e.booksTable.querySelector('thead').addEventListener('click', (ev) => {
      const btn = ev.target.closest('.sort-btn');
      if (btn) h.onSort(btn.dataset.sort);
    });
    e.booksBody.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-action]');
      if (btn && !btn.disabled) h.onBookAction(btn.dataset.action, btn.dataset.id);
    });
    e.pagination.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-page]');
      if (btn && !btn.disabled) h.onPage(Number(btn.dataset.page));
    });
    e.pageSize.addEventListener('change', (ev) => h.onPageSize(Number(ev.target.value)));
    e.addBook.addEventListener('click', () => h.onAddBook());

    // Forms
    e.bookForm.addEventListener('submit', (ev) => { ev.preventDefault(); h.onBookSubmit(); });
    e.issueForm.addEventListener('submit', (ev) => { ev.preventDefault(); h.onIssueSubmit(); });
    for (const form of [e.bookForm, e.issueForm]) {
      form.addEventListener('input', (ev) => this.#clearFieldError(form, ev.target));
    }

    // Dialog close affordances (X / Cancel buttons, backdrop click)
    for (const dlg of [e.bookDialog, e.issueDialog]) {
      dlg.addEventListener('click', (ev) => {
        if (ev.target === dlg || ev.target.closest('[data-close]')) dlg.close();
      });
    }

    // Active issues
    const debouncedIssueSearch = debounce((v) => h.onIssueSearch(v), CONFIG.SEARCH_DEBOUNCE_MS);
    e.issueSearch.addEventListener('input', (ev) => debouncedIssueSearch(ev.target.value));
    e.issueSearch.form.addEventListener('submit', (ev) => ev.preventDefault());
    e.overdueOnly.addEventListener('change', (ev) => h.onOverdueToggle(ev.target.checked));
    e.issuesBody.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-action]');
      if (btn) h.onIssueAction(btn.dataset.action, btn.dataset.id);
    });

    // Routing (hash based)
    const route = () => (location.hash.startsWith('#/issues') ? 'issues' : 'books');
    this.doc.defaultView.addEventListener('hashchange', () => h.onRouteChange(route(), { focus: true }));
    h.onRouteChange(route(), { focus: false });

    // Theme
    this.#initTheme();
  }

  /* ----- navigation ----- */

  /**
   * @param {'books'|'issues'} route
   * @param {{focus?:boolean}} [opts]
   */
  showRoute(route, { focus = false } = {}) {
    const isBooks = route === 'books';
    this.els.viewBooks.hidden = !isBooks;
    this.els.viewIssues.hidden = isBooks;
    this.#setCurrent(this.els.navBooks, isBooks);
    this.#setCurrent(this.els.navIssues, !isBooks);
    this.doc.title = `${isBooks ? 'Books' : 'Active Issues'} · Library Management`;
    if (focus) this.els.main.focus();
  }

  #setCurrent(link, on) {
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  /** @param {boolean} busy */
  setBusy(busy) {
    this.els.booksTableWrap.setAttribute('aria-busy', String(busy));
  }

  /* ----- theme ----- */

  #initTheme() {
    const win = this.doc.defaultView;
    let stored = null;
    try { stored = win.localStorage.getItem('lms.theme'); } catch { /* storage unavailable */ }
    const prefersDark = win.matchMedia?.('(prefers-color-scheme: dark)').matches;
    this.#applyTheme(stored ?? (prefersDark ? 'dark' : 'light'));

    this.els.themeToggle.addEventListener('click', () => {
      const next = this.doc.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      this.#applyTheme(next);
      try { win.localStorage.setItem('lms.theme', next); } catch { /* ignore */ }
    });
  }

  #applyTheme(theme) {
    this.doc.documentElement.dataset.theme = theme;
    this.els.themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
    this.els.themeIcon.textContent = theme === 'dark' ? '☀' : '☾';
  }

  /* ----- filters ----- */

  #readFilters() {
    const checked = (name) => new Set(
      [...this.els.filters.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value));
    return { categories: checked('category'), availability: checked('availability') };
  }

  /**
   * @param {string[]} categories
   * @param {Set<string>} selected
   */
  renderCategoryFilter(categories, selected) {
    setHtml(this.els.categoryFilter, html`${categories.map((c) => html`
      <label class="check"><input type="checkbox" name="category" value="${c}" ${selected.has(c) ? 'checked' : ''} /> ${c}</label>`)}`);
  }

  resetFilters() {
    this.els.search.value = '';
    this.els.filters.querySelectorAll('input[type="checkbox"]').forEach((i) => { i.checked = false; });
  }

  #renderPageSizes() {
    setHtml(this.els.pageSize, html`${CONFIG.PAGE_SIZES.map((n) =>
      html`<option value="${n}" ${n === CONFIG.DEFAULT_PAGE_SIZE ? 'selected' : ''}>${n}</option>`)}`);
  }

  /* ----- books table ----- */

  /**
   * @param {{rows:Book[], total:number, allCount:number, page:number, pageCount:number,
   *          pageSize:number, sortKey:string, sortDir:'asc'|'desc', hasFilters:boolean}} vm
   */
  renderBooks({ rows, total, allCount, page, pageCount, pageSize, sortKey, sortDir, hasFilters }) {
    const e = this.els;

    // Sort indicators (aria-sort on <th>)
    e.booksTable.querySelectorAll('thead th').forEach((th) => {
      const btn = th.querySelector('.sort-btn');
      if (!btn) return;
      th.setAttribute('aria-sort', btn.dataset.sort === sortKey ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    });

    if (rows.length === 0) {
      const msg = allCount === 0
        ? 'The catalogue is empty. Use “Add book” to create the first entry.'
        : 'No books match your search or filters.';
      setHtml(e.booksBody, html`<tr><td colspan="7" class="empty">${msg}</td></tr>`);
    } else {
      setHtml(e.booksBody, html`${rows.map((b) => html`
        <tr>
          <th scope="row" data-label="Title">${b.title}</th>
          <td data-label="Author">${b.author}</td>
          <td data-label="ISBN" class="mono">${b.isbn}</td>
          <td data-label="Category"><span class="chip chip--neutral">${b.category}</span></td>
          <td data-label="Total" class="num">${b.totalQty}</td>
          <td data-label="Available" class="num">
            <span class="chip ${b.isAvailable ? 'chip--success' : 'chip--danger'}">${b.isAvailable ? `${b.availableQty} in stock` : 'Unavailable'}</span>
          </td>
          <td class="cell-actions">
            <button type="button" class="btn btn--sm btn--primary" data-action="issue" data-id="${b.id}"
                    aria-label="Issue ${b.title}" ${b.isAvailable ? '' : 'disabled'}
                    ${b.isAvailable ? '' : raw('title="No copies available"')}>Issue</button>
            <button type="button" class="btn btn--sm btn--secondary" data-action="edit" data-id="${b.id}"
                    aria-label="Edit ${b.title}">Edit</button>
            <button type="button" class="btn btn--sm btn--danger" data-action="delete" data-id="${b.id}"
                    aria-label="Delete ${b.title}">Delete</button>
          </td>
        </tr>`)}`);
    }

    const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const to = Math.min(page * pageSize, total);
    e.resultCount.textContent = total === 0
      ? (hasFilters ? `0 of ${plural(allCount, 'book')} match` : '')
      : `Showing ${from}–${to} of ${plural(total, 'book')}${hasFilters ? ` (filtered from ${allCount})` : ''}`;

    this.#renderPagination(page, pageCount);
  }

  #renderPagination(page, pageCount) {
    const pages = new Set([1, pageCount, page - 1, page, page + 1]);
    const sorted = [...pages].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
    const items = [];
    let prev = 0;
    for (const p of sorted) {
      if (p - prev > 1) items.push('…');
      items.push(p);
      prev = p;
    }

    setHtml(this.els.pagination, html`
      <button type="button" class="page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>
      ${items.map((p) => p === '…'
        ? html`<span class="page-ellipsis" aria-hidden="true">…</span>`
        : html`<button type="button" class="page-btn" data-page="${p}" aria-label="Page ${p}" ${p === page ? raw('aria-current="page"') : ''}>${p}</button>`)}
      <button type="button" class="page-btn" data-page="${page + 1}" ${page >= pageCount ? 'disabled' : ''} aria-label="Next page">›</button>`);
  }

  /* ----- active issues ----- */

  /** @param {LibraryStats} s */
  renderStats(s) {
    setHtml(this.els.stats, html`
      <div class="stat"><dt class="stat__label">Book titles</dt><dd class="stat__value">${s.titles}</dd></div>
      <div class="stat stat--success"><dt class="stat__label">Copies available</dt><dd class="stat__value">${s.availableCopies} <small>/ ${s.copies}</small></dd></div>
      <div class="stat"><dt class="stat__label">Active loans</dt><dd class="stat__value">${s.activeLoans}</dd></div>
      <div class="stat ${s.overdue > 0 ? 'stat--danger' : ''}"><dt class="stat__label">Overdue</dt><dd class="stat__value">${s.overdue}</dd></div>`);

    const badge = this.els.overdueBadge;
    badge.hidden = s.overdue === 0;
    badge.textContent = String(s.overdue);
    badge.setAttribute('aria-label', `${plural(s.overdue, 'overdue loan')}`);
  }

  /**
   * @param {Issue[]} rows active issues to display
   * @param {number} totalActive active issues before filtering
   * @param {string} today
   */
  renderIssues(rows, totalActive, today) {
    if (rows.length === 0) {
      const msg = totalActive === 0 ? 'No books are currently on loan.' : 'No active issues match your filters.';
      setHtml(this.els.issuesBody, html`<tr><td colspan="7" class="empty">${msg}</td></tr>`);
    } else {
      setHtml(this.els.issuesBody, html`${rows.map((i) => {
        const st = i.getStatus(today);
        const chip = {
          overdue: ['chip--danger', `Overdue by ${plural(st.days, 'day')}`],
          'due-today': ['chip--warning', 'Due today'],
          'on-time': ['chip--success', `${plural(st.days, 'day')} left`],
        }[st.state];
        return html`
          <tr class="${st.state === 'overdue' ? 'row--overdue' : ''}">
            <th scope="row" data-label="Book">${i.bookTitle}</th>
            <td data-label="ISBN" class="mono">${i.bookIsbn}</td>
            <td data-label="Borrower">${i.borrower}${i.borrowerEmail ? html`<span class="cell-sub">${i.borrowerEmail}</span>` : ''}</td>
            <td data-label="Issued on">${DateUtil.format(i.issuedOn)}</td>
            <td data-label="Due date">${DateUtil.format(i.dueOn)}</td>
            <td data-label="Status"><span class="chip ${chip[0]}">${chip[1]}</span></td>
            <td class="cell-actions">
              <button type="button" class="btn btn--sm btn--primary" data-action="return" data-id="${i.id}"
                      aria-label="Return ${i.bookTitle} from ${i.borrower}">Return</button>
            </td>
          </tr>`;
      })}`);
    }
    this.els.issueCount.textContent = totalActive === 0 ? '' : `Showing ${rows.length} of ${plural(totalActive, 'active loan')}`;
  }

  /* ----- dialogs ----- */

  /**
   * @param {Book|null} book null for "add"
   * @param {string[]} categories suggestions for the category field
   */
  openBookDialog(book, categories) {
    const { bookForm: form, bookDialog: dlg } = this.els;
    form.reset();
    this.#applyErrors(form, {}, false);
    this.els.bookDialogTitle.textContent = book ? 'Edit book' : 'Add book';
    this.els.bookSubmit.textContent = book ? 'Save changes' : 'Add book';

    this.els.categoryOptions.replaceChildren(...categories.map((c) => {
      const o = this.doc.createElement('option');
      o.value = c;
      return o;
    }));

    form.elements.id.value = book?.id ?? '';
    if (book) {
      form.elements.title.value = book.title;
      form.elements.author.value = book.author;
      form.elements.isbn.value = book.isbn;
      form.elements.category.value = book.category;
      form.elements.totalQty.value = book.totalQty;
    }
    dlg.showModal();
  }

  closeBookDialog() { this.els.bookDialog.close(); }

  /** @returns {Record<string, string>} */
  readBookForm() { return Object.fromEntries(new FormData(this.els.bookForm)); }

  /** @param {Record<string,string>} errors */
  showBookErrors(errors) { this.#applyErrors(this.els.bookForm, errors); }

  /**
   * @param {Book} book
   * @param {string} dueOn
   */
  openIssueDialog(book, dueOn) {
    const { issueForm: form } = this.els;
    form.reset();
    this.#applyErrors(form, {}, false);
    form.elements.bookId.value = book.id;
    this.els.issueInfo.textContent =
      `“${book.title}” — ${book.availableQty} of ${book.totalQty} copies available. Due date: ${DateUtil.format(dueOn)}.`;
    this.els.issueDialog.showModal();
  }

  closeIssueDialog() { this.els.issueDialog.close(); }

  /** @returns {Record<string, string>} */
  readIssueForm() { return Object.fromEntries(new FormData(this.els.issueForm)); }

  /** @param {Record<string,string>} errors */
  showIssueErrors(errors) { this.#applyErrors(this.els.issueForm, errors); }

  /** @param {'book'|'issue'} which @param {boolean} busy */
  setFormBusy(which, busy) {
    const btn = which === 'book' ? this.els.bookSubmit : this.els.issueSubmit;
    btn.disabled = busy;
    btn.setAttribute('aria-busy', String(busy));
  }

  /**
   * Promise-based accessible confirmation dialog.
   * @param {{title:string, message:string, confirmLabel?:string, danger?:boolean}} opts
   * @returns {Promise<boolean>}
   */
  confirm({ title, message, confirmLabel = 'Confirm', danger = false }) {
    const { confirmDialog: dlg, confirmOk } = this.els;
    this.els.confirmTitle.textContent = title;
    this.els.confirmMessage.textContent = message;
    confirmOk.textContent = confirmLabel;
    confirmOk.classList.toggle('btn--primary', !danger);
    confirmOk.classList.toggle('btn--danger-solid', danger);

    return new Promise((resolve) => {
      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'confirm');
      };
      dlg.addEventListener('close', onClose);
      dlg.returnValue = '';
      dlg.showModal();
    });
  }

  /* ----- form error helpers ----- */

  /**
   * @param {HTMLFormElement} form
   * @param {Record<string,string>} errors
   * @param {boolean} [focusFirst=true]
   */
  #applyErrors(form, errors, focusFirst = true) {
    form.querySelectorAll('[data-error-for]').forEach((p) => {
      const name = p.dataset.errorFor;
      const msg = errors[name] ?? '';
      p.textContent = msg;
      p.hidden = !msg;
      const input = form.elements[name];
      if (!input) return;
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    });
    const first = Object.keys(errors)[0];
    if (focusFirst && first) form.elements[first]?.focus();
  }

  #clearFieldError(form, input) {
    if (!input?.name) return;
    const p = form.querySelector(`[data-error-for="${input.name}"]`);
    if (!p || p.hidden) return;
    p.hidden = true;
    p.textContent = '';
    input.removeAttribute('aria-invalid');
  }
}

/* ==========================================================================
   8. CONTROLLER
   ========================================================================== */

/** Coordinates View ↔ Service. Owns UI state (search, sort, page, …) — not business rules. */
class LibraryController {
  #service;
  #view;
  #toasts;
  #state = {
    books: /** @type {Book[]} */ ([]),
    issues: /** @type {Issue[]} */ ([]),
    search: '',
    categories: new Set(),
    availability: new Set(),
    sortKey: 'title',
    sortDir: /** @type {'asc'|'desc'} */ ('asc'),
    page: 1,
    pageSize: CONFIG.DEFAULT_PAGE_SIZE,
    issueSearch: '',
    overdueOnly: false,
  };

  /**
   * @param {{service: LibraryService, view: LibraryView, toasts: ToastManager}} deps
   */
  constructor({ service, view, toasts }) {
    this.#service = service;
    this.#view = view;
    this.#toasts = toasts;
  }

  /** Binds the view and loads initial data. */
  async init() {
    this.#view.bind({
      onSearch: (v) => { this.#state.search = Sanitizer.clean(v, 100); this.#state.page = 1; this.#renderBooks(); },
      onFilterChange: ({ categories, availability }) => {
        Object.assign(this.#state, { categories, availability, page: 1 });
        this.#renderBooks();
      },
      onClearFilters: () => {
        Object.assign(this.#state, { search: '', categories: new Set(), availability: new Set(), page: 1 });
        this.#renderBooks();
      },
      onSort: (key) => this.#onSort(key),
      onPage: (page) => { this.#state.page = page; this.#renderBooks(); },
      onPageSize: (size) => { this.#state.pageSize = size; this.#state.page = 1; this.#renderBooks(); },
      onAddBook: () => this.#view.openBookDialog(null, this.#categories()),
      onBookAction: (action, id) => this.#onBookAction(action, id),
      onBookSubmit: () => this.#onBookSubmit(),
      onIssueSubmit: () => this.#onIssueSubmit(),
      onIssueSearch: (v) => { this.#state.issueSearch = Sanitizer.clean(v, 100); this.#renderIssues(); },
      onOverdueToggle: (on) => { this.#state.overdueOnly = on; this.#renderIssues(); },
      onIssueAction: (action, id) => this.#onIssueAction(action, id),
      onRouteChange: (route, opts) => this.#view.showRoute(route, opts),
    });
    await this.#refresh();
  }

  /* ----- data loading & rendering ----- */

  async #refresh() {
    this.#view.setBusy(true);
    try {
      const [books, issues] = await Promise.all([this.#service.getBooks(), this.#service.getIssues()]);
      this.#state.books = books;
      this.#state.issues = issues;

      const cats = this.#categories();
      this.#state.categories = new Set([...this.#state.categories].filter((c) => cats.includes(c)));
      this.#view.renderCategoryFilter(cats, this.#state.categories);

      this.#renderBooks();
      this.#renderIssues();
    } catch (err) {
      this.#handleError(err, 'Failed to load library data.');
    } finally {
      this.#view.setBusy(false);
    }
  }

  /** @returns {string[]} sorted distinct categories */
  #categories() {
    return [...new Set(this.#state.books.map((b) => b.category))].sort((a, b) => a.localeCompare(b));
  }

  #renderBooks() {
    const s = this.#state;
    const filtered = BookQuery.apply(s.books, {
      search: s.search, categories: s.categories, availability: s.availability, sortKey: s.sortKey, sortDir: s.sortDir,
    });
    const pg = BookQuery.paginate(filtered, s.page, s.pageSize);
    s.page = pg.page;
    this.#view.renderBooks({
      rows: pg.rows, total: pg.total, allCount: s.books.length, page: pg.page, pageCount: pg.pageCount,
      pageSize: s.pageSize, sortKey: s.sortKey, sortDir: s.sortDir,
      hasFilters: Boolean(s.search || s.categories.size || s.availability.size),
    });
  }

  #renderIssues() {
    const s = this.#state;
    const today = DateUtil.todayISO();
    const active = s.issues.filter((i) => i.isActive);
    const q = s.issueSearch.toLowerCase();

    const rows = active
      .filter((i) => !q || [i.borrower, i.bookTitle, i.bookIsbn].some((v) => v.toLowerCase().includes(q)))
      .filter((i) => !s.overdueOnly || i.getStatus(today).state === 'overdue')
      .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.bookTitle.localeCompare(b.bookTitle));

    this.#view.renderStats(this.#service.computeStats(s.books, s.issues, today));
    this.#view.renderIssues(rows, active.length, today);
  }

  /* ----- handlers ----- */

  /** @param {string} key */
  #onSort(key) {
    const s = this.#state;
    if (s.sortKey === key) s.sortDir = s.sortDir === 'asc' ? 'desc' : 'asc';
    else { s.sortKey = key; s.sortDir = 'asc'; }
    s.page = 1;
    this.#renderBooks();
  }

  /** @param {string} action @param {string} id */
  async #onBookAction(action, id) {
    const book = this.#state.books.find((b) => b.id === id);
    if (!book) { this.#toasts.error('This book is no longer in the list.'); return this.#refresh(); }

    if (action === 'edit') {
      this.#view.openBookDialog(book, this.#categories());
    } else if (action === 'issue') {
      if (!book.isAvailable) { this.#toasts.warning(`No copies of “${book.title}” are available.`); return; }
      this.#view.openIssueDialog(book, this.#service.calculateDueDate());
    } else if (action === 'delete') {
      const ok = await this.#view.confirm({
        title: 'Delete book',
        message: `Delete “${book.title}” from the catalogue? This cannot be undone.`,
        confirmLabel: 'Delete', danger: true,
      });
      if (!ok) return;
      try {
        await this.#service.deleteBook(id);
        this.#toasts.success(`Deleted “${book.title}”.`);
        await this.#refresh();
      } catch (err) { this.#handleError(err); }
    }
  }

  async #onBookSubmit() {
    const raw = this.#view.readBookForm();
    const isEdit = Boolean(raw.id);
    this.#view.setFormBusy('book', true);
    try {
      const saved = isEdit ? await this.#service.updateBook(raw.id, raw) : await this.#service.addBook(raw);
      this.#view.closeBookDialog();
      this.#toasts.success(`${isEdit ? 'Updated' : 'Added'} “${saved.title}”.`);
      await this.#refresh();
    } catch (err) {
      if (err instanceof ValidationError) this.#view.showBookErrors(err.fields);
      else this.#handleError(err);
    } finally {
      this.#view.setFormBusy('book', false);
    }
  }

  async #onIssueSubmit() {
    const raw = this.#view.readIssueForm();
    this.#view.setFormBusy('issue', true);
    try {
      const issue = await this.#service.issueBook(raw.bookId, raw);
      this.#view.closeIssueDialog();
      this.#toasts.success(`Issued “${issue.bookTitle}” to ${issue.borrower}. Due ${DateUtil.format(issue.dueOn)}.`);
      await this.#refresh();
    } catch (err) {
      if (err instanceof ValidationError) {
        this.#view.showIssueErrors(err.fields);
      } else {
        if (err instanceof BusinessRuleError || err instanceof NotFoundError) this.#view.closeIssueDialog();
        this.#handleError(err);
        await this.#refresh(); // state may be stale (e.g. last copy just issued elsewhere)
      }
    } finally {
      this.#view.setFormBusy('issue', false);
    }
  }

  /** @param {string} action @param {string} id */
  async #onIssueAction(action, id) {
    if (action !== 'return') return;
    const issue = this.#state.issues.find((i) => i.id === id);
    if (!issue) return this.#refresh();

    const ok = await this.#view.confirm({
      title: 'Return book',
      message: `Mark “${issue.bookTitle}” as returned by ${issue.borrower}?`,
      confirmLabel: 'Mark returned',
    });
    if (!ok) return;

    try {
      const { overdueDays } = await this.#service.returnBook(id);
      if (overdueDays > 0) this.#toasts.warning(`Returned “${issue.bookTitle}”, ${plural(overdueDays, 'day')} overdue.`);
      else this.#toasts.success(`Returned “${issue.bookTitle}”.`);
      await this.#refresh();
    } catch (err) {
      this.#handleError(err);
      await this.#refresh();
    }
  }

  /**
   * Maps errors to the right toast severity.
   * @param {unknown} err
   * @param {string} [fallback]
   */
  #handleError(err, fallback = 'Something went wrong. Please try again.') {
    if (err instanceof BusinessRuleError) this.#toasts.warning(err.message);
    else if (err instanceof AppError) this.#toasts.error(err.message);
    else { console.error(err); this.#toasts.error(fallback); }
  }
}

/* ==========================================================================
   9. BOOTSTRAP
   ========================================================================== */

/** Composition root: builds the object graph and starts the app. */
function bootstrap() {
  const { books, issues } = createRepositories(CONFIG);
  const service = new LibraryService(books, issues);
  const view = new LibraryView(document);
  const toasts = new ToastManager(document.getElementById('toast-container'));
  new LibraryController({ service, view, toasts }).init();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
  else bootstrap();
}

// Allows unit-testing the non-DOM layers under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG, Sanitizer, html, DateUtil, Book, Issue, BookQuery, Validator, LocalStorageRepository, ODataRepository,
    LibraryService, createRepositories, buildSeedData, ValidationError, BusinessRuleError, NotFoundError,
  };
}

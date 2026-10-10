/**
 * Structured error type and error classification shared by the extension
 * pages, the service worker and the content scripts.
 *
 * Every failure that reaches the workflow engine is a PCAError (or is
 * converted into one by `toPCAError`) so the engine can decide, from the
 * code alone, whether to retry, stop for the user, or fail the stage.
 */

export const ERROR_CODES = Object.freeze({
  // Data / validation
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  SCHEMA_UNSUPPORTED: 'SCHEMA_UNSUPPORTED',
  IMPORT_INVALID: 'IMPORT_INVALID',
  ASSET_MISSING: 'ASSET_MISSING',
  ASSET_INVALID: 'ASSET_INVALID',

  // Page / tab
  NO_CONSOLE_TAB: 'NO_CONSOLE_TAB',
  TAB_CLOSED: 'TAB_CLOSED',
  CONTENT_SCRIPT_UNAVAILABLE: 'CONTENT_SCRIPT_UNAVAILABLE',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  UNKNOWN_PAGE: 'UNKNOWN_PAGE',
  WRONG_PAGE: 'WRONG_PAGE',
  NAVIGATION_TIMEOUT: 'NAVIGATION_TIMEOUT',

  // Identity
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  POSSIBLE_DUPLICATE_APP: 'POSSIBLE_DUPLICATE_APP',
  PACKAGE_MISMATCH: 'PACKAGE_MISMATCH',
  PACKAGE_UNAVAILABLE: 'PACKAGE_UNAVAILABLE',

  // DOM
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  AMBIGUOUS_ELEMENT: 'AMBIGUOUS_ELEMENT',
  ELEMENT_DISABLED: 'ELEMENT_DISABLED',
  VALUE_NOT_APPLIED: 'VALUE_NOT_APPLIED',
  UNKNOWN_QUESTION: 'UNKNOWN_QUESTION',
  PAGE_VALIDATION_ERROR: 'PAGE_VALIDATION_ERROR',
  EXISTING_CONTENT: 'EXISTING_CONTENT',
  WAIT_TIMEOUT: 'WAIT_TIMEOUT',

  // Uploads / release
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  UPLOAD_NOT_CONFIRMED: 'UPLOAD_NOT_CONFIRMED',
  PROCESSING_TIMEOUT: 'PROCESSING_TIMEOUT',
  VERSION_CODE_CONFLICT: 'VERSION_CODE_CONFLICT',

  // Workflow
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  LOCKED: 'LOCKED',
  ACTION_TIMEOUT: 'ACTION_TIMEOUT',
  VERIFY_FAILED: 'VERIFY_FAILED',
  DECLARATION_UNANSWERED: 'DECLARATION_UNANSWERED',
  MANUAL_SECTION_INCOMPLETE: 'MANUAL_SECTION_INCOMPLETE',
  READINESS_ISSUES: 'READINESS_ISSUES',
  SUBMISSION_NOT_CONFIRMED: 'SUBMISSION_NOT_CONFIRMED',
  SUBMISSION_UNVERIFIED: 'SUBMISSION_UNVERIFIED',
  INTERRUPTED: 'INTERRUPTED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',

  // Messaging
  MESSAGE_REJECTED: 'MESSAGE_REJECTED',

  UNEXPECTED: 'UNEXPECTED',
});

/**
 * Classification:
 *  - retryable: safe to retry automatically *if* the action is idempotent.
 *  - userAction: the user must do something in the browser before resuming.
 *  - fatal: the stage cannot continue without changing data or code.
 */
const CLASSIFICATION = {
  WAIT_TIMEOUT: 'retryable',
  ACTION_TIMEOUT: 'retryable',
  CONTENT_SCRIPT_UNAVAILABLE: 'retryable',
  NAVIGATION_TIMEOUT: 'retryable',
  VALUE_NOT_APPLIED: 'retryable',

  NO_CONSOLE_TAB: 'userAction',
  TAB_CLOSED: 'userAction',
  SESSION_EXPIRED: 'userAction',
  UNKNOWN_PAGE: 'userAction',
  WRONG_PAGE: 'userAction',
  IDENTITY_MISMATCH: 'userAction',
  POSSIBLE_DUPLICATE_APP: 'userAction',
  PACKAGE_UNAVAILABLE: 'userAction',
  ELEMENT_NOT_FOUND: 'userAction',
  AMBIGUOUS_ELEMENT: 'userAction',
  ELEMENT_DISABLED: 'userAction',
  UNKNOWN_QUESTION: 'userAction',
  PAGE_VALIDATION_ERROR: 'userAction',
  EXISTING_CONTENT: 'userAction',
  UPLOAD_FAILED: 'userAction',
  UPLOAD_NOT_CONFIRMED: 'userAction',
  PROCESSING_TIMEOUT: 'userAction',
  VERSION_CODE_CONFLICT: 'userAction',
  VERIFY_FAILED: 'userAction',
  DECLARATION_UNANSWERED: 'userAction',
  MANUAL_SECTION_INCOMPLETE: 'userAction',
  READINESS_ISSUES: 'userAction',
  SUBMISSION_NOT_CONFIRMED: 'userAction',
  SUBMISSION_UNVERIFIED: 'userAction',
  INTERRUPTED: 'userAction',
  APPROVAL_REQUIRED: 'userAction',
  LOCKED: 'userAction',
  ASSET_MISSING: 'userAction',
  PACKAGE_MISMATCH: 'fatal',

  VALIDATION_FAILED: 'fatal',
  SCHEMA_UNSUPPORTED: 'fatal',
  IMPORT_INVALID: 'fatal',
  ASSET_INVALID: 'fatal',
  INVALID_TRANSITION: 'fatal',
  MESSAGE_REJECTED: 'fatal',
  UNEXPECTED: 'fatal',
};

export class PCAError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message human readable message (no secrets)
   * @param {object} [details] structured, serialisable details
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PCAError';
    this.code = ERROR_CODES[code] ? code : ERROR_CODES.UNEXPECTED;
    this.details = details;
  }

  get classification() {
    return classifyError(this.code);
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details ?? null };
  }
}

export function classifyError(code) {
  return CLASSIFICATION[code] || 'fatal';
}

export function isRetryable(code) {
  return classifyError(code) === 'retryable';
}

/** Converts anything thrown into a PCAError without leaking stack traces. */
export function toPCAError(err) {
  if (err instanceof PCAError) return err;
  if (err && typeof err === 'object' && typeof err.code === 'string' && ERROR_CODES[err.code]) {
    return new PCAError(err.code, String(err.message || err.code), err.details);
  }
  const message = err && err.message ? String(err.message) : String(err);
  return new PCAError(ERROR_CODES.UNEXPECTED, message);
}

/** Serialisable error payload for messaging. */
export function errorPayload(err) {
  const e = toPCAError(err);
  return { code: e.code, message: e.message, details: e.details ?? null };
}

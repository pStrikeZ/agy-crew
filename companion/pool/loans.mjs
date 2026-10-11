import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceFile } from '../state-lock.mjs';
import { PoolError, LOAN_BACKUP_NAME, accountHome, tokenPath, restoreLoanFiles } from './state.mjs';

/** Credential loan: the borrower's HOME keeps the conversation, the lender's
 *  token makes the request. Called inside updatePool, so the file swap and the
 *  loan record are one transaction under the pool lock. */
export function beginLoan(pool, { borrower, lender, jobId, pid = process.pid }) {
  const tb = tokenPath(accountHome(borrower));
  const tl = tokenPath(accountHome(lender));
  const backup = path.join(path.dirname(tb), LOAN_BACKUP_NAME);
  if (fs.existsSync(backup)) throw new PoolError(`a loan backup already exists for ${borrower}: ${backup}; resolve it before borrowing again`);
  if (!fs.existsSync(tl)) throw new PoolError(`lender ${lender} has no token to lend`);
  const hostHadToken = fs.existsSync(tb);
  const loan = { id: randomUUID().slice(0, 8), borrower, lender, pid, job_id: jobId || null,
    host_had_token: hostHadToken, started_at: new Date().toISOString() };
  try {
    if (hostHadToken) replaceFile(tb, backup);
    const tmp = `${tb}.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(tb), { recursive: true });
    fs.copyFileSync(tl, tmp);
    replaceFile(tmp, tb);
  } catch (error) {
    // Put the borrower back exactly as it was before surfacing the failure.
    try { fs.rmSync(tb, { force: true }); if (hostHadToken && fs.existsSync(backup)) replaceFile(backup, tb); } catch {}
    throw error;
  }
  pool.loans.push(loan);
  const lease = { pid, job_id: jobId || null, started_at: loan.started_at, loan_id: loan.id };
  pool.leases.push({ ...lease, id: randomUUID().slice(0, 8), account: lender, role: 'lender' });
  pool.leases.push({ ...lease, id: randomUUID().slice(0, 8), account: borrower, role: 'run' });
  return loan;
}

/** Restore the tokens and forget the loan and its leases. */
export function endLoan(pool, loanId) {
  const loan = pool.loans.find((l) => l.id === loanId);
  if (!loan) return;
  restoreLoanFiles(loan);
  pool.loans = pool.loans.filter((l) => l.id !== loanId);
  pool.leases = pool.leases.filter((l) => l.loan_id !== loanId);
}

export const accountInLoan = (pool, name) => pool.loans.some((l) => l.borrower === name || l.lender === name);

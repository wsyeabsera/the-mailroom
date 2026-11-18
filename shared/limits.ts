// Size limits shared by the Hub and the laptop daemon.

/** Largest write_file content the laptop accepts (the Hub's request body cap is 256 KB, so this is the practical limit too). */
export const MAX_WRITE_BYTES = 200 * 1024;
/** Largest result the laptop will report (a file it reads, or the output of a claude or run task). Output past this is cut. */
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;
/** Results up to this size are stored in the job row; bigger ones go to the separate `job_results` table. */
export const INLINE_RESULT_BYTES = 200 * 1024;
/** How long a separately stored (big) result is kept. The job, its events and small results are kept forever. */
export const BIG_RESULT_TTL_MS = 7 * 24 * 3600_000;

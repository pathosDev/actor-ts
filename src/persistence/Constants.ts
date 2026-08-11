/**
 * Tuned values shared across the persistence subsystem.
 *
 * A constant lives here when it is a cap, bound, timeout or size that more
 * than one persistence file reads — not when it is the built-in default of
 * an options field (that belongs in the matching `XOptions.ts`), and not
 * when it is part of a storage format defined in the file beside it (the
 * `BodyCodec` flags and `ATS1_MAGIC` stay there, because a second copy of
 * a format definition is how the format silently forks).
 *
 * Vendor API limits are prefixed with the vendor.  A bare `MAX_BATCH_ITEMS`
 * is unambiguous inside one driver and meaningless in a shared namespace,
 * where DynamoDB's 25 sits next to whatever the next backend caps at.
 *
 * This module imports nothing, so it can never close an import cycle —
 * the same property `XOptions.ts` has by construction.
 */

/**
 * DynamoDB caps one `BatchWriteItem` call at 25 items.  A hard API limit,
 * not a tuning choice: exceeding it is a `ValidationException`, so both the
 * journal's and the snapshot store's delete loops chunk on it.  They must
 * agree, because they chunk the same shape of request against the same API.
 */
export const DYNAMODB_MAX_BATCH_ITEMS = 25;

/**
 * DynamoDB caps one `TransactWriteItems` call at 100 items.  This is the
 * ceiling on how many events a single `append` can write atomically — the
 * journal rejects a larger batch up front rather than letting AWS reject it,
 * so the caller gets a message naming the limit instead of a driver error.
 */
export const DYNAMODB_MAX_TRANSACTION_ITEMS = 100;
